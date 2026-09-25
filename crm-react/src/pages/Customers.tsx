import { useTranslation } from 'react-i18next'
import { Store } from 'lucide-react'

export default function Customers() {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold flex items-center gap-2"><Store className="w-6 h-6 text-gl-teal" /> {t('customers')}</h1>
      <p className="text-gl-muted">CRUD + zone + frequency + compliance — connects to /customers API.</p>
      <div className="bg-gl-panel border border-gl-line rounded-xl p-8 text-center text-gl-muted">Customers management</div>
    </div>
  )
}
