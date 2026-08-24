import type { ReactNode } from 'react'
import Sidebar from '../components/Sidebar'
import Toast from '../components/Toast'
import { NAV_META } from '../constants/constants'
import type { TabKey, ToastMessage } from '../types'

interface MainLayoutProps {
  activeTab: TabKey
  onNavigate: (tab: TabKey) => void
  toasts: ToastMessage[]
  prefFrom?: string
  children: ReactNode
}

export default function MainLayout({ activeTab, onNavigate, toasts, prefFrom, children }: MainLayoutProps) {
  const meta = NAV_META[activeTab]

  return (
    <div className="app">
      <Sidebar activeTab={activeTab} onNavigate={onNavigate} prefFrom={prefFrom} />

      <main className="main">
        <header className="topbar">
          <div>
            <div className="topbar-title">{meta.title}</div>
            <div className="topbar-sub">{meta.sub}</div>
          </div>
          <div className="topbar-right">
            <span className="tag tag-client">Demo Mode</span>
          </div>
        </header>

        <div className="content">{children}</div>
      </main>

      <div className="toast-wrap">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} />
        ))}
      </div>
    </div>
  )
}
