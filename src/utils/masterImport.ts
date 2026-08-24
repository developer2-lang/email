// ─── MASTER DATABASE IMPORT MAPPING ────────────────────────────────────────
// Pure, framework-free mapping of a Master Database export row onto the
// contact fields. Kept separate from the React UI so it can be unit-tested.

import type { Contact } from '../types/contact';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Source values that mean "no real value" for an email field. These are
 * treated as empty so they never get mistaken for a usable address.
 */
const EMAIL_EMPTY_SENTINELS = new Set([
  'na', 'n/a', '-', '—', 'nil', 'none', 'null', 'unknown', 'not available', '',
  'blank', 'undefined',
  // Generic organizational / CRM sender email — never a contact's address.
  'crm@iuova.in',
]);

/**
 * Generic organizational / CRM sender emails that must never be stored as a
 * contact's personal email, even if they appear in a person-email column.
 */
const GENERIC_ORG_EMAILS = new Set([
  'crm@iuova.in',
]);

/**
 * Normalise a header key so we can match column names regardless of casing,
 * spaces, dashes or underscores. e.g. "Client Type", "client type" and
 * "client_type" all collapse to the same match token.
 */
function keyToken(key: string): string {
  return String(key).toLowerCase().replace(/[\s_\-./]+/g, '');
}

/** Resolve the actual source header on a row that matches the given token. */
function resolveKey(row: any, key: string): string | undefined {
  const want = keyToken(key);
  if (row && Object.prototype.hasOwnProperty.call(row, key)) return key;
  for (const k of Object.keys(row || {})) {
    if (keyToken(k) === want) return k;
  }
  return undefined;
}

/**
 * Pull the first non-empty trimmed value for any of the candidate headers.
 * Header matching is case / space / underscore insensitive so the importer
 * recognises "Client Type", "client type" and "client_type" identically.
 */
function pickValue(row: any, ...keys: string[]): string {
  for (const k of keys) {
    const mk = resolveKey(row, k);
    if (mk !== undefined) {
      const v = row[mk];
      if (v !== undefined && v !== null) {
        const s = String(v).trim();
        if (s) return s;
      }
    }
  }
  return '';
}

/**
 * Like pickValue but for email addresses: ignores blank values AND common
 * placeholder sentinels ("NA", "N/A", "-", etc.) so they are never stored as
 * a contact's email. Returns the address lowercased.
 */
function pickEmail(row: any, ...keys: string[]): string {
  for (const k of keys) {
    const mk = resolveKey(row, k);
    if (mk !== undefined) {
      const v = row[mk];
      if (v !== undefined && v !== null) {
        const s = String(v).trim().toLowerCase();
        if (s && !EMAIL_EMPTY_SENTINELS.has(s) && !GENERIC_ORG_EMAILS.has(s)) {
          return s;
        }
      }
    }
  }
  return '';
}

export interface MappedContact {
  fullName: string;
  email: string;
  company: string;
  designation: string;
  industry: string;
  city: string;
  contactType: string;
  companyCategory: string;
  notes: string;
  status: 'Ready' | 'Missing Email' | 'Duplicate' | 'Invalid';
}

/**
 * Map a single raw Master Database row onto the contact fields used by the
 * Add New Contact form. Handles all requested fallbacks and normalisation:
 *   - Prefer Email ID 1, fall back to Email ID 2.
 *   - The "Email address" column is the CRM/organization email and is NEVER
 *     used as the contact's email (it is only surfaced in Notes).
 *   - Department used as Industry when Industry is unavailable.
 *   - Company resolved from "Company Name" or "Column 2".
 *   - Emails trimmed + lowercased; all text fields trimmed.
 *   - Contact Type / Company Category coerced to valid dropdown options.
 *   - Missing data is never invented.
 */
function normalizeMasterRow(row: any): MappedContact {
  const fullName = pickValue(row, 'Client Name', 'Full Name', 'Name');

  // Email: prefer "Email ID 1", fall back to "Email ID 2". The "Email address"
  // column (crm@iuova.in) is the CRM/organization sender address and is NOT a
  // contact's personal email, so it is completely ignored here.
  const email =
    pickEmail(row, 'Email ID 1') ||
    pickEmail(row, 'Email ID 2');

  const company = pickValue(row, 'Company Name', 'Column 2', 'Company');
  const designation = pickValue(row, 'Designation');
  const industry = pickValue(row, 'Industry') || pickValue(row, 'Department');
  const city = pickValue(row, 'City');
  const contactTypeRaw = pickValue(row, 'Client Type', 'Contact Type');
  const companyCategoryRaw = pickValue(row, 'Company Category', 'Category');

  // Build Notes & Context from the other useful source columns so nothing
  // important from the Master Database is silently dropped on import. The
  // "Email address" column is included here for reference only.
  const noteParts: string[] = [];
  const noteCols = [
    'Project Status',
    'Source of Client Lead',
    'Contact Number 1',
    'Contact Number 2',
    'Email address',
    'Other useful source information',
    'Notes & Context',
    'Notes',
  ];
  for (const c of noteCols) {
    const v = pickValue(row, c);
    if (v) noteParts.push(`${c}: ${v}`);
  }
  const notes = noteParts.join(' | ');

  // Preserve the original source classification verbatim. We only fall back to
  // "New Lead" when the source has no usable client/contact type at all — we
  // never overwrite a real classification with a default.
  const contactType = contactTypeRaw ? contactTypeRaw : 'New Lead';

  // Only default to "Domestic" when the source has no company category. A real
  // category from the spreadsheet is preserved as-is.
  const companyCategory = companyCategoryRaw ? companyCategoryRaw : 'Domestic';

  return {
    fullName,
    email,
    company,
    designation,
    industry,
    city,
    contactType,
    companyCategory,
    notes,
    status: 'Ready',
  };
}

/**
 * Build the import preview: map every source row and assign a validation
 * status. Duplicates are detected against existing contacts (by email) and
 * against earlier rows in the same file.
 */
function buildImportPreview(rows: any[], existingContacts: Contact[]): MappedContact[] {
  const existingEmails = new Set(
    existingContacts.map(c => (c.email || '').toLowerCase().trim()).filter(Boolean)
  );
  const fileSeen = new Set<string>();

  return rows.map(row => {
    const m = normalizeMasterRow(row);

    if (!m.email) {
      m.status = 'Missing Email';
    } else if (!EMAIL_RE.test(m.email)) {
      m.status = 'Invalid';
    } else if (existingEmails.has(m.email) || fileSeen.has(m.email)) {
      m.status = 'Duplicate';
    } else {
      m.status = 'Ready';
    }

    if (m.email) fileSeen.add(m.email);
    return m;
  });
}

export {
  EMAIL_RE,
  EMAIL_EMPTY_SENTINELS,
  keyToken,
  resolveKey,
  pickValue,
  pickEmail,
  normalizeMasterRow,
  buildImportPreview,
};
