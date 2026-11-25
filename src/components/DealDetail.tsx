import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { TaskForm } from './TaskForm'
import { CloseDealDialog, StageBadge } from './SalesBits'
import { localDate, taskState } from '../lib/dates'
import { cancelTask, createTask, toggleTask, type Data, type Lead } from '../lib/model'
import type { WorkspaceSummary } from '../lib/backend'
import { channelLabels, draftStatusLabels, type DraftStatus, type OutreachChannel } from '../lib/outreach'
import {
  callOutcomeLabels, categoryLabels, dealDetail, dealTimeline, isConflict, meetingStatusLabels, money, moveDeal, priorityLabels, recordDealActivity, reopenDeal, salesPipeline,
  saveMeeting, setDealArchived, sourceLabels, taskTypeLabels, timelineGroupLabels, updateDeal, weighted,
  type ActivityInput, type CallOutcome, type DealChanges, type DealDetail as Detail, type Meeting, type MeetingStatus, type Pipeline, type Priority, type Stage, type TimelineGroup, type TimelineItem, dateTime, errorText, relativeDays, shortDate, suggestStage } from '../lib/sales'

type Tab = 'overview' | 'timeline' | 'work' | 'outreach'
const tabs: [Tab, string][] = [['overview', 'Overview'], ['timeline', 'Timeline'], ['work', 'Follow-ups & meetings'], ['outreach', 'Outreach']]
const groups: TimelineGroup[] = ['activity', 'stage', 'task', 'meeting', 'outreach', 'lead']
const groupIcon: Record<TimelineGroup, 'chat' | 'columns' | 'calendar' | 'clock' | 'mail' | 'users'> = { activity: 'chat', stage: 'columns', task: 'calendar', meeting: 'clock', outreach: 'mail', lead: 'users' }
interface Suggestion { stage: Stage; reason: string }

/**
 * One deal: what it's worth, where it stands, who's involved, and everything that happened. Stage changes are only ever
 * made by a person; after something is recorded (a reply, a meeting, a proposal), the next stage may be suggested, and
 * it's applied only if they confirm it.
 */
export function DealDetail({ workspace, dealId, data, client, onCommit, onOpenLead, onOpenOutreach, onConvert, onOpenClient, onOpenDeal, onChanged, onClose }: {
  workspace: WorkspaceSummary; dealId: string; data: Data
  /** M10: the client this deal was converted into, if any. */
  client: { id: string; name: string } | null
  onCommit: (next: Data, message: string) => Promise<boolean>; onOpenLead: (leadId: string) => void; onOpenOutreach: (leadId: string) => void
  onConvert: () => void; onOpenClient: (clientId: string) => void; onOpenDeal: (dealId: string) => void; onChanged: (message?: string) => void; onClose: () => void
}) {
  const [detail, setDetail] = useState<Detail | null>(null), [pipeline, setPipeline] = useState<Pipeline | null>(null)
  const [tab, setTab] = useState<Tab>('overview'), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState<'won' | 'lost' | null>(null), [suggestion, setSuggestion] = useState<Suggestion | null>(null), [timelineVersion, setTimelineVersion] = useState(0)
  const load = useCallback(async () => {
    const [next, config] = await Promise.all([dealDetail(workspace.id, dealId), salesPipeline(workspace.id)])
    setDetail(next); setPipeline(config)
    return next
  }, [workspace.id, dealId])
  useEffect(() => {
    let active = true
    Promise.all([dealDetail(workspace.id, dealId), salesPipeline(workspace.id)]).then(([next, config]) => { if (active) { setDetail(next); setPipeline(config) } })
      .catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, dealId])
  async function act(action: () => Promise<string | void>) {
    setBusy(true); setError(''); setNotice('')
    try { const message = await action(); await load(); setTimelineVersion(value => value + 1); if (message) { setNotice(message); onChanged(message) } else onChanged() }
    catch (cause) { setError(isConflict(cause) ? 'This deal changed in another window. It has been reloaded; check it and try again.' : errorText(cause)); if (isConflict(cause)) await load().catch(() => undefined) }
    finally { setBusy(false) }
  }
  /** After something is recorded, offer the matching stage if the deal is behind it. Never applied without a click. */
  function offer(key: Stage['key'], reason: string) {
    if (!detail || !pipeline) return
    const stage = suggestStage(pipeline.stages, detail, key)
    setSuggestion(stage ? { stage, reason } : null)
  }

  if (!detail || !pipeline) return <Modal id="deal-detail" title="Deal" onClose={onClose}><div className="sp-detail"><p className="sp-loading" role="status">{error ? <span className="sp-error" role="alert">{error}</span> : 'Loading deal…'}</p></div></Modal>
  const lead = data.leads.find(item => item.id === detail.leadId)
  const tasks = data.tasks.filter(task => task.dealId === detail.id)
  const openTasks = tasks.filter(task => !task.completed && !task.cancelled).length
  return <Modal id="deal-detail" title={detail.title} onClose={onClose}>
    <div className="sp-detail">
      <div className="sp-detail-head">
        <div className="sp-detail-who">
          <StageBadge stage={detail.stage} />{detail.archived && <span className="sp-chip">Archived</span>}{detail.priority === 'high' && <span className="sp-chip is-high">High priority</span>}
          <p>{lead ? <button className="sp-link" onClick={() => onOpenLead(lead.id)}>{lead.company || lead.name}</button> : <span className="sp-muted">The lead was removed. The deal keeps its history.</span>}
            {detail.contact && <> · {detail.contact.name}{detail.contact.jobTitle && <span className="sp-muted">, {detail.contact.jobTitle}</span>}</>}</p>
        </div>
        <dl className="sp-facts">
          <div><dt>{detail.outcome === 'won' ? 'Won value' : 'Value'}</dt><dd>{money(detail.outcome === 'won' && detail.wonValue !== null ? detail.wonValue : detail.value, detail.currency)}</dd></div>
          <div><dt>Probability</dt><dd>{detail.outcome === 'open' ? detail.effectiveProbability === null ? '—' : `${detail.effectiveProbability}%${detail.probability === null ? ' (stage)' : ''}` : detail.outcome === 'won' ? '100%' : '0%'}</dd></div>
          <div><dt>Weighted</dt><dd>{detail.outcome === 'open' ? money(weighted(detail), detail.currency) : '—'}</dd></div>
          <div><dt>{detail.outcome === 'open' ? 'Expected close' : 'Closed'}</dt><dd>{detail.outcome === 'open' ? shortDate(detail.expectedCloseDate) : shortDate(detail.actualCloseDate)}</dd></div>
          <div><dt>Owner</dt><dd>{detail.ownerName ?? 'Unassigned'}</dd></div>
        </dl>
      </div>
      {suggestion && <section className="sp-suggest" aria-label="Suggested next step" aria-live="polite"><p><strong>Move to {suggestion.stage.name}?</strong> {suggestion.reason}</p><div className="sp-actions">
        <button className="secondary" onClick={() => setSuggestion(null)}>Not now</button>
        <button className="primary" disabled={busy} onClick={() => { const stage = suggestion.stage; setSuggestion(null); void act(async () => { await moveDeal(workspace.id, detail.id, stage.id, detail.version, crypto.randomUUID()); return `Moved to ${stage.name}.` }) }}>Move to {suggestion.stage.name}</button></div></section>}
      {notice && <p className="sp-notice" role="status">{notice}</p>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="sp-tabs" role="tablist" aria-label="Deal sections">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
        {label}{key === 'work' && openTasks > 0 && <span className="number-tag">{openTasks}</span>}</button>)}</div>
      {tab === 'overview' && <Overview workspace={workspace} detail={detail} pipeline={pipeline} lead={lead} client={client} busy={busy} act={act} onCloseDeal={setClosing} onConvert={onConvert} onOpenClient={onOpenClient} onOpenDeal={onOpenDeal} />}
      {tab === 'timeline' && <Timeline workspaceId={workspace.id} detail={detail} version={timelineVersion} onRecorded={(kind, input) => {
        onChanged()
        if (kind === 'reply' && input.kind === 'reply' && input.sentiment !== 'negative') offer('replied', `You recorded a ${input.sentiment} reply.`)
        else if (kind === 'call' && input.kind === 'call' && input.outcome === 'interested') offer('interested', 'The call outcome was “interested”.')
        else if (kind === 'proposal_sent') offer('proposal', 'You recorded that the proposal was sent.')
      }} />}
      {tab === 'work' && <Work workspace={workspace} detail={detail} pipeline={pipeline} data={data} onCommit={onCommit} onSaved={async message => { await load(); setTimelineVersion(value => value + 1); onChanged(message) }}
        onScheduled={() => offer('meeting', 'You scheduled a meeting.')} />}
      {tab === 'outreach' && <Outreach detail={detail} onOpenOutreach={() => onOpenOutreach(detail.leadId)} />}
    </div>
    {closing && <CloseDealDialog workspaceId={workspace.id} deal={detail} pipeline={pipeline} outcome={closing} onCancel={() => setClosing(null)}
      onDone={deal => { setClosing(null); void act(async () => `Marked as ${deal.outcome}.`) }} />}
  </Modal>
}

function Overview({ workspace, detail, pipeline, lead, client, busy, act, onCloseDeal, onConvert, onOpenClient, onOpenDeal }: {
  workspace: WorkspaceSummary; detail: Detail; pipeline: Pipeline; lead: Lead | undefined; client: { id: string; name: string } | null; busy: boolean; act: (action: () => Promise<string | void>) => Promise<void>
  onCloseDeal: (outcome: 'won' | 'lost') => void; onConvert: () => void; onOpenClient: (clientId: string) => void; onOpenDeal: (dealId: string) => void
}) {
  const [editing, setEditing] = useState(false), [reopenTo, setReopenTo] = useState(''), [archiving, setArchiving] = useState(false)
  const openStages = pipeline.stages.filter(stage => stage.category === 'open' && !stage.archived)
  return <div className="sp-section-grid">
    <section className="sp-card-block">
      <h3>Stage</h3>
      {detail.archived ? <p className="sp-muted">Archived deals are hidden from the pipeline and analytics. Restore it to work on it again.</p>
        : detail.outcome === 'open' ? <>
          <label className="sp-inline">Move to<select value={detail.stageId} disabled={busy} onChange={event => { const stage = openStages.find(item => item.id === event.target.value); if (stage) void act(async () => { await moveDeal(workspace.id, detail.id, stage.id, detail.version, crypto.randomUUID()); return `Moved to ${stage.name}.` }) }}>
            {openStages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
          <p className="sp-muted">In this stage since {shortDate(detail.stageEnteredAt)}.</p>
          <div className="sp-actions"><button className="primary sp-won" disabled={busy} onClick={() => onCloseDeal('won')}>Mark as won</button><button className="secondary" disabled={busy} onClick={() => onCloseDeal('lost')}>Mark as lost</button></div>
        </> : <>
          {detail.outcome === 'won' ? <p>Won on {shortDate(detail.actualCloseDate)}{detail.wonValue !== null && <> for <strong>{money(detail.wonValue, detail.currency)}</strong></>}.{detail.wonNotes && <span className="sp-quote">{detail.wonNotes}</span>}</p>
            : <p>Lost on {shortDate(detail.actualCloseDate)} · <strong>{detail.lostReason}</strong>{detail.lostNotes && <span className="sp-quote">{detail.lostNotes}</span>}</p>}
          {/* M10: a won deal becomes a client (which records its M9 handoff). Converting again opens the same client. */}
          {(detail.outcome === 'won' || client) && <div className="sp-handoff">
            {client ? <><p><Icon name="check" size={16} /> Converted to the client <strong>{client.name}</strong>.{detail.handoff?.note && <span className="sp-quote">{detail.handoff.note}</span>}</p>
              <div className="sp-actions"><button className="secondary" onClick={() => onOpenClient(client.id)}>Open client</button></div></>
              : <>{detail.handoff && <p><Icon name="check" size={16} /> Handed off to client work on {shortDate(detail.handoff.createdAt)}, but not yet a client.{detail.handoff.note && <span className="sp-quote">{detail.handoff.note}</span>}</p>}
                <p className="sp-muted">Converting creates the client with its contacts and agreed services, records the handoff, and can start onboarding. You review everything first; the deal and its history stay as they are.</p>
                <div className="sp-actions"><button className="primary" disabled={busy || detail.archived} onClick={onConvert}>Convert to client…</button></div></>}
          </div>}
          {!detail.handoff && <div className="sp-reopen"><label className="sp-inline">Reopen in<select value={reopenTo} onChange={event => setReopenTo(event.target.value)}><option value="">Choose a stage…</option>{openStages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
            <button className="secondary" disabled={busy || !reopenTo} onClick={() => void act(async () => { await reopenDeal(workspace.id, detail.id, reopenTo, detail.version, crypto.randomUUID()); setReopenTo(''); return 'Deal reopened. Its close details stay in the timeline.' })}>Reopen deal</button></div>}
        </>}
    </section>
    <section className="sp-card-block">
      <div className="sp-block-head"><h3>Details</h3>{!editing && !detail.archived && <button className="text-button" onClick={() => setEditing(true)}>Edit</button>}</div>
      {editing ? <EditDeal workspaceId={workspace.id} detail={detail} pipeline={pipeline} onDone={message => { setEditing(false); if (message) void act(async () => message) }} />
        : <dl className="sp-dl">
          <div><dt>Priority</dt><dd>{priorityLabels[detail.priority]}</dd></div>
          <div><dt>Currency</dt><dd>{detail.currency}</dd></div>
          <div><dt>Source</dt><dd>{sourceLabels[detail.source]}</dd></div>
          <div><dt>Created</dt><dd>{shortDate(detail.createdAt)}</dd></div>
          {detail.description && <div className="sp-wide"><dt>Description</dt><dd className="sp-pre">{detail.description}</dd></div>}
          {detail.notes && <div className="sp-wide"><dt>Notes</dt><dd className="sp-pre">{detail.notes}</dd></div>}
        </dl>}
    </section>
    <section className="sp-card-block">
      <h3>Business</h3>
      {lead ? <dl className="sp-dl">
        <div><dt>Company</dt><dd>{lead.company || '—'}</dd></div><div><dt>Lead</dt><dd>{lead.name}</dd></div>
        {lead.industry && <div><dt>Industry</dt><dd>{lead.industry}</dd></div>}{lead.website && <div><dt>Website</dt><dd><a href={lead.website} target="_blank" rel="noreferrer noopener">{lead.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a></dd></div>}
        <div><dt>Lead status</dt><dd>{lead.status}</dd></div><div><dt>Lead source</dt><dd>{lead.source}</dd></div>
      </dl> : <p className="sp-muted">The lead this deal belonged to was removed from the workspace.</p>}
      {detail.contacts.length > 0 && <><h4>Contacts</h4><ul className="sp-contacts">{detail.contacts.map(contact => <li key={contact.id} className={contact.id === detail.contactId ? 'is-deal' : ''}>
        <strong>{contact.name}</strong>{contact.jobTitle && <span className="sp-muted"> · {contact.jobTitle}</span>}{contact.id === detail.contactId && <span className="sp-chip">Deal contact</span>}
        <span>{contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}{contact.phone && <a href={`tel:${contact.phone}`}>{contact.phone}</a>}</span></li>)}</ul></>}
    </section>
    <section className="sp-card-block">
      <h3>Opportunity</h3>
      {detail.opportunity ? <><p><strong>{detail.opportunity.title}</strong>{detail.serviceName && <span className="sp-muted"> · {detail.serviceName}</span>}</p>
        {detail.opportunity.why && <p className="sp-muted">{detail.opportunity.why}</p>}
        {detail.opportunity.findings.length > 0 && <ul className="sp-findings">{detail.opportunity.findings.map(finding => <li key={finding.id}>{finding.title} <span className="sp-chip">{finding.findingType.replace('_', ' ')}</span></li>)}</ul>}
        <p className="sp-muted">From the business report · confidence {detail.opportunity.confidence}.</p></>
        : detail.opportunityTitle ? <p>{detail.opportunityTitle} <span className="sp-muted">(the report it came from was replaced)</span></p> : <p className="sp-muted">Not linked to a report opportunity.</p>}
    </section>
    <section className="sp-card-block sp-wide">
      <h3>Stage history</h3>
      <ol className="sp-history">{detail.stageHistory.map((entry, index) => <li key={index}><span className={`sp-dot is-${entry.toCategory}`} aria-hidden="true" />{entry.from ? <>{entry.from} → <strong>{entry.to}</strong></> : <>Created in <strong>{entry.to}</strong></>}<time dateTime={entry.movedAt}>{dateTime(entry.movedAt)}</time></li>)}</ol>
      {detail.otherDeals.length > 0 && <p className="sp-muted">Other deals with this lead: {detail.otherDeals.map((deal, index) => <span key={deal.id}>{index > 0 && ', '}<button className="sp-link" onClick={() => onOpenDeal(deal.id)}>{deal.title}</button> ({categoryLabels[deal.outcome].toLowerCase()})</span>)}</p>}
      <div className="sp-archive">{archiving ? <div className="sp-confirm"><p>{detail.archived ? 'Restore this deal to the pipeline and analytics?' : 'Archive this deal? It leaves the pipeline and analytics but keeps its history, and you can restore it.'}</p>
        <div className="sp-actions"><button className="secondary" onClick={() => setArchiving(false)}>Cancel</button><button className="primary" disabled={busy} onClick={() => void act(async () => { await setDealArchived(workspace.id, detail.id, !detail.archived); setArchiving(false); return detail.archived ? 'Deal restored.' : 'Deal archived.' })}>{detail.archived ? 'Restore deal' : 'Archive deal'}</button></div></div>
        : <><button className="text-button" onClick={() => setArchiving(true)}>{detail.archived ? 'Restore deal…' : 'Archive deal…'}</button>
          {/* Owners and admins can convert a deal that isn't won, with a reason the conversion keeps. */}
          {detail.outcome !== 'won' && !client && !detail.archived && workspace.role !== 'member' && <button className="text-button" onClick={onConvert}>Convert to client by exception…</button>}</>}</div>
    </section>
  </div>
}

function EditDeal({ workspaceId, detail, pipeline, onDone }: { workspaceId: string; detail: Detail; pipeline: Pipeline; onDone: (message?: string) => void }) {
  const [form, setForm] = useState({ title: detail.title, description: detail.description, value: detail.value === null ? '' : String(detail.value), currency: detail.currency, probability: detail.probability === null ? '' : String(detail.probability),
    expectedCloseDate: detail.expectedCloseDate ?? '', priority: detail.priority, ownerId: detail.ownerId ?? '', contactId: detail.contactId ?? '', notes: detail.notes })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm(current => ({ ...current, [key]: event.target.value }))
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    const original: Record<string, string> = { title: detail.title, description: detail.description, value: detail.value === null ? '' : String(detail.value), currency: detail.currency, probability: detail.probability === null ? '' : String(detail.probability),
      expectedCloseDate: detail.expectedCloseDate ?? '', priority: detail.priority, ownerId: detail.ownerId ?? '', contactId: detail.contactId ?? '', notes: detail.notes }
    const changes = Object.fromEntries(Object.entries(form).filter(([key, value]) => value !== original[key]).map(([key, value]) => [key, key === 'value' ? value.replace(/,/g, '').trim() : value])) as DealChanges
    if (!Object.keys(changes).length) { onDone(); return }
    try { await updateDeal(workspaceId, detail.id, detail.version, changes); onDone('Deal updated.') }
    catch (cause) { setError(isConflict(cause) ? 'This deal changed in another window. Cancel, check the latest version and edit again.' : errorText(cause)) } finally { setBusy(false) }
  }
  return <form className="sp-form" onSubmit={save}>
    <label>Title *<input required maxLength={150} value={form.title} onChange={set('title')} /></label>
    <div className="sp-row sp-row-3">
      <label>Value<input inputMode="decimal" value={form.value} placeholder="Not set" onChange={set('value')} /></label>
      <label>Currency<select value={form.currency} onChange={set('currency')}>{[...new Set([...pipeline.settings.currencies, detail.currency])].map(code => <option key={code}>{code}</option>)}</select></label>
      <label>Probability %<input inputMode="numeric" value={form.probability} placeholder={detail.stage.category === 'open' ? `Stage: ${pipeline.stages.find(stage => stage.id === detail.stageId)?.probability ?? '—'}` : ''} onChange={event => setForm(current => ({ ...current, probability: event.target.value.replace(/[^\d]/g, '').slice(0, 3) }))} /></label>
    </div>
    <div className="sp-row sp-row-3">
      <label>Expected close<input type="date" value={form.expectedCloseDate} onChange={set('expectedCloseDate')} /></label>
      <label>Priority<select value={form.priority} onChange={set('priority')}>{(['low', 'medium', 'high'] as Priority[]).map(item => <option key={item} value={item}>{priorityLabels[item]}</option>)}</select></label>
      <label>Owner<select value={form.ownerId} onChange={set('ownerId')}><option value="">Unassigned</option>{pipeline.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
    </div>
    {detail.contacts.length > 0 && <label>Deal contact<select value={form.contactId} onChange={set('contactId')}><option value="">None</option>{detail.contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}{contact.jobTitle ? ` · ${contact.jobTitle}` : ''}</option>)}</select></label>}
    <label>Description<textarea rows={3} maxLength={4000} value={form.description} onChange={set('description')} /></label>
    <label>Notes<textarea rows={3} maxLength={4000} value={form.notes} onChange={set('notes')} /></label>
    {error && <p className="sp-error" role="alert">{error}</p>}
    <div className="sp-actions"><button type="button" className="secondary" onClick={() => onDone()}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
  </form>
}

type Composer = 'note' | 'call' | 'reply' | 'proposal_sent'
const composerLabels: Record<Composer, string> = { note: 'Note', call: 'Log a call', reply: 'Record a reply', proposal_sent: 'Proposal sent' }
const composerSubmit: Record<Composer, [string, string]> = { note: ['Add note', 'Note added.'], call: ['Save call', 'Call logged.'], reply: ['Save reply', 'Reply recorded.'], proposal_sent: ['Save proposal', 'Proposal recorded.'] }
function Timeline({ workspaceId, detail, version, onRecorded }: { workspaceId: string; detail: Detail; version: number; onRecorded: (kind: Composer, input: ActivityInput) => void }) {
  const [shown, setShown] = useState<TimelineGroup[]>(groups), [items, setItems] = useState<TimelineItem[] | null>(null), [hasMore, setHasMore] = useState(false), [error, setError] = useState('')
  const [composer, setComposer] = useState<Composer>('note'), [details, setDetails] = useState(''), [summary, setSummary] = useState(''), [sentiment, setSentiment] = useState<'positive' | 'neutral' | 'negative'>('positive')
  const [outcome, setOutcome] = useState<CallOutcome>('connected'), [nextAction, setNextAction] = useState(''), [channel, setChannel] = useState('Email'), [contactId, setContactId] = useState(detail.contactId ?? ''), [occurredAt, setOccurredAt] = useState('')
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState('')
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let active = true
    dealTimeline(workspaceId, detail.id, shown, null).then(result => { if (active) { setItems(result.items); setHasMore(result.hasMore); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspaceId, detail.id, shown, version])
  async function more() {
    if (!items?.length) return
    try { const result = await dealTimeline(workspaceId, detail.id, shown, items[items.length - 1].at); setItems([...items, ...result.items.filter(item => !items.some(existing => existing.id === item.id))]); setHasMore(result.hasMore) }
    catch (cause) { setError(errorText(cause)) }
  }
  async function record(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved('')
    const when = occurredAt ? new Date(occurredAt).toISOString() : undefined, contact = contactId || undefined
    const input: ActivityInput = composer === 'note' ? { kind: 'note', details, summary: summary || undefined, contactId: contact, occurredAt: when }
      : composer === 'reply' ? { kind: 'reply', sentiment, channel, details, contactId: contact, occurredAt: when }
      : composer === 'call' ? { kind: 'call', outcome, nextAction, details, contactId: contact, occurredAt: when }
      : { kind: 'proposal_sent', summary, details, contactId: contact, occurredAt: when }
    try {
      await recordDealActivity(workspaceId, detail.id, input, requestId.current)
      requestId.current = crypto.randomUUID()
      setDetails(''); setSummary(''); setNextAction(''); setOccurredAt(''); setSaved(composerSubmit[composer][1])
      const result = await dealTimeline(workspaceId, detail.id, shown, null); setItems(result.items); setHasMore(result.hasMore)
      onRecorded(composer, input)
    } catch (cause) { setError(errorText(cause)); if (!/reach LeadFlow/.test(errorText(cause))) requestId.current = crypto.randomUUID() } finally { setBusy(false) }
  }
  return <div className="sp-timeline">
    {!detail.archived && <form className="sp-composer" onSubmit={record}>
      <div className="sp-segment" role="group" aria-label="What to record">{(Object.keys(composerLabels) as Composer[]).map(key => <button type="button" key={key} aria-pressed={composer === key} onClick={() => { setComposer(key); setSaved('') }}>{composerLabels[key]}</button>)}</div>
      {composer === 'reply' && <><p className="sp-muted">Record a reply you received. LeadFlow doesn’t read your inbox, so replies are only what you record here or in the outreach studio.</p>
        <div className="sp-row sp-row-3"><label>The reply was<select value={sentiment} onChange={event => setSentiment(event.target.value as typeof sentiment)}><option value="positive">Positive</option><option value="neutral">Neutral</option><option value="negative">Negative</option></select></label>
          <label>Via<select value={channel} onChange={event => setChannel(event.target.value)}>{['Email', 'Phone', 'WhatsApp', 'LinkedIn', 'In person', 'Other'].map(item => <option key={item}>{item}</option>)}</select></label>
          <ContactSelect detail={detail} value={contactId} onChange={setContactId} /></div></>}
      {composer === 'call' && <div className="sp-row sp-row-3"><label>Outcome<select value={outcome} onChange={event => setOutcome(event.target.value as CallOutcome)}>{(Object.keys(callOutcomeLabels) as CallOutcome[]).map(key => <option key={key} value={key}>{callOutcomeLabels[key]}</option>)}</select></label>
        <ContactSelect detail={detail} value={contactId} onChange={setContactId} /><label>Next action<input maxLength={300} value={nextAction} placeholder="e.g. Call back Tuesday" onChange={event => setNextAction(event.target.value)} /></label></div>}
      {(composer === 'note' || composer === 'proposal_sent') && <label>{composer === 'note' ? 'Title (optional)' : 'Proposal'}<input maxLength={200} value={summary} placeholder={composer === 'note' ? 'Note added' : 'e.g. Website redesign proposal v1'} onChange={event => setSummary(event.target.value)} /></label>}
      <label>{composer === 'note' ? 'Note *' : composer === 'call' ? 'Summary' : 'Details'}<textarea rows={3} maxLength={4000} required={composer === 'note'} value={details} onChange={event => setDetails(event.target.value)}
        placeholder={composer === 'note' ? 'What happened, what you learned…' : composer === 'call' ? 'What was discussed' : composer === 'reply' ? 'What they said' : 'Scope, price, link to the document…'} /></label>
      <div className="sp-composer-foot"><label className="sp-inline">When<input type="datetime-local" value={occurredAt} max={localDate() + 'T23:59'} onChange={event => setOccurredAt(event.target.value)} /></label><span className="sp-muted">{occurredAt ? '' : 'Now'}</span>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : composerSubmit[composer][0]}</button></div>
      {saved && <p className="sp-notice" role="status">{saved}</p>}
    </form>}
    <div className="sp-chips" role="group" aria-label="Show in the timeline">{groups.map(group => <button key={group} aria-pressed={shown.includes(group)} onClick={() => setShown(current => current.includes(group) ? current.length > 1 ? current.filter(item => item !== group) : current : [...current, group])}>{timelineGroupLabels[group]}</button>)}</div>
    {error && <p className="sp-error" role="alert">{error}</p>}
    {!items ? <p className="sp-loading" role="status">Loading timeline…</p> : !items.length ? <div className="empty"><h3>Nothing here yet</h3><p>Notes, calls, stage changes, follow-ups, meetings and outreach for this deal appear here.</p></div>
      : <ol className="sp-events">{items.map(item => <li key={item.id} className={`is-${item.group}`}>
        <span className="sp-event-icon" aria-hidden="true"><Icon name={groupIcon[item.group]} size={14} /></span>
        <div><p><strong>{item.summary}</strong></p>{item.details && <p className="sp-pre">{item.details}</p>}
          {item.kind === 'call' && typeof item.metadata.nextAction === 'string' && item.metadata.nextAction && <p className="sp-muted">Next: {item.metadata.nextAction}</p>}
          <p className="sp-muted"><time dateTime={item.at}>{dateTime(item.at)}</time>{item.actorName && ` · ${item.actorName}`}{item.contactName && ` · with ${item.contactName}`} · {timelineGroupLabels[item.group]}</p></div>
      </li>)}</ol>}
    {hasMore && <button className="secondary sp-more" onClick={() => void more()}>Show older</button>}
  </div>
}
function ContactSelect({ detail, value, onChange }: { detail: Detail; value: string; onChange: (value: string) => void }) {
  return <label>Contact<select value={value} onChange={event => onChange(event.target.value)}><option value="">None</option>{detail.contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select></label>
}

function Work({ workspace, detail, pipeline, data, onCommit, onSaved, onScheduled }: {
  workspace: WorkspaceSummary; detail: Detail; pipeline: Pipeline; data: Data; onCommit: (next: Data, message: string) => Promise<boolean>; onSaved: (message: string) => Promise<void>; onScheduled: () => void
}) {
  const [adding, setAdding] = useState(false), [scheduling, setScheduling] = useState<Meeting | 'new' | null>(null), [now] = useState(() => Date.now())
  const day = localDate(), tasks = data.tasks.filter(task => task.dealId === detail.id).toSorted((a, b) => Number(a.completed || a.cancelled) - Number(b.completed || b.cancelled) || a.due.localeCompare(b.due))
  const lead = data.leads.find(item => item.id === detail.leadId)
  return <div className="sp-section-grid">
    <section className="sp-card-block">
      <div className="sp-block-head"><h3>Follow-ups</h3>{lead && !adding && <button className="secondary" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add follow-up</button>}</div>
      {adding && lead && <TaskForm leads={data.leads} initialLeadId={lead.id} fixedDeal={detail} members={pipeline.members} contacts={detail.contacts.map(contact => ({ id: contact.id, name: contact.name }))}
        onCancel={() => setAdding(false)} onSubmit={async (leadId, due, notes, options) => { const saved = await onCommit(createTask(data, leadId, due, notes, options), 'Follow-up scheduled.'); if (saved) { setAdding(false); await onSaved('Follow-up scheduled.') } return saved }} />}
      {!lead && <p className="sp-muted">The lead was removed, so new follow-ups can’t be added to this deal.</p>}
      {!tasks.length && !adding ? <p className="sp-muted">No follow-ups for this deal yet. They’re reminders inside LeadFlow; nothing is sent.</p>
        : <ul className="sp-tasks">{tasks.map(task => { const state = taskState(task, day), assignee = pipeline.members.find(member => member.id === task.assigneeId)
          return <li key={task.id} className={`is-${state.toLowerCase().replace(' ', '-')}`}>
            <div><strong>{task.notes}</strong><p className="sp-muted">{taskTypeLabels[task.taskType ?? 'follow_up']} · {priorityLabels[task.priority ?? 'medium']} priority{assignee && ` · ${assignee.name}`}</p>{task.description && <p className="sp-pre">{task.description}</p>}</div>
            <span className={`due-date task-state ${state.toLowerCase().replace(' ', '-')}`}><span>{state}</span><time dateTime={task.due}>{shortDate(task.due)}</time></span>
            {!task.cancelled && <button className="text-button" onClick={async () => { if (await onCommit(toggleTask(data, task.id), task.completed ? 'Follow-up reopened.' : 'Follow-up completed.')) await onSaved(task.completed ? 'Follow-up reopened.' : 'Follow-up completed.') }}>{task.completed ? 'Reopen' : 'Complete'}</button>}
            {!task.completed && <button className="text-button" onClick={async () => { if (await onCommit(cancelTask(data, task.id), task.cancelled ? 'Follow-up reopened.' : 'Follow-up cancelled.')) await onSaved(task.cancelled ? 'Follow-up reopened.' : 'Follow-up cancelled.') }}>{task.cancelled ? 'Restore' : 'Cancel'}</button>}
          </li> })}</ul>}
    </section>
    <section className="sp-card-block">
      <div className="sp-block-head"><h3>Meetings</h3>{!scheduling && !detail.archived && <button className="secondary" onClick={() => setScheduling('new')}><Icon name="plus" size={14} /> Schedule meeting</button>}</div>
      {scheduling && <MeetingForm workspaceId={workspace.id} detail={detail} meeting={scheduling === 'new' ? null : scheduling} onCancel={() => setScheduling(null)}
        onSaved={async (message, created) => { setScheduling(null); await onSaved(message); if (created) onScheduled() }} />}
      {!detail.meetings.length && !scheduling ? <p className="sp-muted">No meetings yet. Meetings are recorded here; LeadFlow doesn’t send invitations or sync calendars.</p>
        : <ul className="sp-meetings">{detail.meetings.map(meeting => <MeetingRow key={meeting.id} workspaceId={workspace.id} detail={detail} meeting={meeting} now={now} onEdit={() => setScheduling(meeting)} onSaved={onSaved} />)}</ul>}
    </section>
  </div>
}

function MeetingRow({ workspaceId, detail, meeting, now, onEdit, onSaved }: { workspaceId: string; detail: Detail; meeting: Meeting; now: number; onEdit: () => void; onSaved: (message: string) => Promise<void> }) {
  const [confirm, setConfirm] = useState<MeetingStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const past = new Date(meeting.startsAt).getTime() < now
  async function status(next: MeetingStatus) {
    setBusy(true); setError('')
    try { await saveMeeting(workspaceId, detail.id, { id: meeting.id, version: meeting.version, status: next }, crypto.randomUUID()); setConfirm(null); await onSaved(`Meeting marked ${meetingStatusLabels[next].toLowerCase()}.`) }
    catch (cause) { setError(isConflict(cause) ? 'This meeting changed in another window. Close and reopen the deal to see the latest.' : errorText(cause)) } finally { setBusy(false) }
  }
  const contact = detail.contacts.find(item => item.id === meeting.contactId)
  return <li className={`is-${meeting.status}`}>
    <div><strong>{meeting.title}</strong><span className="sp-chip">{meetingStatusLabels[meeting.status]}</span>
      <p className="sp-muted"><time dateTime={meeting.startsAt}>{dateTime(meeting.startsAt, meeting.timezone)}</time> · {meeting.durationMinutes} min{contact && ` · with ${contact.name}`}</p>
      {(meeting.location || meeting.meetingUrl) && <p className="sp-muted">{meeting.location}{meeting.location && meeting.meetingUrl && ' · '}{meeting.meetingUrl && <a href={meeting.meetingUrl} target="_blank" rel="noreferrer noopener">Meeting link</a>}</p>}
      {meeting.agenda && <p className="sp-pre">{meeting.agenda}</p>}{meeting.notes && <p className="sp-pre sp-quote">{meeting.notes}</p>}</div>
    {meeting.status === 'scheduled' && !detail.archived && (confirm ? <div className="sp-confirm"><p>Mark this meeting as {meetingStatusLabels[confirm].toLowerCase()}?</p><div className="sp-actions"><button className="secondary" onClick={() => setConfirm(null)}>Back</button><button className="primary" disabled={busy} onClick={() => void status(confirm)}>Confirm</button></div></div>
      : <div className="sp-actions">{past && <button className="secondary" onClick={() => setConfirm('completed')}>Completed</button>}{past && <button className="secondary" onClick={() => setConfirm('no_show')}>No-show</button>}
        <button className="text-button" onClick={onEdit}>Reschedule or edit</button><button className="text-button" onClick={() => setConfirm('cancelled')}>Cancel meeting</button></div>)}
    {error && <p className="sp-error" role="alert">{error}</p>}
  </li>
}

function MeetingForm({ workspaceId, detail, meeting, onCancel, onSaved }: { workspaceId: string; detail: Detail; meeting: Meeting | null; onCancel: () => void; onSaved: (message: string, created: boolean) => Promise<void> }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const local = (iso: string) => { const date = new Date(iso); return `${localDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` }
  const [form, setForm] = useState({ title: meeting?.title ?? `Call with ${detail.contact?.name ?? detail.lead?.company ?? 'the client'}`, startsAt: meeting ? local(meeting.startsAt) : '', durationMinutes: String(meeting?.durationMinutes ?? 30),
    location: meeting?.location ?? '', meetingUrl: meeting?.meetingUrl ?? '', agenda: meeting?.agenda ?? '', notes: meeting?.notes ?? '', contactId: meeting?.contactId ?? detail.contactId ?? '' })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm(current => ({ ...current, [key]: event.target.value }))
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await saveMeeting(workspaceId, detail.id, { ...(meeting ? { id: meeting.id, version: meeting.version } : {}), title: form.title, startsAt: new Date(form.startsAt).toISOString(), durationMinutes: Number(form.durationMinutes), timezone: meeting?.timezone ?? zone,
        location: form.location, meetingUrl: form.meetingUrl.trim(), agenda: form.agenda, notes: form.notes, contactId: form.contactId || null }, requestId.current)
      await onSaved(meeting ? 'Meeting updated.' : 'Meeting scheduled.', !meeting)
    } catch (cause) { setError(isConflict(cause) ? 'This meeting changed in another window. Cancel and reopen the deal to see the latest.' : errorText(cause)); if (!/reach LeadFlow/.test(errorText(cause))) requestId.current = crypto.randomUUID() }
    finally { setBusy(false) }
  }
  return <form className="sp-form sp-subform" onSubmit={save}>
    <label>Title *<input required maxLength={150} value={form.title} onChange={set('title')} /></label>
    <div className="sp-row sp-row-3"><label>Starts *<input type="datetime-local" required value={form.startsAt} onChange={set('startsAt')} /><small>Your time zone: {meeting?.timezone ?? zone}</small></label>
      <label>Duration<select value={form.durationMinutes} onChange={set('durationMinutes')}>{[15, 30, 45, 60, 90, 120].map(minutes => <option key={minutes} value={minutes}>{minutes} min</option>)}</select></label>
      <ContactSelect detail={detail} value={form.contactId} onChange={value => setForm(current => ({ ...current, contactId: value }))} /></div>
    <div className="sp-row"><label>Location<input maxLength={300} value={form.location} placeholder="Office, phone, video…" onChange={set('location')} /></label>
      <label>Meeting link<input type="url" maxLength={500} value={form.meetingUrl} placeholder="https://" onChange={set('meetingUrl')} /></label></div>
    <label>Agenda<textarea rows={2} maxLength={2000} value={form.agenda} onChange={set('agenda')} /></label>
    {meeting && <label>Notes<textarea rows={2} maxLength={4000} value={form.notes} onChange={set('notes')} /></label>}
    <p className="sp-muted">Saved in LeadFlow only. No invitation is sent and no calendar is changed.</p>
    {error && <p className="sp-error" role="alert">{error}</p>}
    <div className="sp-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : meeting ? 'Save meeting' : 'Schedule meeting'}</button></div>
  </form>
}

function Outreach({ detail, onOpenOutreach }: { detail: Detail; onOpenOutreach: () => void }) {
  return <section className="sp-card-block">
    <div className="sp-block-head"><h3>Outreach with this lead</h3><button className="secondary" onClick={onOpenOutreach}><Icon name="mail" size={14} /> Open outreach studio</button></div>
    <p className="sp-muted">Drafts written for this lead. Sent and replied are only what your team marked; LeadFlow doesn’t send messages or read your inbox.</p>
    {!detail.drafts.length ? <p className="sp-muted">No outreach drafts yet.</p> : <ul className="sp-drafts">{detail.drafts.map(draft => <li key={draft.id}>
      <div><strong>{draft.subject || `${channelLabels[draft.channel as OutreachChannel] ?? draft.channel} message`}</strong>{draft.id === detail.sourceDraftId && <span className="sp-chip">Started this deal</span>}
        <p className="sp-muted">{channelLabels[draft.channel as OutreachChannel] ?? draft.channel}{draft.contactName && ` · to ${draft.contactName}`}{draft.sequenceStep > 0 && ` · follow-up ${draft.sequenceStep}`}</p></div>
      <span className="sp-chip">{draftStatusLabels[draft.status as DraftStatus] ?? draft.status}</span>
      <small className="sp-muted">{draft.repliedAt ? `Replied ${relativeDays(localDate(new Date(draft.repliedAt)), localDate())}` : draft.sentAt ? `Sent ${relativeDays(localDate(new Date(draft.sentAt)), localDate())}` : `Updated ${shortDate(draft.updatedAt)}`}</small>
    </li>)}</ul>}
  </section>
}
