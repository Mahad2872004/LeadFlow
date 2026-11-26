import { useId, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { navigate } from '../../lib/navigation'
import { clientEventLabels } from '../../lib/collaboration'
import { hubMarkNotifications, hubNotifications, hubSaveSettings, hubSettings, type HubNotification } from '../../lib/hub'
import { Icon } from '../Icon'
import { Empty, ErrorState, PageHead, Section, Skeleton } from './hubShared'
import { errorText, passwordProblem, roleLabel, timeAgo, useHub, useLoad } from './hubKit'

export function NotificationsPage() {
  const hub = useHub()
  const [onlyUnread, setOnlyUnread] = useState(false)
  const { data, error, loading, reload, replace } = useLoad(`notifications:${hub.accessId}:${onlyUnread}`, () => hubNotifications(hub.accessId, onlyUnread))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const mark = async (ids: number[] | null) => {
    setBusy(true); setProblem('')
    try {
      await hubMarkNotifications(hub.accessId, ids)
      if (data) replace({ unread: ids ? Math.max(0, data.unread - ids.length) : 0, items: data.items.map(item => !ids || ids.includes(item.id) ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item).filter(item => !onlyUnread || !item.readAt) })
      hub.refreshUnread()
    } catch (cause) { setProblem(errorText(cause)) } finally { setBusy(false) }
  }
  const open = (item: HubNotification) => { if (!item.readAt) void mark([item.id]); navigate(item.link && item.link.startsWith('/portal') ? item.link : '/portal') }
  return <div className="hb-page">
    <PageHead eyebrow={hub.clientName} title="Notifications" description="What happened on your projects. Choose which of these also reach you by email in your settings."
      actions={data && data.unread > 0 ? <button type="button" className="hb-btn is-secondary is-sm" disabled={busy} onClick={() => mark(null)}>Mark all as read</button> : undefined} />
    <div className="hb-segment" role="group" aria-label="Show notifications">
      <button type="button" aria-pressed={!onlyUnread} onClick={() => setOnlyUnread(false)}>All</button>
      <button type="button" aria-pressed={onlyUnread} onClick={() => setOnlyUnread(true)}>Unread{data && data.unread ? <b>{data.unread}</b> : null}</button>
    </div>
    {problem && <p className="hb-inline-error" role="alert">{problem}</p>}
    {loading ? <Skeleton rows={5} label="Loading notifications…" /> : error || !data ? <ErrorState message={error ?? ''} onRetry={reload} />
      : data.items.length === 0 ? <Empty icon="bell" title={onlyUnread ? 'No unread notifications' : 'No notifications yet'}>You’ll hear here when your agency shares work, replies or posts an update.</Empty>
      : <ul className="hb-notifications">{data.items.map(item => <li key={item.id} className={item.readAt ? '' : 'is-unread'}>
        <button type="button" className="hb-notification" onClick={() => open(item)}>
          <span className="hb-notification-dot" aria-hidden="true" />
          <span className="hb-notification-main"><strong>{item.title}</strong>{item.body && <span>{item.body}</span>}<small>{timeAgo(item.createdAt)}{item.readAt ? '' : ' · Unread'}</small></span>
          <Icon name="chevron" size={16} />
        </button>
        {!item.readAt && <button type="button" className="hb-text-btn" disabled={busy} onClick={() => mark([item.id])} aria-label={`Mark “${item.title}” as read`}>Mark read</button>}
      </li>)}</ul>}
  </div>
}

function PasswordForm() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const passwordId = useId(), confirmId = useId()
  return <form className="hb-form" onSubmit={async event => {
    event.preventDefault()
    const issue = passwordProblem(password, confirm)
    if (issue) { setMessage({ ok: false, text: issue }); return }
    setBusy(true); setMessage(null)
    const { error } = await supabase!.auth.updateUser({ password })
    setBusy(false)
    if (error) setMessage({ ok: false, text: error.message }); else { setMessage({ ok: true, text: 'Password changed.' }); setPassword(''); setConfirm('') }
  }}>
    <div className="hb-field-row">
      <div className="hb-field is-grow"><label htmlFor={passwordId}>New password</label><input id={passwordId} type="password" autoComplete="new-password" minLength={8} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></div>
      <div className="hb-field is-grow"><label htmlFor={confirmId}>Confirm new password</label><input id={confirmId} type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={event => setConfirm(event.target.value)} disabled={busy} /></div>
    </div>
    <p className={message ? (message.ok ? 'hb-note' : 'hb-inline-error') : 'hb-sr'} role={message && !message.ok ? 'alert' : 'status'}>{message?.text ?? ''}</p>
    <div><button type="submit" className="hb-btn is-secondary" disabled={busy || !password}>{busy ? 'Saving…' : 'Change password'}</button></div>
  </form>
}

export function SettingsPage() {
  const hub = useHub()
  const { data, error, loading, reload, replace } = useLoad(`settings:${hub.accessId}`, () => hubSettings(hub.accessId))
  const [name, setName] = useState<string | null>(null)
  const [events, setEvents] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [sessionNote, setSessionNote] = useState('')
  const nameId = useId()
  if (loading) return <div className="hb-page"><Skeleton rows={6} label="Loading settings…" /></div>
  if (error || !data) return <div className="hb-page"><ErrorState message={error ?? ''} onRetry={reload} /></div>
  const currentName = name ?? data.name, currentEvents = events ?? data.emailEvents
  const dirty = currentName !== data.name || currentEvents.join() !== data.emailEvents.join()
  return <div className="hb-page hb-settings">
    <PageHead eyebrow={data.client.name} title="Account settings" description="Your profile, email preferences and sign-in security." />
    <form className="hb-stack" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setMessage(null)
      try { replace(await hubSaveSettings(hub.accessId, { name: currentName.trim(), emailEvents: currentEvents })); setName(null); setEvents(null); setMessage({ ok: true, text: 'Settings saved.' }); hub.reloadAccounts() }
      catch (cause) { setMessage({ ok: false, text: errorText(cause) }) } finally { setBusy(false) }
    }}>
      <Section title="Your profile">
        <div className="hb-field-row">
          <div className="hb-field is-grow"><label htmlFor={nameId}>Name</label><input id={nameId} maxLength={150} autoComplete="name" value={currentName} onChange={event => setName(event.target.value)} disabled={busy} /></div>
          <div className="hb-field is-grow"><span className="hb-field-label">Email</span><p className="hb-readonly">{data.email}</p></div>
        </div>
        <p className="hb-hint">Your agency and colleagues see this name on your feedback, approvals and messages.</p>
      </Section>
      <Section title="Email notifications">
        <p className="hb-muted hb-section-note">You always see notifications here in the portal. Choose which ones also come by email.</p>
        <fieldset className="hb-checklist"><legend className="hb-sr">Email me when</legend>
          {data.events.map(key => <label key={key} className="hb-check">
            <input type="checkbox" checked={currentEvents.includes(key)} disabled={busy} onChange={event => setEvents(event.target.checked ? [...currentEvents, key] : currentEvents.filter(item => item !== key))} />
            <span>{clientEventLabels[key] ?? key.replace(/_/g, ' ')}</span>
          </label>)}
        </fieldset>
      </Section>
      <div className="hb-save-bar">
        <p className={message ? (message.ok ? 'hb-note' : 'hb-inline-error') : 'hb-sr'} role={message && !message.ok ? 'alert' : 'status'}>{message?.text ?? ''}</p>
        <button type="submit" className="hb-btn is-primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
    <Section title="Your organization">
      <dl className="hb-facts is-stacked">
        <div><dt>Organization</dt><dd>{data.client.name}</dd></div>
        {data.client.website && <div><dt>Website</dt><dd><a href={data.client.website} target="_blank" rel="noopener noreferrer" className="hb-text-link">{data.client.website.replace(/^https?:\/\//, '')}</a></dd></div>}
        <div><dt>Agency</dt><dd>{data.agencyName}</dd></div>
        <div><dt>Your role</dt><dd>{roleLabel[data.role]}</dd></div>
        <div><dt>Project access</dt><dd>{data.projectAccess === 'all' ? 'Every project shared with your organization' : 'Projects your agency chose for you'}</dd></div>
      </dl>
      <p className="hb-hint">Your agency manages these details and who has access. Contact them to make changes.</p>
    </Section>
    <Section title="Password and security">
      <PasswordForm />
      <div className="hb-security-row">
        <div><strong>Signed in on other devices?</strong><p className="hb-muted">Sign out everywhere except this browser.</p></div>
        <button type="button" className="hb-btn is-secondary" onClick={async () => {
          setSessionNote('')
          const { error: failure } = await supabase!.auth.signOut({ scope: 'others' })
          setSessionNote(failure ? failure.message : 'Other devices were signed out.')
        }}>Sign out other devices</button>
      </div>
      <p className={sessionNote ? 'hb-note' : 'hb-sr'} role="status">{sessionNote}</p>
      <div className="hb-security-row">
        <div><strong>Sign out</strong><p className="hb-muted">End your session on this browser.</p></div>
        <button type="button" className="hb-btn is-ghost" onClick={() => void hub.signOut()}><Icon name="logout" size={15} /> Sign out</button>
      </div>
    </Section>
  </div>
}
