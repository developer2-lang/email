import { supabase } from '../supabase'
import type { Contact, ContactInput, ContactList, ContactRow } from '../types/contact'

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
    type: row.contact_type || 'New Lead',
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

// ─── Custom Audience Lists ──────────────────────────────────────────────────
// Manually curated groups of contacts (e.g. "March Clients", "Hot Leads").
// These are SEPARATE from the database-driven contact_type values. A contact
// can belong to many lists and still retain its contact_type. Membership is
// stored in contact_list_members; the contact row itself is never modified.

/** List all custom lists with their current member counts. */
export async function fetchContactLists(): Promise<{ data: ContactList[]; error: string | null }> {
  try {
    const { data: lists, error } = await supabase
      .from('contact_lists')
      .select('*')
      .order('name')

    if (error) return { data: [], error: error.message }

    // Count members per list in a single query, then attach to each list.
    const { data: members, error: memError } = await supabase
      .from('contact_list_members')
      .select('list_id')

    const counts: Record<string, number> = {}
    if (!memError && members) {
      for (const m of members as { list_id: string }[]) {
        counts[m.list_id] = (counts[m.list_id] || 0) + 1
      }
    }

    const data = ((lists as Record<string, any>[]) || []).map((l) => ({
      id: String(l.id),
      name: l.name,
      description: l.description ?? null,
      created_at: l.created_at ?? null,
      count: counts[String(l.id)] || 0,
    }))

    return { data, error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to load lists' }
  }
}

/** Create a new custom list. Returns the created row (with count 0). */
export async function createContactList(
  name: string,
  description?: string
): Promise<{ data: ContactList | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('contact_lists')
      .insert({
        name: name.trim(),
        description: description && description.trim() ? description.trim() : null,
      })
      .select('*')
      .single()

    if (error) return { data: null, error: error.message }
    const row = data as Record<string, any>
    return {
      data: {
        id: String(row.id),
        name: row.name,
        description: row.description ?? null,
        created_at: row.created_at ?? null,
        count: 0,
      },
      error: null,
    }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to create list' }
  }
}

/** Rename a custom list (name only — memberships and id are unchanged). */
export async function renameContactList(
  id: string,
  name: string
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase
      .from('contact_lists')
      .update({ name: name.trim() })
      .eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to rename list' }
  }
}

/** Delete a custom list and its membership rows (never touches contacts). */
export async function deleteContactList(id: string): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from('contact_lists').delete().eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete list' }
  }
}

/**
 * Add one or more contacts to a list. Uses upsert-by-unique semantics
 * (insert ... on conflict do nothing) so re-adding a member is a no-op rather
 * than a duplicate row. A contact is never removed from All Contacts.
 */
export async function addContactsToList(
  listId: string,
  contactIds: string[]
): Promise<{ error: string | null; added: number }> {
  try {
    if (contactIds.length === 0) return { error: null, added: 0 }
    const rows = contactIds.map((cid) => ({ list_id: listId, contact_id: cid }))
    const { error } = await supabase
      .from('contact_list_members')
      .upsert(rows, { onConflict: 'list_id,contact_id', ignoreDuplicates: true })
    if (error) return { error: error.message, added: 0 }
    return { error: null, added: contactIds.length }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to add contacts', added: 0 }
  }
}

/** Remove a single contact from a list (deletes only the membership row). */
export async function removeContactFromList(
  listId: string,
  contactId: string
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase
      .from('contact_list_members')
      .delete()
      .eq('list_id', listId)
      .eq('contact_id', contactId)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to remove contact' }
  }
}

/**
 * Fetch the contacts that are members of a list. Used by the Contacts page to
 * render a custom-list view. Members are looked up via contact_list_members →
 * contacts, exactly as the campaign recipient query does.
 */
export async function fetchListMembers(listId: string): Promise<{ data: Contact[]; error: string | null }> {
  try {
    const { data: members, error: memError } = await supabase
      .from('contact_list_members')
      .select('contact_id')
      .eq('list_id', listId)

    if (memError) return { data: [], error: memError.message }
    const ids = Array.from(
      new Set(((members as { contact_id: string }[]) || []).map((m) => m.contact_id))
    )
    if (ids.length === 0) return { data: [], error: null }

    const { data, error } = await supabase.from('contacts').select('*').in('id', ids)
    if (error) return { data: [], error: error.message }

    const byId = new Map(ids.map((id, i) => [id, i]))
    const rows = (data as ContactRow[] | null) ?? []
    // Preserve list membership order.
    const ordered = [...rows].sort(
      (a, b) => (byId.get(a.id) ?? 0) - (byId.get(b.id) ?? 0)
    )
    return { data: ordered.map(mapRowToContact), error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to load list members' }
  }
}
