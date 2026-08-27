interface TemplatePreviewProps {
  /** The template's HTML — rendered visually, never shown as raw source. */
  html: string
  /** Human-readable template name shown in the preview header. */
  name?: string
  /** Preview iframe height in pixels. */
  height?: number
}

/**
 * Rendered email-template preview (sandboxed iframe). The raw HTML is used
 * ONLY as the iframe source — it is never displayed as editable text. Returns
 * nothing when there is no content to preview.
 *
 * The HTML is normalized through the SAME single-centered-container pipeline
 * used at send time (`toEmailSafeHtml`) so the preview shows exactly what the
 * recipient sees: one content card on the email background, never stray blocks
 * on the background or a second white box.
 */
import { toEmailSafeHtml } from '../utils/emailRender'

export default function TemplatePreview({
  html,
  name,
  height = 320,
}: TemplatePreviewProps) {
  const content = toEmailSafeHtml(String(html || '').trim())
  if (!content) return null

  return (
    <div style={{ marginBottom: '12px' }}>
      <label
        style={{
          fontSize: '12px',
          fontWeight: 700,
          color: 'var(--text2)',
          display: 'block',
          marginBottom: '6px',
        }}
      >
        Template Preview{name ? ` — ${name}` : ''}
      </label>
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: '6px',
          overflow: 'hidden',
          background: '#FFFFFF',
        }}
      >
        <iframe
          title={name || 'Template preview'}
          sandbox=""
          srcDoc={content}
          style={{
            width: '100%',
            height: `${height}px`,
            border: 'none',
            display: 'block',
            background: '#FFFFFF',
          }}
        />
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
        This is the template rendered as an email. The raw HTML stays internal and is used only
        when the sequence email is sent.
      </div>
    </div>
  )
}
