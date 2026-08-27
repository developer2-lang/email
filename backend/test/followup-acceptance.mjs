/**
 * Follow-up acceptance test (integration).
 *
 * Validates the canonical follow-up rule against a LIVE Supabase instance but
 * a STUB SMTP server (127.0.0.1:2525) — no real email is ever sent.
 *
 * Scenarios:
 *   1. Original 6 sent / 2 opened -> follow-up sends EXACTLY 2 (never 6).
 *   2. Original 6 sent / 0 opened -> follow-up sends 0 (never 6).
 *   3. Non-opener selected -> skipped with reason 'not_opened', no email.
 *   4. Duplicate send -> skipped with reason 'already_sent'.
 *   5. Follow-up analytics reflect ACTUAL recipients (2), not the audience.
 *   6. campaign_contacts for the follow-up campaign contains ONLY recipients.
 *
 * Run:  node test/followup-acceptance.mjs   (from backend/)
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'

// ─── Override SMTP to the stub BEFORE any service module loads ────────────
process.env.EMAIL_HOST = '127.0.0.1'
process.env.EMAIL_PORT = '2525'
process.env.EMAIL_SECURE = 'false'
process.env.EMAIL_USER = ''
process.env.EMAIL_PASSWORD = ''
process.env.EMAIL_FROM = 'Test Sender <test@example.com>'

// ─── Stub SMTP server ─────────────────────────────────────────────────────
const SMTP_PORT = 2525
const delivered = []

function startSmtpServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let dataMode = false
      let authStep = 0 // 0 = idle, 1 = awaiting username, 2 = awaiting password
      let currentTo = ''
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
          line = line.trim()

          if (dataMode) {
            if (line === '.') {
              dataMode = false
              delivered.push({ to: currentTo })
              socket.write('250 2.0.0 OK: queued as MOCK\r\n')
              continue
            }
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

const smtpCount = () => delivered.length
const smtpDelivered = () => delivered.map((d) => d.to)

// ─── Load services AFTER env overrides ────────────────────────────────────
const supabaseService = await import('../services/supabaseService.js')
const followupService = await import('../services/followupService.js')
const emailLogService = await import('../services/emailLogService.js')

const client = supabaseService.supabase

let server
let createdCampaigns = []
let createdContacts = []

async function cleanup() {
  for (const id of createdCampaigns) {
    try {
      await client.from('email_logs').delete().eq('campaign_id', id)
      await client.from('campaign_contacts').delete().eq('campaign_id', id)
      await client.from('campaign_analytics').delete().eq('campaign_id', id)
      await client
        .from('campaign_followup_logs')
        .delete()
        .or(`campaign_id.eq.${id},followup_campaign_id.eq.${id}`)
      await client
        .from('campaign_followups')
        .delete()
        .or(`campaign_id.eq.${id},followup_campaign_id.eq.${id}`)
      await client.from('campaigns').delete().eq('id', id)
    } catch (e) {
      console.warn('cleanup campaign failed:', id, e.message)
    }
  }
  for (const c of createdContacts) {
    try {
      await client.from('contacts').delete().eq('id', c)
    } catch {
      /* ignore */
    }
  }
}

async function insertContact(email) {
  const { data, error } = await client
    .from('contacts')
    .insert({
      full_name: 'Test Contact',
      email,
      company: 'TestCo',
      designation: 'Engineer',
      contact_type: 'Prospect',
    })
    .select('*')
    .single()
  if (error) throw error
  createdContacts.push(data.id)
  return data
}

async function insertCampaign(name) {
  const { data, error } = await client
    .from('campaigns')
    .insert({
      campaign_name: name,
      subject_line: `Subject ${name}`,
      from_name: 'Test Sender',
      audience_segment: 'All Contacts',
      campaign_type: 'Newsletter',
      html_content: '<p>Hello {{first_name}}</p>',
      email_body: 'Hello {{first_name}}',
      status: 'sent',
    })
    .select('*')
    .single()
  if (error) throw error
  createdCampaigns.push(data.id)
  return data
}

async function seedEmailLogs(campaignId, contacts, openedIds) {
  const openedSet = new Set(openedIds.map(String))
  const rows = contacts.map((c) => {
    const isOpen = openedSet.has(String(c.id))
    return {
      campaign_id: campaignId,
      contact_id: c.id,
      email: c.email,
      status: 'sent',
      sent_at: new Date().toISOString(),
      tracking_id: randomUUID(),
      opened: isOpen,
      opened_at: isOpen ? new Date().toISOString() : null,
      clicked: false,
    }
  })
  const { data, error } = await client.from('email_logs').insert(rows).select('*')
  if (error) throw error
  return data
}

async function createFollowup(originalCampaignId, name) {
  const res = await followupService.createFollowupConfig({
    original_campaign_id: originalCampaignId,
    campaign_name: name,
    subject_line: `${name} subject`,
    from_name: 'Test Sender',
    html_content: '<p>Follow-up body</p>',
    campaign_type: 'Follow Up',
    followup_mode: 'manual',
    is_active: true,
  })
  createdCampaigns.push(res.followup_campaign_id)
  return res
}

async function main() {
  server = await startSmtpServer()
  const ts = Date.now()
  const prefix = `__acceptance_${ts}`

  const aContacts = []
  const bContacts = []
  for (let i = 0; i < 6; i++) aContacts.push(await insertContact(`${prefix}_a${i}@example.com`))
  for (let i = 0; i < 6; i++) bContacts.push(await insertContact(`${prefix}_b${i}@example.com`))

  const origA = await insertCampaign(`${prefix}_origA`)
  const origB = await insertCampaign(`${prefix}_origB`)
  await seedEmailLogs(origA.id, aContacts, [aContacts[0].id, aContacts[1].id]) // 2 openers
  await seedEmailLogs(origB.id, bContacts, []) // 0 openers

  // ── Scenario A: 6 sent / 2 opened → exactly 2 ──
  const resA = await createFollowup(origA.id, `${prefix}_fuA`)
  const fuA = resA.followup_campaign_id

  assert.equal(resA.created, true, 'createFollowupConfig created a new campaign')
  assert.equal(
    String(resA.config.campaign_id),
    String(origA.id),
    'canonical: campaign_followups.campaign_id = ORIGINAL campaign',
  )
  assert.equal(
    String(resA.config.followup_campaign_id),
    String(fuA),
    'canonical: campaign_followups.followup_campaign_id = FOLLOW-UP campaign',
  )

  const fuCampaign = await supabaseService.getCampaign(fuA)
  assert.equal(fuCampaign.audience_segment, null, 'follow-up campaign has NO audience segment')
  assert.equal(fuCampaign.campaign_type, 'Follow Up')

  const beforeA = smtpCount()
  const r1 = await followupService.sendFollowupsToSelected(origA.id, {
    contact_ids: [aContacts[0].id, aContacts[1].id],
    followup_campaign_id: fuA,
  })
  assert.equal(r1.length, 2)
  assert.ok(r1.every((r) => r.status === 'sent'), `scenario 1: all sent → ${JSON.stringify(r1)}`)
  assert.equal(smtpCount() - beforeA, 2, 'scenario 1: EXACTLY 2 emails over SMTP (never 6)')

  const sentEmails = r1.map((r) => r.email).sort()
  assert.deepEqual(sentEmails, [aContacts[0].email, aContacts[1].email].sort())

  const fuALogs = await emailLogService.getLogsByCampaign(fuA)
  assert.equal(fuALogs.length, 2, 'scenario 1: follow-up email_logs = 2')
  assert.ok(fuALogs.every((l) => l.status === 'sent'))

  const { data: fuAContacts } = await client
    .from('campaign_contacts')
    .select('contact_id')
    .eq('campaign_id', fuA)
  assert.equal(fuAContacts.length, 2, 'scenario 6: campaign_contacts = exactly the 2 recipients')

  const fuAnalytics = await supabaseService.getCampaignAnalytics(fuA)
  assert.equal(fuAnalytics.total_recipients, 2, 'scenario 5: analytics total_recipients = 2')
  assert.equal(fuAnalytics.delivered, 2, 'scenario 5: analytics delivered = 2')

  // ── Scenario 4: duplicate send → skipped already_sent ──
  const r4 = await followupService.sendFollowupsToSelected(origA.id, {
    contact_ids: [aContacts[0].id, aContacts[1].id],
    followup_campaign_id: fuA,
  })
  assert.ok(
    r4.every((r) => r.status === 'skipped' && r.reason === 'already_sent'),
    `scenario 4: duplicates skipped → ${JSON.stringify(r4)}`,
  )

  // ── Scenario 3: non-opener rejected ──
  const before3 = smtpCount()
  const r3 = await followupService.sendFollowupsToSelected(origA.id, {
    contact_ids: [aContacts[0].id, aContacts[2].id],
    followup_campaign_id: fuA,
  })
  const map3 = Object.fromEntries(r3.map((r) => [String(r.contact_id), r]))
  assert.equal(map3[aContacts[0].id].status, 'skipped')
  assert.equal(map3[aContacts[0].id].reason, 'already_sent')
  assert.equal(map3[aContacts[2].id].status, 'skipped')
  assert.equal(map3[aContacts[2].id].reason, 'not_opened')
  assert.equal(smtpCount() - before3, 0, 'scenario 3: no email to the non-opener')
  assert.equal((await emailLogService.getLogsByCampaign(fuA)).length, 2)

  // ── Scenario B: 6 sent / 0 opened → 0 recipients, never 6 ──
  const resB = await createFollowup(origB.id, `${prefix}_fuB`)
  const fuB = resB.followup_campaign_id

  const resolvedB = await supabaseService.resolveFollowupRecipients(fuB)
  assert.equal(resolvedB.isFollowup, true)
  assert.equal(resolvedB.contacts.length, 0, 'scenario 2: 0 openers → 0 eligible recipients')

  const audienceB = await supabaseService.resolveContactsForCampaign(fuB, 'All Contacts')
  assert.equal(audienceB.length, 0, 'scenario 2: audience "All Contacts" resolves 0 for a follow-up')

  const beforeB = smtpCount()
  const rB = await followupService.sendFollowupsToSelected(origB.id, {
    contact_ids: bContacts.map((c) => c.id),
    followup_campaign_id: fuB,
  })
  assert.equal(rB.length, 6)
  assert.ok(
    rB.every((r) => r.status === 'skipped' && r.reason === 'not_opened'),
    `scenario 2: manual send blocked for all 6 → ${JSON.stringify(rB)}`,
  )
  assert.equal(smtpCount() - beforeB, 0, 'scenario 2: 0 emails over SMTP (never 6)')
  assert.equal((await emailLogService.getLogsByCampaign(fuB)).length, 0)

  const pending = await followupService.listPendingFollowups()
  const pendingForB = pending.filter((p) => String(p.campaign_id) === String(origB.id))
  assert.equal(pendingForB.length, 0, 'scenario 2: nothing queued for a 0-opener original')

  // ── Scenario 7: "All campaigns" — union of openers, deduped, verified across ALL campaigns ──
  // A cross-campaign contact opens BOTH origA and origB — must appear exactly once.
  const cross = await insertContact(`${prefix}_cross@example.com`)
  for (const cid of [origA.id, origB.id]) {
    await client.from('email_logs').insert({
      campaign_id: cid,
      contact_id: cross.id,
      email: cross.email,
      status: 'sent',
      sent_at: new Date().toISOString(),
      tracking_id: randomUUID(),
      opened: true,
      opened_at: new Date().toISOString(),
      clicked: false,
    })
  }

  const allOpened = await followupService.getOpenedContactsForAll()
  const seen = new Set(allOpened.map((o) => String(o.contact_id)))
  assert.equal(seen.size, allOpened.length, 'scenario 7: union is deduped by contact id')
  assert.equal(
    allOpened.filter((o) => String(o.contact_id) === String(cross.id)).length,
    1,
    'scenario 7: cross-campaign opener appears ONCE in the union',
  )
  assert.ok(seen.has(String(aContacts[0].id)), 'scenario 7: union includes an opener of origA')
  assert.ok(seen.has(String(cross.id)), 'scenario 7: union includes the cross opener')

  // "All" manual send: verified across every campaign; a contact who opened both
  // campaigns is still sent exactly once; non-openers are rejected.
  const fuAll = await insertCampaign(`${prefix}_fuAll`)
  const beforeAll = smtpCount()
  const rAll = await followupService.sendFollowupsToSelected('all', {
    contact_ids: [aContacts[0].id, aContacts[1].id, cross.id, aContacts[2].id],
    followup_campaign_id: fuAll.id,
  })
  const mapAll = Object.fromEntries(rAll.map((r) => [String(r.contact_id), r]))
  assert.equal(mapAll[aContacts[0].id].status, 'sent', 'scenario 7: opener of origA sent')
  assert.equal(mapAll[aContacts[1].id].status, 'sent', 'scenario 7: opener of origA sent')
  assert.equal(mapAll[cross.id].status, 'sent', 'scenario 7: cross opener sent exactly once')
  assert.equal(mapAll[aContacts[2].id].status, 'skipped', 'scenario 7: non-opener rejected')
  assert.equal(mapAll[aContacts[2].id].reason, 'not_opened', 'scenario 7: non-opener reason not_opened')
  assert.equal(smtpCount() - beforeAll, 3, 'scenario 7: EXACTLY 3 emails (2 + cross once), never 4')

  // Duplicate all-send → already_sent, no extra email.
  const beforeAll2 = smtpCount()
  const rAll2 = await followupService.sendFollowupsToSelected('all', {
    contact_ids: [aContacts[0].id, cross.id],
    followup_campaign_id: fuAll.id,
  })
  assert.ok(
    rAll2.every((r) => r.status === 'skipped' && r.reason === 'already_sent'),
    `scenario 7: all-send duplicates skipped → ${JSON.stringify(rAll2)}`,
  )
  assert.equal(smtpCount() - beforeAll2, 0, 'scenario 7: no extra emails on duplicate all-send')

  // "All" create: builds the follow-up campaign and links eligible campaigns WITHOUT
  // overwriting existing per-campaign configurations.
  const resAll = await followupService.createFollowupConfig({
    original_campaign_id: 'all',
    campaign_name: `${prefix}_fuAllCampaigns`,
    subject_line: 'All campaigns subject',
    from_name: 'Test Sender',
    html_content: '<p>All follow-up body</p>',
    campaign_type: 'Follow Up',
    followup_mode: 'manual',
    is_active: true,
  })
  createdCampaigns.push(resAll.followup_campaign_id)
  assert.equal(resAll.created, true, 'scenario 7: all-create built a new follow-up campaign')
  assert.equal(resAll.original_campaign_id, 'all', 'scenario 7: all-create reports original_campaign_id = all')
  assert.equal(resAll.config, null, 'scenario 7: all-create has no single config row')
  const fuAllCampaign = await supabaseService.getCampaign(resAll.followup_campaign_id)
  assert.equal(fuAllCampaign.audience_segment, null, 'scenario 7: all-create follow-up has NO audience segment')

  const configA = await followupService.getFollowupConfig(origA.id)
  assert.equal(String(configA.followup_campaign_id), String(fuA), 'scenario 7: origA config NOT overwritten')
  const configB = await followupService.getFollowupConfig(origB.id)
  assert.equal(String(configB.followup_campaign_id), String(fuB), 'scenario 7: origB config NOT overwritten')

  const allResolved = await supabaseService.resolveFollowupRecipients(resAll.followup_campaign_id)
  assert.equal(allResolved.isFollowup, true, 'scenario 7: all-follow-up campaign is a follow-up')

  console.log('ALL ACCEPTANCE SCENARIOS PASSED')
  console.log(`SMTP stub delivered: ${smtpDelivered().join(', ')}`)
}

try {
  await main()
  console.log('RESULT: PASS')
  process.exitCode = 0
} catch (error) {
  console.error('RESULT: FAIL')
  console.error(error)
  process.exitCode = 1
} finally {
  await cleanup()
  if (server) server.close()
}
