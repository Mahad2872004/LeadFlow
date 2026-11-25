import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { Act } from './ClientWorkspace'
import type { WorkspaceSummary } from '../lib/backend'
import { agencyServices, type AgencyService } from '../lib/analysis'
import { dateTime, errorText, shortDate } from '../lib/sales'
import {
  confirmScope, requirementCategories, requirementCategoryLabels, requirementHistory, requirementPriorities, requirementSourceLabels, requirementSources, requirementStatusLabels, requirementStatuses,
  saveClientService, saveRequirement, scopeHistory, serviceStatusLabels,
  type ClientDetail, type ClientService, type Requirement, type RequirementCategory, type RequirementInput, type RequirementPriority, type RequirementSource, type RequirementStatus, type ScopeConfirmation, type ServiceInput, type ServiceStatus,
} from '../lib/clients'

const priorityText: Record<RequirementPriority, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' }

/** Agreed services, requirements and the scope confirmation: what was agreed, as an internal record, not a contract. */
export function ClientScope({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  return <div className="cl-scope">
    <Scope workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    <Services workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
    <Requirements workspace={workspace} detail={detail} busy={busy} locked={locked} act={act} />
  </div>
}

// ---------- Services ----------

function Services({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  const [editing, setEditing] = useState<ServiceInput | null>(null), [showRemoved, setShowRemoved] = useState(false)
  const visible = detail.serviceRecords.filter(service => showRemoved || service.status !== 'removed'), removed = detail.serviceRecords.length - detail.serviceRecords.filter(service => service.status !== 'removed').length
  const setStatus = (service: ClientService, status: ServiceStatus) => void act(async () => {
    await saveClientService(workspace.id, detail.id, { ...service, status, expectedVersion: service.version })
    return status === 'confirmed' ? `${service.name} confirmed.` : status === 'removed' ? `${service.name} removed.` : `${service.name} set back to proposed.`
  })
  return <section className="panel cl-section">
    <div className="section-heading"><div><h2>Agreed services</h2><p>What you’ll deliver. Confirmed services, with their scope, deliverables and exclusions, go into the scope confirmation.</p></div>
      {!locked && <button className="primary" onClick={() => setEditing({ name: '', description: '', agreedScope: '', deliverables: '', exclusions: '', notes: '', status: 'proposed' })}><Icon name="plus" size={17} /> Add service</button>}</div>
    {!visible.length ? <div className="empty"><h3>No services yet</h3><p>Add the services agreed with the client.</p></div>
      : <ul className="cl-services">{visible.map(service => <li key={service.id} className={`is-${service.status}`}>
        <div className="cl-service-head"><strong>{service.name}</strong><span className={`cl-pill is-${service.status}`}>{serviceStatusLabels[service.status]}</span>
          <span className="sp-muted">{service.source === 'deal' ? 'From the deal' : service.source === 'onboarding' ? 'Added during onboarding' : 'Added by hand'}{service.confirmedAt ? ` · confirmed ${shortDate(service.confirmedAt)}` : ''}</span></div>
        <dl className="sp-dl">
          <div className="sp-wide"><dt>Agreed scope</dt><dd className="sp-pre">{service.agreedScope || <span className="sp-muted">Not described yet</span>}</dd></div>
          {service.deliverables && <div><dt>Deliverables</dt><dd className="sp-pre">{service.deliverables}</dd></div>}
          {service.exclusions && <div><dt>Not included</dt><dd className="sp-pre">{service.exclusions}</dd></div>}
          {service.notes && <div className="sp-wide"><dt>Notes</dt><dd className="sp-pre">{service.notes}</dd></div>}
        </dl>
        {!locked && <div className="sp-actions">
          {service.status !== 'confirmed' && service.status !== 'removed' && <button className="secondary" disabled={busy} onClick={() => setStatus(service, 'confirmed')}>Confirm</button>}
          {service.status === 'confirmed' && <button className="text-button" disabled={busy} onClick={() => setStatus(service, 'proposed')}>Set back to proposed</button>}
          {service.status === 'removed' ? <button className="text-button" disabled={busy} onClick={() => setStatus(service, 'proposed')}>Restore</button>
            : <><button className="text-button" onClick={() => setEditing({ ...service })}>Edit</button><button className="text-button" disabled={busy} onClick={() => setStatus(service, 'removed')}>Remove</button></>}
        </div>}
      </li>)}</ul>}
    {removed > 0 && <button className="text-button cl-toggle" onClick={() => setShowRemoved(!showRemoved)}>{showRemoved ? 'Hide' : 'Show'} {removed} removed service{removed === 1 ? '' : 's'}</button>}
    {editing && <ServiceDialog workspace={workspace} service={editing} busy={busy} onClose={() => setEditing(null)}
      onSave={async service => { if (await act(async () => { await saveClientService(workspace.id, detail.id, service); return service.id ? `${service.name} saved.` : `${service.name} added.` })) setEditing(null) }} />}
  </section>
}
function ServiceDialog({ workspace, service, busy, onClose, onSave }: { workspace: WorkspaceSummary; service: ServiceInput; busy: boolean; onClose: () => void; onSave: (service: ServiceInput) => Promise<void> }) {
  const [form, setForm] = useState(service), [catalog, setCatalog] = useState<AgencyService[]>([])
  useEffect(() => { let active = true; agencyServices(workspace.id).then(list => { if (active) setCatalog(list.filter(item => item.active)) }).catch(() => undefined); return () => { active = false } }, [workspace.id])
  const existing = 'version' in service ? (service as ServiceInput & { version: number }).version : undefined
  return <Modal title={service.id ? `Edit ${service.name}` : 'Add a service'} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onSave({ id: form.id, serviceId: form.serviceId ?? null, name: form.name.trim(), description: form.description, agreedScope: form.agreedScope, deliverables: form.deliverables, exclusions: form.exclusions, notes: form.notes, status: form.status ?? 'proposed', ...(existing !== undefined ? { expectedVersion: existing } : {}) }) }}>
      {catalog.length > 0 && <label>From your service catalog<select value={form.serviceId ?? ''} onChange={event => { const item = catalog.find(entry => entry.id === event.target.value); setForm({ ...form, serviceId: item?.id ?? null, ...(item && !form.name ? { name: item.name, description: item.description } : {}) }) }}>
        <option value="">Not from the catalog</option>{catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <label>Service name *<input required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>Agreed scope<textarea rows={3} maxLength={4000} value={form.agreedScope} placeholder="What’s included, in plain words" onChange={event => setForm({ ...form, agreedScope: event.target.value })} /></label>
      <div className="sp-row"><label>Deliverables<textarea rows={3} maxLength={4000} value={form.deliverables} onChange={event => setForm({ ...form, deliverables: event.target.value })} /></label>
        <label>Exclusions<textarea rows={3} maxLength={4000} value={form.exclusions} placeholder="What’s not included" onChange={event => setForm({ ...form, exclusions: event.target.value })} /></label></div>
      <label>Notes<textarea rows={2} maxLength={2000} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label>
      {!service.id && <label className="cl-check-label"><input type="checkbox" checked={form.status === 'confirmed'} onChange={event => setForm({ ...form, status: event.target.checked ? 'confirmed' : 'proposed' })} /> Already agreed with the client (confirmed)</label>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save service</button></div>
    </form>
  </Modal>
}

// ---------- Requirements ----------

const blankRequirement = (): RequirementInput => ({ title: '', description: '', category: 'functional', priority: 'medium', status: 'draft', source: 'internal', notes: '', clientServiceId: null })
function Requirements({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  const [editing, setEditing] = useState<{ input: RequirementInput; version: number | null } | null>(null), [history, setHistory] = useState<Requirement | null>(null)
  const [status, setStatus] = useState<RequirementStatus | ''>(''), [category, setCategory] = useState<RequirementCategory | ''>('')
  const list = detail.requirements.filter(item => (!status || item.status === status) && (!category || item.category === category))
  const undecided = detail.requirements.filter(item => item.status === 'draft' || item.status === 'under_review').length
  const service = (id: string | null) => detail.serviceRecords.find(item => item.id === id)?.name
  return <section className="panel cl-section">
    <div className="section-heading"><div><h2>Requirements <span className="number-tag">{detail.requirements.length}</span></h2><p>Goals, requirements, constraints and expectations. Every change keeps a version. {undecided > 0 && <strong>{undecided} still to decide.</strong>}</p></div>
      {!locked && <button className="primary" onClick={() => setEditing({ input: blankRequirement(), version: null })}><Icon name="plus" size={17} /> Add requirement</button>}</div>
    {detail.requirements.length > 0 && <div className="filters">
      <select aria-label="Filter requirements by status" value={status} onChange={event => setStatus(event.target.value as RequirementStatus | '')}><option value="">Any status</option>{requirementStatuses.map(item => <option key={item} value={item}>{requirementStatusLabels[item]}</option>)}</select>
      <select aria-label="Filter requirements by category" value={category} onChange={event => setCategory(event.target.value as RequirementCategory | '')}><option value="">Any category</option>{requirementCategories.map(item => <option key={item} value={item}>{requirementCategoryLabels[item]}</option>)}</select>
      <span className="results" role="status">{list.length} shown</span></div>}
    {!detail.requirements.length ? <div className="empty"><h3>No requirements yet</h3><p>Record what the client needs: from meetings, from their onboarding answers (use “Create requirement” on an answer), or from the deal.</p></div>
      : !list.length ? <div className="empty"><p>No requirements match these filters.</p></div>
      : <ul className="cl-requirements">{list.map(item => <li key={item.id}>
        <div className="cl-service-head"><strong>{item.title}</strong><span className={`cl-pill is-${item.status}`}>{requirementStatusLabels[item.status]}</span>{(item.priority === 'high' || item.priority === 'critical') && <span className="sp-chip is-high">{priorityText[item.priority]}</span>}</div>
        <p className="sp-muted">{requirementCategoryLabels[item.category]} · {requirementSourceLabels[item.source]}{service(item.clientServiceId) ? ` · ${service(item.clientServiceId)}` : ''} · version {item.version}</p>
        {item.description && <p className="sp-pre">{item.description}</p>}
        {item.notes && <p className="sp-quote">{item.notes}</p>}
        <div className="sp-actions">
          {!locked && <button className="text-button" onClick={() => setEditing({ input: { ...item }, version: item.version })}>Edit</button>}
          {!locked && item.status !== 'confirmed' && <button className="text-button" disabled={busy} onClick={() => void act(async () => { await saveRequirement(workspace.id, detail.id, { ...item, status: 'confirmed' }, item.version, null); return `Requirement confirmed: ${item.title}` })}>Confirm</button>}
          {item.version > 1 && <button className="text-button" onClick={() => setHistory(item)}>History</button>}
        </div>
      </li>)}</ul>}
    {editing && <RequirementDialog detail={detail} requirement={editing.input} busy={busy} onClose={() => setEditing(null)}
      onSave={async (input, requestId) => { if (await act(async () => { await saveRequirement(workspace.id, detail.id, input, editing.version, requestId); return input.id ? 'Requirement saved.' : 'Requirement added.' })) setEditing(null) }} />}
    {history && <RequirementHistory workspace={workspace} requirement={history} detail={detail} onClose={() => setHistory(null)} />}
  </section>
}
function RequirementDialog({ detail, requirement, busy, onClose, onSave }: { detail: ClientDetail; requirement: RequirementInput; busy: boolean; onClose: () => void; onSave: (input: RequirementInput, requestId: string | null) => Promise<void> }) {
  const [form, setForm] = useState(requirement), [requestId] = useState(() => requirement.id ? null : crypto.randomUUID())
  return <Modal title={requirement.id ? 'Edit requirement' : 'Add a requirement'} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onSave({ ...form, title: form.title.trim() }, requestId) }}>
      <label>Title *<input required maxLength={200} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>Description<textarea rows={4} maxLength={4000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <div className="sp-row sp-row-3">
        <label>Category<select value={form.category} onChange={event => setForm({ ...form, category: event.target.value as RequirementCategory })}>{requirementCategories.map(item => <option key={item} value={item}>{requirementCategoryLabels[item]}</option>)}</select></label>
        <label>Priority<select value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value as RequirementPriority })}>{requirementPriorities.map(item => <option key={item} value={item}>{priorityText[item]}</option>)}</select></label>
        <label>Status<select value={form.status} onChange={event => setForm({ ...form, status: event.target.value as RequirementStatus })}>{requirementStatuses.map(item => <option key={item} value={item}>{requirementStatusLabels[item]}</option>)}</select></label>
      </div>
      <div className="sp-row">
        <label>Source<select value={form.source} onChange={event => setForm({ ...form, source: event.target.value as RequirementSource })}>{requirementSources.map(item => <option key={item} value={item}>{requirementSourceLabels[item]}</option>)}</select></label>
        <label>Service<select value={form.clientServiceId ?? ''} onChange={event => setForm({ ...form, clientServiceId: event.target.value || null })}><option value="">Not tied to a service</option>{detail.serviceRecords.filter(item => item.status !== 'removed').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      <label>Notes<textarea rows={2} maxLength={2000} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save requirement</button></div>
    </form>
  </Modal>
}
function RequirementHistory({ workspace, requirement, detail, onClose }: { workspace: WorkspaceSummary; requirement: Requirement; detail: ClientDetail; onClose: () => void }) {
  const [versions, setVersions] = useState<Awaited<ReturnType<typeof requirementHistory>> | null>(null), [error, setError] = useState('')
  useEffect(() => { let active = true; requirementHistory(workspace.id, requirement.id).then(value => { if (active) setVersions(value) }).catch(cause => { if (active) setError(errorText(cause)) }); return () => { active = false } }, [workspace.id, requirement.id])
  return <Modal title={`History · ${requirement.title}`} onClose={onClose}>
    {error ? <p className="sp-error" role="alert">{error}</p> : !versions ? <p className="sp-muted" role="status">Loading…</p>
      : <ol className="cl-versions">{versions.map(version => <li key={version.version}>
        <p><strong>Version {version.version}</strong> · {dateTime(version.changedAt)}{version.changedBy ? ` · ${version.changedBy}` : ''}</p>
        <p>{version.snapshot.title} <span className={`cl-pill is-${version.snapshot.status}`}>{requirementStatusLabels[version.snapshot.status]}</span></p>
        <p className="sp-muted">{requirementCategoryLabels[version.snapshot.category]} · {priorityText[version.snapshot.priority]} priority{version.snapshot.clientServiceId ? ` · ${detail.serviceRecords.find(item => item.id === version.snapshot.clientServiceId)?.name ?? 'a service'}` : ''}</p>
        {version.snapshot.description && <p className="sp-pre">{version.snapshot.description}</p>}
      </li>)}</ol>}
  </Modal>
}

// ---------- Scope ----------

function Scope({ workspace, detail, busy, locked, act }: { workspace: WorkspaceSummary; detail: ClientDetail; busy: boolean; locked: boolean; act: Act }) {
  const [confirming, setConfirming] = useState(false), [history, setHistory] = useState(false)
  const scope = detail.scope, confirmed = detail.serviceRecords.filter(item => item.status === 'confirmed')
  return <section className={`panel cl-section cl-scope-card${scope && !scope.changedSince ? ' is-confirmed' : ''}`}>
    <div className="section-heading"><div><h2>Scope confirmation</h2><p>A dated record of what was agreed: confirmed services, requirements, dependencies, exclusions and expectations. An internal record, not a contract or signature.</p></div>
      <div className="sp-heading-actions">{detail.scopeHistory > 0 && <button className="text-button" onClick={() => setHistory(true)}>History ({detail.scopeHistory})</button>}
        {!locked && <button className={scope && !scope.changedSince ? 'secondary' : 'primary'} disabled={busy || !confirmed.length} title={!confirmed.length ? 'Confirm at least one service first' : undefined} onClick={() => setConfirming(true)}>{scope ? 'Confirm again…' : 'Confirm scope…'}</button>}</div></div>
    {!scope ? <p className="cl-scope-empty">{confirmed.length ? 'Not confirmed yet. When the services and requirements below are agreed, confirm the scope.' : 'Confirm at least one service, then confirm the scope.'}</p>
      : <div className="cl-scope-body">
        <p><strong>Version {scope.sequence}</strong>, confirmed {dateTime(scope.confirmedAt)}{scope.confirmedBy ? ` by ${scope.confirmedBy}` : ''}. {scope.sharedWithClient ? scope.clientAcknowledgedAt ? `The client acknowledged it on ${shortDate(scope.clientAcknowledgedAt)} (an acknowledgement, not a signature).` : 'Shared on the client’s onboarding page; not acknowledged yet.' : 'Not shared with the client.'}</p>
        {scope.changedSince && <p className="sp-caution" role="status">Services or requirements changed after this confirmation. Confirm the scope again so the record matches.</p>}
        <ScopeSummary scope={scope} />
      </div>}
    {confirming && <ConfirmScope detail={detail} busy={busy} onClose={() => setConfirming(false)}
      onConfirm={async details => { if (await act(async () => { const result = await confirmScope(workspace.id, detail.id, details); return `Scope confirmed (version ${result.sequence}).` })) setConfirming(false) }} />}
    {history && <ScopeHistory workspace={workspace} detail={detail} onClose={() => setHistory(false)} />}
  </section>
}
function ScopeSummary({ scope }: { scope: ScopeConfirmation }) {
  const snapshot = scope.snapshot
  return <div className="cl-scope-summary">
    <div><h4>Services</h4><ul>{snapshot.services.map(service => <li key={service.id}><strong>{service.name}</strong>{service.agreedScope && <span className="sp-pre">{service.agreedScope}</span>}{service.deliverables && <small>Deliverables: {service.deliverables}</small>}</li>)}</ul></div>
    <div><h4>Requirements ({snapshot.requirements.length})</h4>{snapshot.requirements.length ? <ul>{snapshot.requirements.map(item => <li key={item.id}>{item.title} <small>{requirementCategoryLabels[item.category]}{item.service ? ` · ${item.service}` : ''}</small></li>)}</ul> : <p className="sp-muted">None confirmed.</p>}</div>
    {snapshot.exclusions.length > 0 && <div><h4>Not included</h4><ul>{snapshot.exclusions.map((item, index) => <li key={index}><strong>{item.service}:</strong> <span className="sp-pre">{item.text}</span></li>)}</ul></div>}
    {snapshot.dependencies.length > 0 && <div><h4>Dependencies &amp; assumptions</h4><ul>{snapshot.dependencies.map((item, index) => <li key={index}>{item.title}</li>)}</ul></div>}
    {snapshot.expectations.length > 0 && <div><h4>Expectations &amp; goals</h4><ul>{snapshot.expectations.map((item, index) => <li key={index}>{item.title}</li>)}</ul></div>}
    {scope.outstandingQuestions && <div><h4>Outstanding questions</h4><p className="sp-pre">{scope.outstandingQuestions}</p></div>}
    {snapshot.undecided > 0 && <p className="sp-muted">{snapshot.undecided} requirement{snapshot.undecided === 1 ? ' was' : 's were'} still undecided when this was confirmed.</p>}
  </div>
}
function ConfirmScope({ detail, busy, onClose, onConfirm }: { detail: ClientDetail; busy: boolean; onClose: () => void; onConfirm: (details: { outstandingQuestions: string; notes: string; sharedWithClient: boolean }) => Promise<void> }) {
  const [questions, setQuestions] = useState(detail.scope?.outstandingQuestions ?? ''), [notes, setNotes] = useState(''), [shared, setShared] = useState(true)
  const services = detail.serviceRecords.filter(item => item.status === 'confirmed'), requirements = detail.requirements.filter(item => item.status === 'confirmed')
  const undecided = detail.requirements.filter(item => item.status === 'draft' || item.status === 'under_review').length
  return <Modal title="Confirm the scope" onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void onConfirm({ outstandingQuestions: questions.trim(), notes: notes.trim(), sharedWithClient: shared }) }}>
      <p className="sp-intro">This saves what is agreed right now: {services.length} confirmed service{services.length === 1 ? '' : 's'} ({services.map(item => item.name).join(', ')}) and {requirements.length} confirmed requirement{requirements.length === 1 ? '' : 's'}, with their exclusions, dependencies and expectations. It replaces the previous confirmation, which stays in the history.</p>
      {undecided > 0 && <p className="sp-caution">{undecided} requirement{undecided === 1 ? ' is' : 's are'} still in draft or under review and won’t be part of the confirmed scope.</p>}
      <label>Outstanding questions<textarea rows={3} maxLength={4000} value={questions} onChange={event => setQuestions(event.target.value)} /><small>Anything still open. Shown to the client with the scope.</small></label>
      <label>Internal notes<textarea rows={2} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} /><small>For your team only.</small></label>
      <label className="cl-check-label"><input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} /> Show it on the client’s onboarding page, where they can acknowledge it</label>
      <p className="sp-muted">This is a record of what was agreed, not a contract, signature or legal acceptance. A client acknowledgement only means they’ve read it.</p>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Confirm scope</button></div>
    </form>
  </Modal>
}
function ScopeHistory({ workspace, detail, onClose }: { workspace: WorkspaceSummary; detail: ClientDetail; onClose: () => void }) {
  const [versions, setVersions] = useState<ScopeConfirmation[] | null>(null), [error, setError] = useState('')
  useEffect(() => { let active = true; scopeHistory(workspace.id, detail.id).then(value => { if (active) setVersions(value) }).catch(cause => { if (active) setError(errorText(cause)) }); return () => { active = false } }, [workspace.id, detail.id])
  return <Modal title="Scope history" onClose={onClose}>
    {error ? <p className="sp-error" role="alert">{error}</p> : !versions ? <p className="sp-muted" role="status">Loading…</p>
      : <ol className="cl-versions">{versions.map(version => <li key={version.id}>
        <p><strong>Version {version.sequence}</strong> · {dateTime(version.confirmedAt)}{version.confirmedBy ? ` · ${version.confirmedBy}` : ''}{version.supersededAt ? ` · replaced ${shortDate(version.supersededAt)}` : ' · current'}{version.clientAcknowledgedAt ? ` · acknowledged by the client ${shortDate(version.clientAcknowledgedAt)}` : ''}</p>
        <ScopeSummary scope={version} />
        {version.notes && <p className="sp-quote">{version.notes}</p>}
      </li>)}</ol>}
  </Modal>
}
