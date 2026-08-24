import type { EmailTemplate } from '../types/campaign'

// Lightweight module-level bridge that carries an "open in the Template Editor"
// intent from the All Templates page to the (separate) Template Editor tab.
// The two tabs are unmounted/mounted by the tab router, so a transient shared
// value is the simplest way to hand the editor exactly which template to load
// (or that it should start a brand-new one) without duplicating the editor.

let pendingTemplate: EmailTemplate | null = null
let pendingNew = false

export function openTemplateInEditor(t: EmailTemplate): void {
  pendingTemplate = t
  pendingNew = false
}

export function openNewTemplateInEditor(): void {
  pendingTemplate = null
  pendingNew = true
}

export interface EditorIntent {
  template: EmailTemplate | null
  isNew: boolean
}

export function consumeEditorIntent(): EditorIntent {
  const result: EditorIntent = { template: pendingTemplate, isNew: pendingNew }
  pendingTemplate = null
  pendingNew = false
  return result
}
