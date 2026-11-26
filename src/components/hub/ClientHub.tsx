import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { navigate, usePathname } from '../../lib/navigation'
import { hubAccounts, hubHome, type HubAccount } from '../../lib/hub'
import { AuthFrame, ForgotPage, InvitePage, NoAccess, ResetPage, SignInPage } from './HubAuth'
import { HubShell, type HubSection } from './HubShell'
import { Empty, HubLink } from './hubShared'
import { HubContext, errorText, isUuid, projectTabs, rememberAccess, rememberedAccess, type HubSession, type ProjectTab } from './hubKit'
import { MessagesPage, OverviewPage, ProjectsPage, ReviewsPage } from './HubOverview'
import { ProjectPage } from './HubProject'
import { DeliverablePage } from './HubDeliverable'
import { FilesPage } from './HubFiles'
import { NotificationsPage, SettingsPage } from './HubSettings'
import './Hub.css'

// M12: the client portal at /portal. A dedicated experience for client people, separate from the agency app; every
// request goes through the hub_ database functions, which check the person's access on each call.

export default function ClientHub() {
  const path = usePathname()
  const route = path.replace(/^\/portal\/?/, '').replace(/\/+$/, '')
  const [auth, setAuth] = useState<{ ready: boolean; session: Session | null; recovery: boolean }>({ ready: false, session: null, recovery: false })
  useEffect(() => {
    if (!supabase) return
    let mounted = true
    supabase.auth.getSession().then(({ data }) => { if (mounted) setAuth(previous => ({ ...previous, ready: true, session: data.session })) }, () => { if (mounted) setAuth(previous => ({ ...previous, ready: true })) })
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setAuth(previous => ({ ready: true, recovery: previous.recovery || event === 'PASSWORD_RECOVERY',
        session: previous.session?.user.id === session?.user.id && previous.session?.user.email === session?.user.email && session ? previous.session : session }))
    })
    return () => { mounted = false; data.subscription.unsubscribe() }
  }, [])
  if (!supabase) return <AuthFrame title="The client portal isn’t connected" lede="This copy of LeadFlow isn’t connected to its database yet. Contact your agency."><span /></AuthFrame>
  if (route === 'invite') return auth.ready ? <InvitePage session={auth.session} /> : <Loading />
  if (route === 'reset') return <ResetPage session={auth.session} ready={auth.ready} recovery={auth.recovery} />
  if (route === 'forgot') return auth.session ? <Redirect to="/portal/settings" /> : <ForgotPage />
  if (!auth.ready) return <Loading />
  if (!auth.session) return <SignInPage />
  return <HubApp key={auth.session.user.id} session={auth.session} route={route} />
}

function Loading() {
  return <div className="hb-loading" role="status"><span className="hb-spinner" aria-hidden="true" />Opening your client portal…</div>
}
function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }) }, [to])
  return <Loading />
}

function HubApp({ session, route }: { session: Session; route: string }) {
  const [accounts, setAccounts] = useState<HubAccount[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [chosen, setChosen] = useState<string | null>(() => rememberedAccess())
  const [counts, setCounts] = useState({ unread: 0, awaiting: 0 })
  const [countsVersion, setCountsVersion] = useState(0)
  useEffect(() => {
    let active = true
    hubAccounts().then(value => { if (active) { setAccounts(value); setLoadError('') } }, (cause: unknown) => { if (active) setLoadError(errorText(cause)) })
    return () => { active = false }
  }, [attempt])
  const account = accounts?.find(item => item.accessId === chosen) ?? accounts?.[0] ?? null
  const accessId = account?.accessId ?? null
  // Unread notifications and items awaiting review, refreshed on navigation.
  useEffect(() => {
    if (!accessId) return
    let active = true
    hubHome(accessId).then(home => { if (active) setCounts({ unread: home.unread, awaiting: home.awaiting.length }) }, () => undefined)
    return () => { active = false }
  }, [accessId, route, countsVersion])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    document.getElementById('hb-main')?.focus({ preventScroll: true })
  }, [route])
  const setAccess = useCallback((next: string) => { setChosen(next); rememberAccess(next) }, [])
  const refreshUnread = useCallback(() => setCountsVersion(value => value + 1), [])
  const signOut = useCallback(async () => { await supabase!.auth.signOut(); navigate('/portal', { replace: true }) }, [])
  const reloadAccounts = useCallback(() => setAttempt(count => count + 1), [])
  const value = useMemo<HubSession | null>(() => account ? {
    accessId: account.accessId, userId: session.user.id, userEmail: session.user.email ?? '', name: account.name, email: account.email, role: account.role,
    clientName: account.clientName, agencyName: account.agencyName, accounts: (accounts ?? []).map(item => ({ accessId: item.accessId, clientName: item.clientName, agencyName: item.agencyName })),
    unread: counts.unread, refreshUnread, setAccess, signOut, reloadAccounts,
  } : null, [account, accounts, counts.unread, refreshUnread, setAccess, signOut, reloadAccounts, session.user.id, session.user.email])
  if (loadError && !accounts) return <AuthFrame title="We couldn’t open your portal"><div className="hb-error" role="alert"><p>{loadError}</p>
    <button type="button" className="hb-btn is-secondary" onClick={() => { setLoadError(''); setAttempt(count => count + 1) }}>Try again</button></div></AuthFrame>
  if (!accounts) return <Loading />
  if (!value) return <NoAccess email={session.user.email ?? ''} />
  const parts = route.split('/').filter(Boolean)
  let section: HubSection = 'none'
  let page
  if (parts.length === 0) { section = 'overview'; page = <OverviewPage /> }
  else if (parts[0] === 'projects' && parts.length === 1) { section = 'projects'; page = <ProjectsPage /> }
  else if (parts[0] === 'projects' && isUuid(parts[1]) && parts[2] === 'deliverables' && isUuid(parts[3]) && parts.length === 4) {
    section = 'projects'; page = <DeliverablePage key={parts[3]} projectId={parts[1]} deliverableId={parts[3]} />
  } else if (parts[0] === 'projects' && isUuid(parts[1]) && parts.length <= 3 && (parts.length === 2 || projectTabs.includes(parts[2] as ProjectTab))) {
    section = 'projects'; page = <ProjectPage key={parts[1]} projectId={parts[1]} tab={(parts[2] as ProjectTab | undefined) ?? 'overview'} />
  } else if (parts.length === 1 && parts[0] === 'reviews') { section = 'reviews'; page = <ReviewsPage /> }
  else if (parts.length === 1 && parts[0] === 'messages') { section = 'messages'; page = <MessagesPage /> }
  else if (parts.length === 1 && parts[0] === 'files') { section = 'files'; page = <FilesPage /> }
  else if (parts.length === 1 && parts[0] === 'notifications') { section = 'notifications'; page = <NotificationsPage /> }
  else if (parts.length === 1 && parts[0] === 'settings') { section = 'settings'; page = <SettingsPage /> }
  else page = <div className="hb-page"><Empty icon="compass" title="This page doesn’t exist">The link may be incomplete. <HubLink to="/portal">Go to your overview</HubLink>.</Empty></div>
  return <HubContext.Provider value={value}>
    <HubShell section={section} awaiting={counts.awaiting}>{page}</HubShell>
  </HubContext.Provider>
}
