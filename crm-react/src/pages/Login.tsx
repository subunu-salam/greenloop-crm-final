import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Leaf, Loader2 } from 'lucide-react'
import { login } from '../api/client'
import { useAuthStore } from '../store/auth'

export default function Login() {
  const { t, i18n } = useTranslation()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin123')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const setToken = useAuthStore((s) => s.setToken)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await login(username, password)
      setToken(data.token)
      navigate('/')
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const toggleLang = () => {
    const next = i18n.language === 'en' ? 'ar' : 'en'
    i18n.changeLanguage(next)
    localStorage.setItem('gl_lang', next)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gl-bg p-4" dir={i18n.language === 'ar' ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-sm">
        <div className="bg-gl-panel border border-gl-line rounded-2xl p-8 shadow-xl">
          <div className="flex flex-col items-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-gl-teal-d flex items-center justify-center mb-3">
              <Leaf className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gl-teal">{t('appName')}</h1>
            <p className="text-gl-muted text-sm mt-1">{t('tagline')}</p>
            <p className="text-xs text-gl-muted mt-0.5">Majari Vehicle Operations · UAE</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-gl-muted mb-1.5">{t('username')}</label>
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full bg-gl-panel2 border border-gl-line rounded-lg px-3 py-2.5 text-gl-text focus:outline-none focus:ring-2 focus:ring-gl-teal-d" autoComplete="username" />
            </div>
            <div>
              <label className="block text-xs text-gl-muted mb-1.5">{t('password')}</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-gl-panel2 border border-gl-line rounded-lg px-3 py-2.5 text-gl-text focus:outline-none focus:ring-2 focus:ring-gl-teal-d" autoComplete="current-password" />
            </div>
            {error && <p className="text-gl-red text-sm">{error}</p>}
            <button type="submit" disabled={loading} className="w-full bg-gl-teal-d hover:bg-gl-teal text-white font-semibold py-2.5 rounded-lg transition flex items-center justify-center gap-2 disabled:opacity-60">
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('login')}
            </button>
          </form>
          <div className="mt-6 flex items-center justify-between text-xs text-gl-muted">
            <span>Demo: admin / admin123</span>
            <button onClick={toggleLang} className="hover:text-gl-teal transition">{i18n.language === 'en' ? 'العربية' : 'English'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
