import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { TaskList } from './TaskList'
import { OnboardingRequest } from './OnboardingRequest'
import { ReadinessBadge } from './OnboardingReadiness'
import { ClientMark, ClientStatusChip, OnboardingMeter } from './Clients'
import { ClientScope } from './ClientScope'
import { ClientDocuments } from './ClientDocuments'
import { ClientActivity } from './ClientActivity'
import type { WorkspaceSummary } from '../lib/backend'
import { cancelTask, clientTaskTypes, createClientTask, priorities, toggleTask, today, type Data, type Lead, type Priority, type TaskType } from '../lib/model'
import { errorText, money, priorityLabels, shortDate, taskTypeLabels, dateTime, type SalesMember } from '../lib/sales'
import { mailtoLink } from '../lib/outreach'
import { loadOverview, serviceLabels, type TemplateSummary } from '../lib/onboarding'
import {
  clientHandoff, clientStatusLabels, completeOnboarding, completionCheck, conflict, contactRoleLabels, contactRoles, channelLabels, deleteClientContact, loadClient, markWelcomeSent,
  preferredChannels, saveClientContact, saveWelcome, setClientStatus, startOnboarding, updateClient, welcomeChannelLabels, welcomeChannels, welcomeDraft,
  type ClientContact, type ClientContactRole, type ClientDetail, type CompletionItem, type ContactInput, type Handoff, type PreferredChannel, type ProfileFields, type WelcomeChannel,
} from '../lib/clients'

export type ClientTab = 'overview' | 'contacts' | 'onboarding' | 'scope' | 'documents' | 'tasks' | 'activity' | 'projects'
const tabs: [ClientTab, string][] = [['overview', 'Overview'], ['contacts', 'Contacts'], ['onboarding', 'Onboarding'], ['scope', 'Services & scope'], ['documents', 'Documents'], ['tasks', 'Tasks'], ['activity', 'Activity & notes'], ['projects', 'Projects']]
/** Runs a change, reloads the client, and reports the outcome. Resolves true when the change succeeded. */
export type Act = (action: () => Promise<string | void>) => Promise<boolean>

/**
 * One client's workspace: profile, contacts, onboarding, agreed services and scope, documents, tasks, history and notes.
 * Every change goes through a role-checked database function; archived clients are read-only until unarchived.
 */
export function ClientWorkspace({ workspace, clientId, data, day, members, leads, initialTab = 'overview', initialRequest = null, onBack, onCommit, onOpenDeal, onOpenLead, onChanged }: {
  workspace: WorkspaceSummary; clientId: string; data: Data; day: string; members: SalesMember[]; leads: Lead[]; initialTab?: ClientTab; initialRequest?: string | null
  onBack: () => void; onCommit: (next: Data, message: string) => Promise<boolean>; onOpenDeal: (dealId: string) => void; onOpenLead: (leadId: string) => void; onChanged: (message?: string) => void
}) {
  const [detail, setDetail] = useState<ClientDetail | null>(null), [tab, setTab] = useState<ClientTab>(initialTab), [openRequest, setOpenRequest] = useState<string | null>(initialRequest)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [loadError, setLoadError] = useState(''), [revision, setRevision] = useState(0)
  const [statusDialog, setStatusDialog] = useState<'archived' | 'unarchive' | null>(null)
  const load = useCallback(async () => { const next = await loadClient(workspace.id, clientId); setDetail(next); setRevision(value => value + 1); return next }, [workspace.id, clientId])
  useEffect(() => {
    let active = true
    loadClient(workspace.id, clientId).then(next => { if (active) setDetail(next) }).catch(cause => { if (active) setLoadError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, clientId])
  const act: Act = async action => {
    setBusy(true); setError(''); setNotice('')
    try { const message = await action(); await load(); if (message) { setNotice(message); onChanged(message) } else onChanged(); return true }
    catch (cause) {
      setError(conflict(cause) ? 'This client changed in another window. It has been reloaded; check it and try again.' : errorText(cause))
      if (conflict(cause)) await load().catch(() => undefined)
      return false
    } finally { setBusy(false) }
  }
  if (!detail) return <section className="panel"><div className="sp-loading" role="status">{loadError ? <><p className="sp-error" role="alert">{loadError}</p><button className="secondary" onClick={onBack}>Back to clients</button></> : 'Loading client…'}</div></section>
  const locked = detail.status === 'archived', manager = workspace.role !== 'member'
  const clientTasks = data.tasks.filter(task => task.clientId === detail.id)
  const openTasks = clientTasks.filter(task => !task.completed && !task.cancelled).length
  const primary = detail.contacts.find(contact => contact.isPrimary)
  return <div className="cl-workspace">
    <button className="text-button cl-back" onClick={onBack}><span aria-hidden="true">←</span> All clients</button>
    <section className="panel cl-head">
      <div className="cl-head-who">
        <ClientMark name={detail.name} logoUrl={detail.logoUrl} size={52} />
        <div><h2>{detail.name}</h2>
          <p className="cl-head-tags"><ClientStatusChip status={detail.status} /><OnboardingMeter state={detail.onboarding.state} percent={detail.onboarding.percent} />
            {detail.website && <a href={detail.website} target="_blank" rel="noreferrer noopener">{detail.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a>}</p></div>
        <div className="cl-head-actions">
          {!locked && <label className="sp-inline">Status<select value={detail.status} disabled={busy} onChange={event => void act(async () => { await setClientStatus(workspace.id, detail.id, event.target.value as ClientDetail['status'], detail.version, ''); return `Status changed to ${clientStatusLabels[event.target.value as ClientDetail['status']].toLowerCase()}.` })}>
            {(['onboarding', 'active', 'paused', 'completed'] as const).map(status => <option key={status} value={status}>{clientStatusLabels[status]}</option>)}</select></label>}
          {manager && <button className="secondary" disabled={busy} onClick={() => setStatusDialog(locked ? 'unarchive' : 'archived')}>{locked ? 'Unarchive' : 'Archive…'}</button>}
        </div>
      </div>
      <dl className="sp-facts cl-facts">
        <div><dt>Primary contact</dt><dd>{primary ? primary.fullName : '—'}{primary?.email && <small><a href={`mailto:${primary.email}`}>{primary.email}</a></small>}</dd></div>
        <div><dt>Owner</dt><dd>{detail.ownerName ?? 'Unassigned'}</dd></div>
        <div><dt>Confirmed services</dt><dd>{detail.services.length || '—'}</dd></div>
        <div><dt>Open tasks</dt><dd>{openTasks}</dd></div>
        <div><dt>{detail.deal ? 'From the deal' : detail.lead ? 'From the lead' : 'Client since'}</dt><dd>{detail.deal ? <button className="sp-link" onClick={() => onOpenDeal(detail.deal!.id)}>{detail.deal.title}</button>
          : detail.lead ? <button className="sp-link" onClick={() => onOpenLead(detail.lead!.id)}>{detail.lead.company || detail.lead.name}</button> : shortDate(detail.createdAt)}</dd></div>
      </dl>
    </section>
    {locked && <p className="sp-caution" role="note">This client is archived. Its records, files and history are kept and read-only; client links stopped working. {manager ? 'Unarchive it to make changes.' : 'An owner or admin can unarchive it.'}</p>}
    {notice && <p className="sp-notice" role="status">{notice}</p>}
    {error && <p className="sp-error" role="alert">{error}</p>}
    <div className="sp-tabs cl-tabs" role="tablist" aria-label="Client sections">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); if (key !== 'onboarding') setOpenRequest(null) }}>
      {label}{key === 'tasks' && openTasks > 0 && <span className="number-tag">{openTasks}</span>}{key === 'documents' && detail.documentCount > 0 && <span className="number-tag">{detail.documentCount}</span>}</button>)}</div>
    <div className="cl-tab-body" role="tabpanel" aria-label={tabs.find(([key]) => key === tab)![1]}>
      {tab === 'overview' && <Overview workspace={workspace} detail={detail} busy={busy} locked={locked} manager={manager} revision={revision} act={act} onOpenTab={setTab} />}
      {tab === 'contacts' && <Contacts workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />}
      {tab === 'onboarding' && (openRequest
        ? <OnboardingRequest workspace={workspace} requestId={openRequest} members={detail.members} leads={leads} onBack={message => { setOpenRequest(null); void load().catch(() => undefined); if (message) { setNotice(message); onChanged(message) } }} />
        : <Onboarding workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} onOpen={setOpenRequest} />)}
      {tab === 'scope' && <ClientScope workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />}
      {tab === 'documents' && <ClientDocuments workspace={workspace} detail={detail} locked={locked} manager={manager} onChanged={message => { void load().catch(() => undefined); setNotice(message); onChanged(message) }} />}
      {tab === 'tasks' && <Tasks detail={detail} data={data} day={day} members={members} locked={locked} onCommit={onCommit} />}
      {tab === 'activity' && <ClientActivity workspace={workspace} detail={detail} revision={revision} />}
      {tab === 'projects' && <Projects workspace={workspace} detail={detail} onOpenTab={setTab} />}
    </div>
    {statusDialog && <StatusDialog kind={statusDialog} name={detail.name} busy={busy} onClose={() => setStatusDialog(null)}
      onConfirm={async reason => { if (await act(async () => { await setClientStatus(workspace.id, detail.id, statusDialog, detail.version, reason); return statusDialog === 'archived' ? `${detail.name} was archived.` : `${detail.name} was unarchived.` })) setStatusDialog(null) }} />}
  </div>
}

function StatusDialog({ kind, name, busy, onClose, onConfirm }: { kind: 'archived' | 'unarchive'; name: string; busy: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  return <Modal title={kind === 'archived' ? `Archive ${name}?` : `Unarchive ${name}?`} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onConfirm(reason.trim()) }}>
      <p className="sp-intro">{kind === 'archived' ? 'Archiving hides the client from the directory and makes it read-only. Its onboarding links stop working. Nothing is deleted, and you can unarchive it.' : 'The client returns to the status it had before it was archived. Client links stay revoked; create new ones if needed.'}</p>
      <label>Reason (optional)<textarea rows={2} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{kind === 'archived' ? 'Archive client' : 'Unarchive client'}</button></div>
    </form>
  </Modal>
}

function Card({ title, action, children, wide = false }: { title: string; action?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <section className={`sp-card-block${wide ? ' sp-wide' : ''}`}><div className="sp-block-head"><h3>{title}</h3>{action}</div>{children}</section>
}

// ---------- Overview ----------

function Overview({ workspace, detail, busy, locked, manager, revision, act, onOpenTab }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; manager: boolean; revision: number; act: Act; onOpenTab: (tab: ClientTab) => void }) {
  return <div className="sp-section-grid cl-overview">
    <Completion workspace={workspace} detail={detail} busy={busy} locked={locked} manager={manager} revision={revision} act={act} onOpenTab={onOpenTab} />
    <Profile workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    <Welcome workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    <Dates workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    <Notes workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    {detail.conversion && <Card title="Converted from a deal">
      <dl className="sp-dl">
        <div><dt>Deal</dt><dd>{String(detail.conversion.dealTitle ?? '—')}</dd></div>
        <div><dt>Value</dt><dd>{money((detail.conversion.wonValue ?? detail.conversion.value ?? null) as number | null, String(detail.conversion.currency ?? 'USD'))}</dd></div>
        <div><dt>Converted</dt><dd>{shortDate(detail.convertedAt)}{detail.convertedBy ? ` by ${detail.convertedBy}` : ''}</dd></div>
        <div><dt>Outcome</dt><dd>{detail.conversion.outcome === 'won' ? 'Won' : `Converted by exception (${String(detail.conversion.outcome)})`}</dd></div>
        {typeof detail.conversion.overrideReason === 'string' && <div className="sp-wide"><dt>Reason</dt><dd className="sp-pre">{detail.conversion.overrideReason}</dd></div>}
        {detail.deal?.opportunityTitle && <div className="sp-wide"><dt>Opportunity</dt><dd>{detail.deal.opportunityTitle}</dd></div>}
      </dl>
    </Card>}
  </div>
}

function Completion({ workspace, detail, busy, locked, manager, revision, act, onOpenTab }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; manager: boolean; revision: number; act: Act; onOpenTab: (tab: ClientTab) => void }) {
  const [check, setCheck] = useState<{ items: CompletionItem[]; ready: boolean } | null>(null), [confirming, setConfirming] = useState(false), [note, setNote] = useState(''), [reason, setReason] = useState('')
  useEffect(() => {
    let active = true
    completionCheck(workspace.id, detail.id).then(value => { if (active) setCheck(value) }).catch(() => { if (active) setCheck(null) })
    return () => { active = false }
  }, [workspace.id, detail.id, revision])
  const target: Record<CompletionItem['key'], ClientTab> = { contact: 'contacts', services: 'scope', requirements: 'scope', scope: 'scope', onboarding: 'onboarding' }
  if (detail.completion) return <Card title="Onboarding completed" wide>
    <p><Icon name="check" size={16} /> Completed on {shortDate(detail.completion.completedAt)}{detail.completion.completedBy ? ` by ${detail.completion.completedBy}` : ''}. The project handoff record is saved for delivery.</p>
    {detail.completion.overrideReason && <p className="sp-caution">Completed with {detail.completion.outstanding.length} item{detail.completion.outstanding.length === 1 ? '' : 's'} outstanding: {detail.completion.outstanding.map(item => item.label).join(', ')}. Reason: {detail.completion.overrideReason}</p>}
    {detail.completion.note && <p className="sp-quote">{detail.completion.note}</p>}
    <button className="text-button" onClick={() => onOpenTab('projects')}>View the handoff record</button>
  </Card>
  const outstanding = check?.items.filter(item => !item.met) ?? []
  return <Card title="Ready for delivery?" wide>
    {!check ? <p className="sp-muted">Checking…</p> : <>
      <ul className="cl-checklist">{check.items.map(item => <li key={item.key} className={item.met ? 'is-met' : ''}>
        <span className="cl-check-mark" aria-hidden="true">{item.met ? '✓' : ''}</span><div><strong>{item.label}</strong>{!item.met && <small>{item.detail}</small>}</div>
        {!item.met && <button className="text-button" onClick={() => onOpenTab(target[item.key])}>Open</button>}
        <span className="sr-only">{item.met ? 'Done' : 'Outstanding'}</span></li>)}</ul>
      {confirming ? <div className="sp-confirm">
        <p>{check.ready ? 'Complete onboarding? This happens once: it records what was agreed (contacts, services, scope, requirements, documents) as the handoff for project delivery, and hands off any ready checklists.'
          : `Complete onboarding with ${outstanding.length} item${outstanding.length === 1 ? '' : 's'} outstanding? The reason and what was outstanding are kept with the record.`}</p>
        {!check.ready && <label>Reason *<textarea required rows={2} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>}
        <label>Note for the delivery team<textarea rows={2} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></label>
        <div className="sp-actions"><button className="secondary" onClick={() => setConfirming(false)}>Cancel</button>
          <button className="primary" disabled={busy || (!check.ready && !reason.trim())} onClick={() => void act(async () => { const result = await completeOnboarding(workspace.id, detail.id, note.trim(), check.ready ? null : reason.trim()); setConfirming(false); return result.repeated ? 'Onboarding was already completed.' : 'Onboarding completed. The handoff for project delivery is saved.' })}>Complete onboarding</button></div>
      </div> : <div className="sp-actions">
        {check.ready ? <button className="primary sp-won" disabled={busy || locked} onClick={() => setConfirming(true)}>Complete onboarding…</button>
          : manager ? <button className="secondary" disabled={busy || locked} onClick={() => setConfirming(true)}>Complete anyway…</button>
          : <p className="sp-muted">Finish the outstanding items to complete onboarding. An owner or admin can complete it anyway, with a reason.</p>}
      </div>}
    </>}
  </Card>
}

function Profile({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  const initial = { name: detail.name, website: detail.website, industry: detail.industry, logoUrl: detail.logoUrl, description: detail.description, address: detail.address, city: detail.city, region: detail.region, postcode: detail.postcode, country: detail.country, timezone: detail.timezone, ownerId: detail.ownerId ?? '' }
  const [editing, setEditing] = useState(false), [form, setForm] = useState(initial)
  const zones = (() => { try { return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [] } catch { return [] } })()
  async function save() {
    const changes = Object.fromEntries(Object.entries(form).filter(([key, value]) => value !== initial[key as keyof typeof initial])) as ProfileFields
    if (!Object.keys(changes).length) { setEditing(false); return }
    if ('ownerId' in changes) changes.ownerId = form.ownerId || null
    if (await act(async () => { await updateClient(workspace.id, detail.id, detail.version, changes); return 'Client details saved.' })) setEditing(false)
  }
  if (editing) return <Card title="Profile">
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <label>Client name *<input required maxLength={150} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <div className="sp-row"><label>Website<input maxLength={300} value={form.website} onChange={event => setForm({ ...form, website: event.target.value })} /></label>
        <label>Industry<input maxLength={100} value={form.industry} onChange={event => setForm({ ...form, industry: event.target.value })} /></label></div>
      <label>Logo address<input maxLength={500} value={form.logoUrl} placeholder="https://…/logo.png" onChange={event => setForm({ ...form, logoUrl: event.target.value })} /><small>An https link to the client’s logo. Optional.</small></label>
      <label>Description<textarea rows={3} maxLength={4000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <label>Address<input maxLength={300} value={form.address} onChange={event => setForm({ ...form, address: event.target.value })} /></label>
      <div className="sp-row sp-row-3"><label>City<input maxLength={100} value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} /></label>
        <label>Region<input maxLength={100} value={form.region} onChange={event => setForm({ ...form, region: event.target.value })} /></label>
        <label>Postcode<input maxLength={20} value={form.postcode} onChange={event => setForm({ ...form, postcode: event.target.value })} /></label></div>
      <div className="sp-row sp-row-3"><label>Country code<input maxLength={2} value={form.country} placeholder="US" onChange={event => setForm({ ...form, country: event.target.value.toUpperCase() })} /></label>
        <label>Time zone{zones.length ? <select value={form.timezone} onChange={event => setForm({ ...form, timezone: event.target.value })}><option value="">Not set</option>{zones.map(zone => <option key={zone}>{zone}</option>)}</select>
          : <input maxLength={60} value={form.timezone} placeholder="Europe/London" onChange={event => setForm({ ...form, timezone: event.target.value })} />}</label>
        <label>Owner<select value={form.ownerId} onChange={event => setForm({ ...form, ownerId: event.target.value })}><option value="">Unassigned</option>{detail.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div>
      <div className="sp-actions"><button type="button" className="secondary" onClick={() => { setForm(initial); setEditing(false) }}>Cancel</button><button className="primary" disabled={busy}>Save details</button></div>
    </form>
  </Card>
  const place = [detail.address, detail.city, detail.region, detail.postcode, detail.country].filter(Boolean).join(', ')
  return <Card title="Profile" action={!locked && <button className="text-button" onClick={() => { setForm(initial); setEditing(true) }}>Edit</button>}>
    <dl className="sp-dl">
      <div><dt>Industry</dt><dd>{detail.industry || '—'}</dd></div><div><dt>Time zone</dt><dd>{detail.timezone || '—'}</dd></div>
      <div className="sp-wide"><dt>Address</dt><dd>{place || '—'}</dd></div>
      {detail.description && <div className="sp-wide"><dt>Description</dt><dd className="sp-pre">{detail.description}</dd></div>}
      <div><dt>Created</dt><dd>{shortDate(detail.createdAt)}</dd></div><div><dt>Updated</dt><dd>{shortDate(detail.updatedAt)}</dd></div>
    </dl>
  </Card>
}

function Dates({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  const [editing, setEditing] = useState(false), [rows, setRows] = useState(detail.importantDates)
  const sorted = detail.importantDates.toSorted((a, b) => a.date.localeCompare(b.date))
  return <Card title="Important dates" action={!locked && !editing && <button className="text-button" onClick={() => { setRows(detail.importantDates); setEditing(true) }}>Edit</button>}>
    {editing ? <form className="sp-form" onSubmit={event => { event.preventDefault(); void act(async () => { await updateClient(workspace.id, detail.id, detail.version, { importantDates: rows.filter(row => row.label.trim() || row.date) }); setEditing(false); return 'Important dates saved.' }) }}>
      {rows.map((row, index) => <div className="cl-date-row" key={index}>
        <input aria-label="What the date is" maxLength={60} required value={row.label} placeholder="e.g. Launch, Contract renewal" onChange={event => setRows(rows.map((item, at) => at === index ? { ...item, label: event.target.value } : item))} />
        <input aria-label={`Date for ${row.label || 'entry'}`} type="date" required value={row.date} onChange={event => setRows(rows.map((item, at) => at === index ? { ...item, date: event.target.value } : item))} />
        <button type="button" className="text-button" aria-label={`Remove ${row.label || 'date'}`} onClick={() => setRows(rows.filter((_, at) => at !== index))}>Remove</button></div>)}
      {rows.length < 20 && <button type="button" className="text-button" onClick={() => setRows([...rows, { label: '', date: today() }])}>+ Add a date</button>}
      <div className="sp-actions"><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={busy}>Save dates</button></div>
    </form> : sorted.length ? <ul className="cl-dates">{sorted.map((row, index) => <li key={index}><strong>{row.label}</strong><time dateTime={row.date}>{shortDate(row.date)}</time></li>)}</ul>
      : <p className="sp-muted">Kickoff, launch, renewal: dates worth remembering for this client.</p>}
  </Card>
}

function Notes({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  const [text, setText] = useState(detail.internalNotes)
  return <Card title="Internal notes">
    <p className="sp-muted">For your team only. Never shown to the client. For dated notes, use Activity &amp; notes.</p>
    <textarea className="cl-textarea" aria-label="Internal notes" rows={5} maxLength={8000} value={text} disabled={locked} onChange={event => setText(event.target.value)} />
    {!locked && text !== detail.internalNotes && <div className="sp-actions"><button className="secondary" onClick={() => setText(detail.internalNotes)}>Discard</button>
      <button className="primary" disabled={busy} onClick={() => void act(async () => { await updateClient(workspace.id, detail.id, detail.version, { internalNotes: text }); return 'Notes saved.' })}>Save notes</button></div>}
  </Card>
}

/** The welcome message: written and saved here, sent by the agency from their own email or chat. LeadFlow never sends it. */
function Welcome({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  const draft = detail.welcome.body ? detail.welcome : { ...detail.welcome, ...welcomeDraft(detail, workspace.name, '') }
  const [subject, setSubject] = useState(draft.subject), [body, setBody] = useState(draft.body), [channel, setChannel] = useState<WelcomeChannel>('email'), [copied, setCopied] = useState(''), [marking, setMarking] = useState(false)
  const dirty = subject !== detail.welcome.subject || body !== detail.welcome.body
  const email = (detail.contacts.find(contact => contact.isPrimary) ?? detail.contacts[0])?.email
  async function copy() {
    try { await navigator.clipboard.writeText(`${subject}\n\n${body}`); setCopied('Copied. Paste it into your email or chat.') } catch { setCopied('Copy didn’t work in this browser. Select the text and copy it instead.') }
  }
  return <Card title="Welcome message" wide>
    {detail.welcome.sentAt ? <p className="sp-notice" role="status">Marked as sent by {welcomeChannelLabels[detail.welcome.channel ?? 'other'].toLowerCase()} on {dateTime(detail.welcome.sentAt)}{detail.welcome.sentBy ? ` by ${detail.welcome.sentBy}` : ''}. It was sent outside LeadFlow, so delivery isn’t tracked.</p>
      : <p className="sp-muted">Write it here, then send it from your own email or chat. LeadFlow doesn’t send it and can’t confirm delivery; mark it as sent once you have.</p>}
    <label className="cl-field">Subject<input maxLength={200} value={subject} disabled={locked} onChange={event => setSubject(event.target.value)} /></label>
    <label className="cl-field">Message<textarea className="cl-textarea" rows={9} maxLength={8000} value={body} disabled={locked} onChange={event => setBody(event.target.value)} /></label>
    {copied && <p className="sp-muted" role="status">{copied}</p>}
    <div className="sp-actions">
      {!locked && <button className="secondary" disabled={busy || !dirty} onClick={() => void act(async () => { await saveWelcome(workspace.id, detail.id, subject, body); return 'Welcome message saved.' })}>Save draft</button>}
      {!locked && !detail.welcome.body && <span className="sp-muted">Not saved yet: this is a starting point.</span>}
      <button className="secondary" onClick={() => void copy()}><Icon name="copy" size={15} /> Copy</button>
      {email && <a className="secondary cl-link-button" href={mailtoLink(email, subject, body)}><Icon name="mail" size={15} /> Open in your email app</a>}
      {!locked && !detail.welcome.sentAt && (marking ? <span className="cl-inline-confirm">
        <label className="sp-inline">Sent by<select value={channel} onChange={event => setChannel(event.target.value as WelcomeChannel)}>{welcomeChannels.map(item => <option key={item} value={item}>{welcomeChannelLabels[item]}</option>)}</select></label>
        <button className="primary" disabled={busy || dirty || !detail.welcome.body} title={dirty || !detail.welcome.body ? 'Save the message first' : undefined} onClick={() => void act(async () => { await markWelcomeSent(workspace.id, detail.id, channel); setMarking(false); return 'Welcome message marked as sent.' })}>Confirm it was sent</button>
        <button className="text-button" onClick={() => setMarking(false)}>Cancel</button></span>
        : <button className="primary" disabled={busy} onClick={() => setMarking(true)}>Mark as sent…</button>)}
    </div>
    {marking && (dirty || !detail.welcome.body) && <p className="sp-muted">Save the message first, so the record matches what you sent.</p>}
  </Card>
}

// ---------- Contacts ----------

const blankContact = (): ContactInput => ({ fullName: '', jobTitle: '', role: 'project', email: '', phone: '', preferredChannel: 'email', notes: '', isPrimary: false })
function Contacts({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  const [editing, setEditing] = useState<ContactInput | null>(null), [removing, setRemoving] = useState<ClientContact | null>(null)
  return <section className="panel cl-section">
    <div className="section-heading"><div><h2>Contacts <span className="number-tag">{detail.contacts.length}</span></h2><p>Who you work with at {detail.name}. The primary contact receives onboarding by default.</p></div>
      {!locked && <button className="primary" onClick={() => setEditing({ ...blankContact(), isPrimary: !detail.contacts.length })}><Icon name="plus" size={17} /> Add contact</button>}</div>
    {!detail.contacts.length ? <div className="empty"><h3>No contacts yet</h3><p>Add the client’s decision-maker and day-to-day contact.</p></div>
      : <ul className="cl-contacts">{detail.contacts.map(contact => <li key={contact.id}>
        <div><strong>{contact.fullName}</strong>{contact.isPrimary && <span className="sp-chip is-high">Primary</span>}<span className="sp-chip">{contactRoleLabels[contact.role]}</span>
          <p className="sp-muted">{[contact.jobTitle, `Prefers ${channelLabels[contact.preferredChannel].toLowerCase()}`].filter(Boolean).join(' · ')}</p>
          <p className="cl-contact-links">{contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}{contact.phone && <a href={`tel:${contact.phone}`}>{contact.phone}</a>}</p>
          {contact.notes && <p className="sp-quote">{contact.notes}</p>}</div>
        {!locked && <div className="sp-actions">
          {!contact.isPrimary && <button className="text-button" disabled={busy} onClick={() => void act(async () => { await saveClientContact(workspace.id, detail.id, { ...contact, isPrimary: true }); return `${contact.fullName} is now the primary contact.` })}>Make primary</button>}
          <button className="text-button" onClick={() => setEditing({ ...contact })}>Edit</button>
          <button className="text-button" onClick={() => setRemoving(contact)}>Remove</button></div>}
      </li>)}</ul>}
    {editing && <ContactDialog contact={editing} busy={busy} onClose={() => setEditing(null)}
      onSave={async contact => { if (await act(async () => { await saveClientContact(workspace.id, detail.id, contact); return contact.id ? 'Contact saved.' : `${contact.fullName} was added.` })) setEditing(null) }} />}
    {removing && <Modal title={`Remove ${removing.fullName}?`} onClose={() => setRemoving(null)}>
      <p>{removing.isPrimary && detail.contacts.length > 1 ? 'Make another contact primary first; the primary contact can’t be removed while others remain.' : 'The contact is removed from this client. The removal is kept in the client’s history.'}</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setRemoving(null)}>Cancel</button>
        <button className="primary" disabled={busy || (removing.isPrimary && detail.contacts.length > 1)} onClick={() => void act(async () => { await deleteClientContact(workspace.id, detail.id, removing.id); setRemoving(null); return `${removing.fullName} was removed.` })}>Remove contact</button></div>
    </Modal>}
  </section>
}
function ContactDialog({ contact, busy, onClose, onSave }: { contact: ContactInput; busy: boolean; onClose: () => void; onSave: (contact: ContactInput) => Promise<void> }) {
  const [form, setForm] = useState(contact)
  return <Modal title={contact.id ? `Edit ${contact.fullName}` : 'Add a contact'} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onSave({ ...form, fullName: form.fullName.trim(), email: form.email.trim(), phone: form.phone.trim(), jobTitle: form.jobTitle.trim() }) }}>
      <div className="sp-row"><label>Full name *<input required maxLength={150} value={form.fullName} onChange={event => setForm({ ...form, fullName: event.target.value })} /></label>
        <label>Job title<input maxLength={150} value={form.jobTitle} onChange={event => setForm({ ...form, jobTitle: event.target.value })} /></label></div>
      <div className="sp-row"><label>Role<select value={form.role} onChange={event => setForm({ ...form, role: event.target.value as ClientContactRole })}>{contactRoles.map(role => <option key={role} value={role}>{contactRoleLabels[role]}</option>)}</select></label>
        <label>Preferred channel<select value={form.preferredChannel} onChange={event => setForm({ ...form, preferredChannel: event.target.value as PreferredChannel })}>{preferredChannels.map(item => <option key={item} value={item}>{channelLabels[item]}</option>)}</select></label></div>
      <div className="sp-row"><label>Email<input type="email" maxLength={254} value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></label>
        <label>Phone<input type="tel" maxLength={40} value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} /></label></div>
      <label>Notes<textarea rows={2} maxLength={2000} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label>
      <label className="cl-check-label"><input type="checkbox" checked={form.isPrimary} onChange={event => setForm({ ...form, isPrimary: event.target.checked })} /> Primary contact</label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save contact</button></div>
    </form>
  </Modal>
}

// ---------- Onboarding ----------

function Onboarding({ workspace, detail, busy, locked, act, onOpen }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act; onOpen: (requestId: string) => void }) {
  const [starting, setStarting] = useState(false)
  return <section className="panel cl-section">
    <div className="section-heading"><div><h2>Onboarding checklists</h2><p>What the client provides and what your team does, stage by stage. Open one to review answers, share the client link and track internal steps.</p></div>
      {!locked && <button className="primary" onClick={() => setStarting(true)}><Icon name="plus" size={17} /> Start onboarding</button>}</div>
    {!detail.requests.length ? <div className="empty"><h3>No onboarding yet</h3><p>Start a checklist from a template to collect the information, assets and access you need.</p></div>
      : <ul className="cl-requests">{detail.requests.map(request => <li key={request.id}>
        <button className="cl-request" onClick={() => onOpen(request.id)} aria-label={`Open ${request.title}`}>
          <span className="cl-request-head"><strong>{request.title}</strong><ReadinessBadge state={request.readiness.state} /></span>
          <span className="sp-muted">{serviceLabels[request.serviceType]}{request.templateName ? ` · ${request.templateName}` : ''}{request.dueDate ? ` · inputs due ${shortDate(request.dueDate)}` : ''}{request.status === 'active' && !request.hasActiveLink ? ' · no client link yet' : ''}</span>
          <span className="cl-progress" aria-label={`${request.readiness.percent}% of required items and steps resolved`}><i style={{ width: `${request.readiness.percent}%` }} /></span>
          {request.stages.length > 0 && <span className="cl-stage-strip">{request.stages.filter(stage => stage.state !== 'empty').map(stage => <span key={stage.stageId ?? 'other'} className={`cl-stage is-${stage.state}`} title={`${stage.name}: ${stage.resolved} of ${stage.required} required resolved`}>{stage.name} {stage.resolved}/{stage.required}</span>)}</span>}
        </button></li>)}</ul>}
    {starting && <StartOnboarding workspace={workspace} detail={detail} busy={busy} onClose={() => setStarting(false)}
      onStart={async (details, requestId) => { let created = ''; if (await act(async () => { created = await startOnboarding(workspace.id, detail.id, details, requestId); return 'Onboarding checklist created as a draft. Review it, then open it to the client.' })) { setStarting(false); onOpen(created) } }} />}
  </section>
}
function StartOnboarding({ workspace, detail, busy, onClose, onStart }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; onClose: () => void; onStart: (details: { templateId: string | null; title: string; dueDate: string | null; targetKickoffDate: string | null }, requestId: string) => Promise<void> }) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null), [templateId, setTemplateId] = useState(''), [title, setTitle] = useState(`${detail.name} onboarding`), [due, setDue] = useState(''), [kickoff, setKickoff] = useState('')
  const [requestId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    let active = true
    loadOverview(workspace.id).then(overview => { if (active) { const usable = overview.templates.filter(item => !item.archived); setTemplates(usable); setTemplateId(usable[0]?.id ?? '') } }).catch(() => { if (active) setTemplates([]) })
    return () => { active = false }
  }, [workspace.id])
  return <Modal title="Start onboarding" onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onStart({ templateId: templateId || null, title: title.trim(), dueDate: due || null, targetKickoffDate: kickoff || null }, requestId) }}>
      <p className="sp-intro">The checklist starts as a draft linked to {detail.name}, with the primary contact filled in. Nothing is sent until you share a client link.</p>
      <label>Template<select value={templateId} disabled={templates === null} onChange={event => setTemplateId(event.target.value)}>
        {templates === null && <option>Loading…</option>}{templates?.map(item => <option key={item.id} value={item.id}>{item.name} · {serviceLabels[item.serviceType]} ({item.itemCount} items)</option>)}<option value="">Blank checklist</option></select></label>
      <label>Title *<input required maxLength={150} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <div className="sp-row"><label>Inputs due<input type="date" value={due} onChange={event => setDue(event.target.value)} /></label>
        <label>Target kickoff<input type="date" value={kickoff} onChange={event => setKickoff(event.target.value)} /></label></div>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || templates === null}>Create checklist</button></div>
    </form>
  </Modal>
}

// ---------- Tasks ----------

const suggested: { type: TaskType; notes: string; days: number }[] = [
  { type: 'welcome', notes: 'Send the welcome message', days: 0 }, { type: 'request_info', notes: 'Share the onboarding checklist link', days: 1 },
  { type: 'review_requirements', notes: 'Review the client’s requirements', days: 5 }, { type: 'confirm_scope', notes: 'Confirm the agreed scope with the client', days: 7 },
  { type: 'prepare_handoff', notes: 'Prepare the project handoff', days: 10 },
]
const addDays = (date: string, days: number) => { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + days); return value.toISOString().slice(0, 10) }
function Tasks({ detail, data, day, members, locked, onCommit }: { detail: ClientDetail; data: Data; day: string; members: SalesMember[]; locked: boolean; onCommit: (next: Data, message: string) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false), [error, setError] = useState('')
  const tasks = data.tasks.filter(task => task.clientId === detail.id)
  const missing = suggested.filter(item => !tasks.some(task => task.taskType === item.type && !task.cancelled))
  const names = new Map([[detail.id, detail.name]]), memberNames = new Map(members.map(member => [member.id, member.name]))
  async function addSuggested() {
    setError('')
    try {
      let next = data
      for (const item of missing) next = createClientTask(next, detail.id, addDays(day, item.days), item.notes, { taskType: item.type, priority: item.type === 'welcome' ? 'high' : 'medium', onboardingRequestId: detail.requests.find(request => request.status !== 'cancelled' && request.status !== 'completed')?.id })
      await onCommit(next, `${missing.length} onboarding task${missing.length === 1 ? '' : 's'} planned.`)
    } catch (cause) { setError(errorText(cause)) }
  }
  return <section className="panel cl-section">
    <div className="section-heading"><div><h2>Tasks</h2><p>Reminders for your team, in the same follow-up list as everything else. Nothing is sent to the client.</p></div>
      {!locked && <div className="sp-heading-actions">{missing.length > 0 && <button className="secondary" onClick={() => void addSuggested()}>Plan standard tasks ({missing.length})</button>}<button className="primary" onClick={() => setAdding(true)}><Icon name="plus" size={17} /> Add task</button></div>}</div>
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    <TaskList tasks={tasks} leads={[]} day={day} members={memberNames} clients={names} onSelect={() => undefined} emptyMessage="No tasks for this client yet."
      onToggle={task => void onCommit(toggleTask(data, task.id), task.completed ? 'Task reopened.' : 'Task completed.')} onCancel={task => void onCommit(cancelTask(data, task.id), task.cancelled ? 'Task restored.' : 'Task cancelled.')} />
    {adding && <ClientTaskDialog detail={detail} members={members} onClose={() => setAdding(false)}
      onSubmit={async (due, notes, options) => { if (await onCommit(createClientTask(data, detail.id, due, notes, options), 'Task added.')) setAdding(false) }} />}
  </section>
}
function ClientTaskDialog({ detail, members, onClose, onSubmit }: { detail: ClientDetail; members: SalesMember[]; onClose: () => void; onSubmit: (due: string, notes: string, options: Parameters<typeof createClientTask>[4]) => Promise<void> }) {
  const [taskType, setTaskType] = useState<TaskType>('request_info'), [priority, setPriority] = useState<Priority>('medium'), [due, setDue] = useState(today()), [notes, setNotes] = useState(''), [description, setDescription] = useState('')
  const [assigneeId, setAssigneeId] = useState(''), [requestId, setRequestId] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function submit() {
    setError(''); setBusy(true)
    try { await onSubmit(due, notes, { taskType, priority, description: description.trim() || undefined, assigneeId: assigneeId || undefined, onboardingRequestId: requestId || undefined }) }
    catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal title={`Add a task for ${detail.name}`} onClose={onClose}>
    <form className="task-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="task-form-row">
        <label>Type<select value={taskType} onChange={event => setTaskType(event.target.value as TaskType)}>{clientTaskTypes.map(type => <option key={type} value={type}>{taskTypeLabels[type]}</option>)}</select></label>
        <label>Priority<select value={priority} onChange={event => setPriority(event.target.value as Priority)}>{priorities.map(item => <option key={item} value={item}>{priorityLabels[item]}</option>)}</select></label>
      </div>
      <label>Due date *<input type="date" required value={due} onChange={event => setDue(event.target.value)} /></label>
      <label>Task *<textarea required maxLength={2000} rows={2} value={notes} placeholder="What needs doing?" onChange={event => setNotes(event.target.value)} /></label>
      <div className="task-form-row">
        {members.length > 0 && <label>Assigned to<select value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
        {detail.requests.length > 0 && <label>Checklist<select value={requestId} onChange={event => setRequestId(event.target.value)}><option value="">Not linked</option>{detail.requests.filter(request => request.status !== 'cancelled').map(request => <option key={request.id} value={request.id}>{request.title}</option>)}</select></label>}
      </div>
      <label>Details<textarea maxLength={2000} rows={2} value={description} onChange={event => setDescription(event.target.value)} /></label>
      {error && <p role="alert" className="field-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Add task</button></div>
    </form>
  </Modal>
}

// ---------- Projects (M11) ----------

/** Delivery projects arrive in M11. Until then this shows the handoff record onboarding completion saved for it. */
function Projects({ workspace, detail, onOpenTab }: { workspace: WorkspaceSummary; detail: ClientDetail; onOpenTab: (tab: ClientTab) => void }) {
  const [handoff, setHandoff] = useState<Handoff | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (detail.completion) clientHandoff(workspace.id, detail.id).then(value => { if (active) setHandoff(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, detail.id, detail.completion])
  const snapshot = handoff?.snapshot as { contacts?: unknown[]; services?: { name: string }[]; requirements?: unknown[]; documents?: unknown[]; onboarding?: unknown[]; scope?: { sequence: number } | null } | undefined
  return <section className="panel cl-section">
    <div className="section-heading"><div><h2>Projects</h2><p>Project delivery is the next milestone (M11) and isn’t available yet.</p></div></div>
    <div className="cl-projects">
      {!detail.completion ? <div className="empty"><h3>Not ready for delivery yet</h3><p>When onboarding is completed, LeadFlow saves a handoff record (contacts, confirmed services, scope, requirements and documents) for project delivery.</p><button className="secondary" onClick={() => onOpenTab('overview')}>See what’s outstanding</button></div>
        : error ? <p className="sp-error" role="alert">{error}</p> : !snapshot ? <p className="sp-muted">Loading the handoff record…</p>
        : <div className="sp-card-block"><h3>Handoff record</h3><p className="sp-muted">Saved on {shortDate(handoff!.completedAt)}. It doesn’t change when the client’s details change later.</p>
          <dl className="sp-dl">
            <div><dt>Services</dt><dd>{snapshot.services?.map(service => service.name).join(', ') || '—'}</dd></div>
            <div><dt>Scope</dt><dd>{snapshot.scope ? `Version ${snapshot.scope.sequence}` : 'Not confirmed'}</dd></div>
            <div><dt>Requirements</dt><dd>{snapshot.requirements?.length ?? 0} confirmed</dd></div>
            <div><dt>Contacts</dt><dd>{snapshot.contacts?.length ?? 0}</dd></div>
            <div><dt>Documents</dt><dd>{snapshot.documents?.length ?? 0}</dd></div>
            <div><dt>Checklists</dt><dd>{snapshot.onboarding?.length ?? 0}</dd></div>
          </dl>
          {handoff!.overrideReason && <p className="sp-caution">Completed by exception: {handoff!.overrideReason}</p>}</div>}
    </div>
  </section>
}
