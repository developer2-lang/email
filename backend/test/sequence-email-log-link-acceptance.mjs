/**
 * Sequence EMAIL-LOG LINK + WAIT-HOURS acceptance test — focused Step 1 → Step 2.
 *
 * Covers the two automation fixes:
 *   1. Every sent sequence step creates a sequence_step_logs row whose
 *      email_log_id points at a REAL email_logs row (status 'sent') — the
 *      branch tracking link. Without it, eligibility can never read the parent
 *      email's open record and every branch computes eligible = 0.
 *   2. Both the OPENED and NOT_OPENED children respect their OWN saved
 *      wait_hours (send only after the wait elapses), and opening re-routes to
 *      the OPENED child scheduled at (open time + child.wait_hours) — NOT on
 *      the next tick.
 *
 * Tree (no hardcoded step numbers, built via the real service):
 *
 *   Step 1 (STARTING, wait 0)
 *   ├── OPENED     → Step 2 OPENED    (wait 3h)
 *   └── NOT_OPENED → Step 2 NOT_OPENED (wait 1h)
 *
 * Recipients:
 *   W1: opens Step 1          -> Step 2 OPENED    (due open + 3h)
 *   W2: never opens Step 1    -> Step 2 NOT_OPENED (due sent + 1h)
 *
 * The sequence is a DRAFT (background worker only scans ACTIVE sequences) so
 * the worker functions are driven directly.
 *
 * Run:  node test/sequence-email-log-link-acceptance.mjs   (from backend/)
 */
import 'dotenv/config'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'

// ─── Override SMTP + worker pacing to the stub BEFORE any module loads ─────
process.env.EMAIL_HOST = '127.0.0.1'
process.env.EMAIL_PORT = '2525'
process.env.EMAIL_SECURE = 'false'
process.env.EMAIL_USER = 'stub@example.co'
process.env.EMAIL_PASSWORD = 'stub'
process.env.EMAIL_FROM = 'Test Sender <test@example.com>'
process.env.TRACKING_BASE_URL = 'http://tracking.test'
process.env.SEQUENCE_SEND_DELAY_MS = '0'
process.env.SEQUENCE_BATCH_SIZE = '100'

// ─── Stub SMTP server (captures full message DATA per recipient) ──────────
const SMTP_PORT = 2525
const delivered = []

function startSmtpServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let dataMode = false
      let authStep = 0
      let currentTo = ''
      let dataBuffer = ''
      socket.on('error', () => {})
      socket.setEncoding('utf8')
      socket.write('220 test-smtp ESMTP ready\r\n')

      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)

          if (dataMode) {
            if (line === '.') {
              dataMode = false
              delivered.push({ to: currentTo, data: dataBuffer })
              dataBuffer = ''
              socket.write('250 2.0.0 OK: queued as MOCK\r\n')
              continue
            }
            dataBuffer += `${line}\n`
            continue
          }

          const upper = line.toUpperCase()
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write(
              '250-test-smtp\r\n' +
              '250-SIZE 104857600\r\n' +
              '250-8BITMIME\r\n' +
              '250-ENHANCEDSTATUSCODES\r\n' +
              '250 PIPELINING\r\n'
            )
          } else if (upper.startsWith('AUTH LOGIN')) {
            authStep = 1
            socket.write('334 VXNlcm5hbWU6\r\n')
          } else if (upper.startsWith('AUTH PLAIN')) {
            authStep = 0
            socket.write('235 2.7.0 Authentication successful\r\n')
          } else if (authStep === 1) {
            authStep = 2
            socket.write('334 UGFzc3dvcmQ6\r\n')
          } else if (authStep === 2) {
            authStep = 0
            socket.write('235 2.7.0 Authentication successful\r\n')
          } else if (upper.startsWith('MAIL FROM')) {
            socket.write('250 2.1.0 OK\r\n')
          } else if (upper.startsWith('RCPT TO')) {
            const m = line.match(/<([^>]+)>/)
            if (m) currentTo = m[1]
            socket.write('250 2.1.5 OK\r\n')
          } else if (upper === 'DATA') {
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
            dataMode = true
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n')
            socket.end()
          } else if (upper === 'RSET' || upper === 'NOOP') {
            socket.write('250 2.0.0 OK\r\n')
          } else {
            socket.write('250 OK\r\n')
          }
        }
      })
    })
    server.on('error', reject)
    server.listen(SMTP_PORT, '127.0.0.1', () => resolve(server))
  })
}

function subjectOf(msg) {
  const m = (msg.data || '').match(/^Subject: (.*)$/m)
  return m ? m[1].trim() : null
}
const smtpCount = () => delivered.length
const forRecipient = (email) => delivered.filter((d) => d.to === email)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nowIso = () => new Date().toISOString()
const msAgo = (ms) => new Date(Date.now() - ms).toISOString()

let smtpServer
let client
let supabaseService
let sequenceService
let processDueEnrollment
let handleStepOpened

const RUN_ID = `seql_${Date.now()}`
const SEGMENT = `SeqEmailLogTest-${RUN_ID}`
const emails = {
  W1: `seql.W1.${RUN_ID}@example.co`,
  W2: `seql.W2.${RUN_ID}@example.co`,
}

let sequenceId
let seqCampaignId
const contacts = {}
const steps = {}
let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

async function insertContact(email) {
  const { data, error } = await client.from('contacts').insert({
    email,
    full_name: 'EmailLink Test Contact',
    company: 'EmailLink Test Co',
    designation: 'Tester',
    contact_type: SEGMENT,
    company_category: 'Technology',
  }).select('id, email').single()
  if (error) throw error
  return data
}

async function getEnrollment(contactId) {
  const { data, error } = await client
    .from('sequence_enrollments')
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('contact_id', contactId)
    .single()
  if (error) throw error
  return data
}

async function getStepLog(contactId, stepNode) {
  const { data, error } = await client
    .from('sequence_step_logs')
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('sequence_step_id', stepNode.id)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function getEmailLog(emailLogId) {
  const { data, error } = await client
    .from('email_logs')
    .select('*')
    .eq('id', emailLogId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function processEnrollment(contactId) {
  const { data: enrollment, error } = await client
    .from('sequence_enrollments')
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('contact_id', contactId)
    .single()
  if (error) throw error
  if (enrollment.status !== 'active') return { skipped: true, status: enrollment.status }

  const { data: sequence, error: seqError } = await client
    .from('sequences')
    .select('*')
    .eq('id', sequenceId)
    .single()
  if (seqError) throw seqError

  const { data: contact, error: contactError } = await client
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single()
  if (contactError) throw contactError

  return processDueEnrollment({ ...enrollment, sequences: sequence, contacts: contact })
}

// Assert a step-log row exists, its email_log_id is non-null, and it points at
// a REAL email_logs row in 'sent' state. THE root-cause regression this test
// guards: sends whose email_log_id stayed NULL stranded every branch at 0.
async function assertStepLogLinked(contactId, stepNode, label) {
  const stepLog = await getStepLog(contactId, stepNode)
  assert.ok(stepLog, `${label}: step log row exists`)
  assert.ok(stepLog.email_log_id, `${label}: sequence_step_logs.email_log_id is non-null (was NULL — broken branch link)`)
  const emailLog = await getEmailLog(stepLog.email_log_id)
  assert.ok(emailLog, `${label}: email_logs row ${stepLog.email_log_id} exists`)
  assert.equal(emailLog.status, 'sent', `${label}: email_logs.status is 'sent'`)
  assert.equal(emailLog.contact_id, contactId, `${label}: email_log points at the right contact`)
  return { stepLog, emailLog }
}

function assertNearFuture(iso, expectedOffsetMs, label, toleranceMs = 2 * 60 * 1000) {
  const delta = new Date(iso).getTime() - (Date.now() + expectedOffsetMs)
  assert.ok(
    Math.abs(delta) <= toleranceMs,
    `${label}: next_run_at ≈ now + ${Math.round(expectedOffsetMs / 60000)}m (got ${new Date(iso).toISOString()}, offset ${Math.round((new Date(iso).getTime() - Date.now()) / 60000)}m)`
  )
}

async function main() {
  smtpServer = await startSmtpServer()
  console.log('[Test] Stub SMTP listening on 127.0.0.1:2525')

  supabaseService = await import('../services/supabaseService.js')
  sequenceService = await import('../services/sequenceService.js')
  ;({ processDueEnrollment, handleStepOpened } = await import('../workers/sequenceWorker.js'))
  client = supabaseService.supabase

  contacts.W1 = await insertContact(emails.W1)
  contacts.W2 = await insertContact(emails.W2)

  const seq = await sequenceService.createSequence({
    name: `__seq_emaillink__${RUN_ID}`,
    audience_segment: SEGMENT,
    trigger_type: 'behaviour',
    recipient_type: 'all',
    send_mode: 'both',
  })
  sequenceId = seq.id

  const root = await sequenceService.createStep(sequenceId, {
    step_number: 1,
    normal_subject: 'Step 1 Subject',
    normal_body: 'Step 1 BODY',
    wait_hours: 0,
  })
  const step2Opened = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: root.id,
    parent_branch: 'OPENED',
    normal_subject: 'Step 2 Opened Subject',
    normal_body: 'Step 2 OPENED BODY',
    wait_hours: 3,
  })
  const step2NotOpened = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: root.id,
    parent_branch: 'NOT_OPENED',
    increment_subject: 'Step 2 NotOpened Subject',
    increment_body: 'Step 2 NOT-OPENED BODY',
    wait_hours: 1,
  })

  Object.assign(steps, { root, step2Opened, step2NotOpened })
  console.log(`\n[Test] tree ready — 3 nodes (step2 OPENED wait 3h, step2 NOT_OPENED wait 1h)`)

  // ── Enroll both on the STARTING node, due immediately ──
  for (const p of ['W1', 'W2']) {
    const { error } = await client.from('sequence_enrollments').insert({
      sequence_id: sequenceId,
      contact_id: contacts[p].id,
      current_step_id: root.id,
      current_step: 1,
      current_email_type: 'normal',
      status: 'active',
      enrolled_at: nowIso(),
      next_run_at: msAgo(60_000),
    })
    if (error) throw error
  }

  // ── Phase A: Step 1 sent to both — email_log_id MUST be linked ──
  console.log('\n── Phase A: Step 1 → both recipients; email_log_id link asserted ──')
  for (const p of ['W1', 'W2']) await processEnrollment(contacts[p].id)
  assert.equal(smtpCount(), 2, 'exactly 2 emails after Step 1')
  for (const p of ['W1', 'W2']) {
    assert.equal(subjectOf(forRecipient(emails[p])[0]), 'Step 1 Subject', `${p} Step 1 subject`)
    await assertStepLogLinked(contacts[p].id, root, `${p} Step 1`)
    const enrollment = await getEnrollment(contacts[p].id)
    assert.equal(enrollment.current_step_id, step2NotOpened.id, `${p} parked on Step 2 NOT_OPENED after Step 1`)
    // NOT_OPENED child wait = 1h: parked at (parent sent + 1h), not next tick.
    assertNearFuture(enrollment.next_run_at, 3600 * 1000, `${p} Step 2 NOT_OPENED due (wait 1h)`)
  }
  {
    const { data: seqRow } = await client.from('sequences').select('campaign_id').eq('id', sequenceId).single()
    seqCampaignId = seqRow && seqRow.campaign_id
  }
  ok('Step 1 sent to both; step logs carry a real email_logs.id; both parked on Step 2 NOT_OPENED at sent+1h')

  // ── Phase B: W1 opens Step 1 → re-route to Step 2 OPENED, due at open+3h ──
  console.log('\n── Phase B: W1 opens Step 1 → Step 2 OPENED (wait 3h respected) ──')
  {
    const w1StepLog = await getStepLog(contacts.W1.id, root)
    await client
      .from('email_logs')
      .update({ opened: true, opened_at: nowIso() })
      .eq('id', w1StepLog.email_log_id)
    const result = await handleStepOpened({ id: w1StepLog.email_log_id, contact_id: contacts.W1.id })
    assert.equal(result && result.id, step2Opened.id, 'W1 re-routed to Step 2 OPENED')
    const enrollment = await getEnrollment(contacts.W1.id)
    assert.equal(enrollment.current_step_id, step2Opened.id, 'W1 now on Step 2 OPENED')
    // KEY: the OPENED child's own wait_hours schedules the send at open+3h,
    // NOT immediately. eligible=0 or 'next tick' would land ~now (≤60s).
    assertNearFuture(enrollment.next_run_at, 3 * 3600 * 1000, 'W1 Step 2 OPENED due (wait 3h)')
    ok('opening re-routes to Step 2 OPENED scheduled at open+3h — eligibility true + wait respected')
  }

  // ── Phase C: wait NOT elapsed → neither branch sends yet ──
  console.log('\n── Phase C: before the waits elapse, no Step 2 email is sent ──')
  for (const p of ['W1', 'W2']) await processEnrollment(contacts[p].id)
  assert.equal(smtpCount(), 2, 'no Step 2 send while waits are pending')
  ok('both branches stay pending until their own wait_hours elapse')

  // ── Phase D: waits elapse → Step 2 sends on each branch with a linked log ──
  console.log('\n── Phase D: waits elapsed → Step 2 branch send ──')
  {
    // Simulate elapsed time by backdating tracking, then force-due each.
    // W1: open happened 4h ago (open+3h wait elapsed 1h ago).
    const w1StepLog = await getStepLog(contacts.W1.id, root)
    await client
      .from('email_logs')
      .update({ opened_at: msAgo(4 * 3600 * 1000) })
      .eq('id', w1StepLog.email_log_id)
    // W2: parent sent 2h ago (sent+1h wait elapsed 1h ago).
    await client
      .from('sequence_step_logs')
      .update({ sent_at: msAgo(2 * 3600 * 1000) })
      .eq('id', (await getStepLog(contacts.W2.id, root)).id)
  }
  for (const p of ['W1', 'W2']) {
    await client
      .from('sequence_enrollments')
      .update({ next_run_at: msAgo(60_000) })
      .eq('sequence_id', sequenceId)
      .eq('contact_id', contacts[p].id)
  }
  for (const p of ['W1', 'W2']) await processEnrollment(contacts[p].id)
  assert.equal(smtpCount(), 4, 'exactly 4 emails after Step 2')

  const w1Msgs = forRecipient(emails.W1)
  const w2Msgs = forRecipient(emails.W2)
  assert.equal(subjectOf(w1Msgs[1]), 'Step 2 Opened Subject', 'W1 Step 2 = OPENED content')
  assert.equal(subjectOf(w2Msgs[1]), 'Step 2 NotOpened Subject', 'W2 Step 2 = NOT_OPENED increment content')
  await assertStepLogLinked(contacts.W1.id, steps.step2Opened, 'W1 Step 2 OPENED')
  await assertStepLogLinked(contacts.W2.id, steps.step2NotOpened, 'W2 Step 2 NOT_OPENED')
  ok('after the waits elapsed, Step 2 OPENED (W1) + NOT_OPENED (W2) sent, each with a real email_log_id')

  console.log(`\n✅ ALL ${passed} CHECKS PASSED — email-log link + wait-hours acceptance OK`)
}

async function cleanup() {
  try {
    if (seqCampaignId) {
      await client.from('email_logs').delete().eq('campaign_id', seqCampaignId)
    }
    if (sequenceId) {
      await client.from('sequence_enrollments').delete().eq('sequence_id', sequenceId)
      await client.from('sequence_step_logs').delete().eq('sequence_id', sequenceId)
      await client.from('sequence_steps').delete().eq('sequence_id', sequenceId)
      await client.from('sequences').delete().eq('id', sequenceId)
    }
    for (const p of ['W1', 'W2']) {
      if (contacts[p]) await client.from('contacts').delete().eq('id', contacts[p].id)
    }
    if (seqCampaignId) {
      await client.from('campaigns').delete().eq('id', seqCampaignId)
    }
  } catch (error) {
    console.error('[Test] Cleanup failed (non-fatal):', error.message)
  }
  if (smtpServer) smtpServer.close()
}

main()
  .catch((error) => {
    console.error('\n✗ TEST FAILED:', error.message)
    console.error(error.stack || error)
    process.exitCode = 1
  })
  .finally(cleanup)
