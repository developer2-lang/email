import { describe, it, expect } from 'vitest';
import {
  resolveSegmentRecipients,
  contactMatchesSegment,
  isDeliverableRecipientEmail,
} from './contactSegment';

// Contacts shaped exactly like the DB rows the senders resolve against.
// `company_category` is present but MUST NOT be used for audience filtering.
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
  // A contact_type used to prove a 0-recipient segment does not send.
  { id: '12', contact_type: 'Test Client', company_category: 'OEM', email: 'h@test.com' },
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

describe('direct contact_type matching (requirement: segment === contacts.contact_type)', () => {
  it('New Lead (1) -> only contacts whose contact_type is exactly "New Lead"', () => {
    // id 10 has example.com (non-deliverable) so only 5,6 remain valid.
    const ids = resolveSegmentRecipients(contacts, 'New Lead').map((c) => c.id);
    expect(ids).toEqual(['5', '6']);
  });

  it('Existing Client (Vatsal/ Shubham) (1) -> exact contact_type match', () => {
    const ids = resolveSegmentRecipients(contacts, 'Existing Client (Vatsal/ Shubham)').map((c) => c.id);
    expect(ids).toEqual(['1', '2']);
  });

  it('New Client - Inbound (1) -> exact contact_type match', () => {
    // id 8 has empty email and 11 duplicates id 3's email -> only 3.
    const ids = resolveSegmentRecipients(contacts, 'New Client - Inbound').map((c) => c.id);
    expect(ids).toEqual(['3']);
  });

  it('New Client - Outbound (1) -> exact contact_type match', () => {
    // id 9 has a malformed email -> excluded.
    const ids = resolveSegmentRecipients(contacts, 'New Client - Outbound').map((c) => c.id);
    expect(ids).toEqual(['4']);
  });

  it('Test Client (1) -> exact contact_type match', () => {
    const ids = resolveSegmentRecipients(contacts, 'Test Client').map((c) => c.id);
    expect(ids).toEqual(['12']);
  });

  it('a specific segment NEVER expands to the whole audience', () => {
    expect(resolveSegmentRecipients(contacts, 'New Lead').length).toBeLessThan(contacts.length);
    expect(resolveSegmentRecipients(contacts, 'New Client - Inbound').length).toBeLessThan(contacts.length);
  });
});

describe('company_category is never used for audience filtering', () => {
  it('a company_category label resolves to 0 recipients (only contact_type is used)', () => {
    expect(resolveSegmentRecipients(contacts, 'OEM').length).toBe(0);
    expect(resolveSegmentRecipients(contacts, 'OEM Contacts').length).toBe(0);
    expect(resolveSegmentRecipients(contacts, 'International Clients').length).toBe(0);
  });

  it('OEM company_category contacts are NOT returned for any contact_type segment', () => {
    for (const seg of ['New Lead', 'New Client - Inbound', 'Existing Client (Vatsal/ Shubham)']) {
      const resolvedEmails = resolveSegmentRecipients(contacts, seg)
        .map((c) => String(c.email).trim().toLowerCase())
        .sort();
      const expectedEmails = Array.from(
        new Set(
          contacts
            .filter((c) => c.email && isDeliverableRecipientEmail(c.email) && c.contact_type === seg)
            .map((c) => String(c.email).trim().toLowerCase())
        )
      ).sort();
      expect(resolvedEmails).toEqual(expectedEmails);
    }
  });
});

describe('strict contact_type matching — a label that is not an exact contact_type resolves to 0', () => {
  it('generic labels ("New Clients", "Existing Clients Only", "New Leads") are NOT selectable segments and resolve to 0', () => {
    // The composer dropdown only offers exact contact_type values, so these
    // generic labels must not accidentally expand to a wider audience.
    expect(resolveSegmentRecipients(contacts, 'New Clients').length).toBe(0);
    expect(resolveSegmentRecipients(contacts, 'Existing Clients Only').length).toBe(0);
    expect(resolveSegmentRecipients(contacts, 'New Leads').length).toBe(0);
  });

  it('an unknown segment name resolves to 0 (never the whole audience)', () => {
    expect(resolveSegmentRecipients(contacts, 'Some Future Type').length).toBe(0);
  });
});

describe('All Contacts', () => {
  it('excludes invalid emails and dedupes - never sends to the whole raw table', () => {
    const ids = resolveSegmentRecipients(contacts, 'All Contacts').map((c) => c.id);
    // 12 total rows, but 8/9/10 are invalid and 11 is a duplicate of 3 -> 8 unique valid.
    expect(ids).toEqual(['1', '2', '3', '4', '5', '6', '7', '12']);
    expect(ids.length).toBe(8);
  });
});

describe('manual email list', () => {
  it('sends only to the listed, deliverable addresses', () => {
    const emails = resolveSegmentRecipients(contacts, 'e@lead.com, c@client.com')
      .map((c) => String(c.email).trim().toLowerCase())
      .sort();
    expect(emails).toEqual(['c@client.com', 'e@lead.com']);
  });
});

describe('count === send (single source of truth)', () => {
  it('the dropdown count is exactly the array the sender emails', () => {
    for (const seg of ['All Contacts', 'New Lead', 'New Client - Inbound', 'Test Client', 'Existing Client (Vatsal/ Shubham)']) {
      const resolved = resolveSegmentRecipients(contacts, seg);
      const matching = contacts
        .filter((c) => c.email && isDeliverableRecipientEmail(c.email) && contactMatchesSegment(c, seg))
        .map((c) => String(c.email).trim().toLowerCase());
      const resolvedEmails = resolved.map((c) => String(c.email).trim().toLowerCase()).sort();
      expect(resolvedEmails).toEqual(Array.from(new Set(matching)).sort());
      expect(resolved.length).toBe(new Set(matching).size);
    }
  });
});
