/**
 * Sequence BRANCHING acceptance test — full Step 1 → Step 2 → Step 3 tree,
 * all FOUR recipient paths, no hardcoded step numbers.
 *
 * Tree (built via the real service createStep, keyed ONLY by parent_step_id +
 * parent_branch):
 *
 *   Step 1 (STARTING)
 *   ├── OPENED     → Step 2 OPENED
 *   │                 ├── OPENED     → Step 3 OPENED
 *   │                 └── NOT_OPENED → Step 3 NOT_OPENED
 *   └── NOT_OPENED → Step 2 NOT_OPENED
 *                     ├── OPENED     → Step 3 OPENED
 *                     └── NOT_OPENED → Step 3 NOT_OPENED
 *
 * Recipients (tracking outcome drives each path):
 *   P1: opens Step 1, opens Step 2 -> Step 3 (opened branch)
 *   P2: opens Step 1, skips Step 2 -> Step 3 (not-opened branch)
 *   P3: skips Step 1, opens Step 2 -> Step 3 (opened branch)
 *   P4: skips Step 1, skips Step 2 -> Step 3 (not-opened branch)
 *
 * The sequence is a DRAFT (the shared background worker only scans ACTIVE
 * sequences) so the worker functions are driven directly — the exact
 * per-enrollment path the automatic worker runs.
 *
 * Run:  node test/sequence-branching-acceptance.mjs   (from backend/)
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
// Leaves (nodes with no children) complete immediately in this test.
process.env.SEQUENCE_LEAF_RECHECK_HOURS = '0'

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

let smtpServer
let client
let supabaseService
let sequenceService
let processDueEnrollment
let handleStepOpened

const RUN_ID = `seqbr_${Date.now()}`
const SEGMENT = `SeqBranchTest-${RUN_ID}`
const emails = {
  P1: `seqbr.P1.${RUN_ID}@example.co`,
  P2: `seqbr.P2.${RUN_ID}@example.co`,
  P3: `seqbr.P3.${RUN_ID}@example.co`,
  P4: `seqbr.P4.${RUN_ID}@example.co`,
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
    full_name: 'Branch Test Contact',
    company: 'Branch Test Co',
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

async function openStepEmail(contact, stepNode) {
  const stepLog = await getStepLog(contact.id, stepNode)
  assert.ok(stepLog && stepLog.email_log_id, `${contact.email} has a step log to open`)
  await client
    .from('email_logs')
    .update({ opened: true, opened_at: new Date().toISOString() })
    .eq('id', stepLog.email_log_id)
  const result = await handleStepOpened({ id: stepLog.email_log_id, contact_id: contact.id })
  return { stepLog, result }
}

async function main() {
  smtpServer = await startSmtpServer()
  console.log('[Test] Stub SMTP listening on 127.0.0.1:2525')

  supabaseService = await import('../services/supabaseService.js')
  sequenceService = await import('../services/sequenceService.js')
  ;({ processDueEnrollment, handleStepOpened } = await import('../workers/sequenceWorker.js'))
  client = supabaseService.supabase

  // ── Build the full tree through the REAL service (nothing hardcoded) ──
  contacts.P1 = await insertContact(emails.P1)
  contacts.P2 = await insertContact(emails.P2)
  contacts.P3 = await insertContact(emails.P3)
  contacts.P4 = await insertContact(emails.P4)

  const seq = await sequenceService.createSequence({
    name: `__seq_branch__${RUN_ID}`,
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
    wait_hours: 0,
  })
  const step2NotOpened = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: root.id,
    parent_branch: 'NOT_OPENED',
    increment_subject: 'Step 2 NotOpened Subject',
    increment_body: 'Step 2 NOT-OPENED BODY',
    wait_hours: 0,
  })
  const step3OpenedFromOpened = await sequenceService.createStep(sequenceId, {
    step_number: 3,
    parent_step_id: step2Opened.id,
    parent_branch: 'OPENED',
    normal_subject: 'Step 3 Opened (via 2 opened) Subject',
    normal_body: 'Step 3 OPENED BODY',
    wait_hours: 0,
  })
  const step3NotOpenedFromOpened = await sequenceService.createStep(sequenceId, {
    step_number: 3,
    parent_step_id: step2Opened.id,
    parent_branch: 'NOT_OPENED',
    increment_subject: 'Step 3 NotOpened (via 2 opened) Subject',
    increment_body: 'Step 3 NOT-OPENED BODY (via 2 opened)',
    wait_hours: 0,
  })
  const step3OpenedFromNotOpened = await sequenceService.createStep(sequenceId, {
    step_number: 3,
    parent_step_id: step2NotOpened.id,
    parent_branch: 'OPENED',
    normal_subject: 'Step 3 Opened (via 2 not opened) Subject',
    normal_body: 'Step 3 OPENED BODY (via 2 not opened)',
    wait_hours: 0,
  })
  const step3NotOpenedFromNotOpened = await sequenceService.createStep(sequenceId, {
    step_number: 3,
    parent_step_id: step2NotOpened.id,
    parent_branch: 'NOT_OPENED',
    increment_subject: 'Step 3 NotOpened (via 2 not opened) Subject',
    increment_body: 'Step 3 NOT-OPENED BODY (via 2 not opened)',
    wait_hours: 0,
  })

  Object.assign(steps, {
    root,
    step2Opened,
    step2NotOpened,
    step3OpenedFromOpened,
    step3NotOpenedFromOpened,
    step3OpenedFromNotOpened,
    step3NotOpenedFromNotOpened,
  })
  console.log(`\n[Test] tree ready — ${Object.keys(steps).length} nodes`)

  // ── Enroll all 4 on the STARTING node, due immediately ──
  const now = new Date().toISOString()
  for (const p of ['P1', 'P2', 'P3', 'P4']) {
    const { error } = await client.from('sequence_enrollments').insert({
      sequence_id: sequenceId,
      contact_id: contacts[p].id,
      current_step_id: root.id,
      current_step: 1,
      current_email_type: 'normal',
      status: 'active',
      enrolled_at: now,
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
    })
    if (error) throw error
  }

  // ── Phase 1: Step 1 sent to all 4 ──
  console.log('\n── Phase 1: Step 1 (STARTING) → all 4 ──')
  for (const p of ['P1', 'P2', 'P3', 'P4']) await processEnrollment(contacts[p].id)
  assert.equal(smtpCount(), 4, 'exactly 4 emails after Step 1')
  for (const p of ['P1', 'P2', 'P3', 'P4']) {
    assert.equal(subjectOf(forRecipient(emails[p])[0]), 'Step 1 Subject', `${p} Step 1 subject`)
    const enrollment = await getEnrollment(contacts[p].id)
    assert.equal(enrollment.current_step_id, step2NotOpened.id, `${p} parked on Step 2 (not opened) after Step 1`)
  }
  {
    const { data: seqRow } = await client.from('sequences').select('campaign_id').eq('id', sequenceId).single()
    seqCampaignId = seqRow && seqRow.campaign_id
  }
  ok('Step 1 sent to all 4; every recipient parked on the NOT_OPENED child (Step 2)')

  // ── Phase 2: P1 + P2 open Step 1 → re-route to Step 2 OPENED ──
  console.log('\n── Phase 2: P1 + P2 open Step 1 → Step 2 OPENED ──')
  for (const p of ['P1', 'P2']) {
    const { result } = await openStepEmail(contacts[p], root)
    assert.equal(result.id, step2Opened.id, `${p} re-routed to Step 2 opened`)
    const enrollment = await getEnrollment(contacts[p].id)
    assert.equal(enrollment.current_step_id, step2Opened.id, `${p} now on Step 2 opened`)
  }
  ok('opening Step 1 re-routes the opener onto Step 2 OPENED')

  // ── Phase 3: branch send — Step 2 OPENED → P1/P2, Step 2 NOT_OPENED → P3/P4 ──
  console.log('\n── Phase 3: Step 2 branch send ──')
  for (const p of ['P1', 'P2', 'P3', 'P4']) await processEnrollment(contacts[p].id)
  assert.equal(smtpCount(), 8, 'exactly 8 emails after Step 2')

  for (const p of ['P1', 'P2']) {
    const msgs = forRecipient(emails[p])
    assert.equal(msgs.length, 2, `${p} got Step 1 + Step 2`)
    assert.equal(subjectOf(msgs[1]), 'Step 2 Opened Subject', `${p} Step 2 = OPENED content`)
  }
  for (const p of ['P3', 'P4']) {
    const msgs = forRecipient(emails[p])
    assert.equal(msgs.length, 2, `${p} got Step 1 + Step 2`)
    assert.equal(subjectOf(msgs[1]), 'Step 2 NotOpened Subject', `${p} Step 2 = NOT-OPENED increment content`)
  }
  ok('Step 2 OPENED sent to openers (P1/P2); Step 2 NOT_OPENED (increment) sent to non-openers (P3/P4)')

  // State: everyone parked on the Step-3 NOT_OPENED child of their Step 2 node,
  // and current_email_type reflects the actual node type.
  {
    const p1 = await getEnrollment(contacts.P1.id)
    assert.equal(p1.current_step_id, step3NotOpenedFromOpened.id, 'P1 parked on Step 3 (not opened, via 2 opened)')
    assert.equal(p1.current_email_type, 'increment', 'P1 current_email_type reflects the not-opened node')
    const p4 = await getEnrollment(contacts.P4.id)
    assert.equal(p4.current_step_id, step3NotOpenedFromNotOpened.id, 'P4 parked on Step 3 (not opened, via 2 not opened)')
    assert.equal(p4.current_email_type, 'increment', 'P4 current_email_type reflects the not-opened node')
    ok('after Step 2, everyone parked on the correct Step-3 NOT_OPENED child; current_email_type=increment')
  }

  // ── Phase 4: P1 opens Step 2 (opened), P3 opens Step 2 (not opened) ──
  console.log('\n── Phase 4: opens on Step 2 re-route to the correct Step 3 OPENED child ──')
  {
    const { result: r1 } = await openStepEmail(contacts.P1, steps.step2Opened)
    assert.equal(r1.id, step3OpenedFromOpened.id, 'P1 re-routed to Step 3 OPENED (via 2 opened)')
    const { result: r3 } = await openStepEmail(contacts.P3, steps.step2NotOpened)
    assert.equal(r3.id, step3OpenedFromNotOpened.id, 'P3 re-routed to Step 3 OPENED (via 2 not opened)')
    const p1 = await getEnrollment(contacts.P1.id)
    assert.equal(p1.current_step_id, step3OpenedFromOpened.id, 'P1 on Step 3 OPENED')
    const p3 = await getEnrollment(contacts.P3.id)
    assert.equal(p3.current_step_id, step3OpenedFromNotOpened.id, 'P3 on Step 3 OPENED')
    ok('opens on Step 2 re-route to the correct Step 3 OPENED child on each branch')
  }

  // ── Phase 5: Step 3 send — all 4 different leaves ──
  console.log('\n── Phase 5: Step 3 branch send (4 distinct leaves) ──')
  for (const p of ['P1', 'P2', 'P3', 'P4']) await processEnrollment(contacts[p].id)
  assert.equal(smtpCount(), 12, 'exactly 12 emails total')

  const expected = {
    P1: ['Step 1 Subject', 'Step 2 Opened Subject', 'Step 3 Opened (via 2 opened) Subject'],
    P2: ['Step 1 Subject', 'Step 2 Opened Subject', 'Step 3 NotOpened (via 2 opened) Subject'],
    P3: ['Step 1 Subject', 'Step 2 NotOpened Subject', 'Step 3 Opened (via 2 not opened) Subject'],
    P4: ['Step 1 Subject', 'Step 2 NotOpened Subject', 'Step 3 NotOpened (via 2 not opened) Subject'],
  }
  for (const p of ['P1', 'P2', 'P3', 'P4']) {
    const got = forRecipient(emails[p]).map(subjectOf)
    assert.deepEqual(got, expected[p], `${p} received exactly the right branch chain`)
    const enrollment = await getEnrollment(contacts[p].id)
    assert.equal(enrollment.status, 'completed', `${p} completed after its leaf`)
    assert.equal(enrollment.next_run_at, null, `${p} next_run_at NULL on completion`)
  }
  ok('ALL FOUR PATHS continued automatically: Opened→Opened, Opened→NotOpened, NotOpened→Opened, NotOpened→NotOpened')

  // ── Step Progress: Eligible/Sent/Status reflect the actual recipient path ──
  console.log('\n── Step Progress ──')
  {
    const detail = await sequenceService.getSequence(sequenceId)
    assert.equal(detail.summary.completed, 4, 'summary: 4 completed')
    assert.equal(detail.summary.in_progress, 0, 'summary: 0 in progress')
    const byId = Object.fromEntries(detail.steps_progress.map((row) => [row.step.id, row]))
    const expect = {
      [root.id]: { eligible: 4, sent: 4, opened: 2, status: 'completed', path: 'STARTING' },
      [step2Opened.id]: { eligible: 2, sent: 2, opened: 1, status: 'completed', path: 'OPENED' },
      [step2NotOpened.id]: { eligible: 2, sent: 2, opened: 1, status: 'completed', path: 'NOT_OPENED' },
      [step3OpenedFromOpened.id]: { eligible: 1, sent: 1, opened: 0, status: 'completed', path: 'OPENED' },
      [step3NotOpenedFromOpened.id]: { eligible: 1, sent: 1, opened: 0, status: 'completed', path: 'NOT_OPENED' },
      [step3OpenedFromNotOpened.id]: { eligible: 1, sent: 1, opened: 0, status: 'completed', path: 'OPENED' },
      [step3NotOpenedFromNotOpened.id]: { eligible: 1, sent: 1, opened: 0, status: 'completed', path: 'NOT_OPENED' },
    }
    for (const [stepId, exp] of Object.entries(expect)) {
      const row = byId[stepId]
      assert.ok(row, `progress row exists for ${stepId}`)
      assert.equal(row.eligible, exp.eligible, `${stepId} eligible`)
      assert.equal(row.sent, exp.sent, `${stepId} sent`)
      assert.equal(row.opened, exp.opened, `${stepId} opened`)
      assert.equal(row.status, exp.status, `${stepId} status`)
      assert.equal(row.path, exp.path, `${stepId} path`)
    }
    ok('Step Progress: Eligible/Sent/Opened/Status computed from the real per-recipient branch path')
  }

  console.log(`\n✅ ALL ${passed} CHECKS PASSED — full branching acceptance OK`)
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
    for (const p of ['P1', 'P2', 'P3', 'P4']) {
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
