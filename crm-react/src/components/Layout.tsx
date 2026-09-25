import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard, ListOrdered, Truck, RefreshCw, Store, Users,
  Wrench, Building2, BarChart3, Bell, Settings, LogOut, Leaf,
} from 'lucide-react'
import { useAuthStore } from '../store/auth'
import clsx from 'clsx'
import { useEffect, useState } from 'react'

const navItems = [
  { to: '/', icon: LayoutDashboard, key: 'dashboard' },
  { to: '/ledger', icon: ListOrdered, key: 'ledger' },
  { to: '/fleet', icon: Truck, key: 'fleet' },
  { to: '/reschedule', icon: RefreshCw, key: 'reschedule' },
  { to: '/customers', icon: Store, key: 'customers' },
  { to: '/users', icon: Users, key: 'users' },
  { to: '/vehicles', icon: Truck, key: 'vehicles' },
  { to: '/maintenance', icon: Wrench, key: 'maintenance' },
  { to: '/companies', icon: Building2, key: 'companies' },
  { to: '/reports', icon: BarChart3, key: 'reports' },
  { to: '/alerts', icon: Bell, key: 'alerts' },
  { to: '/settings', icon: Settings, key: 'settings' },
]

export default function Layout() {
  const { t, i18n } = useTranslation()
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()
  const [live, setLive] = useState(false)
  const [alertCount] = useState(0)

  useEffect(() => { setLive(true) }, [])

  const handleLogout = () => { logout(); navigate('/login') }
  const isRtl = i18n.language === 'ar'

  return (
    <div className={clsx('flex min-h-screen bg-gl-bg', isRtl && 'rtl')} dir={isRtl ? 'rtl' : 'ltr'}>
      <aside className="sidebar w-60 shrink-0 bg-gl-panel border-r border-gl-line flex flex-col sticky top-0 h-screen">
        <div className="p-5 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gl-teal-d flex items-center justify-center">
            <Leaf className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="font-bold text-lg text-gl-teal leading-tight">{t('appName')}</div>
            <div className="text-[11px] text-gl-muted">Majari Ops</div>
          </div>
        </div>
        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {navItems.map(({ to, icon: Icon, key }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) =>
              clsx('flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive ? 'bg-gl-teal-d text-white' : 'text-gl-muted hover:bg-gl-panel2 hover:text-gl-text')
            }>
              <Icon className="w-4.5 h-4.5 shrink-0" strokeWidth={2} />
              <span className="truncate">{t(key)}</span>
              {key === 'alerts' && alertCount > 0 && (
                <span className="ml-auto bg-gl-red text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{alertCount}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-gl-line space-y-3">
          <div className="flex items-center gap-2 text-xs text-gl-muted">
            <span className={clsx('w-2 h-2 rounded-full', live ? 'bg-gl-green' : 'bg-gl-red')} />
            {live ? t('live') : t('connecting')}
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gl-muted hover:text-gl-text hover:bg-gl-panel2 rounded-lg transition">
            <LogOut className="w-4 h-4" /> {t('logout')}
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="p-6 max-w-[1400px] mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
