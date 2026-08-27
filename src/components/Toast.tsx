import type { ToastMessage } from '../types'

interface ToastProps {
  toast: ToastMessage
}

export default function Toast({ toast }: ToastProps) {
  return (
    <div className={`toast toast-${toast.type}`} role="status">
      {toast.text}
    </div>
  )
}
