import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

export default function Reschedule() {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold flex items-center gap-2"><RefreshCw className="w-6 h-6 text-gl-teal" /> {t('reschedule')}</h1>
      <p className="text-gl-muted">Intelligent rescheduling engine — top-3 slots with mileage deviation.</p>
      <div className="bg-gl-panel border border-gl-line rounded-xl p-8 text-center text-gl-muted">Rescheduling module (connect to existing API)</div>
    </div>
  )
}
