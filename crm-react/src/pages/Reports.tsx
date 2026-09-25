import { useTranslation } from 'react-i18next'
import { BarChart3, Download } from 'lucide-react'

export default function Reports() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BarChart3 className="w-6 h-6 text-gl-teal" /> {t('reports')}</h1>
          <p className="text-gl-muted text-sm">Advanced analytics, compliance, driver performance & CSV/PDF export</p>
        </div>
        <button className="flex items-center gap-2 bg-gl-panel2 border border-gl-line hover:border-gl-teal px-4 py-2 rounded-lg text-sm">
          <Download className="w-4 h-4" /> Export
        </button>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        {['Client Compliance', 'Driver Performance', 'Anomaly Breakdown', 'Full Ledger'].map((r) => (
          <div key={r} className="bg-gl-panel border border-gl-line rounded-xl p-5 hover:border-gl-teal/40 transition cursor-pointer">
            <h3 className="font-semibold">{r}</h3>
            <p className="text-xs text-gl-muted mt-1">Connects to existing /reports/* endpoints</p>
          </div>
        ))}
      </div>
    </div>
  )
}
