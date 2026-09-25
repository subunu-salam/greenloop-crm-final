// API base: empty in local (proxy) or set VITE_API_URL for Cloudflare → Render/Vercel
const API = (import.meta.env.VITE_API_URL || '') + '/api/v1'

export async function api<T = any>(
  path: string,
  opts: RequestInit & { body?: any } = {},
  token?: string | null
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string>),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(API + path, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })

  if (res.status === 401) throw new Error('Session expired')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data as T
}

export async function login(username: string, password: string) {
  const res = await fetch(API + '/auth/admin-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Login failed')
  return data as { token: string }
}
