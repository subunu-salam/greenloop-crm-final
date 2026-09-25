import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench, AlertCircle, CheckCircle, Calendar } from 'lucide-react'

const demoVehicles = [
  { id: 1, fleet: 'TRUCK-01', plate: 'D-12345', nextService: '2026-10-15', regExpiry: '2027-03-01', insExpiry: '2026-12-20', status: 'ok', lastKm: 45200 },
  { id: 2, fleet: 'TRUCK-02', plate: 'D-67890', nextService: '2026-09-28', regExpiry: '2026-11-15', insExpiry: '2026-10-05', status: 'due', lastKm: 62100 },
  { id: 3, fleet: 'TRUCK-03', plate: 'D-11223', nextService: '2026-11-01', regExpiry: '2027-01-20', insExpiry: '2027-02-10', status: 'ok', lastKm: 18900 },
]

export default function Maintenance() {
  const { t } = useTranslation()
  const [vehicles] = useState(demoVehicles)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Wrench className="w-6 h-6 text-gl-teal" /> {t('maintenance')}</h1>
        <p className="text-gl-muted text-sm mt-1">Vehicle compliance, service schedules & UAE registration tracking for Majari fleet</p>
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        <div className="bg-gl-panel border border-gl-line rounded-xl p-5"><div className="text-2xl font-bold text-gl-green">2</div><div className="text-xs text-gl-muted uppercase mt-1">Compliant vehicles</div></div>
        <div className="bg-gl-panel border border-gl-line rounded-xl p-5"><div className="text-2xl font-bold text-gl-amber">1</div><div className="text-xs text-gl-muted uppercase mt-1">Service due soon</div></div>
        <div className="bg-gl-panel border border-gl-line rounded-xl p-5"><div className="text-2xl font-bold text-gl-red">0</div><div className="text-xs text-gl-muted uppercase mt-1">Expired docs</div></div>
      </div>
      <div className="bg-gl-panel border border-gl-line rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gl-muted text-xs uppercase border-b border-gl-line">
              <th className="px-4 py-3">Vehicle</th><th className="px-4 py-3">Plate</th><th className="px-4 py-3">{t('nextService')}</th>
              <th className="px-4 py-3">{t('registrationExpiry')}</th><th className="px-4 py-3">{t('insuranceExpiry')}</th>
              <th className="px-4 py-3">Last Odometer</th><th className="px-4 py-3">{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id} className="border-b border-gl-line/50 hover:bg-gl-panel2/40">
                <td className="px-4 py-3 font-medium">{v.fleet}</td>
                <td className="px-4 py-3">{v.plate}</td>
                <td className="px-4 py-3"><span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5 text-gl-muted" />{v.nextService}</span></td>
                <td className="px-4 py-3">{v.regExpiry}</td>
                <td className="px-4 py-3">{v.insExpiry}</td>
                <td className="px-4 py-3">{v.lastKm.toLocaleString()} km</td>
                <td className="px-4 py-3">
                  {v.status === 'ok' ? (
                    <span className="inline-flex items-center gap-1 text-gl-green text-xs font-semibold"><CheckCircle className="w-3.5 h-3.5" /> Compliant</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-gl-amber text-xs font-semibold"><AlertCircle className="w-3.5 h-3.5" /> Service due</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gl-muted">* Demo data. Full CRUD + reminders will connect to new backend endpoints for service logs, RTA registration & insurance documents.</p>
    </div>
  )
}
