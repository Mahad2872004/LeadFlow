import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { navigate } from '../../lib/navigation'
import { dateLabel } from '../../lib/format'
import { acceptInvitation, activateInvitation, HubError, invitationStatus, type InvitationStatus } from '../../lib/hub'
import { Icon } from '../Icon'
import { ThemeToggle } from '../ThemeToggle'
import { HubLink } from './hubShared'
import { errorText, passwordProblem, rememberAccess, roleLabel } from './hubKit'

// Sign-in, password recovery and invitation acceptance for client people. Accounts come only from an agency invitation;
// password recovery uses Supabase Auth's own email.


export function AuthFrame({ title, lede, children, footer }: { title: string; lede?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return <div className="hb-auth">
    <div className="hb-auth-top"><span className="hb-brand"><span className="hb-brand-mark" aria-hidden="true">L</span> LeadFlow <span className="hb-brand-sub">Client portal</span></span><ThemeToggle className="hb-icon-btn" /></div>
    <main className="hb-auth-card" id="hb-main">
      <h1>{title}</h1>
      {lede && <p className="hb-lede">{lede}</p>}
      {children}
    </main>
    {footer && <p className="hb-auth-foot">{footer}</p>}
  </div>
}

function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId()
  return <div className="hb-field"><label htmlFor={id}>{label}</label>{children(id)}{hint && <small className="hb-hint">{hint}</small>}</div>
}

async function signInWith(email: string, password: string) {
  const { error } = await supabase!.auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw new Error(/invalid login credentials/i.test(error.message) ? 'That email and password don’t match an account.' : /email not confirmed/i.test(error.message) ? 'Confirm your email address first, then sign in.' : error.message)
}

export function SignInPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setProblem('')
    try { await signInWith(email, password) } catch (cause) { setProblem(errorText(cause)); setBusy(false) }
  }
  return <AuthFrame title="Sign in to your client portal" lede="See your projects, review work and talk with your agency in one place."
    footer={<>Access is by invitation from your agency. Agency team? <a href="/login">Sign in to LeadFlow</a>.</>}>
    <form className="hb-form" onSubmit={submit}>
      <Field label="Email">{id => <input id={id} type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} />}</Field>
      <Field label="Password">{id => <input id={id} type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />}</Field>
      {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
      <button type="submit" className="hb-btn is-primary is-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <HubLink to="/portal/forgot" className="hb-text-link">Forgot your password?</HubLink>
    </form>
  </AuthFrame>
}

export function ForgotPage() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [problem, setProblem] = useState('')
  return <AuthFrame title="Reset your password" lede="Enter the email address your agency invited. We’ll send a link to choose a new password.">
    {sent ? <div className="hb-notice is-success" role="status"><p><strong>Check your email.</strong> If an account exists for that address, we sent a link to reset the password. It may take a few minutes.</p>
      <HubLink to="/portal" className="hb-btn is-secondary">Back to sign in</HubLink></div>
      : <form className="hb-form" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setProblem('')
        const { error } = await supabase!.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/portal/reset` })
        setBusy(false)
        // Rate limits and transport failures are worth showing; everything else gets the same neutral answer.
        if (error && (/rate limit|too many/i.test(error.message) || /fetch/i.test(error.message))) { setProblem(/fetch/i.test(error.message) ? 'We couldn’t connect. Try again.' : 'Too many requests. Wait a minute and try again.'); return }
        setSent(true)
      }}>
        <Field label="Email">{id => <input id={id} type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} />}</Field>
        {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
        <button type="submit" className="hb-btn is-primary is-block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        <HubLink to="/portal" className="hb-text-link">Back to sign in</HubLink>
      </form>}
  </AuthFrame>
}

function NewPasswordFields({ password, confirm, setPassword, setConfirm, disabled }: { password: string; confirm: string; setPassword: (value: string) => void; setConfirm: (value: string) => void; disabled: boolean }) {
  return <>
    <Field label="New password" hint="At least 8 characters.">{id => <input id={id} type="password" autoComplete="new-password" minLength={8} required value={password} onChange={event => setPassword(event.target.value)} disabled={disabled} />}</Field>
    <Field label="Confirm password">{id => <input id={id} type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={event => setConfirm(event.target.value)} disabled={disabled} />}</Field>
  </>
}

/** The landing page of Supabase's recovery email: it signs the person in for a password change. */
export function ResetPage({ session, ready, recovery }: { session: Session | null; ready: boolean; recovery: boolean }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [problem, setProblem] = useState('')
  if (!ready) return <AuthFrame title="Reset your password"><p role="status" className="hb-muted">Checking your link…</p></AuthFrame>
  if (!session && !recovery) return <AuthFrame title="This link isn’t valid any more" lede="Password reset links work once and expire after a while.">
    <HubLink to="/portal/forgot" className="hb-btn is-primary is-block">Send a new link</HubLink>
  </AuthFrame>
  if (done) return <AuthFrame title="Password changed"><div className="hb-notice is-success" role="status"><p>Your new password is saved.</p><HubLink to="/portal" className="hb-btn is-primary">Open your portal</HubLink></div></AuthFrame>
  return <AuthFrame title="Choose a new password" lede={session?.user.email ? <>For <strong>{session.user.email}</strong></> : undefined}>
    <form className="hb-form" onSubmit={async event => {
      event.preventDefault()
      const issue = passwordProblem(password, confirm)
      if (issue) { setProblem(issue); return }
      setBusy(true); setProblem('')
      const { error } = await supabase!.auth.updateUser({ password })
      setBusy(false)
      if (error) setProblem(error.message); else setDone(true)
    }}>
      <NewPasswordFields password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} disabled={busy} />
      {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
      <button type="submit" className="hb-btn is-primary is-block" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
    </form>
  </AuthFrame>
}

const invalidCopy: Record<Exclude<InvitationStatus['status'], 'valid'>, [string, string]> = {
  invalid: ['This invitation link isn’t valid', 'Check that you opened the whole link from your email, or ask your agency for a new invitation.'],
  expired: ['This invitation has expired', 'Invitations last 7 days. Ask your agency to renew it, and they’ll send you a new link.'],
  revoked: ['This invitation was withdrawn', 'Ask your agency for a new invitation if you still need access.'],
  accepted: ['This invitation was already used', 'Sign in with the account that accepted it, or ask your agency for a new invitation.'],
}

/** /portal/invite#<token>. The token is read once from the fragment, removed from the address bar and kept in memory. */
export function InvitePage({ session }: { session: Session | null }) {
  const [token] = useState(() => window.location.hash.replace(/^#/, ''))
  const [status, setStatus] = useState<InvitationStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [mode, setMode] = useState<'auto' | 'signin'>('auto')
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', '/portal/invite') }, [])
  useEffect(() => {
    if (!token) return
    let active = true
    invitationStatus(token).then(value => { if (active) { setStatus(value); setName(current => current || value.name || '') } }, (cause: unknown) => { if (active) setLoadError(errorText(cause)) })
    return () => { active = false }
  }, [token, attempt])
  if (!token) return <AuthFrame title="Open your invitation link again" lede="For your security, the invitation code isn’t kept after the page loads. Open the link from your invitation email again.">
    <HubLink to="/portal" className="hb-btn is-secondary is-block">Go to sign in</HubLink></AuthFrame>
  if (loadError) return <AuthFrame title="We couldn’t check your invitation"><div className="hb-error" role="alert"><p>{loadError}</p>
    <button type="button" className="hb-btn is-secondary" onClick={() => { setLoadError(''); setAttempt(value => value + 1) }}>Try again</button></div></AuthFrame>
  if (!status) return <AuthFrame title="Opening your invitation…"><p role="status" className="hb-muted">Checking the link…</p></AuthFrame>
  if (status.status !== 'valid') {
    const [title, lede] = invalidCopy[status.status]
    return <AuthFrame title={title} lede={lede}><HubLink to="/portal" className="hb-btn is-secondary is-block">Go to sign in</HubLink></AuthFrame>
  }
  const invited = (status.email ?? '').toLowerCase()
  const summary = <div className="hb-invite-card">
    <span className="hb-invite-icon" aria-hidden="true"><Icon name="building" size={20} /></span>
    <div><strong>{status.agencyName}</strong> invited you to the <strong>{status.clientName}</strong> client portal{status.role ? <> as <strong>{roleLabel[status.role]}</strong></> : null}.
      <small>For {status.email}{status.expiresAt ? ` · link valid until ${dateLabel(status.expiresAt)}` : ''}</small></div>
  </div>
  const finish = (accessId?: string) => { if (accessId) rememberAccess(accessId); navigate('/portal', { replace: true }) }
  const signedInAs = session?.user.email?.toLowerCase() ?? ''
  // Someone else is signed in on this browser.
  if (session && signedInAs !== invited) return <AuthFrame title="You’re signed in with another account">
    {summary}
    <p className="hb-muted">This invitation is for <strong>{status.email}</strong>, but this browser is signed in as <strong>{session.user.email}</strong>. Sign out to continue with the invited address.</p>
    <button type="button" className="hb-btn is-primary is-block" onClick={() => { void supabase!.auth.signOut() }}>Sign out and continue</button>
  </AuthFrame>
  const accept = async () => {
    setBusy(true); setProblem('')
    try { finish((await acceptInvitation(token)).accessId) } catch (cause) { setProblem(errorText(cause)); setBusy(false) }
  }
  // Signed in with the invited address: one click.
  if (session) return <AuthFrame title="Accept your invitation">
    {summary}
    {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
    <button type="button" className="hb-btn is-primary is-block" disabled={busy} onClick={accept}>{busy ? 'Accepting…' : 'Accept and open the portal'}</button>
  </AuthFrame>
  if (status.accountExists || mode === 'signin') return <AuthFrame title="Sign in to accept" lede="You already have an account with this address. Sign in to add this client portal to it.">
    {summary}
    <form className="hb-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setProblem('')
      try { await signInWith(invited, password); finish((await acceptInvitation(token)).accessId) } catch (cause) { setProblem(errorText(cause)); setBusy(false) }
    }}>
      <Field label="Email">{id => <input id={id} type="email" value={status.email} readOnly />}</Field>
      <Field label="Password">{id => <input id={id} type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />}</Field>
      {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
      <button type="submit" className="hb-btn is-primary is-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in and accept'}</button>
      <HubLink to="/portal/forgot" className="hb-text-link">Forgot your password?</HubLink>
    </form>
  </AuthFrame>
  return <AuthFrame title="Set up your account" lede="Choose a password to finish. You’ll use your email address and this password to sign in.">
    {summary}
    <form className="hb-form" onSubmit={async event => {
      event.preventDefault()
      const issue = passwordProblem(password, confirm)
      if (issue) { setProblem(issue); return }
      setBusy(true); setProblem('')
      try {
        const activated = await activateInvitation(token, { name: name.trim(), password })
        await signInWith(activated.email || invited, password)
        finish()
      } catch (cause) {
        // The address already has an account (for example, a second invitation): sign in instead.
        if (cause instanceof HubError && cause.status === 409) { setMode('signin'); setPassword(''); setConfirm(''); setProblem(cause.message) }
        else setProblem(errorText(cause))
        setBusy(false)
      }
    }}>
      <Field label="Email">{id => <input id={id} type="email" value={status.email} readOnly />}</Field>
      <Field label="Your name">{id => <input id={id} autoComplete="name" maxLength={150} value={name} onChange={event => setName(event.target.value)} disabled={busy} />}</Field>
      <NewPasswordFields password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} disabled={busy} />
      {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
      <button type="submit" className="hb-btn is-primary is-block" disabled={busy}>{busy ? 'Setting up…' : 'Create account and open the portal'}</button>
    </form>
  </AuthFrame>
}

/** Signed in, but with no client access here (agency members, revoked people, closed client spaces). */
export function NoAccess({ email }: { email: string }) {
  const [busy, setBusy] = useState(false)
  return <AuthFrame title="No client portal for this account" lede={<>You’re signed in as <strong>{email}</strong>, but this account doesn’t have access to a client portal. If you expected access, ask your agency to invite you again.</>}
    footer={<>Agency team? <a href="/app">Open LeadFlow</a>.</>}>
    <button type="button" className="hb-btn is-secondary is-block" disabled={busy} onClick={async () => { setBusy(true); await supabase!.auth.signOut(); setBusy(false) }}>Sign out</button>
  </AuthFrame>
}
