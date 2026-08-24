import type { EmailTemplate } from '../types/campaign'

interface LoadTemplateControlProps {
  templates: EmailTemplate[]
  templatesLoading: boolean
  /** Currently selected template id for THIS branch ('' = none selected). */
  value: string
  /** True while this branch's Storage HTML is being fetched. */
  loading: boolean
  /** Load error for this branch (kept visible after a failed fetch). */
  error: string | null
  onSelect: (templateId: string) => void
}

/**
 * Reusable "Load Template" dropdown rendered above a step branch's Body field.
 * Lists ALL templates from `public.templates` (fetched dynamically by the
 * parent — nothing is hardcoded). Each rendered instance is bound to exactly
 * ONE step branch, so every step / OPENED / NOT OPENED branch keeps its own
 * selection, loading state and error.
 */
export default function LoadTemplateControl({
  templates,
  templatesLoading,
  value,
  loading,
  error,
  onSelect,
}: LoadTemplateControlProps) {
  return (
    <div className="form-group" style={{ marginBottom: '10px' }}>
      <label>Load Template</label>
      {templatesLoading ? (
        <select disabled>
          <option>Loading templates…</option>
        </select>
      ) : templates.length === 0 ? (
        <select disabled>
          <option>No templates available</option>
        </select>
      ) : (
        <select
          value={value || ''}
          disabled={loading}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">Select template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {loading && (
        <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
          Loading template…
        </div>
      )}
      {error && (
        <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '4px' }}>{error}</div>
      )}
    </div>
  )
}