import { describe, it, expect } from 'vitest';
import {
  resolveSegmentRecipients,
  contactMatchesSegment,
  isDeliverableRecipientEmail,
} from './contactSegment';

// Contacts shaped exactly like the DB rows the senders resolve against.
const contacts = [
  { id: '1', contact_type: 'Existing Client (Vatsal/ Shubham)', company_category: 'OEM', email: 'a@client.com' },
  { id: '2', contact_type: 'Existing Client (Vatsal/ Shubham)', company_category: 'International', email: 'b@client.com' },
  { id: '3', contact_type: 'New Client - Inbound', company_category: 'OEM', email: 'c@client.com' },
  { id: '4', contact_type: 'New Client - Outbound', company_category: 'OEM', email: 'd@client.com' },
  { id: '5', contact_type: 'New Lead', company_category: 'OEM', email: 'e@lead.com' },
  { id: '6', contact_type: 'New Lead', company_category: 'International', email: 'f@lead.com' },
  { id: '7', contact_type: 'Prospect', company_category: 'OEM', email: 'g@prospect.com' },
  // Invalid / missing emails must NEVER be counted or sent.
  { id: '8', contact_type: 'New Client - Inbound', company_category: 'OEM', email: '' },
  { id: '9', contact_type: 'New Client - Outbound', company_category: 'OEM', email: 'not-an-email' },
  { id: '10', contact_type: 'New Lead', company_category: 'OEM', email: 'test@example.com' },
  // Duplicate email of id '3' must only be counted once.
  { id: '11', contact_type: 'New Client - Inbound', company_category: 'OEM', email: 'c@client.com' },
];

describe('email validity', () => {
  it('rejects empty / malformed / reserved-test addresses', () => {
    expect(isDeliverableRecipientEmail('')).toBe(false);
    expect(isDeliverableRecipientEmail('nope')).toBe(false);
    expect(isDeliverableRecipientEmail('a@b@c.com')).toBe(false);
    expect(isDeliverableRecipientEmail('foo@example.com')).toBe(false);
    expect(isDeliverableRecipientEmail('a@client.com')).toBe(true);
  });
});

describe('resolveSegmentRecipients — count === send (no invalid, no dupes)', () => {
  it('New Clients: 206-style — only New Client category with valid unique emails', () => {
    const recipients = resolveSegmentRecipients(contacts, 'New Clients');
    // ids 3,4 (valid) + id 11 duplicates id 3's email (dropped) + id 8 (empty) + id 9 (bad) excluded.
    const ids = recipients.map((c) => c.id);
    expect(ids).toEqual(['3', '4']);
    expect(recipients.length).toBe(2);
    // The count the UI shows is the same array the sender emails.
    expect(resolveSegmentRecipients(contacts, 'New Clients').length).toBe(recipients.length);
  });

  it('Existing Clients Only', () => {
    expect(resolveSegmentRecipients(contacts, 'Existing Clients Only').map((c) => c.id)).toEqual(['1', '2']);
  });

  it('New Leads', () => {
    // id 10 has example.com (non-deliverable) so only 5,6 remain.
    expect(resolveSegmentRecipients(contacts, 'New Leads').map((c) => c.id)).toEqual(['5', '6']);
  });

  it('OEM Contacts', () => {
    expect(resolveSegmentRecipients(contacts, 'OEM Contacts').map((c) => c.id)).toEqual(['1', '3', '4', '5', '7']);
  });

  it('International Clients', () => {
    expect(resolveSegmentRecipients(contacts, 'International Clients').map((c) => c.id)).toEqual(['2', '6']);
  });

  it('All Contacts excludes invalid emails and dedupes, never sends to the whole raw table', () => {
    const ids = resolveSegmentRecipients(contacts, 'All Contacts').map((c) => c.id);
    // 11 total rows, but 8/9/10 are invalid and 11 is a duplicate of 3.
    expect(ids).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(ids.length).toBe(7);
  });

  it('a specific segment never expands to the entire audience', () => {
    expect(resolveSegmentRecipients(contacts, 'New Leads').length).toBeLessThan(contacts.length);
  });

  it('resolveSegmentRecipients = unique deliverable emails of matching contacts', () => {
    for (const seg of ['Existing Clients Only', 'New Clients', 'New Leads', 'OEM Contacts', 'International Clients']) {
      const resolvedEmails = resolveSegmentRecipients(contacts, seg)
        .map((c) => String(c.email).trim().toLowerCase())
        .sort();
      const matchingEmails = Array.from(
        new Set(
          contacts
            .filter((c) => c.email && isDeliverableRecipientEmail(c.email) && contactMatchesSegment(c, seg))
            .map((c) => String(c.email).trim().toLowerCase())
        )
      ).sort();
      expect(resolvedEmails).toEqual(matchingEmails);
      // The dropdown count is exactly the array the sender emails.
      expect(
        resolveSegmentRecipients(contacts, seg).length
      ).toBe(matchingEmails.length);
    }
  });
});
