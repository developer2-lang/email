import { describe, it, expect } from 'vitest';
import { normalizeMasterRow, buildImportPreview } from './masterImport';

describe('Master Database import email mapping', () => {
  it('uses Email ID 1 and ignores the CRM "Email address" column', () => {
    const row = {
      Company: 'Vardhmam Electrical Appliances',
      'Client Name': 'Vineet Jain',
      'Email ID 1': 'vineet.jain@lazerindia.com',
      'Email ID 2': 'blank',
      'Email address': 'crm@iuova.in',
    };

    const m = normalizeMasterRow(row);

    expect(m.fullName).toBe('Vineet Jain');
    expect(m.company).toBe('Vardhmam Electrical Appliances');
    expect(m.email).toBe('vineet.jain@lazerindia.com');
    // The CRM/org email must NOT leak into the contact email.
    expect(m.email).not.toBe('crm@iuova.in');
    // But it should still be surfaced in the notes for reference.
    expect(m.notes).toContain('Email address: crm@iuova.in');
  });

  it('falls back to Email ID 2 when Email ID 1 is blank', () => {
    const row = {
      'Client Name': 'Asha Mehta',
      'Email ID 1': 'NA',
      'Email ID 2': 'asha.mehta@acme.com',
      'Email address': 'crm@iuova.in',
    };

    const m = normalizeMasterRow(row);
    expect(m.email).toBe('asha.mehta@acme.com');
  });

  it('treats every listed sentinel in Email ID 1/2 as missing and ignores CRM email', () => {
    const sentinels = ['blank', 'NA', 'N/A', '-', '—', 'null', 'undefined', 'crm@iuova.in'];
    for (const s of sentinels) {
      const row = {
        'Client Name': 'No Email Contact',
        'Email ID 1': s,
        'Email ID 2': s,
        'Email address': 'crm@iuova.in',
      };
      const m = normalizeMasterRow(row);
      expect(m.email).toBe('');
    }
  });

  it('marks a contact as Missing Email when only the CRM email is present', () => {
    const rows = [
      {
        'Client Name': 'Only Crm',
        'Email ID 1': '',
        'Email ID 2': '',
        'Email address': 'crm@iuova.in',
      },
    ];
    const preview = buildImportPreview(rows, []);
    expect(preview[0].email).toBe('');
    expect(preview[0].status).toBe('Missing Email');
  });
});
