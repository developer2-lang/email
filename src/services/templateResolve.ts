import { supabase } from '../supabase'
import type { EmailTemplate } from '../types/campaign'

/**
 * Resolve the stored HTML for a template through the EXISTING template
 * architecture: storage-backed templates fetch their file from the `email
 * template` Storage bucket; database-backed templates use the `body` column.
 * HTML is always preserved verbatim — never stripped to plain text, never
 * rewritten. Placeholders like {{first_name}} stay untouched.
 *
 * Shared by the Template Editor and the All Templates page so every surface
 * renders the exact same real template content.
 */
export async function resolveTemplateHtml(t: EmailTemplate): Promise<string> {
  if (t.template_source === 'storage') {
    if (!t.storage_bucket || !t.storage_path) {
      throw new Error(`Template '${t.name}' is missing a storage bucket or file path.`)
    }
    const { data } = supabase.storage.from(t.storage_bucket).getPublicUrl(t.storage_path)
    if (!data?.publicUrl) {
      throw new Error('Could not resolve the template file URL.')
    }
    const response = await fetch(data.publicUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch template file (HTTP ${response.status}).`)
    }
    const html = await response.text()
    if (!html.trim()) throw new Error('The template file is empty.')
    return html
  }
  const body = t.body || ''
  if (!body.trim()) throw new Error(`Template '${t.name}' has an empty body.`)
  return body
}
