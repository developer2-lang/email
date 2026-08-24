import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as XLSX from 'xlsx'
import './styles/index.css'
import App from './App'

// Expose SheetJS globally so the ContactsTab Excel importer (`window.XLSX`) works.
window.XLSX = XLSX

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
