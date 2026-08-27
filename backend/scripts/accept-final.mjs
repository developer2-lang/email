import { createClient } from '@supabase/supabase-js';
import { checkDueEnrollments, ensureSequenceCampaign } from '../workers/sequenceWorker.js';
import { getSequence, updateStep } from '../services/sequenceService.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const NAME = '__accept2_test';
const MIN_12 = 12 * 60 * 1000;

const CONTACTS = {
  A: '971a8162-6c55-4921-a2fd-39a01e168982',
  B: 'bb91cf05-bcfc-4c0d-be60-a4aebb48a09c',
  C: '000f8354-43fa-4b03-aa07-9cd791f0f3f5',
  D: '1ab29b16-ca23-4192-8aae-3d823c9528a6',
  E: '0d74d7c2-4c50-4113-9f6f-deb537aa706d',
  F: 'e58ecd7d-259d-4fbd-b104-4552b012d973',
};

let PASS = 0;
let FAIL = 0;
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { FAIL++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
const keys = (ids) => ids.map((id) => Object.entries(CONTACTS).find(([, v]) => v === id)?.[0] || id.slice(0, 8)).sort().join(',');

async function createTree() {
  const { data: seq, error } = await supabase.from('sequences').insert({ name: NAME, status: 'draft' }).select().single();
  if (error) throw new Error('insert sequence: ' + error.message);
  const steps = {};
  const mk = async (key, s) => {
    const { data, error: err } = await supabase
      .from('sequence_steps')
      .insert({
        sequence_id: seq.id,
        step_number: s.number,
        normal_subject: s.subject,
        normal_body: `BODY-${key.toUpperCase()}`,
        parent_step_id: s.parent || null,
        parent_branch: s.branch || 'STARTING',
        wait_hours: 0,
      })
      .select()
      .single();
    if (err) throw new Error(`insert step ${key}: ${err.message}`);
    steps[key] = data;
  };
  await mk('s1', { number: 1, subject: 'SUBJ-1' });
  await mk('s2', { number: 2, subject: 'SUBJ-2', parent: steps.s1.id, branch: 'OPENED' });
  await mk('s2a', { number: 2, subject: 'SUBJ-2A', parent: steps.s1.id, branch: 'NOT_OPENED' });
  await mk('s3', { number: 3, subject: 'SUBJ-3', parent: steps.s2.id, branch: 'OPENED' });
  await mk('s3a', { number: 3, subject: 'SUBJ-3A', parent: steps.s2.id, branch: 'NOT_OPENED' });
  await mk('s4', { number: 3, subject: 'SUBJ-4', parent: steps.s2a.id, branch: 'OPENED' });
  await mk('s4a', { number: 3, subject: 'SUBJ-4A', parent: steps.s2a.id, branch: 'NOT_OPENED' });
  seq.campaign_id = await ensureSequenceCampaign(seq);
  return { seq, steps };
}

async function enrollAll(seq, s1) {
  for (const k of Object.keys(CONTACTS)) {
    const { error } = await supabase.from('sequence_enrollments').insert({
      sequence_id: seq.id, contact_id: CONTACTS[k], status: 'active',
      current_step_id: s1.id, next_run_at: new Date().toISOString(),
    });
    if (error) throw new Error(`enroll ${k}: ${error.message}`);
  }
}

async function stepLog(seqId, contactId, stepId) {
  const { data } = await supabase
    .from('sequence_step_logs')
    .select('id, email_log_id, status')
    .eq('sequence_id', seqId).eq('contact_id', contactId).eq('sequence_step_id', stepId)
    .maybeSingle();
  return data;
}

// EDGE-MODE OPEN: record the open directly on email_logs exactly like the
// Supabase Edge Function (campaign-tracker) does. We deliberately DO NOT call
// handleStepOpened — the worker must detect the open itself and advance/send
// immediately (fast path) on the next re-check.
async function simulateOpen(seq, ck, stepId) {
  const log = await stepLog(seq.id, CONTACTS[ck], stepId);
  if (!log || !log.email_log_id) throw new Error(`no email log for ${ck} on ${stepId}`);
  await supabase.from('email_logs').update({ opened: true, opened_at: new Date().toISOString() }).eq('id', log.email_log_id);
  await forceNow(seq, ck);
}

// Force the enrollment due now so the worker's per-minute re-check is simulated.
async function forceNow(seq, ck) {
  await supabase.from('sequence_enrollments').update({ next_run_at: new Date().toISOString() })
    .eq('sequence_id', seq.id).eq('contact_id', CONTACTS[ck]);
}

// Backdate the step's sent_at 12 min (detection window elapsed) + force due —
// for recipients who did NOT open, so the NOT_OPENED branch can be decided.
async function backdateAndForce(seq, ck, stepId) {
  const log = await stepLog(seq.id, CONTACTS[ck], stepId);
  if (!log) throw new Error(`no log for ${ck} on ${stepId}`);
  await supabase.from('sequence_step_logs').update({ sent_at: new Date(Date.now() - MIN_12).toISOString() }).eq('id', log.id);
  await forceNow(seq, ck);
}

async function sentIds(seq, stepId) {
  const { data } = await supabase.from('sequence_step_logs').select('contact_id')
    .eq('sequence_id', seq.id).eq('sequence_step_id', stepId);
  return (data || []).map((l) => l.contact_id);
}

async function enrollmentCur(seq, ck) {
  const { data } = await supabase.from('sequence_enrollments').select('current_step_id, status')
    .eq('sequence_id', seq.id).eq('contact_id', CONTACTS[ck]).single();
  return data;
}

async function openedAt(seq, ck, stepId) {
  const log = await stepLog(seq.id, CONTACTS[ck], stepId);
  if (!log || !log.email_log_id) return null;
  const { data } = await supabase.from('email_logs').select('opened, opened_at').eq('id', log.email_log_id).maybeSingle();
  return data;
}

async function cleanup(seq) {
  if (!seq) return;
  const { data: logs } = await supabase.from('sequence_step_logs').select('email_log_id').eq('sequence_id', seq.id);
  const ids = (logs || []).map((l) => l.email_log_id).filter(Boolean);
  if (ids.length) await supabase.from('email_logs').delete().in('id', ids);
  await supabase.from('sequence_step_logs').delete().eq('sequence_id', seq.id);
  await supabase.from('sequence_enrollments').delete().eq('sequence_id', seq.id);
  await supabase.from('sequence_branch_steps').delete().eq('sequence_id', seq.id);
  await supabase.from('sequence_steps').delete().eq('sequence_id', seq.id);
  await supabase.from('campaigns').delete().eq('id', seq.campaign_id);
  await supabase.from('sequences').delete().eq('id', seq.id);
  console.log('\nCleanup done.');
}

let seq = null;
try {
  console.log('== Creating scratch DRAFT sequence (all wait_hours=0) ==');
  const { seq: s, steps } = await createTree();
  seq = s;
  await enrollAll(seq, steps.s1);
  console.log('Sequence:', seq.id);

  // ── PHASE 1 ─────────────────────────────────────────────
  console.log('\n== PHASE 1: Step 1 -> 6 ==');
  await checkDueEnrollments([seq.id]);
  const s1 = await sentIds(seq, steps.s1.id);
  check('Step 1 sent = 6', s1.length === 6);
  check('Step 1 recipients = A,B,C,D,E,F', keys(s1) === 'A,B,C,D,E,F', `got {${keys(s1)}}`);
  for (const k of Object.keys(CONTACTS)) {
    const oa = await openedAt(seq, k, steps.s1.id);
    check(`S1 opened_at empty for ${k} before any open`, oa && oa.opened_at === null, `opened_at=${oa && oa.opened_at}`);
  }

  // ── PHASE 2: A,B,C,D,E open S1; F does NOT ──────────────
  console.log('\n== PHASE 2: 5 opened / 1 not (edge-mode opens only) ==');
  for (const k of ['A', 'B', 'C', 'D', 'E']) await simulateOpen(seq, k, steps.s1.id);
  await checkDueEnrollments([seq.id]);
  const s2 = await sentIds(seq, steps.s2.id);
  check('Step 2 sent immediately = 5 (fast path, no window wait)', s2.length === 5, `got {${keys(s2)}}`);
  check('Step 2 recipients = A,B,C,D,E', keys(s2) === 'A,B,C,D,E', `got {${keys(s2)}}`);
  const fCur = await enrollmentCur(seq, 'F');
  check('F still on Step 1 (not opened, window not elapsed)', fCur.current_step_id === steps.s1.id && fCur.status === 'active');
  check('Step 2A still 0 before F window elapses', (await sentIds(seq, steps.s2a.id)).length === 0);
  for (const k of ['A', 'B', 'C', 'D', 'E']) {
    const oa = await openedAt(seq, k, steps.s1.id);
    check(`S1 opened_at populated for ${k}`, oa && oa.opened === true && oa.opened_at, `opened=${oa && oa.opened} at=${oa && oa.opened_at}`);
  }
  const fOa = await openedAt(seq, 'F', steps.s1.id);
  check('S1 opened_at empty for F (not opened)', fOa && fOa.opened === false && fOa.opened_at === null, `opened=${fOa && fOa.opened}`);

  // window elapses for F -> NOT_OPENED branch
  await backdateAndForce(seq, 'F', steps.s1.id);
  await checkDueEnrollments([seq.id]);
  const s2a = await sentIds(seq, steps.s2a.id);
  check('Step 2A sent = 1, recipient = F', keys(s2a) === 'F', `got {${keys(s2a)}}`);

  // ── PHASE 3: A,C,E open S2; B,D do not; F opens S2A ─────
  console.log('\n== PHASE 3: 3/2 on Step 2 and 1/0 on Step 2A ==');
  for (const k of ['A', 'C', 'E']) await simulateOpen(seq, k, steps.s2.id);
  await simulateOpen(seq, 'F', steps.s2a.id);
  const bCur = await enrollmentCur(seq, 'B');
  const dCur = await enrollmentCur(seq, 'D');
  check('B,D still on Step 2 (undecided) before window', bCur.current_step_id === steps.s2.id && dCur.current_step_id === steps.s2.id);
  await checkDueEnrollments([seq.id]);
  const s3 = await sentIds(seq, steps.s3.id);
  const s4 = await sentIds(seq, steps.s4.id);
  check('Step 3 sent immediately = 3, recipients = A,C,E', keys(s3) === 'A,C,E', `got {${keys(s3)}}`);
  check('Step 4 sent immediately = 1, recipient = F', keys(s4) === 'F', `got {${keys(s4)}}`);
  check('Step 3A/4A not sent before window', (await sentIds(seq, steps.s3a.id)).length === 0 && (await sentIds(seq, steps.s4a.id)).length === 0);

  for (const k of ['B', 'D']) await backdateAndForce(seq, k, steps.s2.id);
  await checkDueEnrollments([seq.id]);
  const s3a = await sentIds(seq, steps.s3a.id);
  const s4a = await sentIds(seq, steps.s4a.id);
  check('Step 3A sent = 2, recipients = B,D', keys(s3a) === 'B,D', `got {${keys(s3a)}}`);
  check('Step 4A sent = 0', s4a.length === 0, `got {${keys(s4a)}}`);

  // ── FINAL VERIFICATION ──────────────────────────────────
  console.log('\n== FINAL VERIFICATION ==');
  const expect = { s1: ['A', 'B', 'C', 'D', 'E', 'F'], s2: ['A', 'B', 'C', 'D', 'E'], s2a: ['F'], s3: ['A', 'C', 'E'], s3a: ['B', 'D'], s4: ['F'], s4a: [] };
  const { data: logs } = await supabase.from('sequence_step_logs').select('sequence_step_id, contact_id, status').eq('sequence_id', seq.id);
  for (const key of Object.keys(expect)) {
    const ids = await sentIds(seq, steps[key].id);
    check(`Step ${key.toUpperCase()} sent exactly {${keys(expect[key])}}`, keys(ids) === keys(expect[key]), `got {${keys(ids)}}`);
  }
  // every step log has the correct step_id + recipient_id
  let stepIdOk = true;
  for (const l of logs) {
    const key = Object.keys(steps).find((k) => steps[k].id === l.sequence_step_id);
    if (!key || !expect[key].includes(Object.entries(CONTACTS).find(([, v]) => v === l.contact_id)?.[0])) stepIdOk = false;
  }
  check('Every step_log has correct step_id + recipient_id', stepIdOk, `logs=${logs.length}`);

  // DB relationships
  const rel = { s2: ['s1', 'OPENED'], s2a: ['s1', 'NOT_OPENED'], s3: ['s2', 'OPENED'], s3a: ['s2', 'NOT_OPENED'], s4: ['s2a', 'OPENED'], s4a: ['s2a', 'NOT_OPENED'] };
  for (const key of Object.keys(rel)) {
    const [p, b] = rel[key];
    check(`DB: ${key.toUpperCase()}.parent_step_id=${p} parent_branch=${b}`, steps[key].parent_step_id === steps[p].id && steps[key].parent_branch === b);
  }
  check('DB: Step1 parent_step_id=null parent_branch=STARTING', steps.s1.parent_step_id === null && steps.s1.parent_branch === 'STARTING');

  // opened_at only where opened
  let openedOk = true;
  const openers = { s1: ['A', 'B', 'C', 'D', 'E'], s2: ['A', 'C', 'E'], s2a: ['F'] };
  for (const key of Object.keys(openers)) {
    for (const k of Object.keys(CONTACTS)) {
      const oa = await openedAt(seq, k, steps[key].id);
      const shouldOpen = openers[key].includes(k);
      if (!oa) continue;
      if (shouldOpen && !(oa.opened === true && oa.opened_at)) openedOk = false;
      if (!shouldOpen && oa.opened === true) openedOk = false;
    }
  }
  check('opened_at populated ONLY for actually-opened emails', openedOk);

  // No duplicates + totals
  const kc = {};
  for (const l of logs) kc[`${l.sequence_step_id}:${l.contact_id}`] = (kc[`${l.sequence_step_id}:${l.contact_id}`] || 0) + 1;
  const dups = Object.values(kc).filter((v) => v > 1);
  check('No duplicate sends', dups.length === 0, `dups=${dups.length}`);
  check('Total step logs = 18', logs.length === 18, `logs=${logs.length}`);
  const { data: emails } = await supabase.from('email_logs').select('status').eq('campaign_id', seq.campaign_id);
  check('All email_logs status=sent', emails.every((x) => x.status === 'sent'), `emails=${emails.length}`);
  check('Total emails = 18', emails.length === 18);

  // Distinct subjects stored per branch
  const subjects = Object.keys(steps).map((k) => steps[k].normal_subject);
  check('Distinct subject per branch', new Set(subjects).size === 7, JSON.stringify(subjects));

  // ── WORKER RESTART + REFRESH IDEMPOTENCY ────────────────
  console.log('\n== WORKER RESTART + REFRESH ==');
  await checkDueEnrollments([seq.id]);
  await checkDueEnrollments([seq.id]);
  await checkDueEnrollments([seq.id]);
  check('After restart ticks: 0 new sends', (await sentIds(seq, steps.s2.id)).length === 5 && (await sentIds(seq, steps.s2a.id)).length === 1);
  const { data: logsAfter } = await supabase.from('sequence_step_logs').select('id').eq('sequence_id', seq.id);
  check('Refresh: step_log count unchanged', logsAfter.length === 18, `logs=${logsAfter.length}`);
  const { data: enrAfter } = await supabase.from('sequence_enrollments').select('status').eq('sequence_id', seq.id);
  check('Refresh: all enrollments still completed', enrAfter.every((e) => e.status === 'completed'));

  // ── EDIT / SAVE ─────────────────────────────────────────
  console.log('\n== EDIT / SAVE PERSISTENCE ==');
  const before = steps.s2.normal_subject;
  await updateStep(seq.id, steps.s2.id, { normal_subject: 'SUBJ-2-EDITED', normal_body: 'BODY-2-EDITED' });
  const { data: s2row } = await supabase.from('sequence_steps').select('normal_subject, normal_body, parent_step_id, parent_branch, wait_hours').eq('id', steps.s2.id).single();
  check('DB updated with new subject/body', s2row.normal_subject === 'SUBJ-2-EDITED' && s2row.normal_body === 'BODY-2-EDITED', `subject=${s2row.normal_subject}`);
  check('DB parent/branch/wait preserved after edit', s2row.parent_step_id === steps.s1.id && s2row.parent_branch === 'OPENED' && s2row.wait_hours === 0);
  const { steps_progress: progress } = await getSequence(seq.id);
  const p2 = progress.find((p) => p.step.id === steps.s2.id);
  check('Sequence page reads edited subject from DB', p2 && p2.subject === 'SUBJ-2-EDITED', `subject=${p2 && p2.subject}`);
  check('Subject actually changed', before !== s2row.normal_subject);

  console.log(`\n========== RESULT: ${PASS} passed, ${FAIL} failed ==========`);
} catch (err) {
  console.error('\nE2E ERROR:', err);
  process.exitCode = 1;
} finally {
  await cleanup(seq);
}
