import { describe, it, expect } from 'vitest';
import {
  normalizeContactType,
  contactMatchesSegment,
  filterContactsBySegment,
} from './contactSegment';

// Representative of the ACTUAL values stored in the Contacts table — these do
// NOT equal the segment labels, which is the root of the original bug.
const contacts = [
  { id: '1', contact_type: 'Existing Client (Vatsal/ Shubham)', company_category: 'OEM' },
  { id: '2', contact_type: 'Existing Client (Vatsal/ Shubham)', company_category: 'International' },
  { id: '3', contact_type: 'New Client - Inbound', company_category: 'OEM' },
  { id: '4', contact_type: 'New Client - Outbound', company_category: 'OEM' },
  { id: '5', contact_type: 'New Lead', company_category: 'OEM' },
  { id: '6', contact_type: 'New Lead', company_category: 'International' },
  { id: '7', contact_type: 'Prospect', company_category: 'OEM' },
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

describe('contactMatchesSegment (category prefix matching)', () => {
  it('Existing Clients Only matches any existing-client contact_type', () => {
    const matched = contacts.filter((c) => contactMatchesSegment(c, 'Existing Clients Only'));
    expect(matched.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('New Clients matches New Client - Inbound / Outbound (and plain New Client)', () => {
    expect(contactMatchesSegment({ contact_type: 'New Client' }, 'New Clients')).toBe(true);
    expect(contactMatchesSegment({ contact_type: 'New Client - Inbound' }, 'New Clients')).toBe(true);
    expect(contactMatchesSegment({ contact_type: 'New Client - Outbound' }, 'New Clients')).toBe(true);
    // Does NOT match Existing Client or New Lead.
    expect(contactMatchesSegment({ contact_type: 'Existing Client (X)' }, 'New Clients')).toBe(false);
    expect(contactMatchesSegment({ contact_type: 'New Lead' }, 'New Clients')).toBe(false);
  });

  it('New Leads matches normalized new lead only', () => {
    const matched = contacts.filter((c) => contactMatchesSegment(c, 'New Leads'));
    expect(matched.map((c) => c.id)).toEqual(['5', '6']);
  });

  it('OEM Contacts matches company_category OEM', () => {
    const matched = contacts.filter((c) => contactMatchesSegment(c, 'OEM Contacts'));
    expect(matched.map((c) => c.id)).toEqual(['1', '3', '4', '5', '7']);
  });

  it('International Clients matches company_category International', () => {
    const matched = contacts.filter((c) => contactMatchesSegment(c, 'International Clients'));
    expect(matched.map((c) => c.id)).toEqual(['2', '6']);
  });

  it('works with the frontend Contact shape (type/category)', () => {
    const matched = mappedContacts.filter((c) => contactMatchesSegment(c, 'Existing Clients Only'));
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
      'OEM Contacts',
      'International Clients',
    ]) {
      const filtered = filterContactsBySegment(contacts, seg);
      const counted = contacts.filter((c) => contactMatchesSegment(c, seg)).length;
      expect(filtered.length).toBe(counted);
    }
  });
});
