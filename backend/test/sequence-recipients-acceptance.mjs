/**
 * Sequence branch-tree recipients + manual send acceptance test (integration).
 *
 * Validates the recursive branch-tree model against a LIVE Supabase instance
 * and a STUB SMTP server (127.0.0.1:2525) — no real email is ever sent.
 *
 * Branching model under test:
 *   - Step 1 (the STARTING node) is sent to EVERY enrolled recipient.
 *   - Each step branches OPENED / NOT OPENED off the parent node's email
 *     tracking (sequence_step_logs + email_logs): the 'opened' child is due
 *     immediately after a real open, the 'not_opened' child is due after ITS
 *     OWN wait_hours and only sends while the parent email stays unopened.
 *   - BOTH branches ALWAYS send their configured next email. A node with no
 *     children ends its branch.
 *   - The recipients UI + manual send use the SAME central eligibility
 *     (getBranchEligibility) as the worker: per-node recipient lists are exact,
 *     and manual sends re-validate every recipient before sending.
 *
 * Scenario (spec): 6 enrolled contacts A–F. Step 1 sent to all; A, B and E
 * open it (3) and C, D, F do not (3).
 *   Step 2 ('opened' child) -> eligible exactly A, B, E -> sent to them.
 *   Step 3 ('not_opened' child) -> eligible exactly C, D, F -> sent after the
 *   wait. No recipient receives both branches; all complete.
 *
 * Run:  node test/sequence-recipients-acceptance.mjs   (from backend/)
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
const delivered = [] // { to, data }

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

async function waitFor(description, predicate, timeoutMs = 30_000) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${description}`)
    }
    await sleep(200)
  }
}

let smtpServer
let client
let supabaseService
let sequenceService
let checkDueEnrollments
let handleStepOpened

const RUN_ID = `seqr_${Date.now()}`
const SEGMENT = `SeqRTest-${RUN_ID}`
// NOTE: not @example.com — the canonical resolver skips RFC 2606 test
// addresses, so these use a deliverable-looking domain.
const emails = Array.from({ length: 6 }, (_, i) => `seqr.${String.fromCharCode(97 + i)}.${RUN_ID}@example.co`)

let contacts = [] // [A..F]
let campaignOf = {} // sequenceId -> dedicated campaign id

async function makeDueForSequence(sequenceId) {
  const now = new Date().toISOString()
  await client
    .from('sequence_enrollments')
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString(), updated_at: now })
    .eq('sequence_id', sequenceId)
    .eq('status', 'active')
}

async function completedCount(sequenceId) {
  const { count, error } = await client
    .from('sequence_enrollments')
    .select('id', { count: 'exact', head: true })
    .eq('sequence_id', sequenceId)
    .eq('status', 'completed')
  if (error) throw error
  return count
}

async function stepLogCount(sequenceId) {
  const { count, error } = await client
    .from('sequence_step_logs')
    .select('id', { count: 'exact', head: true })
    .eq('sequence_id', sequenceId)
  if (error) throw error
  return count
}

/**
 * Drive the worker tick until the stub SMTP has delivered at least `target`
 * emails AND that many step logs are durable (the worker writes the step log
 * right after the SMTP send, so SMTP delivery alone races with downstream
 * reads like openStepEmail). Keeps re-arming the enrollments AND re-invoking
 * checkDueEnrollments so a tick swallowed by the worker's in-process
 * `_checking` lock (activation fire-and-forget race) is simply retried on the
 * next poll.
 */
async function driveUntil(description, target, sequenceId, timeoutMs = 30_000) {
  return waitFor(description, async () => {
    await makeDueForSequence(sequenceId)
    await checkDueEnrollments([sequenceId])
    return smtpCount() >= target && (await stepLogCount(sequenceId)) >= target
  }, timeoutMs)
}

/** Drive ticks until every enrollment of the sequence has completed. */
async function driveUntilCompleted(description, sequenceId, timeoutMs = 30_000) {
  return waitFor(description, async () => {
    await makeDueForSequence(sequenceId)
    await checkDueEnrollments([sequenceId])
    return (await completedCount(sequenceId)) >= 6
  }, timeoutMs)
}

/** Backdate a step's sent time so wait_hours-based gates elapse on the next tick. */
async function backdateStepSent(sequenceId, contactId, stepNode, hoursAgo) {
  const at = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString()
  const { data: stepLog } = await client
    .from('sequence_step_logs')
    .update({ sent_at: at })
    .eq('sequence_id', sequenceId)
    .eq('sequence_step_id', stepNode.id)
    .eq('contact_id', contactId)
    .select('email_log_id')
    .single()
  if (stepLog && stepLog.email_log_id) {
    await client
      .from('email_logs')
      .update({ sent_at: at })
      .eq('id', stepLog.email_log_id)
  }
}

async function getEnrollments(sequenceId) {
  const { data, error } = await client
    .from('sequence_enrollments')
    .select('*')
    .eq('sequence_id', sequenceId)
  if (error) throw error
  return data || []
}

async function getStepLog(sequenceId, contactId, stepNode) {
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

async function openStepEmail(sequenceId, contact, stepNode) {
  const stepLog = await getStepLog(sequenceId, contact.id, stepNode)
  assert.ok(stepLog && stepLog.email_log_id, `${contact.email} has a step-${stepNode.step_number} log to open`)
  await client
    .from('email_logs')
    .update({ opened: true, opened_at: new Date().toISOString() })
    .eq('id', stepLog.email_log_id)
  const result = await handleStepOpened({ id: stepLog.email_log_id, contact_id: contact.id })
  return { stepLog, result }
}

async function createSeq(extra = {}) {
  return sequenceService.createSequence({
    name: `__seqr_test__${RUN_ID}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    audience_segment: SEGMENT,
    trigger_type: 'behaviour',
    recipient_type: 'all',
    send_mode: 'both',
    ...extra,
  })
}

/** The spec scenario steps: Step 1 + Step 2 (opened) + Step 3 (not opened). */
async function addBranchSteps(sequenceId) {
  const step1 = await sequenceService.createStep(sequenceId, {
    step_number: 1,
    normal_subject: 'Step 1: Hello',
    normal_body: 'Step 1 body',
    wait_hours: 0,
  })
  const step2 = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: step1.id,
    parent_branch: 'opened',
    normal_subject: 'Step 2: Opened path',
    normal_body: 'Step 2 opened body',
    wait_hours: 0,
  })
  const step3 = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: step1.id,
    parent_branch: 'not_opened',
    normal_subject: 'Step 3 fallback',
    normal_body: 'Step 3 fallback body',
    increment_subject: 'Step 3: Did not open',
    increment_body: 'Step 3 not-opened body',
    wait_hours: 24,
  })
  return [step1, step2, step3]
}

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  smtpServer = await startSmtpServer()
  console.log('[Test] Stub SMTP listening on 127.0.0.1:2525')

  supabaseService = await import('../services/supabaseService.js')
  sequenceService = await import('../services/sequenceService.js')
  ;({ checkDueEnrollments, handleStepOpened } = await import('../workers/sequenceWorker.js'))
  client = supabaseService.supabase

  // 1. 6 contacts (no starting campaign — the sequence sends its own Step 1).
  for (let i = 0; i < 6; i++) {
    const { data, error } = await client.from('contacts').insert({
      full_name: `SeqR Contact ${i + 1}`,
      email: emails[i],
      company: 'SeqRCo',
      designation: 'Tester',
      contact_type: SEGMENT,
    }).select('*').single()
    if (error) throw error
    contacts.push(data)
  }

  // ── Case 1: starting-node resolution + manual sequences are never auto-sent ──
  console.log('\n── CASE 1: starting node resolves all 6; manual sequences are not auto-sent ──')
  let sManualResolve
  {
    const s = await createSeq({ send_mode: 'manual' })
    sManualResolve = s.id
    await sequenceService.createStep(s.id, {
      step_number: 1,
      normal_subject: 'Manual Step 1',
      normal_body: 'Manual Step 1 body',
      wait_hours: 0,
    })
    const activated = await sequenceService.activateSequence(s.id)
    assert.equal(activated.enrolled_count, 6, 'activation enrolled all 6')

    const resolved = await sequenceService.resolveSequenceRecipients(s.id)
    assert.equal(resolved.recipients.length, 6, 'starting node resolves to all 6 enrolled')
    assert.ok(resolved.recipients.every((e) => e.contacts), 'every recipient row carries its contact')

    const listed = await sequenceService.listSequenceRecipients(s.id)
    assert.equal(listed.recipients.length, 6, 'starting-node recipients list = 6')
    assert.ok(listed.recipients.every((r) => r.status === 'eligible'), 'all 6 marked eligible')
    assert.deepEqual(listed.sequence.engagement, { all: 0, opened: 0, not_opened: 0 }, 'no sequence emails sent yet')

    // Worker must skip manual sequences entirely — nothing is auto-sent.
    await makeDueForSequence(s.id)
    await checkDueEnrollments([s.id])
    assert.equal(smtpCount(), 0, 'worker sent NOTHING for a manual sequence')
    ok('starting node → 6 eligible; worker never auto-sends manual sequences')
  }

  // ── Case 2: automatic branch tree (the spec scenario) ──
  console.log('\n── CASE 2: automatic — A,B,E open Step 1 → Step 2; C,D,F → Step 3 after wait ──')
  let sAutoId
  {
    const s = await createSeq({ send_mode: 'automatic' })
    sAutoId = s.id
    const [step1, step2, step3] = await addBranchSteps(s.id)

    // Activation enrolls all 6 on the STARTING node (due now). Drive tick 1
    // explicitly — the activation fire-and-forget is a racing convenience, not
    // something a test can rely on.
    const activated = await sequenceService.activateSequence(s.id)
    assert.equal(activated.enrolled_count, 6, 'activation enrolled all 6')
    await driveUntil('step 1 sent to all 6', 6, s.id)
    assert.equal(smtpCount(), 6, 'tick 1 sent exactly 6 step-1 emails')
    for (const contact of contacts) {
      assert.equal(subjectOf(forRecipient(contact.email)[0]), 'Step 1: Hello', `${contact.email} got Step 1`)
    }
    ok('tick 1: Step 1 (STARTING) sent to all 6 immediately')

    // A, B and E open Step 1 → handleStepOpened re-routes them to Step 2.
    for (const contact of [contacts[0], contacts[1], contacts[4]]) {
      const { result } = await openStepEmail(s.id, contact, step1)
      assert.ok(result && result.id === step2.id, `${contact.email} re-routed to the opened child`)
    }
    ok('3 recipients (A, B, E) opened Step 1 and were re-routed to Step 2')

    // Per-node recipient resolution uses the CENTRAL eligibility.
    {
      const r2 = await sequenceService.resolveSequenceRecipients(s.id, step2.id)
      const r2emails = r2.recipients.map((e) => e.contacts.email).sort()
      assert.deepEqual(r2emails, [emails[0], emails[1], emails[4]].sort(), 'Step 2 eligible = exactly A, B, E')
      const r3 = await sequenceService.resolveSequenceRecipients(s.id, step3.id)
      const r3emails = r3.recipients.map((e) => e.contacts.email).sort()
      assert.deepEqual(r3emails, [emails[2], emails[3], emails[5]].sort(), 'Step 3 eligible = exactly C, D, F')

      const listed2 = await sequenceService.listSequenceRecipients(s.id, step2.id)
      const byEmail2 = Object.fromEntries(listed2.recipients.map((r) => [r.contact.email, r.status]))
      assert.equal(byEmail2[emails[0]], 'eligible')
      assert.equal(byEmail2[emails[1]], 'eligible')
      assert.equal(byEmail2[emails[4]], 'eligible')
      assert.equal(byEmail2[emails[2]], 'not_opened')
      assert.equal(byEmail2[emails[3]], 'not_opened')
      assert.equal(byEmail2[emails[5]], 'not_opened')
      ok('per-node recipients: Step 2 → A,B,E (3); Step 3 → C,D,F (3) — same central logic as the worker')
    }

    // Step 2 (opened child) is due now → sent to A, B, E.
    await driveUntil('step 2 sent to A, B, E', 9, s.id)
    assert.equal(smtpCount(), 9, 'tick 2 sent exactly 3 step-2 emails')
    for (const contact of [contacts[0], contacts[1], contacts[4]]) {
      const msgs = forRecipient(contact.email)
      assert.equal(msgs.length, 2, `${contact.email} got Step 1 + Step 2`)
      assert.equal(subjectOf(msgs[1]), 'Step 2: Opened path', `${contact.email} Step 2 = opened-child content`)
    }
    ok('tick 2: Step 2 (opened) sent to A, B, E only')

    // Step 3 (not_opened child) is not due yet — the wait gate must hold.
    await makeDueForSequence(s.id)
    await checkDueEnrollments([s.id])
    {
      const cMsgs = forRecipient(emails[2])
      assert.equal(cMsgs.length, 1, 'C still has ONLY Step 1 (wait gate held)')
      const enrollments = await getEnrollments(s.id)
      const enr = (id) => enrollments.find((e) => e.contact_id === id)
      assert.equal(enr(contacts[2].id).current_step_id, step3.id, 'C still waiting on Step 3')
    }

    // Step 3 (not_opened child) sends after its wait_hours → C, D, F. The wait
    // is computed from the parent sent_at + wait_hours, so backdate Step 1's
    // sent time past the 24h window (the ONLY thing that changes) and re-tick.
    for (const contact of [contacts[2], contacts[3], contacts[5]]) {
      await backdateStepSent(s.id, contact.id, step1, 25)
    }
    await driveUntil('step 3 sent to C, D, F', 12, s.id)
    assert.equal(smtpCount(), 12, 'tick 3 sent exactly 3 step-3 emails')
    for (const contact of [contacts[2], contacts[3], contacts[5]]) {
      const msgs = forRecipient(contact.email)
      assert.equal(msgs.length, 2, `${contact.email} got Step 1 + Step 3`)
      assert.equal(subjectOf(msgs[1]), 'Step 3: Did not open', `${contact.email} Step 3 = not-opened content`)
    }
    ok('tick 3: Step 3 (not opened) sent to C, D, F after their wait')

    // Per-branch content + leaf completion semantics: Step 2 is a leaf with
    // wait_hours=0 so A/B/E complete immediately; Step 3 is a leaf with
    // wait_hours=24 so C/D/F enter its final grace wait (still active) until
    // that wait elapses. Nobody receives both branches.
    {
      const enrollments = await getEnrollments(s.id)
      assert.equal(enrollments.length, 6, '6 enrollments')
      const statusOf = (contactId) => enrollments.find((e) => e.contact_id === contactId).status
      for (const contact of [contacts[0], contacts[1], contacts[4]]) {
        assert.equal(statusOf(contact.id), 'completed', `${contact.email} completed after Step 2 leaf (wait 0)`)
      }
      for (const contact of [contacts[2], contacts[3], contacts[5]]) {
        assert.equal(statusOf(contact.id), 'active', `${contact.email} in final grace wait after Step 3 leaf (wait 24h)`)
      }
      const finalCounts = {}
      for (const contact of contacts) {
        finalCounts[contact.email] = forRecipient(contact.email).map(subjectOf)
      }
      for (const email of [emails[0], emails[1], emails[4]]) {
        assert.deepEqual(finalCounts[email], ['Step 1: Hello', 'Step 2: Opened path'], `${email}: Step 1 + Step 2 only`)
      }
      for (const email of [emails[2], emails[3], emails[5]]) {
        assert.deepEqual(finalCounts[email], ['Step 1: Hello', 'Step 3: Did not open'], `${email}: Step 1 + Step 3 only`)
      }
      ok('post-send: Step 2 leaf completed A/B/E; Step 3 leaf holds C/D/F in its wait — nobody got both branches')
    }

    // Elapse the Step 3 leaf wait (backdate its sent_at 25h) → C/D/F complete.
    for (const contact of [contacts[2], contacts[3], contacts[5]]) {
      await backdateStepSent(s.id, contact.id, step3, 25)
    }
    await driveUntilCompleted('C, D, F complete after Step 3 leaf wait elapses', s.id)

    // Final state: all completed, no recipient received both branches.
    {
      const enrollments = await getEnrollments(s.id)
      assert.equal(enrollments.length, 6, '6 enrollments')
      for (const e of enrollments) {
        assert.equal(e.status, 'completed', `enrollment ${e.contact_id} completed`)
        assert.equal(e.next_run_at, null, `enrollment ${e.contact_id} next_run_at NULL`)
      }
      assert.equal(smtpCount(), 12, 'completion sent no extra emails (12 total)')
      ok('final: all 6 completed; Step 3 leaf wait ended without resending')

      // handleStepOpened is idempotent — replaying an open changes nothing.
      const aLog = await getStepLog(s.id, contacts[0].id, step1)
      const replay = await handleStepOpened({ id: aLog.email_log_id, contact_id: contacts[0].id })
      assert.equal(replay, null, 'replayed open returns null (already advanced)')
      ok('handleStepOpened is idempotent (no-op on completed recipients)')
    }

    // Sequence overview: per-node progress + engagement from real tracking.
    {
      const detail = await sequenceService.getSequence(s.id)
      assert.deepEqual(detail.summary, {
        total_eligible: 6,
        total: 6,
        in_progress: 0,
        completed: 6,
        pending: 0,
        failed: 0,
      })
      assert.deepEqual(detail.engagement, { all: 6, opened: 3, not_opened: 3 }, '3 opened (A,B,E), 3 not (C,D,F)')
      const progressById = Object.fromEntries(detail.steps_progress.map((row) => [row.step.id, row]))
      const p1 = progressById[step1.id]
      const p2 = progressById[step2.id]
      const p3 = progressById[step3.id]
      assert.equal(p1.path, 'STARTING')
      assert.equal(p1.sent, 6)
      assert.equal(p1.eligible, 6)
      assert.equal(p1.opened, 3)
      assert.equal(p1.status, 'completed')
      assert.equal(p2.path, 'OPENED')
      assert.equal(p2.sent, 3)
      assert.equal(p2.eligible, 3)
      assert.equal(p2.status, 'completed')
      assert.equal(p3.path, 'NOT_OPENED')
      assert.equal(p3.sent, 3)
      assert.equal(p3.eligible, 3)
      assert.equal(p3.wait_label, '24h')
      assert.equal(p3.status, 'completed')
      assert.deepEqual(p2.next, [], 'Step 2 has no children')
      assert.deepEqual(p3.next, [], 'Step 3 has no children')
      ok('getSequence: per-node progress (Step 1: 6/6, Step 2: 3/3, Step 3: 3/3) + engagement')
    }

    // Isolation: dedicated hidden campaign, reused for every step.
    {
      const { data: seqRow } = await client
        .from('sequences')
        .select('campaign_id')
        .eq('id', s.id)
        .single()
      assert.ok(seqRow && seqRow.campaign_id, 'sequence got a dedicated campaign')
      campaignOf[s.id] = seqRow.campaign_id
      const { data: seqCampaign } = await client
        .from('campaigns')
        .select('id, campaign_type')
        .eq('id', seqRow.campaign_id)
        .single()
      assert.equal(seqCampaign.campaign_type, 'sequence', 'dedicated campaign is campaign_type=sequence')
      const { data: logCount } = await client
        .from('email_logs')
        .select('id')
        .eq('campaign_id', seqRow.campaign_id)
      assert.equal(logCount.length, 12, 'all 12 step emails logged under the DEDICATED campaign')
      const listed = await supabaseService.listCampaigns()
      assert.ok(!listed.some((c) => c.id === seqRow.campaign_id), 'sequence campaign hidden from listCampaigns')
      ok('isolation: all sequence emails use the hidden dedicated campaign (campaign_type=sequence)')
    }
  }

  // ── Case 3: manual send is branch-gated and re-validated per recipient ──
  console.log('\n── CASE 3: manual send — per-recipient branch validation ──')
  let sManualId
  let mStep1
  let mStep2
  let mStep3
  {
    const s = await createSeq({ send_mode: 'manual' })
    sManualId = s.id
    ;[mStep1, mStep2, mStep3] = await addBranchSteps(s.id)
    const activated = await sequenceService.activateSequence(s.id)
    assert.equal(activated.enrolled_count, 6, 'manual sequence still enrolls its 6 recipients')

    // Worker never auto-sends a manual sequence.
    await makeDueForSequence(s.id)
    await checkDueEnrollments([s.id])
    assert.equal(smtpCount(), 12, 'nothing auto-sent for the manual sequence')

    // Manual send of the STARTING node to A and C → both sent (no parent gate).
    const r1 = await sequenceService.manualSendSequence(s.id, {
      step_id: mStep1.id,
      contact_ids: [contacts[0].id, contacts[2].id],
    })
    assert.equal(r1.sent, 2, 'manual Step 1 sent to A and C')
    assert.equal(r1.skipped, 0)
    assert.ok(r1.results.every((r) => r.status === 'sent' && r.email_type === 'normal'), 'both results sent as normal')
    assert.equal(smtpCount(), 14, 'manual send added 2 emails')
    ok('manual: STARTING node sends to any enrolled recipient (no parent gate)')

    // A opens Step 1 → moved to Step 2 (opened child).
    await openStepEmail(s.id, contacts[0], mStep1)

    // Manual send of Step 2 to A → opened branch eligible → sent immediately.
    const r2 = await sequenceService.manualSendSequence(s.id, {
      step_id: mStep2.id,
      contact_ids: [contacts[0].id],
    })
    assert.equal(r2.sent, 1, 'manual Step 2 sent to A')
    assert.equal(r2.results[0].status, 'sent')
    assert.equal(r2.results[0].email_type, 'normal')
    assert.equal(smtpCount(), 15, 'manual Step 2 added 1 email')

    // Manual send of Step 2 to C → NOT opened → ineligible, nothing sent.
    const r3 = await sequenceService.manualSendSequence(s.id, {
      step_id: mStep2.id,
      contact_ids: [contacts[2].id],
    })
    assert.equal(r3.sent, 0, 'C is NOT eligible for the opened branch')
    assert.equal(r3.skipped, 1)
    assert.equal(r3.results[0].status, 'ineligible')
    const cEmailsBeforeR3 = forRecipient(emails[2]).length
    assert.ok(!forRecipient(emails[2]).map(subjectOf).includes('Step 2: Opened path'), 'C received no Step-2 (opened) email')
    assert.equal(forRecipient(emails[2]).length, cEmailsBeforeR3, 'C unchanged by the ineligible Step-2 attempt')
    assert.equal(smtpCount(), 15, 'no email sent for the ineligible Step-2 attempt')

    // Manual send of Step 3 to C → not-opened branch eligible → sent (INCREMENT content).
    const r4 = await sequenceService.manualSendSequence(s.id, {
      step_id: mStep3.id,
      contact_ids: [contacts[2].id],
    })
    assert.equal(r4.sent, 1, 'manual Step 3 sent to C')
    assert.equal(r4.results[0].email_type, 'increment', 'not-opened node sends its INCREMENT content')
    assert.equal(subjectOf(forRecipient(emails[2]).at(-1)), 'Step 3: Did not open', 'C Step 3 = not-opened content')
    assert.equal(smtpCount(), 16, 'manual Step 3 added 1 email')

    // Duplicate of an already-sent node is blocked.
    const r5 = await sequenceService.manualSendSequence(s.id, {
      step_id: mStep1.id,
      contact_ids: [contacts[0].id],
    })
    assert.equal(r5.sent, 0, 'duplicate Step 1 is NOT sent again')
    assert.equal(r5.skipped, 1)
    assert.equal(r5.results[0].status, 'already_sent')
    const aEmailsBeforeR5 = forRecipient(emails[0]).length
    assert.equal(forRecipient(emails[0]).length, aEmailsBeforeR5, 'A unchanged by the blocked duplicate')
    const aSubjects = forRecipient(emails[0]).map(subjectOf)
    assert.equal(aSubjects.filter((s) => s === 'Step 1: Hello').length, 2, 'A has Step 1 from Case 2 + manual send')
    assert.equal(aSubjects.filter((s) => s === 'Step 2: Opened path').length, 2, 'A has Step 2 from Case 2 + manual send')
    assert.ok(!aSubjects.includes('Step 3 fallback') && !aSubjects.includes('Step 3: Did not open'), 'A received no Step-3 email')

    // Manual send of Step 3 to A → A opened Step 1 → ineligible for not_opened branch.
    const r6 = await sequenceService.manualSendSequence(s.id, {
      step_id: mStep3.id,
      contact_ids: [contacts[0].id],
    })
    assert.equal(r6.sent, 0, 'A is not eligible for the not-opened branch')
    assert.equal(r6.results[0].status, 'ineligible')
    assert.equal(smtpCount(), 16, 'no email for the ineligible Step-3 attempt')

    // Manual send also branches the enrollment forward (A completed on Step 2).
    const enrollments = await getEnrollments(s.id)
    const enr = (id) => enrollments.find((e) => e.contact_id === id)
    assert.equal(enr(contacts[0].id).status, 'completed', 'A completed after Step 2 (no children)')
    assert.equal(enr(contacts[2].id).status, 'active', 'C waits out Step 3 leaf (wait > 0) after the manual send')
    assert.equal(enr(contacts[2].id).current_step_id, mStep3.id, 'C sits on the Step 3 leaf after the manual send')
    ok('manual: sent A→Step 2 (opened), C→Step 3 (not opened); duplicates + wrong-branch sends blocked; enrollments advanced')
  }

  // ── Case 4: defaults + validation (branch-tree step API) ──
  console.log('\n── CASE 4: defaults + enum + branch-tree step validation ──')
  {
    const s = await createSeq({})
    assert.equal(s.recipient_type, 'all', 'recipient_type defaults to all')
    assert.equal(s.send_mode, 'both', 'send_mode defaults to both')

    await assert.rejects(
      createSeq({ recipient_type: 'bogus' }),
      /recipient_type/,
      'invalid recipient_type rejected'
    )
    await assert.rejects(
      createSeq({ send_mode: 'bogus' }),
      /send_mode/,
      'invalid send_mode rejected'
    )
    await assert.rejects(
      sequenceService.updateSequence(s.id, { recipient_type: 'bogus' }),
      /recipient_type/,
      'invalid recipient_type rejected on update'
    )
    await assert.rejects(
      sequenceService.updateSequence(s.id, { send_mode: 'bogus' }),
      /send_mode/,
      'invalid send_mode rejected on update'
    )
    ok('defaults: recipient_type=all, send_mode=both; invalid enums rejected on create + update')

    // Step parenting validation.
    const st1 = await sequenceService.createStep(s.id, {
      step_number: 1,
      normal_subject: 'S1',
      normal_body: 'S1 body',
      wait_hours: 0,
    })
    await assert.rejects(
      sequenceService.createStep(s.id, {
        step_number: 2,
        normal_subject: 'S2',
        normal_body: 'S2 body',
        parent_step_id: st1.id,
        wait_hours: 0,
      }),
      /parent_branch must be OPENED or NOT_OPENED/,
      'parent_step_id without parent_branch rejected'
    )
    await assert.rejects(
      sequenceService.createStep(s.id, {
        step_number: 2,
        normal_subject: 'S2',
        normal_body: 'S2 body',
        parent_branch: 'opened',
        wait_hours: 0,
      }),
      /parent_step_id is required/,
      'parent_branch without parent_step_id rejected'
    )
    const st2 = await sequenceService.createStep(s.id, {
      step_number: 2,
      parent_step_id: st1.id,
      parent_branch: 'opened',
      normal_subject: 'S2 opened',
      normal_body: 'S2 opened body',
      wait_hours: 0,
    })
    await assert.rejects(
      sequenceService.createStep(s.id, {
        step_number: 2,
        parent_step_id: st1.id,
        parent_branch: 'opened',
        normal_subject: 'S2 dup',
        normal_body: 'S2 dup body',
        wait_hours: 0,
      }),
      /already exists for this parent step/,
      'a second child on the same parent + branch rejected'
    )
    await assert.rejects(
      sequenceService.updateStep(s.id, st2.id, { parent_step_id: st2.id, parent_branch: 'opened' }),
      /own parent/,
      'a step cannot be its own parent'
    )
    const otherSeq = await createSeq({})
    const otherStep = await sequenceService.createStep(otherSeq.id, {
      step_number: 1,
      normal_subject: 'Other',
      normal_body: 'Other body',
      wait_hours: 0,
    })
    await assert.rejects(
      sequenceService.createStep(s.id, {
        step_number: 2,
        parent_step_id: otherStep.id,
        parent_branch: 'opened',
        normal_subject: 'Cross',
        normal_body: 'Cross body',
        wait_hours: 0,
      }),
      /Parent step does not exist in this sequence/,
      'cross-sequence parent rejected'
    )
    const noStepSeq = await createSeq({})
    await assert.rejects(
      sequenceService.activateSequence(noStepSeq.id),
      /at least one step/,
      'activation without steps rejected'
    )
    ok('step API: parent/branch required together, one child per branch, no self/cross parents, activation needs a step')
  }

  console.log(`\n✅ ALL ${passed} CHECKS PASSED — step-branching recipients + manual acceptance OK`)
}

// ─── Cleanup ──────────────────────────────────────────────────────────────
async function cleanup() {
  try {
    const { data: seqRows } = await client
      .from('sequences')
      .select('id, campaign_id')
      .like('name', `__seqr_test__${RUN_ID}%`)
    for (const row of seqRows || []) {
      const cid = campaignOf[row.id] || row.campaign_id
      if (cid) await client.from('email_logs').delete().eq('campaign_id', cid)
      await client.from('sequence_enrollments').delete().eq('sequence_id', row.id)
      await client.from('sequence_step_logs').delete().eq('sequence_id', row.id)
      await client.from('sequences').delete().eq('id', row.id)
      if (cid) await client.from('campaigns').delete().eq('id', cid)
    }
    for (const contact of contacts) {
      if (contact) await client.from('contacts').delete().eq('id', contact.id)
    }
  } catch (error) {
    console.error('[Test] Cleanup failed (non-fatal):', error.message)
  }
  if (smtpServer) smtpServer.close()
}

main()
  .catch((error) => {
    console.error('\n✗ TEST FAILED:', error.message)
    process.exitCode = 1
  })
  .finally(cleanup)
