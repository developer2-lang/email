/**
 * Automatic-mode follow-up verification (integration).
 *
 * Uses a LIVE Supabase instance but a STUB SMTP server (127.0.0.1:2525) — no
 * real email is ever sent.
 *
 * Covers:
 *   - Creation-time backfill (Trigger 1): existing openers get the follow-up
 *     IMMEDIATELY, unopened recipients are never emailed.
 *   - Live open (Trigger 2): a future opener is emailed immediately.
 *   - Duplicate protection: re-opening an already-sent opener sends nothing.
 *
 * Run:  node test/followup-automatic-verify.mjs   (from backend/)
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
      let authStep = 0
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

const supabaseService = await import('../services/supabaseService.js')
const followupService = await import('../services/followupService.js')
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
      full_name: 'Auto Test',
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

async function main() {
  server = await startSmtpServer()
  const ts = Date.now()
  const prefix = `__auto_${ts}`

  const contacts = []
  for (let i = 0; i < 5; i++) contacts.push(await insertContact(`${prefix}_${i}@example.com`))

  const orig = await insertCampaign(`${prefix}_orig`)
  // 3 opened, 2 NOT opened (must never receive the follow-up).
  await seedEmailLogs(orig.id, contacts, [contacts[0].id, contacts[1].id, contacts[2].id])

  // ── AUTOMATIC create: 3 existing openers → 3 follow-ups immediately ──
  const before = smtpCount()
  const res = await followupService.createFollowupConfig({
    original_campaign_id: orig.id,
    campaign_name: `${prefix}_fu`,
    subject_line: 'Follow-up',
    from_name: 'Test Sender',
    html_content: '<p>Follow-up body</p>',
    campaign_type: 'Follow Up',
    followup_mode: 'automatic',
    is_active: true,
  })
  createdCampaigns.push(res.followup_campaign_id)

  const a = res.automatic
  console.log('CREATE RESULT:', JSON.stringify(a))
  assert.ok(a, 'automatic result present')
  assert.equal(a.openers, 3, `Openers = 3 (got ${a.openers})`)
  assert.equal(a.sent, 3, `Sent = 3 (got ${a.sent})`)
  assert.equal(a.eligible, 0, `Eligible = 0 (got ${a.eligible})`)
  assert.equal(a.delivered, 3, `Delivered = 3 (got ${a.delivered})`)
  assert.equal(a.failed, 0, `Failed = 0 (got ${a.failed})`)
  assert.equal(smtpCount() - before, 3, 'EXACTLY 3 emails over SMTP (unopened excluded)')

  const sentTo = delivered.slice(before).map((d) => d.to).sort()
  const expectTo = [contacts[0].email, contacts[1].email, contacts[2].email].sort()
  assert.deepEqual(sentTo, expectTo, 'follow-up went ONLY to the 3 openers')

  // ── Trigger 2: a FUTURE opener opens the original → immediate follow-up ──
  const beforeLive = smtpCount()
  await client.from('email_logs').update({ opened: true, opened_at: new Date().toISOString() })
    .eq('campaign_id', orig.id).eq('contact_id', contacts[3].id)
  await followupService.handleOpenFollowup(orig.id, contacts[3].id, contacts[3].email)
  assert.equal(smtpCount() - beforeLive, 1, 'future opener → exactly 1 immediate follow-up')
  assert.equal(delivered[delivered.length - 1].to, contacts[3].email, 'future opener got the follow-up')

  // ── Duplicate protection: re-open an already-sent opener → NO second email ──
  const beforeDup = smtpCount()
  await followupService.handleOpenFollowup(orig.id, contacts[0].id, contacts[0].email)
  assert.equal(smtpCount() - beforeDup, 0, 'duplicate (re-open) sends nothing')

  // ── TEST 2 equivalent: 0 openers → 0 sent ──
  const contacts2 = []
  for (let i = 0; i < 3; i++) contacts2.push(await insertContact(`${prefix}_b${i}@example.com`))
  const orig2 = await insertCampaign(`${prefix}_orig2`)
  await seedEmailLogs(orig2.id, contacts2, []) // 0 opened
  const res2 = await followupService.createFollowupConfig({
    original_campaign_id: orig2.id,
    campaign_name: `${prefix}_fu2`,
    subject_line: 'Follow-up 2',
    from_name: 'Test Sender',
    html_content: '<p>Follow-up body 2</p>',
    campaign_type: 'Follow Up',
    followup_mode: 'automatic',
    is_active: true,
  })
  createdCampaigns.push(res2.followup_campaign_id)
  console.log('CREATE2 RESULT:', JSON.stringify(res2.automatic))
  assert.equal(res2.automatic.openers, 0, 'Openers = 0 for no-opener original')
  assert.equal(res2.automatic.sent, 0, 'Sent = 0 for no-opener original')

  console.log('AUTOMATIC FOLLOW-UP VERIFICATION PASSED')
  console.log(`SMTP stub delivered total: ${smtpCount()}`)
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
