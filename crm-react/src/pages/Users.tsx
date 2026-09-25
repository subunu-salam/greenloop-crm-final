import { useTranslation } from 'react-i18next'
import { Users, Trophy } from 'lucide-react'

export default function UsersPage() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold flex items-center gap-2"><Users className="w-6 h-6 text-gl-teal" /> {t('users')}</h1>
      <p className="text-gl-muted">Drivers & admins + performance scorecards & gamification for Majari teams.</p>
      <div className="bg-gl-panel border border-gl-line rounded-xl p-5">
        <h3 className="font-semibold flex items-center gap-2 mb-4"><Trophy className="w-4 h-4 text-gl-amber" /> {t('scorecard')} — Top Drivers (demo)</h3>
        <div className="space-y-3">
          {[
            { name: 'Ali', vehicle: 'TRUCK-01', score: 96, completed: 142, anomalies: 2 },
            { name: 'Ramesh', vehicle: 'TRUCK-02', score: 91, completed: 128, anomalies: 5 },
          ].map((d, i) => (
            <div key={i} className="flex items-center gap-4 bg-gl-panel2 rounded-lg px-4 py-3">
              <div className="text-2xl font-bold text-gl-teal w-8">#{i + 1}</div>
              <div className="flex-1">
                <div className="font-medium">{d.name} · {d.vehicle}</div>
                <div className="text-xs text-gl-muted">{d.completed} pickups · {d.anomalies} anomalies</div>
              </div>
              <div className="text-right">
                <div className="text-xl font-bold text-gl-green">{d.score}</div>
                <div className="text-[10px] text-gl-muted uppercase">Score</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
