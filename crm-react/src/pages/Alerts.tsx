import { useTranslation } from 'react-i18next'
import { Bell } from 'lucide-react'

export default function Alerts() {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold flex items-center gap-2"><Bell className="w-6 h-6 text-gl-teal" /> {t('alerts')}</h1>
      <p className="text-gl-muted">SLA breaches, anomalies, reschedules — real-time via WebSocket.</p>
      <div className="bg-gl-panel border border-gl-line rounded-xl p-8 text-center text-gl-muted">Alerts feed</div>
    </div>
  )
}
