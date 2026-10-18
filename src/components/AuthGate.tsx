import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
export function AuthGate({children}: {children: ReactNode}) {
  const [user, setUser] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!supabase) return
    let mounted = true
    supabase.auth.getSession().then(({data, error}) => {
      if (!mounted) return
      setUser(data.session?.user.id ?? null); setError(error?.message ?? ''); setLoading(false)
    }).catch(() => { if (mounted) { setError('Unable to restore your session. Reload to retry.'); setLoading(false) } })
    const {data} = supabase.auth.onAuthStateChange((_event, session) => { setUser(session?.user.id ?? null); setLoading(false) })
    return () => { mounted = false; data.subscription.unsubscribe() }
  }, [])
  if (!supabase) return <main className="auth-panel"><h1>Connect LeadFlow to Supabase</h1><p>Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local, apply the database migration, and restart Vite. See README for setup.</p><p>Your existing browser demo records have not been changed.</p></main>
  if (loading) return <div className="loading" role="status">Restoring your session…</div>
  if (user) return <div key={user}>{children}</div>
  return <main className="auth-panel"><h1>Sign in to LeadFlow</h1><p>Use the internal account provided by your administrator.</p><form onSubmit={async event => {
    event.preventDefault(); if (busy) return
    const fields = new FormData(event.currentTarget); setBusy(true); setError('')
    try { const {error} = await supabase!.auth.signInWithPassword({email: String(fields.get('email')), password: String(fields.get('password'))}); if(error) setError(error.message) }
    catch { setError('Unable to sign in. Check your connection and try again.') }
    finally { setBusy(false) }
  }}><label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label>{error && <p role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form></main>
}
