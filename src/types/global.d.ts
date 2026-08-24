export {}

declare global {
  interface Window {
    /** SheetJS library injected at bootstrap so ContactsTab Excel import works. */
    XLSX?: any
  }
}
