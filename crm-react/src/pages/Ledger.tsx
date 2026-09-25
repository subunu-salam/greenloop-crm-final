import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet'
import L from 'leaflet'
import { api } from '../api/client'
import { useAuthStore } from '../store/auth'
import { List, Map as MapIcon } from 'lucide-react'
import clsx from 'clsx'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

export default function Ledger() {
  const { t } = useTranslation()
  const token = useAuthStore((s) => s.token)
  const [view, setView] = useState<'list' | 'map'>('list')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    setLoading(true)
    api(`/ledger?date=${date}`, {}, token)
      .then((d) => setRows(d.stops || d || []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [date, token])

  const center: [number, number] = [25.2048, 55.2708]
  const points = rows.filter((r) => r.lat && r.lng).map((r) => [r.lat, r.lng] as [number, number])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('ledger')}</h1>
          <p className="text-gl-muted text-sm">Dubai & Abu Dhabi zones · Route verification</p>
        </div>
        <div className="flex items-center gap-3">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-gl-panel2 border border-gl-line rounded-lg px-3 py-2 text-sm" />
          <div className="flex bg-gl-panel border border-gl-line rounded-lg p-0.5">
            <button onClick={() => setView('list')} className={clsx('px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5', view === 'list' ? 'bg-gl-teal-d text-white' : 'text-gl-muted')}>
              <List className="w-4 h-4" /> {t('listView')}
            </button>
            <button onClick={() => setView('map')} className={clsx('px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5', view === 'map' ? 'bg-gl-teal-d text-white' : 'text-gl-muted')}>
              <MapIcon className="w-4 h-4" /> {t('mapView')}
            </button>
          </div>
        </div>
      </div>

      {view === 'map' ? (
        <div className="bg-gl-panel border border-gl-line rounded-xl overflow-hidden h-[560px]">
          <MapContainer center={center} zoom={11} style={{ height: '100%', width: '100%' }}>
            <TileLayer attribution='&copy; OSM' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {rows.filter((r) => r.lat && r.lng).map((r, i) => (
              <Marker key={i} position={[r.lat, r.lng]}>
                <Popup><strong>{r.name || r.customer}</strong><br />{r.branch} · {r.status}<br />{r.fleet_number}</Popup>
              </Marker>
            ))}
            {points.length > 1 && <Polyline positions={points} color="#14b8a6" weight={3} />}
          </MapContainer>
        </div>
      ) : (
        <div className="bg-gl-panel border border-gl-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gl-muted text-xs uppercase border-b border-gl-line">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">{t('zone')}</th>
                <th className="px-4 py-3">{t('vehicle')}</th>
                <th className="px-4 py-3">{t('status')}</th>
                <th className="px-4 py-3">GPS</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gl-muted">{t('loading')}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gl-muted">{t('noData')}</td></tr>
              ) : rows.map((r, i) => (
                <tr key={i} className="border-b border-gl-line/50 hover:bg-gl-panel2/50">
                  <td className="px-4 py-2.5 text-gl-muted">{r.seq || i + 1}</td>
                  <td className="px-4 py-2.5 font-medium">{r.name || r.customer} <span className="text-gl-muted font-normal text-xs">{r.branch}</span></td>
                  <td className="px-4 py-2.5"><span className="text-xs bg-gl-panel2 border border-gl-line px-2 py-0.5 rounded">{r.zone}</span></td>
                  <td className="px-4 py-2.5">{r.fleet_number}</td>
                  <td className="px-4 py-2.5"><span className={clsx('pill', `pill-${r.status}`)}>{r.status}</span></td>
                  <td className="px-4 py-2.5 text-xs text-gl-muted">{r.gps_lat ? `${Number(r.gps_lat).toFixed(4)}, ${Number(r.gps_lng).toFixed(4)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
