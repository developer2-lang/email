import { describe, it, expect } from 'vitest';
import {
  normalizeContactType,
  contactMatchesSegment,
  filterContactsBySegment,
} from './contactSegment';

// Representative of the ACTUAL values stored in the Contacts table. The Audience
// Segment is DIRECTLY connected to `contacts.contact_type` — `company_category`
// is never used for filtering.
const contacts = [
  { id: '1', contact_type: 'Existing Client (Vatsal/ Shubham)', company_category: 'OEM' },
  { id: '2', contact_type: 'Existing Client (Vatsal/ Shubham)', company_category: 'International' },
  { id: '3', contact_type: 'New Client - Inbound', company_category: 'OEM' },
  { id: '4', contact_type: 'New Client - Outbound', company_category: 'OEM' },
  { id: '5', contact_type: 'New Lead', company_category: 'OEM' },
  { id: '6', contact_type: 'New Lead', company_category: 'International' },
  { id: '7', contact_type: 'Prospect', company_category: 'OEM' },
  { id: '8', contact_type: 'Test Client', company_category: 'OEM' },
];

// The frontend Contact shape uses `type` / `category` instead of
// contact_type / company_category — the helper must accept both.
const mappedContacts = contacts.map((c) => ({
  id: c.id,
  type: c.contact_type,
  category: c.company_category,
}));

describe('normalizeContactType', () => {
  it('trims and lowercases, and treats null/undefined as empty', () => {
    expect(normalizeContactType('  Existing Client  ')).toBe('existing client');
    expect(normalizeContactType(null)).toBe('');
    expect(normalizeContactType(undefined)).toBe('');
  });
});

describe('contactMatchesSegment — direct contact_type matching', () => {
  it('exact contact_type match is the source of truth', () => {
    expect(contactMatchesSegment({ contact_type: 'New Lead' }, 'New Lead')).toBe(true);
    expect(
      contactMatchesSegment({ contact_type: 'Existing Client (Vatsal/ Shubham)' }, 'Existing Client (Vatsal/ Shubham)')
    ).toBe(true);
    expect(contactMatchesSegment({ contact_type: 'New Client - Inbound' }, 'New Client - Inbound')).toBe(true);
    // A different contact_type does NOT match.
    expect(contactMatchesSegment({ contact_type: 'Existing Client (X)' }, 'New Lead')).toBe(false);
  });

  it('Existing Clients Only (generic label) does NOT match via prefix — only exact contact_type matches', () => {
    // "Existing Clients Only" is not an exact contact_type value, so it matches
    // nothing (the composer only offers exact contact_type segments).
    const matched = contacts.filter((c) => contactMatchesSegment(c, 'Existing Clients Only'));
    expect(matched.map((c) => c.id)).toEqual([]);
  });

  it('New Clients / New Leads (generic labels) do not over-match contact_types', () => {
    // A specific contact_type matches ONLY itself.
    expect(contactMatchesSegment({ contact_type: 'New Client - Inbound' }, 'New Clients')).toBe(false);
    expect(contactMatchesSegment({ contact_type: 'New Lead' }, 'New Leads')).toBe(false);
    // Exact contact_type still matches.
    expect(contactMatchesSegment({ contact_type: 'New Lead' }, 'New Lead')).toBe(true);
  });

  it('company_category is NEVER used for audience filtering', () => {
    // Even though these contacts have company_category OEM / International,
    // selecting those labels must NOT match any contact.
    expect(contacts.filter((c) => contactMatchesSegment(c, 'OEM')).length).toBe(0);
    expect(contacts.filter((c) => contactMatchesSegment(c, 'OEM Contacts')).length).toBe(0);
    expect(contacts.filter((c) => contactMatchesSegment(c, 'International Clients')).length).toBe(0);
    // A contact with company_category OEM but contact_type New Lead is NOT
    // matched by the "OEM" label.
    expect(contactMatchesSegment(contacts[4], 'OEM')).toBe(false);
  });

  it('works with the frontend Contact shape (type/category)', () => {
    const matched = mappedContacts.filter((c) => contactMatchesSegment(c, 'Existing Client (Vatsal/ Shubham)'));
    expect(matched.map((c) => c.id)).toEqual(['1', '2']);
  });
});

describe('filterContactsBySegment', () => {
  it('All Contacts returns everyone', () => {
    expect(filterContactsBySegment(contacts, 'All Contacts').length).toBe(contacts.length);
  });

  it('count and filter agree for every segment', () => {
    for (const seg of [
      'All Contacts',
      'Existing Clients Only',
      'New Clients',
      'New Leads',
      'New Lead',
      'New Client - Inbound',
      'Test Client',
    ]) {
      const filtered = filterContactsBySegment(contacts, seg);
      const counted = contacts.filter((c) => contactMatchesSegment(c, seg)).length;
      expect(filtered.length).toBe(counted);
    }
  });
});
