import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calendar, CheckCircle2, Clock, AlertTriangle, Store, Target, Zap, RefreshCw } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'
import { api } from '../api/client'
import { useAuthStore } from '../store/auth'
import clsx from 'clsx'

type Period = 'daily' | 'weekly' | 'monthly'

export default function Dashboard() {
  const { t } = useTranslation()
  const token = useAuthStore((s) => s.token)
  const [period, setPeriod] = useState<Period>('daily')
  const [data, setData] = useState<any>(null)
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [period, token])

  async function load() {
    if (!token) return
    setLoading(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      let from = today
      if (period === 'weekly') {
        const d = new Date(); d.setDate(d.getDate() - 6); from = d.toISOString().slice(0, 10)
      } else if (period === 'monthly') {
        from = today.slice(0, 8) + '01'
      }
      const [dash, overview] = await Promise.all([
        api('/dashboard', {}, token),
        api(`/stats/overview?from=${from}&to=${today}`, {}, token).catch(() => null),
      ])
      setData(dash)
      setStats(overview)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  const totals = stats?.totals || {}
  const doneable = (totals.collected || 0) + (totals.canceled || 0) + (totals.overdue || 0)
  const rate = doneable ? Math.round((100 * (totals.collected || 0)) / doneable) : 100

  const kpis = [
    { label: t('scheduled'), value: totals.scheduled || 0, icon: Calendar, color: 'text-gl-blue' },
    { label: t('collected'), value: totals.collected || 0, icon: CheckCircle2, color: 'text-gl-green' },
    { label: t('completionRate'), value: `${rate}%`, icon: Target, color: rate >= 90 ? 'text-gl-green' : rate >= 70 ? 'text-gl-amber' : 'text-gl-red' },
    { label: t('pending'), value: totals.pending || 0, icon: Clock, color: 'text-gl-amber' },
    { label: t('noPickup'), value: (totals.canceled || 0) + (totals.overdue || 0), icon: AlertTriangle, color: 'text-gl-red' },
    { label: t('activeClients'), value: data?.customers || 0, icon: Store, color: 'text-gl-text' },
  ]

  const statusData = [
    { name: t('collected'), value: totals.collected || 0, color: '#22c55e' },
    { name: t('pending'), value: totals.pending || 0, color: '#f59e0b' },
    { name: 'No-pickup', value: totals.canceled || 0, color: '#f43f5e' },
    { name: 'Overdue', value: totals.overdue || 0, color: '#94a3b8' },
  ]

  if (loading && !data) return <div className="text-gl-muted py-20 text-center">{t('loading')}</div>

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('dashboard')}</h1>
          <p className="text-gl-muted text-sm mt-0.5">Majari Vehicle Operations · UAE · Shift cutoff {data?.shift_cutoff || '12:00'}</p>
        </div>
        <div className="flex bg-gl-panel border border-gl-line rounded-xl p-1">
          {(['daily', 'weekly', 'monthly'] as Period[]).map((p) => (
            <button key={p} onClick={() => setPeriod(p)} className={clsx('px-4 py-1.5 rounded-lg text-sm font-semibold transition', period === p ? 'bg-gl-teal-d text-white' : 'text-gl-muted hover:text-gl-text')}>
              {p === 'daily' ? t('today') : p === 'weekly' ? t('last7') : t('thisMonth')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((k) => (
          <div key={k.label} className="bg-gl-panel border border-gl-line rounded-xl p-4">
            <div className={clsx('text-2xl font-bold', k.color)}>{k.value}</div>
            <div className="flex items-center gap-1.5 text-xs text-gl-muted mt-1 uppercase tracking-wide">
              <k.icon className="w-3.5 h-3.5" /> {k.label}
            </div>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-gl-panel border border-gl-line rounded-xl p-5">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Target className="w-4 h-4 text-gl-teal" /> Status Split</h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={3}>
                  {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#16202a', border: '1px solid #263847', borderRadius: 8 }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-gl-panel border border-gl-line rounded-xl p-5">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Store className="w-4 h-4 text-gl-teal" /> By Zone</h3>
          <div className="h-56">
            {stats?.zones?.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.zones} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#263847" />
                  <XAxis type="number" stroke="#8aa0b0" fontSize={11} />
                  <YAxis type="category" dataKey="zone" stroke="#8aa0b0" fontSize={11} width={80} />
                  <Tooltip contentStyle={{ background: '#16202a', border: '1px solid #263847' }} />
                  <Bar dataKey="collected" stackId="a" fill="#14b8a6" name="Collected" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="canceled" stackId="a" fill="#f43f5e" name="No-pickup" />
                  <Bar dataKey="pending" stackId="a" fill="#f59e0b" name="Pending" />
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="h-full flex items-center justify-center text-gl-muted">{t('noData')}</div>}
          </div>
        </div>
      </div>

      <div className="bg-gl-panel border border-gl-line rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2"><Zap className="w-4 h-4 text-gl-teal" /> {t('liveFeed')}</h3>
          <button onClick={load} className="flex items-center gap-1.5 text-xs text-gl-muted hover:text-gl-teal transition"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
        </div>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {(data?.recent || []).length === 0 && <p className="text-gl-muted text-sm py-6 text-center">{t('noData')}</p>}
          {(data?.recent || []).map((r: any, i: number) => (
            <div key={i} className="flex items-center gap-3 bg-gl-panel2 rounded-lg px-3 py-2.5">
              {r.photo_url ? <img src={r.photo_url} alt="" className="w-10 h-10 rounded-md object-cover" /> :
                <div className="w-10 h-10 rounded-md bg-gl-bg flex items-center justify-center text-gl-red"><AlertTriangle className="w-5 h-5" /></div>}
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{r.name} <span className="text-gl-muted font-normal">({r.branch})</span></div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={clsx('pill', `pill-${r.status}`)}>{r.status}</span>
                  {r.fleet_number && <span className="text-xs text-gl-muted">{r.fleet_number}</span>}
                </div>
              </div>
              <span className="text-xs text-gl-muted whitespace-nowrap">{(r.completed_at || '').replace('T', ' ').slice(0, 16)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
