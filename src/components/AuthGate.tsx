import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { emailLinkError } from '../lib/auth'
import { navigate, safeNext, usePathname } from '../lib/navigation'
import { AuthContext, type AuthUser } from '../lib/session'
import { AuthScreen } from './AuthScreen'
const toUser = (session: Session | null): AuthUser | null => session ? { id: session.user.id, email: session.user.email ?? '' } : null
// M12: accounts created by a client invitation belong to the client portal; the database refuses them here too.
const isClientAccount = (session: Session | null) => session?.user.app_metadata?.account_type === 'client'
export function AuthGate({children}: {children: ReactNode}) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [clientAccount, setClientAccount] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(emailLinkError)
  const signingOut = useRef(false)
  const pathname = usePathname()
  const authPage = pathname === '/login' || pathname === '/signup'
  useEffect(() => {
    if (!supabase) return
    let mounted = true
    supabase.auth.getSession().then(({data, error}) => {
      if (!mounted) return
      setUser(toUser(data.session)); setClientAccount(isClientAccount(data.session)); if (error) setError(error.message); setLoading(false)
    }).catch(() => { if (mounted) { setError('Unable to restore your session. Reload to retry.'); setLoading(false) } })
    // Token refreshes keep the same user object, so the workspace below is not remounted.
    const {data} = supabase.auth.onAuthStateChange((_event, session) => {
      const next = toUser(session)
      setClientAccount(isClientAccount(session))
      setUser(previous => previous?.id === next?.id && previous?.email === next?.email ? previous : next); setLoading(false)
    })
    return () => { mounted = false; data.subscription.unsubscribe() }
  }, [])
  // Signed-in users leave the auth pages; everyone else is sent to sign in, then back to where they were going.
  useEffect(() => {
    if (loading) return
    if (user && authPage) navigate(safeNext(new URLSearchParams(window.location.search).get('next')), {replace: true})
    else if (!user && !authPage) {
      const here = window.location.pathname + window.location.search
      navigate(signingOut.current || here === '/app' ? '/login' : `/login?next=${encodeURIComponent(here)}`, {replace: true})
      signingOut.current = false
    }
  }, [loading, user, authPage])
  async function signOut() {
    signingOut.current = true
    const { error } = await supabase!.auth.signOut()
    if (error) { signingOut.current = false; return error.message }
    return null
  }
  if (!supabase) return <main className="auth-panel"><h1>Connect LeadFlow to Supabase</h1><p>Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local, apply the database migration, and restart Vite. See README for setup.</p><p>Your existing browser demo records have not been changed.</p></main>
  if (loading || (user && authPage)) return <div className="auth-loading" role="status"><span className="spinner" aria-hidden="true"/>Restoring your session…</div>
  if (!user) return <AuthScreen mode={pathname === '/signup' ? 'sign-up' : 'sign-in'} notice={error}/>
  if (clientAccount) return <main className="auth-panel" role="main"><h1>This is a client portal account</h1><p>{user.email} was invited by an agency to its client portal. Open your portal to see your projects, reviews and files.</p>
    <p><a className="primary" href="/portal">Open the client portal</a> <button type="button" className="secondary" onClick={() => void signOut()}>Sign out</button></p></main>
  return <AuthContext.Provider value={{user, signOut}}><div key={user.id}>{children}</div></AuthContext.Provider>
}
