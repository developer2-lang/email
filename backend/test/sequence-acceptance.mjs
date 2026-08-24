/**
 * Sequence automation worker acceptance test (integration).
 *
 * Validates the recursive branch-tree worker against a LIVE Supabase instance
 * but a STUB SMTP server (127.0.0.1:2525) — no real email is ever sent.
 *
 * ISOLATION: the test sequence is kept as a DRAFT (never activated) and the
 * worker functions are driven DIRECTLY via processDueEnrollment — the exact
 * per-enrollment path the automatic worker runs (eligibility -> send ->
 * advance). The background worker only scans ACTIVE sequences, so a running
 * dev-server worker can never claim these enrollments or race the test.
 *
 * Branching model under test:
 *   - Step 1 (the STARTING node, parent_step_id IS NULL) is sent to EVERY
 *     enrolled recipient.
 *   - After a node's email is sent the recipient branches by whether they
 *     OPENED that email:
 *       opened     -> advances onto the node's 'opened' child; that child's
 *                     email is sent on the next due tick.
 *       not opened -> advances onto the node's 'not_opened' child; that
 *                     child's email is sent after ITS OWN wait_hours — but
 *                     ONLY IF the parent email is STILL not opened by then.
 *                     An open during the wait re-routes the recipient to the
 *                     parent's 'opened' child instead.
 *   - BOTH branches ALWAYS send their configured next email. NOT_OPENED never
 *     means STOP. A node with no children ends its branch ("completed").
 *   - handleStepOpened (hooked into the tracking service) advances the opened
 *     branch IMMEDIATELY on a real open, from both the opened step itself and
 *     its not_opened child.
 *
 * Scenario:
 *   Step 1 (starting) -> sent to A, B, C.
 *   Step 2 = Step 1's 'opened' child. Step 3 = Step 1's 'not_opened' child
 *   (wait_hours = 0 -> immediately due).
 *   1. Step 1 is sent to all 3; each advances onto Step 3 (nothing opened
 *      yet), due immediately.
 *   2. A and B open Step 1 -> handleStepOpened re-routes them to Step 2 ->
 *      Step 2's opened email is sent; Step 2 has no children, so A and B
 *      complete.
 *   3. C never opens -> Step 3 sends the not-opened email and C completes. No
 *      recipient received both branches of Step 1.
 *   4. Idle processing sends nothing (everyone completed).
 *   5. Duplicate / self-heal: D is enrolled on Step 1 with a Step-1 email
 *      ALREADY logged -> the worker advances WITHOUT resending, then sends
 *      Step 3 normally.
 *   6. All emails go to the sequence's DEDICATED hidden campaign
 *      (campaign_type='sequence'), hidden from listCampaigns.
 *   7. getSequence reports per-node progress + engagement from real tracking.
 *
 * Run:  node test/sequence-acceptance.mjs   (from backend/)
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
// Leaf nodes (no child steps) complete immediately in this test — auto-recovery
// is exercised by the branching acceptance test instead.
process.env.SEQUENCE_LEAF_RECHECK_HOURS = '0'

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
let processDueEnrollment
let handleStepOpened

const RUN_ID = `seq_${Date.now()}`
const SEGMENT = `SeqTest-${RUN_ID}`
// NOTE: not @example.com — the canonical resolver skips RFC 2606 test
// addresses, so these use a deliverable-looking domain.
const emailA = `seqtest.a.${RUN_ID}@example.co`
const emailB = `seqtest.b.${RUN_ID}@example.co`
const emailC = `seqtest.c.${RUN_ID}@example.co`
const emailD = `seqtest.d.${RUN_ID}@example.co`

let sequenceId
let seqCampaignId
let contactA
let contactB
let contactC
let contactD
let step1
let step2 // Step 1's 'opened' child
let step3 // Step 1's 'not_opened' child

async function insertContact(email, contactType = SEGMENT) {
  const { data, error } = await client.from('contacts').insert({
    email,
    full_name: 'Seq Test Contact',
    company: 'Seq Test Co',
    designation: 'Tester',
    contact_type: contactType,
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

/**
 * Drive ONE due enrollment through the worker's exact per-enrollment pipeline
 * (eligibility -> send -> advance). The sequence is a DRAFT so the shared
 * background worker never touches it — this call is the only driver.
 */
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

  return processDueEnrollment({
    ...enrollment,
    sequences: sequence,
    contacts: contact,
  })
}

/**
 * Simulate a real open on a contact's step-1 email: flip the email_log, then
 * invoke the SAME hook the tracking service calls (handleStepOpened).
 */
async function openStepEmail(contact, stepNode) {
  const stepLog = await getStepLog(contact.id, stepNode)
  assert.ok(stepLog && stepLog.email_log_id, `${contact.email} has a step-${stepNode.step_number} log to open`)
  await client
    .from('email_logs')
    .update({ opened: true, opened_at: new Date().toISOString() })
    .eq('id', stepLog.email_log_id)
  const result = await handleStepOpened({ id: stepLog.email_log_id, contact_id: contact.id })
  return { stepLog, result }
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
  ;({ processDueEnrollment, handleStepOpened } = await import('../workers/sequenceWorker.js'))
  client = supabaseService.supabase

  // 1. Contacts (no starting campaign — the sequence sends its own Step 1).
  contactA = await insertContact(emailA)
  contactB = await insertContact(emailB)
  contactC = await insertContact(emailC)
  contactD = await insertContact(emailD, `SeqTestOther-${RUN_ID}`)

  // 2. Sequence (DRAFT — isolated from the shared background worker) + steps.
  const seq = await sequenceService.createSequence({
    name: `__seq_test__${RUN_ID}`,
    audience_segment: SEGMENT,
    trigger_type: 'behaviour',
    recipient_type: 'all',
    send_mode: 'both',
  })
  sequenceId = seq.id
  step1 = await sequenceService.createStep(sequenceId, {
    step_number: 1,
    normal_subject: 'Step1 NORMAL Subject {{name}}',
    normal_body: 'Step1 NORMAL BODY for {{name}}',
    wait_hours: 0,
  })
  step2 = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: step1.id,
    parent_branch: 'opened',
    normal_subject: 'Step2 Opened Subject',
    normal_body: 'Step2 OPENED BODY',
    wait_hours: 0,
  })
  step3 = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: step1.id,
    parent_branch: 'not_opened',
    normal_subject: 'Step3 NORMAL fallback',
    normal_body: 'Step3 NORMAL fallback body',
    increment_subject: 'Step3 NotOpened Subject',
    increment_body: 'Step3 NOT-OPENED BODY',
    wait_hours: 0,
  })

  // 3. Enroll A, B, C on the STARTING node, due immediately (draft sequence —
  //    the worker is driven directly, exactly as the automatic tick would).
  const now = new Date().toISOString()
  for (const contact of [contactA, contactB, contactC]) {
    const { error } = await client.from('sequence_enrollments').insert({
      sequence_id: sequenceId,
      contact_id: contact.id,
      current_step_id: step1.id,
      current_step: 1,
      current_email_type: 'normal',
      status: 'active',
      enrolled_at: now,
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
    })
    if (error) throw error
  }

  // 4. Step 1 (STARTING node) is sent to every enrolled recipient immediately.
  console.log('\n── Step 1 sent to all 3 (STARTING node) ──')
  for (const contact of [contactA, contactB, contactC]) {
    await processEnrollment(contact.id)
  }
  assert.equal(smtpCount(), 3, 'Step 1 sent to exactly 3 recipients')
  ok('Step 1 (STARTING node) sent to all 3 enrolled recipients')

  {
    const aMsgs = forRecipient(emailA)
    const bMsgs = forRecipient(emailB)
    const cMsgs = forRecipient(emailC)
    for (const msgs of [aMsgs, bMsgs, cMsgs]) {
      assert.equal(msgs.length, 1, `${msgs[0] && msgs[0].to} got exactly 1 email`)
      assert.equal(subjectOf(msgs[0]), 'Step1 NORMAL Subject Seq Test Contact', 'step1 subject uses NORMAL variant + merge tags')
    }
    ok('step 1 content: NORMAL variant with {{name}} merge tag')

    // Everything advanced onto the NOT-OPENED child (nothing opened at send
    // time), due immediately (step3.wait_hours = 0).
    for (const contact of [contactA, contactB, contactC]) {
      const enrollment = await getEnrollment(contact.id)
      assert.equal(enrollment.current_step_id, step3.id, `${contact.email} advanced to the not_opened child (Step 3)`)
      assert.ok(
        enrollment.next_run_at && new Date(enrollment.next_run_at).getTime() <= Date.now(),
        `${contact.email} next_run_at due now (wait_hours=0, got ${enrollment.next_run_at})`,
      )
    }
    ok('state: all 3 advanced to Step 3 (not opened), due immediately (wait_hours=0)')

    // Dedicated hidden campaign created lazily on first send.
    const { data: seqRow } = await client
      .from('sequences')
      .select('campaign_id')
      .eq('id', sequenceId)
      .single()
    seqCampaignId = seqRow && seqRow.campaign_id
    assert.ok(seqCampaignId, 'sequence got a dedicated campaign after first send')
    const { data: seqCampaign } = await client
      .from('campaigns')
      .select('id, campaign_type')
      .eq('id', seqCampaignId)
      .single()
    assert.equal(seqCampaign.campaign_type, 'sequence', 'dedicated campaign is hidden campaign_type=sequence')
    ok('sequence emails use a dedicated hidden campaign (campaign_type=sequence)')
  }

  // 5. A and B open Step 1 -> handleStepOpened re-routes them to Step 2 (opened child).
  console.log('\n── A + B open Step 1 → re-route to Step 2 (opened child) ──')
  for (const contact of [contactA, contactB]) {
    const { result } = await openStepEmail(contact, step1)
    assert.ok(result && result.id === step2.id, `${contact.email} re-routed to the opened child (Step 2)`)
    const enrollment = await getEnrollment(contact.id)
    assert.equal(enrollment.current_step_id, step2.id, `${contact.email} now on Step 2`)
  }
  ok('handleStepOpened: opening the parent email re-routes the recipient off the not_opened child onto the opened child')

  // 6. Branch send: A/B on Step 2 (opened), C on Step 3 (not opened) — all
  //    fire together, since step3.wait_hours=0 makes C immediately due.
  console.log('\n── branch send: Step 2 (opened) → A/B, Step 3 (not opened) → C ──')
  for (const contact of [contactA, contactB, contactC]) {
    await processEnrollment(contact.id)
  }
  assert.equal(smtpCount(), 6, 'branch send sent exactly 3 emails (Step 2 to A/B, Step 3 to C)')

  {
    for (const contact of [contactA, contactB]) {
      const msgs = forRecipient(contact.email)
      assert.equal(msgs.length, 2, `${contact.email} got Step 1 + Step 2`)
      assert.equal(subjectOf(msgs[1]), 'Step2 Opened Subject', `${contact.email} Step 2 = opened-child NORMAL content`)
      const enrollment = await getEnrollment(contact.id)
      assert.equal(enrollment.status, 'completed', `${contact.email} completed (Step 2 has no children)`)
      assert.equal(enrollment.next_run_at, null, `${contact.email} next_run_at NULL on completion`)
    }
    ok('opened branch: A and B got Step 2 (opened child) and completed — no both-branch email')

    const cMsgs = forRecipient(emailC)
    assert.equal(cMsgs.length, 2, 'C got Step 1 + Step 3')
    assert.equal(subjectOf(cMsgs[1]), 'Step3 NotOpened Subject', 'C Step 3 uses the not_opened INCREMENT content')
    assert.ok((cMsgs[1].data || '').includes('Step3 NOT-OPENED BODY'), 'C Step 3 body is INCREMENT variant')
    const cEnrollment = await getEnrollment(contactC.id)
    assert.equal(cEnrollment.status, 'completed', 'C completed after the not-opened branch email')
    assert.equal(cEnrollment.next_run_at, null, 'C next_run_at NULL on completion')
    ok('not-opened branch: C got Step 3 (not_opened child) and completed — NOT_OPENED never stops')

    // No recipient ever received both branches of Step 1.
    const got = {
      [emailA]: forRecipient(emailA).map(subjectOf),
      [emailB]: forRecipient(emailB).map(subjectOf),
      [emailC]: forRecipient(emailC).map(subjectOf),
    }
    assert.deepEqual(got[emailA], ['Step1 NORMAL Subject Seq Test Contact', 'Step2 Opened Subject'])
    assert.deepEqual(got[emailB], ['Step1 NORMAL Subject Seq Test Contact', 'Step2 Opened Subject'])
    assert.deepEqual(got[emailC], ['Step1 NORMAL Subject Seq Test Contact', 'Step3 NotOpened Subject'])
    ok('no recipient received both the opened and not-opened branch email of a step')
  }

  // 7. Idle processing produces nothing (everyone completed).
  console.log('\n── idle processing ──')
  for (const contact of [contactA, contactB, contactC]) {
    const result = await processEnrollment(contact.id)
    assert.equal(result.skipped, true, `${contact.email} idle call skipped`)
  }
  assert.equal(smtpCount(), 6, 'no emails on idle processing')
  ok('idle processing sends nothing (all enrollments completed)')

  // 8. Duplicate / self-heal: D is enrolled on Step 1 but its Step-1 email is
  //    ALREADY logged (crash after send, before advance). The worker must
  //    advance WITHOUT resending, then send Step 3 normally.
  console.log('\n── duplicate protection / self-heal (D Step-1 already logged) ──')
  {
    const dummyLog = await client.from('email_logs').insert({
      campaign_id: seqCampaignId,
      contact_id: contactD.id,
      email: emailD,
      status: 'sent',
      sent_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      opened: false,
      clicked: false,
    }).select('*').single()
    await client.from('sequence_step_logs').insert({
      sequence_id: sequenceId,
      sequence_step_id: step1.id,
      contact_id: contactD.id,
      email_log_id: dummyLog.data.id,
      sent_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      opened: false,
      clicked: false,
      status: 'sent',
    })
    await client.from('sequence_enrollments').insert({
      sequence_id: sequenceId,
      contact_id: contactD.id,
      current_step_id: step1.id,
      current_step: 1,
      current_email_type: 'normal',
      status: 'active',
      enrolled_at: new Date().toISOString(),
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
    })
  }

  const countBeforeHeal = smtpCount()
  const healResult = await processEnrollment(contactD.id)
  assert.equal(smtpCount(), countBeforeHeal, 'no NEW email for D (Step 1 already logged)')
  {
    const dEnrollment = await getEnrollment(contactD.id)
    assert.equal(dEnrollment.current_step_id, step3.id, 'D advanced to Step 3 WITHOUT resending Step 1')
  }
  ok('self-heal: already-logged Step 1 advanced without a duplicate send')

  await processEnrollment(contactD.id)
  assert.equal(smtpCount(), countBeforeHeal + 1, 'D received exactly 1 email (Step 3)')
  {
    const dEnrollment = await getEnrollment(contactD.id)
    assert.equal(dEnrollment.status, 'completed', 'D completed after Step 3')
    const dMsgs = forRecipient(emailD)
    assert.equal(dMsgs.length, 1, 'D got exactly 1 email total (Step 3 only)')
    assert.equal(subjectOf(dMsgs[0]), 'Step3 NotOpened Subject', 'D Step 3 = not_opened INCREMENT content')
    ok('D: self-healed advance then sent Step 3 normally')
  }

  // 9. Sequence overview (per-node progress + engagement from real tracking).
  {
    const detail = await sequenceService.getSequence(sequenceId)
    assert.equal(detail.summary.completed, 4, 'all 4 enrollments completed')
    assert.equal(detail.summary.in_progress, 0, 'no enrollments in progress')
    assert.deepEqual(detail.engagement, { all: 4, opened: 2, not_opened: 2 }, 'engagement from the sequence own sent emails')
    const progressById = Object.fromEntries(detail.steps_progress.map((row) => [row.step.id, row]))
    const p1 = progressById[step1.id]
    const p2 = progressById[step2.id]
    const p3 = progressById[step3.id]
    assert.equal(p1.path, 'STARTING')
    assert.equal(p1.sent, 4)
    assert.equal(p1.eligible, 4)
    assert.equal(p1.opened, 2)
    assert.equal(p1.status, 'completed')
    assert.equal(p2.path, 'OPENED')
    assert.equal(p2.sent, 2)
    assert.equal(p2.eligible, 2)
    assert.equal(p2.status, 'completed')
    assert.equal(p3.path, 'NOT_OPENED')
    assert.equal(p3.sent, 2)
    assert.equal(p3.eligible, 2)
    assert.equal(p3.status, 'completed')
    ok('getSequence: per-node progress + engagement derived from real tracking data')
  }

  // 10. The dedicated campaign is hidden from the campaign list.
  {
    const listed = await supabaseService.listCampaigns()
    assert.ok(!listed.some((c) => c.id === seqCampaignId), 'sequence campaign hidden from listCampaigns')
    ok('sequence campaigns hidden from the campaign list')
  }

  console.log(`\n✅ ALL ${passed} CHECKS PASSED — sequence worker acceptance OK`)
}

// ─── Cleanup ──────────────────────────────────────────────────────────────
async function cleanup() {
  try {
    if (seqCampaignId) {
      await client.from('email_logs').delete().eq('campaign_id', seqCampaignId)
    }
    if (sequenceId) {
      await client.from('sequence_enrollments').delete().eq('sequence_id', sequenceId)
      await client.from('sequence_step_logs').delete().eq('sequence_id', sequenceId)
      await client.from('sequences').delete().eq('id', sequenceId)
    }
    for (const contact of [contactA, contactB, contactC, contactD]) {
      if (contact) await client.from('contacts').delete().eq('id', contact.id)
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
