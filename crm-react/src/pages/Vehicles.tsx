import { useTranslation } from 'react-i18next'
import { Truck } from 'lucide-react'

export default function Vehicles() {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold flex items-center gap-2"><Truck className="w-6 h-6 text-gl-teal" /> {t('vehicles')}</h1>
      <p className="text-gl-muted">Fleet onboarding & capacity management.</p>
      <div className="bg-gl-panel border border-gl-line rounded-xl p-8 text-center text-gl-muted">Vehicles (connect to /vehicles API)</div>
    </div>
  )
}
