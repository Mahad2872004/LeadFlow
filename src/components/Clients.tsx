import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { MetricCard } from './MetricCard'
import type { WorkspaceSummary } from '../lib/backend'
import type { Lead } from '../lib/model'
import { dealsFor, errorText, money, shortDate, type Deal, type SalesMember } from '../lib/sales'
import {
  clientDashboard, clientStatusLabels, clientStatuses, contactRoleLabels, contactRoles, createClient, listClients, onboardingStateLabels, onboardingStates,
  type ClientContactRole, type ClientFilters, type ClientIndexEntry, type ClientPage, type Dashboard, type OnboardingState,
} from '../lib/clients'
import './Clients.css'

const pageSize = 25

/** Onboarding status as a labelled progress bar; the database computes it from the client's checklists. */
export function OnboardingMeter({ state, percent }: { state: OnboardingState; percent: number }) {
  return <span className={`cl-meter is-${state}`}><span className="cl-meter-label">{onboardingStateLabels[state]}{state !== 'not_started' && state !== 'completed' && <> · {percent}%</>}</span>
    <span className="cl-meter-track" aria-hidden="true"><i style={{ width: `${state === 'completed' ? 100 : percent}%` }} /></span></span>
}
export const ClientStatusChip = ({ status }: { status: keyof typeof clientStatusLabels }) => <span className={`cl-status is-${status}`}>{clientStatusLabels[status]}</span>
export function ClientMark({ name, logoUrl, size = 36 }: { name: string; logoUrl?: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (logoUrl && !failed) return <img className="cl-mark" src={logoUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  return <span className={`cl-mark tone-${name.length % 4}`} style={{ width: size, height: size }} aria-hidden="true">{name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()}</span>
}

/** The Clients page: onboarding at a glance, then every client, with search and filters. Opening one shows its workspace. */
export function Clients({ workspace, day, leads, members, clients, version, onOpenClient, onConvertDeal, onShowTasks, onChanged }: {
  workspace: WorkspaceSummary; day: string; leads: Lead[]; members: SalesMember[]; clients: ClientIndexEntry[]; version: number
  onOpenClient: (clientId: string) => void; onConvertDeal: (dealId: string) => void; onShowTasks: () => void; onChanged: (message: string) => void
}) {
  const [filters, setFilters] = useState<ClientFilters>({ status: 'current', onboarding: '', search: '', sort: 'updated', direction: 'desc' })
  const [offset, setOffset] = useState(0), [page, setPage] = useState<ClientPage | null>(null), [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState(''), [creating, setCreating] = useState(false)
  const set = (patch: Partial<ClientFilters>) => { setFilters(current => ({ ...current, ...patch })); setOffset(0) }
  useEffect(() => {
    let active = true
    clientDashboard(workspace.id, { status: 'current' }, day).then(value => { if (active) setDashboard(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, day, version])
  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      listClients(workspace.id, { ...filters, limit: pageSize, offset }).then(value => { if (active) { setPage(value); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    }, filters.search ? 250 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [workspace.id, filters, offset, version])
  const filtered = !!(filters.search || filters.onboarding || filters.industry || filters.ownerId || filters.status !== 'current')
  const header = (key: NonNullable<ClientFilters['sort']>, label: string) => <th aria-sort={filters.sort === key ? (filters.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
    <button className="sp-sort" onClick={() => set(filters.sort === key ? { direction: filters.direction === 'asc' ? 'desc' : 'asc' } : { sort: key, direction: key === 'name' ? 'asc' : 'desc' })}>{label}{filters.sort === key && <span aria-hidden="true">{filters.direction === 'asc' ? ' ↑' : ' ↓'}</span>}</button></th>
  return <>
    {dashboard && <section aria-label="Onboarding overview">
      <div className="stats cl-stats">
        <MetricCard label="Clients" value={dashboard.totalClients} hint={`${dashboard.byStatus.active ?? 0} active · ${dashboard.byStatus.paused ?? 0} paused`} icon="users" onClick={() => set({ status: 'current', onboarding: '' })} />
        <MetricCard label="Onboarding" value={dashboard.onboarding} hint={`${dashboard.byOnboarding.ready ?? 0} ready to complete`} icon="clipboard" accent onClick={() => set({ status: 'current', onboarding: 'in_progress' })} />
        <MetricCard label="Waiting on clients" value={dashboard.waitingOnClient} hint={`${dashboard.pendingSubmissions} submission${dashboard.pendingSubmissions === 1 ? '' : 's'} to review`} icon="clock" onClick={() => set({ status: 'current', onboarding: 'in_progress' })} />
        <MetricCard label="Scope to confirm" value={dashboard.awaitingScope} hint="Clients without a confirmed scope" icon="check" onClick={() => set({ status: 'current', onboarding: '' })} />
        <MetricCard label="Overdue tasks" value={dashboard.overdueTasks} hint={`${dashboard.dueTodayTasks} due today`} icon="calendar" onClick={onShowTasks} />
      </div>
      {(dashboard.attention.length > 0 || dashboard.recentlyOnboarded.length > 0) && <div className="cl-glance">
        {dashboard.attention.length > 0 && <section className="panel"><div className="section-heading"><div><h2>Onboarding in progress</h2><p>Who each one is waiting on, from their checklists.</p></div></div>
          <ul className="cl-attention">{dashboard.attention.slice(0, 8).map(item => <li key={item.clientId}>
            <button className="sp-link" onClick={() => onOpenClient(item.clientId)}>{item.name}</button>
            <OnboardingMeter state={item.onboarding.state} percent={item.onboarding.percent} />
            <small>{[item.onboarding.waitingOnClient && `${item.onboarding.waitingOnClient} waiting on client`, item.onboarding.awaitingReview && `${item.onboarding.awaitingReview} to review`, item.onboarding.agencySteps && `${item.onboarding.agencySteps} with agency steps left`].filter(Boolean).join(' · ') || (item.onboarding.state === 'ready' ? 'Ready to complete' : 'No checklist open')}</small>
          </li>)}</ul></section>}
        {dashboard.recentlyOnboarded.length > 0 && <section className="panel"><div className="section-heading"><div><h2>Recently onboarded</h2><p>The last 30 days.</p></div></div>
          <ul className="cl-attention">{dashboard.recentlyOnboarded.slice(0, 8).map(item => <li key={item.clientId}>
            <button className="sp-link" onClick={() => onOpenClient(item.clientId)}>{item.name}</button><small>{shortDate(item.completedAt)}{item.override ? ' · completed with items outstanding' : ''}</small></li>)}</ul></section>}
      </div>}
    </section>}

    <section className="panel cl-panel">
      <div className="section-heading sp-heading">
        <div><h2>All clients {page && <span className="number-tag">{page.total}</span>}</h2><p>Every client, their onboarding and who owns them.</p></div>
        <div className="sp-heading-actions"><button className="primary" onClick={() => setCreating(true)}><Icon name="plus" size={17} /> New client</button></div>
      </div>
      <div className="filters">
        <label className="search"><Icon name="search" size={18} /><input aria-label="Search clients" placeholder="Search name, contact, website or city…" value={filters.search} onChange={event => set({ search: event.target.value })} /></label>
        <select aria-label="Filter by status" value={filters.status} onChange={event => set({ status: event.target.value as ClientFilters['status'] })}>
          <option value="current">All but archived</option>{clientStatuses.map(status => <option key={status} value={status}>{clientStatusLabels[status]}</option>)}<option value="all">Everything</option></select>
        <select aria-label="Filter by onboarding" value={filters.onboarding} onChange={event => set({ onboarding: event.target.value as OnboardingState | '' })}>
          <option value="">Any onboarding</option>{onboardingStates.map(state => <option key={state} value={state}>{onboardingStateLabels[state]}</option>)}</select>
        {page && page.industries.length > 0 && <select aria-label="Filter by industry" value={filters.industry ?? ''} onChange={event => set({ industry: event.target.value })}><option value="">Any industry</option>{page.industries.map(item => <option key={item}>{item}</option>)}</select>}
        {members.length > 1 && <select aria-label="Filter by owner" value={filters.ownerId ?? ''} onChange={event => set({ ownerId: event.target.value })}><option value="">Any owner</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select>}
        {page && <span className="results" role="status">{page.total} client{page.total === 1 ? '' : 's'}</span>}
        {filtered && <button className="text-button" onClick={() => set({ search: '', status: 'current', onboarding: '', industry: '', ownerId: '' })}>Clear filters</button>}
      </div>
      {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
      {!page ? <p className="sp-loading" role="status">Loading clients…</p>
        : !page.items.length ? <div className="empty">{filtered ? <><h3>No clients match</h3><p>Try another search or filter.</p></>
          : <><h3>No clients yet</h3><p>Convert a won deal into a client, or add one by hand. Clients keep their contacts, agreed services, onboarding and documents together.</p><button className="secondary" onClick={() => setCreating(true)}>New client</button></>}</div>
        : <>
          <div className="sp-table-wrap"><table className="sp-table cl-table">
            <thead><tr>{header('name', 'Client')}<th>Status</th><th>Onboarding</th><th>Primary contact</th><th>Services</th><th>Owner</th>{header('updated', 'Updated')}</tr></thead>
            <tbody>{page.items.map(client => <tr key={client.id}>
              <td><button className="cl-who" onClick={() => onOpenClient(client.id)}><ClientMark name={client.name} logoUrl={client.logoUrl} size={32} /><span><strong>{client.name}</strong><small>{[client.industry, client.city].filter(Boolean).join(' · ') || client.website.replace(/^https?:\/\/(www\.)?/, '') || '—'}</small></span></button></td>
              <td><ClientStatusChip status={client.status} /></td>
              <td><OnboardingMeter state={client.onboarding.state} percent={client.onboarding.percent} /></td>
              <td>{client.primaryContact ? <>{client.primaryContact.name}<small>{client.primaryContact.email || client.primaryContact.phone}</small></> : <span className="sp-muted">None yet</span>}</td>
              <td>{client.services.length ? client.services.join(', ') : <span className="sp-muted">None confirmed</span>}</td>
              <td>{client.ownerName ?? <span className="sp-muted">Unassigned</span>}{client.openTasks > 0 && <small>{client.openTasks} open task{client.openTasks === 1 ? '' : 's'}</small>}</td>
              <td><small>{shortDate(client.updatedAt)}</small></td>
            </tr>)}</tbody>
          </table></div>
          {page.total > pageSize && <div className="sp-pager"><span>{page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} of {page.total}</span>
            <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</button>
            <button className="secondary" disabled={offset + pageSize >= page.total} onClick={() => setOffset(offset + pageSize)}>Next</button></div>}
        </>}
    </section>
    {creating && <NewClient workspace={workspace} leads={leads} members={members} clients={clients} onClose={() => setCreating(false)}
      onConvert={dealId => { setCreating(false); onConvertDeal(dealId) }}
      onCreated={(id, name) => { setCreating(false); onChanged(`${name} was added to your clients.`); onOpenClient(id) }} />}
  </>
}

/** A new client: from a won deal (the usual way, with a review), or by hand, optionally linked to a lead. */
function NewClient({ workspace, leads, members, clients, onClose, onConvert, onCreated }: {
  workspace: WorkspaceSummary; leads: Lead[]; members: SalesMember[]; clients: ClientIndexEntry[]; onClose: () => void; onConvert: (dealId: string) => void; onCreated: (id: string, name: string) => void
}) {
  const [mode, setMode] = useState<'deal' | 'manual'>('deal'), [deals, setDeals] = useState<Deal[] | null>(null), [dealId, setDealId] = useState('')
  const [form, setForm] = useState({ name: '', website: '', industry: '', ownerId: '', leadId: '', contactName: '', contactEmail: '', contactPhone: '', contactRole: 'decision_maker' as ClientContactRole, service: '' })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let active = true
    // Won deals that aren't clients yet. Deals already converted open their client instead.
    const converted = new Set(clients.map(client => client.dealId).filter(Boolean))
    dealsFor(workspace.id, { outcome: 'won', limit: 100, sort: 'updated', direction: 'desc' }).then(page => { if (active) { const open = page.items.filter(deal => !converted.has(deal.id)); setDeals(open); setDealId(open[0]?.id ?? ''); if (!open.length) setMode('manual') } })
      .catch(() => { if (active) { setDeals([]); setMode('manual') } })
    return () => { active = false }
  }, [workspace.id, clients])
  const update = (patch: Partial<typeof form>) => setForm(current => ({ ...current, ...patch }))
  function fromLead(leadId: string) {
    const lead = leads.find(item => item.id === leadId)
    update({ leadId, ...(lead ? { name: form.name || lead.company || lead.name, website: form.website || lead.website || '', industry: form.industry || lead.industry || '', contactName: form.contactName || lead.name, contactEmail: form.contactEmail || lead.email, contactPhone: form.contactPhone || lead.phone } : {}) })
  }
  async function submit() {
    setError('')
    if (mode === 'deal') { if (dealId) onConvert(dealId); return }
    if (!form.name.trim()) return setError('Give the client a name.')
    setBusy(true)
    try {
      const result = await createClient(workspace.id, { name: form.name.trim(), website: form.website.trim(), industry: form.industry.trim(), ownerId: form.ownerId || null, leadId: form.leadId || null,
        contacts: form.contactName.trim() ? [{ fullName: form.contactName.trim(), jobTitle: '', role: form.contactRole, email: form.contactEmail.trim(), phone: form.contactPhone.trim(), preferredChannel: 'email', notes: '', isPrimary: true }] : [],
        services: form.service.trim() ? [{ name: form.service.trim(), description: '', agreedScope: '', deliverables: '', exclusions: '', notes: '' }] : [] }, requestId.current)
      onCreated(result.id, form.name.trim())
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal title="New client" onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="sp-segment" role="group" aria-label="How to add the client">
        <button type="button" aria-pressed={mode === 'deal'} onClick={() => setMode('deal')}>From a won deal</button>
        <button type="button" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>Add by hand</button>
      </div>
      {mode === 'deal' ? deals === null ? <p className="sp-loading" role="status">Loading won deals…</p> : deals.length === 0
        ? <p className="sp-muted">Every won deal is already a client. Mark a deal as won in the sales pipeline, or add a client by hand.</p>
        : <><p className="sp-intro">Converting a won deal carries over its lead, contacts, services and history. You’ll review everything before the client is created.</p>
          <label>Won deal<select value={dealId} onChange={event => setDealId(event.target.value)}>{deals.map(deal => <option key={deal.id} value={deal.id}>{deal.title} · {deal.lead?.company || deal.lead?.name || 'Lead removed'} · {money(deal.wonValue ?? deal.value, deal.currency)}</option>)}</select></label></>
        : <>
          <p className="sp-intro">For clients that didn’t come through the sales pipeline. You can add more contacts, services and dates in the client’s workspace.</p>
          {leads.length > 0 && <label>From a lead (optional)<select value={form.leadId} onChange={event => fromLead(event.target.value)}><option value="">Not linked to a lead</option>{leads.map(lead => <option key={lead.id} value={lead.id}>{lead.company ? `${lead.company} · ${lead.name}` : lead.name}</option>)}</select></label>}
          <label>Client name *<input required maxLength={150} value={form.name} onChange={event => update({ name: event.target.value })} /></label>
          <div className="sp-row sp-row-3">
            <label>Website<input maxLength={300} value={form.website} placeholder="https://example.com" onChange={event => update({ website: event.target.value })} /></label>
            <label>Industry<input maxLength={100} value={form.industry} onChange={event => update({ industry: event.target.value })} /></label>
            <label>Owner<select value={form.ownerId} onChange={event => update({ ownerId: event.target.value })}><option value="">Me</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
          </div>
          <fieldset className="cl-fieldset"><legend>Primary contact</legend>
            <div className="sp-row"><label>Name<input maxLength={150} value={form.contactName} onChange={event => update({ contactName: event.target.value })} /></label>
              <label>Role<select value={form.contactRole} onChange={event => update({ contactRole: event.target.value as ClientContactRole })}>{contactRoles.map(role => <option key={role} value={role}>{contactRoleLabels[role]}</option>)}</select></label></div>
            <div className="sp-row"><label>Email<input type="email" maxLength={254} value={form.contactEmail} onChange={event => update({ contactEmail: event.target.value })} /></label>
              <label>Phone<input type="tel" maxLength={40} value={form.contactPhone} onChange={event => update({ contactPhone: event.target.value })} /></label></div>
          </fieldset>
          <label>Service (optional)<input maxLength={80} value={form.service} placeholder="e.g. Website redesign" onChange={event => update({ service: event.target.value })} /><small>Added as proposed; confirm it with the client in the workspace.</small></label>
        </>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || (mode === 'deal' && !dealId)}>{mode === 'deal' ? 'Review and convert…' : busy ? 'Adding…' : 'Add client'}</button></div>
    </form>
  </Modal>
}
