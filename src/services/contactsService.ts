import { supabase } from '../supabase'
import type { Contact, ContactInput, ContactRow } from '../types/contact'

const TABLE = 'contacts'

function toInsertRow(input: ContactInput) {
  return {
    full_name: input.full_name.trim(),
    email: input.email.trim().toLowerCase(),
    company: input.company.trim(),
    designation: input.designation?.trim() || null,
    industry: input.industry?.trim() || null,
    city: input.city?.trim() || null,
    contact_type: input.contact_type || 'New Lead',
    company_category: input.company_category || 'OEM',
    notes: input.notes?.trim() || null,
  }
}

function mapRowToContact(row: ContactRow): Contact {
  return {
    id: String(row.id),
    name: row.full_name || '',
    company: row.company || '',
    email: (row.email || '').toLowerCase().trim(),
    designation: row.designation || '',
    industry: row.industry || '',
    city: row.city || '',
    type: row.contact_type || '',
    category: row.company_category || 'OEM',
    notes: row.notes || '',
    lastContacted: '',
    engagement: 0,
    enriched: false,
  }
}

export async function fetchContacts(): Promise<{ data: Contact[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return { data: [], error: error.message }
    const rows = (data as ContactRow[] | null) ?? []
    return { data: rows.map(mapRowToContact), error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch contacts' }
  }
}

export async function insertContact(input: ContactInput): Promise<{ data: Contact | null; error: string | null }> {
  try {
    const { data, error } = await supabase.from(TABLE).insert(toInsertRow(input)).select('*')

    if (error) return { data: null, error: error.message }
    const row = Array.isArray(data) && data.length > 0 ? (data[0] as ContactRow) : null
    return { data: row ? mapRowToContact(row) : null, error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to add contact' }
  }
}

export async function updateContact(id: string, input: ContactInput): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).update(toInsertRow(input)).eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update contact' }
  }
}

export async function deleteContact(id: string): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).delete().eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete contact' }
  }
}

export async function deleteContacts(ids: string[]): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).delete().in('id', ids)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete contacts' }
  }
}

export async function insertContacts(inputs: ContactInput[]): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).insert(inputs.map(toInsertRow))
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to import contacts' }
  }
}

/**
 * Bulk import that maps rows from a Master Database export to contact fields.
 * Matching is done primarily by email address (case-insensitive):
 *   - No existing contact with that email -> insert a new contact.
 *   - Existing contact found           -> merge, filling only the fields that
 *     are currently empty in the database with source values. Existing populated
 *     values are preserved (never overwritten with blank data).
 *
 * Returns counts of newly inserted vs merged/updated records.
 */
export async function upsertContactsByEmail(inputs: ContactInput[]): Promise<{
  inserted: number
  updated: number
  error: string | null
}> {
  if (inputs.length === 0) return { inserted: 0, updated: 0, error: null }

  try {
    const { data: existing, error: fetchErr } = await fetchContacts()
    if (fetchErr) return { inserted: 0, updated: 0, error: fetchErr }

    // Merge rows that share an email *within the same import batch* so a
    // duplicate in the file does not produce two DB writes. Later rows only
    // fill fields left empty by earlier rows (never overwrite with blanks).
    const byEmail = new Map<string, ContactInput>()
    for (const input of inputs) {
      const key = (input.email || '').toLowerCase().trim()
      if (!key) continue
      const prev = byEmail.get(key)
      if (!prev) {
        byEmail.set(key, { ...input })
        continue
      }
      byEmail.set(key, {
        full_name: (prev.full_name || '').trim() || input.full_name,
        email: input.email,
        company: (prev.company || '').trim() || input.company,
        designation: (prev.designation || '').trim() || input.designation || null,
        industry: (prev.industry || '').trim() || input.industry || null,
        city: (prev.city || '').trim() || input.city || null,
        contact_type: (prev.contact_type || '').trim() || input.contact_type,
        company_category: (prev.company_category || '').trim() || input.company_category,
        notes: (prev.notes || '').trim() || input.notes || null,
      })
    }

    const existingByEmail = new Map<string, Contact>()
    for (const c of existing) existingByEmail.set((c.email || '').toLowerCase(), c)

    let inserted = 0
    let updated = 0

    for (const input of byEmail.values()) {
      const key = (input.email || '').toLowerCase().trim()
      const ex = existingByEmail.get(key)

      if (!ex) {
        const { error } = await insertContact(input)
        if (error) return { inserted, updated, error }
        inserted++
      } else {
        const merged: ContactInput = {
          full_name: (ex.name || '').trim() || input.full_name,
          email: input.email,
          company: (ex.company || '').trim() || input.company,
          designation: (ex.designation || '').trim() || input.designation || null,
          industry: (ex.industry || '').trim() || input.industry || null,
          city: (ex.city || '').trim() || input.city || null,
          contact_type: (ex.type || '').trim() || input.contact_type,
          company_category: (ex.category || '').trim() || input.company_category,
          notes: (ex.notes || '').trim() || input.notes || null,
        }
        const { error } = await updateContact(ex.id, merged)
        if (error) return { inserted, updated, error }
        updated++
      }
    }

    return { inserted, updated, error: null }
  } catch (err) {
    return {
      inserted: 0,
      updated: 0,
      error: err instanceof Error ? err.message : 'Failed to import contacts',
    }
  }
}

// ─── Contact Types synchronization ──────────────────────────────────────────
// Keep `contact_types` in sync with the distinct values actually present in
// `contacts.contact_type`. This is one-directional (contacts are the source of
// truth for the set of types) and append-only:
//   - existing rows in `contact_types` are never modified or removed here
//   - only MISSING distinct contact_type values are inserted
//   - `contact_types.name` carries a UNIQUE constraint, so a duplicate can
//     never be created even if this runs concurrently
// The loop is bounded: read distinct types → read existing types → compute the
// missing set → insert only the missing → stop. It never re-triggers itself.
export async function syncContactTypes(): Promise<{ error: string | null }> {
  try {
    // 1) Distinct non-empty contact_type values from contacts.
    const { data: rows, error: cErr } = await supabase
      .from('contacts')
      .select('contact_type');
    if (cErr) return { error: cErr.message };

    const distinct = new Set<string>();
    for (const r of (rows as { contact_type: string | null }[]) || []) {
      const t = r.contact_type;
      // Ignore NULL, empty strings, and whitespace-only values.
      if (t && t.trim().length > 0) distinct.add(t.trim());
    }
    if (distinct.size === 0) return { error: null };

    // 2) Existing contact_types names (used to avoid re-inserting duplicates).
    const { data: types, error: tErr } = await supabase
      .from('contact_types')
      .select('name');
    if (tErr) return { error: tErr.message };

    const known = new Set<string>();
    for (const r of (types as { name: string | null }[]) || []) {
      if (r.name != null) known.add(r.name.trim());
    }

    // 3) Compute the missing values (exact contact_type string is used as name).
    const missing = Array.from(distinct).filter((v) => !known.has(v));
    if (missing.length === 0) return { error: null };

    // 4) Insert only the missing values. Duplicate errors (from the UNIQUE
    //    constraint) are expected and ignored — they can occur if another
    //    sync inserted the same value between our read and write.
    for (const name of missing) {
      const { error } = await supabase
        .from('contact_types')
        .insert({ name, is_active: true });
      if (error && !/duplicate|unique/i.test(error.message)) {
        return { error: error.message };
      }
    }

    return { error: null };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to sync contact types',
    };
  }
}

// ─── Contact Types (segments) ───────────────────────────────────────────────
// A "list" in the UI is really a contact TYPE / segment. These live in the
// existing `contact_types` table (columns: id, name, is_active, created_at).
// We never create or write to a `contact_lists` table — contacts reference a
// type by the `contacts.contact_type` TEXT value matching `contact_types.name`.

/** Create a new contact type / segment. Returns the created row. */
export async function createContactType(
  name: string
): Promise<{ data: { id: string; name: string; is_active: boolean } | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('contact_types')
      .insert({
        name: name.trim(),
        is_active: true,
      })
      .select('id, name, is_active')
      .single()

    if (error) return { data: null, error: error.message }
    const row = data as { id: any; name: string; is_active: boolean }
    return {
      data: { id: String(row.id), name: row.name, is_active: row.is_active },
      error: null,
    }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to create contact type' }
  }
}

/** Fetch the active contact types (segments) from the existing `contact_types`
 *  table. Single source of truth shared by the Contacts tabs and the Contact
 *  Types management page. */
export async function fetchContactTypes(): Promise<{
  data: { id: string; name: string }[];
  error: string | null;
}> {
  try {
    const { data, error } = await supabase
      .from('contact_types')
      .select('id, name, is_active')
      .eq('is_active', true)
      .order('name');
    if (error) return { data: [], error: error.message };
    const rows = (data as { id: any; name: string }[]).map((r) => ({
      id: String(r.id),
      name: r.name,
    }));
    return { data: rows, error: null };
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to load contact types' };
  }
}

/** Rename a contact type and keep its contacts assigned.
 *  The relationship is the denormalized `contacts.contact_type` TEXT column, so
 *  after renaming the row we also update every contact that referenced the old
 *  name — the tab/filter on the Contacts page must reflect the new name. */
export async function renameContactType(
  id: string,
  oldName: string,
  newName: string
): Promise<{ data: { id: string; name: string } | null; error: string | null }> {
  try {
    const trimmed = newName.trim();
    if (!trimmed) return { data: null, error: 'Name is required' };

    const { data, error } = await supabase
      .from('contact_types')
      .update({ name: trimmed })
      .eq('id', id)
      .select('id, name')
      .single();

    if (error) return { data: null, error: error.message };

    // Keep the denormalized relationship in sync (no FK exists between the two
    // tables, so we must update the contact rows by the old name).
    if (oldName && oldName !== trimmed) {
      const { error: updErr } = await supabase
        .from('contacts')
        .update({ contact_type: trimmed })
        .eq('contact_type', oldName);
      if (updErr) {
        // Roll back the rename so the two stay consistent.
        await supabase.from('contact_types').update({ name: oldName }).eq('id', id);
        return { data: null, error: updErr.message };
      }
    }

    const row = data as { id: any; name: string };
    return { data: { id: String(row.id), name: row.name }, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to rename contact type' };
  }
}

/** Delete a contact type.
 *  CRITICAL: this NEVER deletes contacts. It removes the `contact_types` row and
 *  clears the `contact_type` assignment (set to NULL) on any contacts that
 *  referenced it. The contacts themselves remain in the `contacts` table and
 *  continue to appear under "All Contacts". There is no FK / cascade that could
 *  touch the contacts table. */
export async function deleteContactType(
  id: string,
  name: string
): Promise<{ error: string | null }> {
  try {
    // 1) Unassign contacts first. If this fails we must not delete the type.
    const { error: unassignErr } = await supabase
      .from('contacts')
      .update({ contact_type: null })
      .eq('contact_type', name);
    if (unassignErr) {
      return { error: unassignErr.message };
    }

    // 2) Remove the type record itself.
    const { error } = await supabase.from('contact_types').delete().eq('id', id);
    if (error) return { error: error.message };

    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete contact type' };
  }
}

/** Count contacts per contact type.
 *  Relationship = `contacts.contact_type` (TEXT) matching `contact_types.name`.
 *  Returns a map of name → count. Contacts with NULL type are not counted under
 *  any type (they live only under "All Contacts"). */
export async function fetchContactTypeCounts(): Promise<{
  data: Record<string, number>;
  error: string | null;
}> {
  try {
    const { data, error } = await supabase.from('contacts').select('contact_type');
    if (error) return { data: {}, error: error.message };
    const counts: Record<string, number> = {};
    for (const row of data as { contact_type: string | null }[]) {
      const t = row.contact_type;
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
    return { data: counts, error: null };
  } catch (err) {
    return { data: {}, error: err instanceof Error ? err.message : 'Failed to load contact counts' };
  }
}

