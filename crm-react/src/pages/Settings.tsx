import { useTranslation } from 'react-i18next'
import { Settings as SettingsIcon, Languages } from 'lucide-react'

export default function Settings() {
  const { t, i18n } = useTranslation()
  const setLang = (lng: string) => {
    i18n.changeLanguage(lng)
    localStorage.setItem('gl_lang', lng)
  }
  return (
    <div className="space-y-6 max-w-lg">
      <h1 className="text-2xl font-bold flex items-center gap-2"><SettingsIcon className="w-6 h-6 text-gl-teal" /> {t('settings')}</h1>
      <div className="bg-gl-panel border border-gl-line rounded-xl p-5 space-y-4">
        <h3 className="font-semibold flex items-center gap-2"><Languages className="w-4 h-4" /> {t('language')}</h3>
        <div className="flex gap-3">
          <button onClick={() => setLang('en')} className={`px-4 py-2 rounded-lg text-sm font-semibold border ${i18n.language === 'en' ? 'bg-gl-teal-d border-gl-teal text-white' : 'border-gl-line text-gl-muted'}`}>English</button>
          <button onClick={() => setLang('ar')} className={`px-4 py-2 rounded-lg text-sm font-semibold border ${i18n.language === 'ar' ? 'bg-gl-teal-d border-gl-teal text-white' : 'border-gl-line text-gl-muted'}`}>العربية</button>
        </div>
      </div>
      <p className="text-xs text-gl-muted">More settings (shift cutoff, company branding, notification preferences) can be added and wired to /settings API.</p>
    </div>
  )
}
