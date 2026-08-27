/**
 * Sequence RESUME acceptance test — the "children added AFTER the parent
 * branch already completed" scenario.
 *
 * The automatic worker used to strand a branch forever when a Step N node had
 * NO children at the time its email was sent: the enrollment completed as a
 * wait-0 leaf, then when Step N+1 (OPENED / NOT_OPENED) was added later the
 * completed enrollment could never resume (getDueEnrollments only scans ACTIVE
 * rows and completed rows have next_run_at = NULL).
 *
 * This test reproduces that exact path and verifies the fix:
 *   1. Step 1 (wait 0, no children) sends → enrollments COMPLETE as a leaf.
 *   2. Step 2 OPENED + NOT_OPENED are added AFTER the fact.
 *   3. resumeCompletedEnrollments() revives ONLY the stranded completions.
 *   4. checkDueEnrollments() then sends Step 2 to every recipient in the SAME
 *      tick (wait_hours = 0 → the chain continues immediately), to the correct
 *      branch content (2 opened / 2 not-opened), and the branches complete.
 *
 * Run:  node test/sequence-resume-acceptance.mjs   (from backend/)
 */
import 'dotenv/config'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'

// ─── Override SMTP + worker pacing to the stub BEFORE any module loads ─────
process.env.EMAIL_HOST = '127.0.0.1'
process.env.EMAIL_PORT = '2526'
process.env.EMAIL_SECURE = 'false'
process.env.EMAIL_USER = 'stub@example.co'
process.env.EMAIL_PASSWORD = 'stub'
process.env.EMAIL_FROM = 'Test Sender <test@example.com>'
process.env.TRACKING_BASE_URL = 'http://tracking.test'
process.env.SEQUENCE_SEND_DELAY_MS = '0'
process.env.SEQUENCE_BATCH_SIZE = '100'

// ─── Stub SMTP server (captures full message DATA per recipient) ──────────
const SMTP_PORT = 2526
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

let smtpServer
let client
let sequenceService
let processDueEnrollment
let resumeCompletedEnrollments
let checkDueEnrollments

const RUN_ID = `seqres_${Date.now()}`
const SEGMENT = `SeqResumeTest-${RUN_ID}`
const emails = {
  P1: `seqres.P1.${RUN_ID}@example.co`,
  P2: `seqres.P2.${RUN_ID}@example.co`,
  P3: `seqres.P3.${RUN_ID}@example.co`,
  P4: `seqres.P4.${RUN_ID}@example.co`,
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
    full_name: 'Resume Test Contact',
    company: 'Resume Test Co',
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

async function simulateOpen(contactId, stepNode) {
  const stepLog = await getStepLog(contactId, stepNode)
  assert.ok(stepLog && stepLog.email_log_id, `${contactId} has a Step 1 email log to mark opened`)
  const { error } = await client
    .from('email_logs')
    .update({ opened: true, opened_at: new Date().toISOString() })
    .eq('id', stepLog.email_log_id)
  if (error) throw error
}

async function main() {
  smtpServer = await startSmtpServer()
  console.log('[Test] Stub SMTP listening on 127.0.0.1:2526')

  const supabaseService = await import('../services/supabaseService.js')
  sequenceService = await import('../services/sequenceService.js')
  ;({ processDueEnrollment, resumeCompletedEnrollments, checkDueEnrollments } = await import('../workers/sequenceWorker.js'))
  client = supabaseService.supabase

  // ── Contacts + sequence + Step 1 ONLY (no children yet) ──
  contacts.P1 = await insertContact(emails.P1)
  contacts.P2 = await insertContact(emails.P2)
  contacts.P3 = await insertContact(emails.P3)
  contacts.P4 = await insertContact(emails.P4)

  const seq = await sequenceService.createSequence({
    name: `__seq_resume__${RUN_ID}`,
    audience_segment: SEGMENT,
    trigger_type: 'behaviour',
    recipient_type: 'all',
    send_mode: 'both',
  })
  sequenceId = seq.id

  steps.root = await sequenceService.createStep(sequenceId, {
    step_number: 1,
    normal_subject: 'Step 1 Subject',
    normal_body: 'Step 1 BODY',
    wait_hours: 0,
  })

  const now = new Date().toISOString()
  for (const p of ['P1', 'P2', 'P3', 'P4']) {
    const { error } = await client.from('sequence_enrollments').insert({
      sequence_id: sequenceId,
      contact_id: contacts[p].id,
      current_step_id: steps.root.id,
      current_step: 1,
      current_email_type: 'normal',
      status: 'active',
      enrolled_at: now,
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
    })
    if (error) throw error
  }

  // ── Phase 1: Step 1 sends to all 4, then COMPLETES (wait-0 leaf, no children) ──
  console.log('\n── Phase 1: Step 1 (leaf, no children) → all 4 COMPLETE ──')
  for (const p of ['P1', 'P2', 'P3', 'P4']) await processEnrollment(contacts[p].id)
  assert.equal(smtpCount(), 4, 'exactly 4 emails after Step 1')
  for (const p of ['P1', 'P2', 'P3', 'P4']) {
    const enrollment = await getEnrollment(contacts[p].id)
    assert.equal(enrollment.status, 'completed', `${p} completed as a wait-0 leaf`)
    assert.equal(enrollment.next_run_at, null, `${p} next_run_at NULL on completion`)
  }
  {
    const { data: seqRow } = await client.from('sequences').select('campaign_id').eq('id', sequenceId).single()
    seqCampaignId = seqRow && seqRow.campaign_id
  }
  ok('Step 1 sent to all 4; every enrollment COMPLETED while Step 1 was a leaf')

  // ── Phase 2: children added AFTER completion (the stranded-branch bug) ──
  console.log('\n── Phase 2: Step 2 OPENED + NOT_OPENED added AFTER completion ──')
  steps.step2Opened = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: steps.root.id,
    parent_branch: 'OPENED',
    normal_subject: 'Step 2 Opened Subject',
    normal_body: 'Step 2 OPENED BODY',
    wait_hours: 0,
  })
  steps.step2NotOpened = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: steps.root.id,
    parent_branch: 'NOT_OPENED',
    increment_subject: 'Step 2 NotOpened Subject',
    increment_body: 'Step 2 NOT-OPENED BODY',
    wait_hours: 0,
  })

  // P1 + P2 opened Step 1; P3 + P4 did not.
  await simulateOpen(contacts.P1.id, steps.root)
  await simulateOpen(contacts.P2.id, steps.root)
  ok('Step 2 branches added after completion; P1/P2 marked as Step 1 openers')

  // ── Phase 3: resume + one automatic tick sends BOTH Step 2 branches ──
  console.log('\n── Phase 3: resumeCompletedEnrollments + checkDueEnrollments ──')
  // The sequence must be ACTIVE for the worker's resume scan (worker only
  // automates active sequences). Mark it active WITHOUT re-enrolling.
  {
    const { error } = await client.from('sequences').update({ status: 'active' }).eq('id', sequenceId)
    if (error) throw error
  }

  const revived = await resumeCompletedEnrollments([sequenceId])
  assert.equal(revived, 4, 'exactly the 4 stranded completions are revived')

  await checkDueEnrollments([sequenceId])
  assert.equal(smtpCount(), 8, 'Step 2 sent to all 4 in the same tick (wait-0 chain)')

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
  for (const p of ['P1', 'P2', 'P3', 'P4']) {
    const enrollment = await getEnrollment(contacts[p].id)
    assert.equal(enrollment.status, 'completed', `${p} completed again after its Step 2 leaf`)
  }
  ok('resume revived the 4 stranded enrollments; Step 2 auto-sent to BOTH branches in one tick')

  // ── Phase 4: idempotent — a second resume revives nothing ──
  console.log('\n── Phase 4: second resume is a no-op (no churn) ──')
  const revivedAgain = await resumeCompletedEnrollments([sequenceId])
  assert.equal(revivedAgain, 0, 'nothing left to revive after the chain completed')
  for (const p of ['P1', 'P2', 'P3', 'P4']) {
    const enrollment = await getEnrollment(contacts[p].id)
    assert.equal(enrollment.status, 'completed', `${p} stays completed (no churn)`)
  }
  ok('second resume is a no-op — completed leaves are never churned back to life')

  // ── Step Progress reflects the correct branch path ──
  console.log('\n── Step Progress ──')
  {
    const detail = await sequenceService.getSequence(sequenceId)
    assert.equal(detail.summary.completed, 4, 'summary: 4 completed')
    const byId = Object.fromEntries(detail.steps_progress.map((row) => [row.step.id, row]))
    const expect = {
      [steps.root.id]: { eligible: 4, sent: 4, opened: 2, status: 'completed', path: 'STARTING' },
      [steps.step2Opened.id]: { eligible: 2, sent: 2, opened: 0, status: 'completed', path: 'OPENED' },
      [steps.step2NotOpened.id]: { eligible: 2, sent: 2, opened: 0, status: 'completed', path: 'NOT_OPENED' },
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
    ok('Step Progress: children added after completion still show correct Eligible/Sent/Status')
  }

  console.log(`\n✅ ALL ${passed} CHECKS PASSED — resume-after-branch-add acceptance OK`)
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
