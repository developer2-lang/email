/**
 * Sequence OPEN-TRACKING acceptance test — legacy rows with NULL email_log_id.
 *
 * Reproduces the reported production bug: Step 1 sent to 6 recipients, 4 of
 * them genuinely opened (email_logs.opened = true), yet Step Progress showed
 * Opened = 0 and the branches resolved 0 recipients.
 *
 * Root cause: sequence_step_logs.email_log_id is the tracking link the whole
 * sequence calculation reads THROUGH. Legacy sends wrote that link as NULL, so
 * the open/click data living in email_logs never reached getSequence or the
 * branch eligibility — the code fell back to sequence_step_logs.opened, which
 * nothing ever syncs.
 *
 * Fix under test: a self-healing backfill (backfillStepLogEmailLinks) matches
 * each unlinked step log to the real email_log row under the sequence's
 * dedicated campaign (same contact, closest sent_at) and writes the link back.
 * It runs from getSequence and from the worker's context loader, so Step
 * Progress, engagement and OPENED/NOT_OPENED branching all read the actual
 * tracking data.
 *
 * Scenario (all counts derived, nothing hardcoded):
 *   Step 1 (STARTING, wait 0)
 *   ├── OPENED     → Step 2 (opened child)
 *   └── NOT_OPENED → Step 3 (not_opened child)
 *
 *   6 recipients W1–W6 enrolled and "sent" Step 1 with NULL email_log_id
 *   (legacy). W1–W4 open Step 1, W5–W6 do not. Expectations:
 *     Step 1  -> eligible 6, sent 6, opened 4
 *     Step 2  -> exactly W1–W4 (4 opened recipients)
 *     Step 3  -> exactly W5–W6 (2 not-opened recipients)
 *
 * Run:  node test/sequence-open-tracking-acceptance.mjs   (from backend/)
 */
import 'dotenv/config'
import assert from 'node:assert/strict'

let client
let supabaseService
let sequenceService

const RUN_ID = `seqo_${Date.now()}`
const SEGMENT = `SeqOpenTest-${RUN_ID}`
const emails = Array.from({ length: 6 }, (_, i) => `seqo.${String.fromCharCode(97 + i)}.${RUN_ID}@example.co`)

let sequenceId
let seqCampaignId
const contacts = []
const steps = {}
const enrolled = {}

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

const nowIso = () => new Date().toISOString()
const msAgo = (ms) => new Date(Date.now() - ms).toISOString()

async function insertContact(email) {
  const { data, error } = await client.from('contacts').insert({
    email,
    full_name: 'SeqOpen Test Contact',
    company: 'SeqOpen Test Co',
    designation: 'Tester',
    contact_type: SEGMENT,
    company_category: 'Technology',
  }).select('id, email').single()
  if (error) throw error
  return data
}

async function getStepLogsForStep(stepNode) {
  const { data, error } = await client
    .from('sequence_step_logs')
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('sequence_step_id', stepNode.id)
  if (error) throw error
  return data || []
}

async function main() {
  supabaseService = await import('../services/supabaseService.js')
  sequenceService = await import('../services/sequenceService.js')
  client = supabaseService.supabase

  for (let i = 0; i < 6; i++) contacts.push(await insertContact(emails[i]))

  const seq = await sequenceService.createSequence({
    name: `__seq_open__${RUN_ID}`,
    audience_segment: SEGMENT,
    trigger_type: 'behaviour',
    recipient_type: 'all',
    send_mode: 'both',
  })
  sequenceId = seq.id

  const step1 = await sequenceService.createStep(sequenceId, {
    step_number: 1,
    normal_subject: 'Step 1 Subject',
    normal_body: 'Step 1 BODY',
    wait_hours: 0,
  })
  const step2Opened = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: step1.id,
    parent_branch: 'OPENED',
    normal_subject: 'Step 2 Opened Subject',
    normal_body: 'Step 2 OPENED BODY',
    wait_hours: 0,
  })
  const step3NotOpened = await sequenceService.createStep(sequenceId, {
    step_number: 2,
    parent_step_id: step1.id,
    parent_branch: 'NOT_OPENED',
    increment_subject: 'Step 3 NotOpened Subject',
    increment_body: 'Step 3 NOT-OPENED BODY',
    wait_hours: 1,
  })
  Object.assign(steps, { step1, step2Opened, step3NotOpened })

  // ── Dedicated campaign (created lazily on first send in production) ──
  const { data: campaign, error: campError } = await client.from('campaigns').insert({
    campaign_name: `__seq_open_campaign__${RUN_ID}`,
    subject_line: 'Sequence email',
    from_name: '',
    campaign_type: 'sequence',
    status: 'draft',
    audience_segment: null,
  }).select('id').single()
  if (campError) throw campError
  seqCampaignId = campaign.id
  const { error: seqUpdateError } = await client
    .from('sequences')
    .update({ campaign_id: seqCampaignId })
    .eq('id', sequenceId)
  if (seqUpdateError) throw seqUpdateError

  // ── Enroll all 6 on the STARTING node ──
  const sentAt = msAgo(3600 * 1000)
  for (let i = 0; i < 6; i++) {
    const contact = contacts[i]
    const { error: e1 } = await client.from('sequence_enrollments').insert({
      sequence_id: sequenceId,
      contact_id: contact.id,
      current_step_id: step1.id,
      current_step: 1,
      current_email_type: 'normal',
      status: 'active',
      enrolled_at: nowIso(),
      next_run_at: msAgo(60_000),
    })
    if (e1) throw e1

    // ── Legacy send: step log written WITHOUT the email_log_id link ──
    const { error: e2 } = await client.from('sequence_step_logs').insert({
      sequence_id: sequenceId,
      sequence_step_id: step1.id,
      contact_id: contact.id,
      email_log_id: null,
      sent_at: sentAt,
      opened: false,
      clicked: false,
      status: 'sent',
    })
    if (e2) throw e2

    // ── The real email_log that tracking actually updates ──
    const { data: emailLog, error: e3 } = await client.from('email_logs').insert({
      campaign_id: seqCampaignId,
      contact_id: contact.id,
      email: contact.email,
      status: 'sent',
      sent_at: sentAt,
    }).select('id').single()
    if (e3) throw e3
    enrolled[contact.id] = emailLog.id
  }

  // ── W1–W4 genuinely open Step 1 (tracking updates email_logs ONLY) ──
  for (let i = 0; i < 4; i++) {
    const { error } = await client
      .from('email_logs')
      .update({ opened: true, opened_at: nowIso() })
      .eq('id', enrolled[contacts[i].id])
    if (error) throw error
  }

  const openedIds = new Set([0, 1, 2, 3].map((i) => contacts[i].id))
  console.log(`\n[Test] Step 1 "sent" to 6 with NULL email_log_id; W1–W4 opened (email_logs.opened=true), W5–W6 not`)

  // ── Step Progress: opened MUST come from email_logs after self-heal ──
  console.log('\n── Step Progress: opened = 4 from real tracking, not the never-synced step-log flag ──')
  const detail = await sequenceService.getSequence(sequenceId)
  const progressById = Object.fromEntries(detail.steps_progress.map((row) => [row.step.id, row]))
  const p1 = progressById[step1.id]
  assert.equal(p1.sent, 6, 'Step 1 sent = 6')
  assert.equal(p1.eligible, 6, 'Step 1 eligible = 6')
  assert.equal(p1.opened, 4, 'Step 1 opened = 4 (was 0 — open data never reached the calculation)')
  assert.deepEqual(detail.engagement, { all: 6, opened: 4, not_opened: 2 }, 'engagement reads email_logs opens')
  ok('getSequence: Step 1 sent 6 / eligible 6 / opened 4; engagement opened 4, not_opened 2')

  // ── Self-heal: legacy step logs now carry the real email_log_id ──
  console.log('\n── Self-heal: NULL links backfilled from the matching email_logs rows ──')
  {
    const logs = await getStepLogsForStep(step1)
    assert.equal(logs.length, 6, '6 step-1 logs present')
    const linked = logs.map((l) => ({ contact_id: l.contact_id, email_log_id: l.email_log_id }))
    assert.ok(linked.every((l) => l.email_log_id), 'every legacy step log was backfilled with email_log_id')
    for (const { contact_id, email_log_id } of linked) {
      assert.equal(email_log_id, enrolled[contact_id], 'backfilled link points at the contact\'s real email_logs row')
    }
    ok('all 6 legacy step logs backfilled to the real email_logs.id')
  }

  // ── Branch propagation: 4 → OPENED child, 2 → NOT_OPENED child ──
  console.log('\n── Branch propagation (same central eligibility as the worker) ──')
  {
    const rOpened = await sequenceService.resolveSequenceRecipients(sequenceId, step2Opened.id)
    const openedEmails = rOpened.recipients.map((e) => e.contacts.email).sort()
    assert.deepEqual(
      openedEmails,
      emails.slice(0, 4).sort(),
      'Step 2 (OPENED child) eligible = exactly the 4 recipients who opened'
    )
    assert.equal(openedEmails.length, 4, 'opened branch carries exactly 4 recipients')

    const rNotOpened = await sequenceService.resolveSequenceRecipients(sequenceId, step3NotOpened.id)
    const notOpenedEmails = rNotOpened.recipients.map((e) => e.contacts.email).sort()
    assert.deepEqual(
      notOpenedEmails,
      emails.slice(4, 6).sort(),
      'Step 3 (NOT_OPENED child) eligible = exactly the 2 recipients who never opened'
    )
    assert.equal(notOpenedEmails.length, 2, 'not-opened branch carries exactly 2 recipients')
    ok('propagation: 4 opened recipients → Step 2 (OPENED), 2 unopened → Step 3 (NOT_OPENED)')

    // Step 2's own progress row reflects the 4 propagated recipients too.
    const p2 = progressById[step2Opened.id]
    assert.equal(p2.eligible, 4, 'Step 2 eligible = 4 in steps_progress')
    assert.equal(p2.opened, 0, 'Step 2 has no opens yet (nothing sent to it)')
    assert.equal(p2.sent, 0, 'Step 2 not sent yet')
  }

  console.log(`\n✅ ALL ${passed} CHECKS PASSED — open tracking reaches the sequence calculation OK`)
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
    for (const contact of contacts) {
      if (contact) await client.from('contacts').delete().eq('id', contact.id)
    }
    if (seqCampaignId) {
      await client.from('campaigns').delete().eq('id', seqCampaignId)
    }
  } catch (error) {
    console.error('[Test] Cleanup failed (non-fatal):', error.message)
  }
}

main()
  .catch((error) => {
    console.error('\n✗ TEST FAILED:', error.message)
    console.error(error.stack || error)
    process.exitCode = 1
  })
  .finally(cleanup)
