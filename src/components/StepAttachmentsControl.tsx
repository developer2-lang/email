import { useRef, useState } from 'react'
import type { SequenceAttachment } from '../types/sequence'
import { formatFileSize } from '../services/sequenceAttachmentService'

interface StepAttachmentsControlProps {
  /** The step branch's currently attached files (saved or composer-only). */
  attachments: SequenceAttachment[]
  /** True while one of this branch's files is being uploaded. */
  uploading: boolean
  /** Latest upload error for this branch (kept visible after a failure). */
  error: string | null
  onFiles: (files: FileList | null) => void
  onRemove: (attachment: SequenceAttachment) => void
}

/**
 * Reusable "Attachments" section rendered below a step branch's Body field.
 * Each rendered instance is bound to exactly ONE step branch (the OPENED /
 * starting branch or the NOT OPENED branch of one step), so every step keeps
 * its own file list, upload state and error.
 */
export default function StepAttachmentsControl({
  attachments,
  uploading,
  error,
  onFiles,
  onRemove,
}: StepAttachmentsControlProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)

  return (
    <div className="form-group" style={{ marginBottom: '10px' }}>
      <label>Attachments</label>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept=".pdf,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,application/zip"
        onChange={(e) => {
          onFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <button
        type="button"
        className="btn btn-secondary btn-xs"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        style={{ opacity: uploading ? 0.6 : 1, cursor: uploading ? 'not-allowed' : 'pointer' }}
      >
        {uploading ? 'Uploading…' : `📎 Attach File${hover ? '' : ''}`}
      </button>
      <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
        Upload files to include them when this step&rsquo;s email is sent. Supported: PDF, images,
        DOCX, XLSX, PPTX, TXT, CSV and other common email attachments (max 20 MB each).
      </div>

      {error && (
        <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '4px' }}>{error}</div>
      )}

      {attachments.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text4)', padding: '8px 0' }}>
          No attachments yet. Upload files to include them when this step&rsquo;s email is sent.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
          {attachments.map((att) => (
            <div
              key={att.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 10px',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                background: 'var(--surface3)',
              }}
            >
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  color: 'var(--accent)',
                  background: 'var(--surface1)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '3px 6px',
                  textTransform: 'uppercase',
                  flexShrink: 0,
                }}
              >
                {(att.file_type.split('/').pop() || 'file').slice(0, 10)}
              </span>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  minWidth: 0,
                  flex: 1,
                }}
              >
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--text2)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {att.file_name}
                </span>
                <span style={{ fontSize: '11.5px', color: 'var(--text4)' }}>
                  {att.file_type || 'Unknown type'} • {formatFileSize(att.file_size)}
                </span>
              </div>
              <button
                type="button"
                className="btn-icon"
                onClick={() => onRemove(att)}
                title="Remove attachment"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}