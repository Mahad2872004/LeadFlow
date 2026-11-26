import { useEffect, useState } from 'react'
import { errorText } from '../lib/sales'
import { memberEventLabels, memberNotificationSettings, saveMemberNotificationSettings } from '../lib/collaboration'
import './ProjectCollaboration.css'

/** Which client-activity events also reach this member by email (in-app notifications always appear). */
export function CollabEmailSettings({ workspaceId }: { workspaceId: string }) {
  const [events, setEvents] = useState<string[] | null>(null), [all, setAll] = useState<string[]>([]), [saved, setSaved] = useState<string[]>([])
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    memberNotificationSettings(workspaceId).then(value => { if (active) { setEvents(value.emailEvents); setSaved(value.emailEvents); setAll(value.events) } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspaceId])
  const dirty = events !== null && (events.length !== saved.length || events.some(event => !saved.includes(event)))
  async function save() {
    if (!events) return
    setBusy(true); setError(''); setNotice('')
    try { const value = await saveMemberNotificationSettings(workspaceId, events); setEvents(value.emailEvents); setSaved(value.emailEvents); setNotice('Email preferences saved.') }
    catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <section className="panel settings-panel cb-email-settings" aria-labelledby="cb-email-title">
    <div className="settings-heading"><div><h2 id="cb-email-title">Client activity emails</h2><p>What clients do on the client portal always appears in your notifications. Choose what also reaches you by email.</p></div></div>
    {events === null ? <p className="sp-muted" role="status">{error || 'Loading…'}</p> : <form onSubmit={event => { event.preventDefault(); void save() }}>
      <ul>{all.map(event => <li key={event}><label className="cb-check"><input type="checkbox" checked={events.includes(event)}
        onChange={change => setEvents(change.target.checked ? [...events, event] : events.filter(item => item !== event))} />{memberEventLabels[event] ?? event}</label></li>)}</ul>
      <p className="settings-note">You hear about projects you own (owners and admins hear about projects without an owner), decisions on reviews you requested, and, as an owner or admin, people joining the portal. Emails go out only when email delivery is configured for this LeadFlow installation.</p>
      {error && <p className="sp-error" role="alert">{error}</p>}
      {notice && <p className="auth-success" role="status">{notice}</p>}
      <div className="modal-actions"><button className="primary" disabled={busy || !dirty}>Save email preferences</button></div>
    </form>}
  </section>
}
