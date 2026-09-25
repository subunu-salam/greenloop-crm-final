import { useTranslation } from 'react-i18next'
import { Building2, Plus } from 'lucide-react'

const demoCompanies = [
  { id: 1, name: 'Majari Logistics LLC', branches: 3, vehicles: 8, clients: 42, zone: 'Dubai', status: 'active' },
  { id: 2, name: 'Majari Waste Solutions', branches: 1, vehicles: 4, clients: 18, zone: 'Abu Dhabi', status: 'active' },
  { id: 3, name: 'GreenLoop Demo Co', branches: 1, vehicles: 2, clients: 36, zone: 'Dubai', status: 'demo' },
]

export default function Companies() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Building2 className="w-6 h-6 text-gl-teal" /> {t('companies')}</h1>
          <p className="text-gl-muted text-sm mt-1">Multi-company / multi-branch support for Majari group</p>
        </div>
        <button className="flex items-center gap-2 bg-gl-teal-d hover:bg-gl-teal text-white px-4 py-2 rounded-lg text-sm font-semibold transition">
          <Plus className="w-4 h-4" /> {t('add')} Company
        </button>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {demoCompanies.map((c) => (
          <div key={c.id} className="bg-gl-panel border border-gl-line rounded-xl p-5 hover:border-gl-teal/40 transition">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-lg">{c.name}</h3>
                <span className="text-xs bg-gl-panel2 border border-gl-line px-2 py-0.5 rounded mt-1 inline-block">{c.zone}</span>
              </div>
              <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full ${c.status === 'active' ? 'bg-green-900/40 text-green-400' : 'bg-sky-900/40 text-sky-400'}`}>{c.status}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-5 text-center">
              <div><div className="text-xl font-bold text-gl-teal">{c.branches}</div><div className="text-[10px] text-gl-muted uppercase">Branches</div></div>
              <div><div className="text-xl font-bold">{c.vehicles}</div><div className="text-[10px] text-gl-muted uppercase">Vehicles</div></div>
              <div><div className="text-xl font-bold">{c.clients}</div><div className="text-[10px] text-gl-muted uppercase">Clients</div></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
