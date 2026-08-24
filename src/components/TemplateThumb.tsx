/**
 * Render an actual saved-template preview inside a scaled-down iframe. The
 * preview shows the REAL template HTML (never a placeholder image), normalized
 * through the same Gmail-safe pipeline used at send time.
 */
export function TemplateThumb({ html, height = 132 }: { html: string; height?: number }) {
  return (
    <div
      style={{
        width: '100%',
        height,
        overflow: 'hidden',
        position: 'relative',
        background: '#FFFFFF',
        border: '1px solid #E5E7EB',
        borderRadius: '8px',
      }}
    >
      <iframe
        title="template thumbnail"
        sandbox=""
        srcDoc={html}
        style={{
          width: 600,
          height: 800,
          border: 'none',
          transform: 'scale(0.25)',
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
