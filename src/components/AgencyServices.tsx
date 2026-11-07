import { useEffect, useState } from 'react'
import { agencyServices, analysisUsage, deleteAgencyService, installStarterServices, opportunityLabels, opportunityTypes, saveAgencyService, type AgencyService, type OpportunityType, type UsageSummary } from '../lib/analysis'
import type { WorkspaceSummary } from '../lib/backend'
import { Modal } from './Modal'
import './BusinessReport.css'

type Draft = { id?: string; name: string; description: string; category: string; targetCategories: string; opportunityTypes: OpportunityType[]; pricing: string; notes: string; active: boolean }
const blank: Draft = { name: '', description: '', category: '', targetCategories: '', opportunityTypes: [], pricing: '', notes: '', active: true }
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Something went wrong. Try again.'
const unitLabels: Record<string, string> = { pages: 'pages crawled', runs: 'crawler runs', requests: 'PageSpeed requests', input_tokens: 'AI input tokens', output_tokens: 'AI output tokens' }

/** The services the agency sells. Business analysis matches its findings to these. Owners and admins edit; members read. */
export function AgencyServices({ workspace }: { workspace: WorkspaceSummary }) {
  const [services, setServices] = useState<AgencyService[] | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState(''), [formError, setFormError] = useState(''), [busy, setBusy] = useState(false)
  const canEdit = workspace.role !== 'member'
  async function load() { setServices(await agencyServices(workspace.id)) }
  useEffect(() => {
    let active = true
    agencyServices(workspace.id).then(items => { if (active) setServices(items) }).catch(cause => { if (active) { setServices([]); setError(errorText(cause)) } })
    analysisUsage(workspace.id).then(value => { if (active) setUsage(value) }).catch(() => { /* Usage is informational. */ })
    return () => { active = false }
  }, [workspace.id])
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await action(); await load() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!draft) return
    if (!draft.name.trim()) { setFormError('Give the service a name.'); return }
    setBusy(true); setFormError('')
    try {
      await saveAgencyService(workspace.id, { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), description: draft.description.trim(), category: draft.category.trim(), pricing: draft.pricing.trim(),
        notes: draft.notes.trim(), active: draft.active, opportunityTypes: draft.opportunityTypes, targetCategories: draft.targetCategories.split(',').map(item => item.trim()).filter(Boolean) })
      setDraft(null); await load()
    } catch (cause) { setFormError(errorText(cause)) } finally { setBusy(false) }
  }
  const edit = (service: AgencyService) => { setFormError(''); setDraft({ id: service.id, name: service.name, description: service.description, category: service.category, targetCategories: service.targetCategories.join(', '),
    opportunityTypes: service.opportunityTypes, pricing: service.pricing, notes: service.notes, active: service.active }) }

  return <section className="panel svc-panel" aria-labelledby="svc-title">
    <div className="svc-head"><div><h2 id="svc-title">Agency services</h2><p>What your agency offers. Business analysis matches each website’s findings to these services.</p></div>
      {canEdit && <div className="svc-actions">{services && services.length === 0 && <button className="secondary" disabled={busy} onClick={() => void run(() => installStarterServices(workspace.id))}>Add starter services</button>}
        <button className="primary" disabled={busy} onClick={() => { setFormError(''); setDraft({ ...blank }) }}>Add service</button></div>}</div>
    {usage && <p className="svc-usage"><span>This month: <strong>{usage.analyses}</strong> analys{usage.analyses === 1 ? 'is' : 'es'}</span>
      {usage.usage.map(item => <span key={`${item.provider}:${item.unit}`}><strong>{Number(item.quantity).toLocaleString()}</strong> {unitLabels[item.unit] ?? `${item.provider} ${item.unit}`}{item.costUsd !== null ? ` ($${Number(item.costUsd).toFixed(2)} reported)` : ''}</span>)}</p>}
    {error && <p className="br-error" role="alert">{error}</p>}
    {services === null ? <p className="br-muted" role="status">Loading services…</p> : services.length === 0 ? <p className="br-muted">No services yet.{canEdit ? ' Add the starter set and edit it, or add your own.' : ' Ask an owner or admin to add them.'}</p>
      : <ul className="svc-list">{services.map(service => <li key={service.id} className={service.active ? '' : 'inactive'}>
        <div><h3>{service.name}{!service.active && ' (inactive)'}</h3>{service.description && <p>{service.description}</p>}
          <p>{service.opportunityTypes.map(type => opportunityLabels[type]).join(' · ') || 'No opportunity types'}{service.targetCategories.length ? ` · For: ${service.targetCategories.join(', ')}` : ''}{service.pricing ? ` · ${service.pricing}` : ''}</p>
          {canEdit && service.notes && <p>Internal: {service.notes}</p>}</div>
        {canEdit && <div className="svc-actions"><button className="secondary" disabled={busy} onClick={() => edit(service)}>Edit</button>
          <button className="secondary" disabled={busy} onClick={() => void run(() => saveAgencyService(workspace.id, { id: service.id, active: !service.active }))}>{service.active ? 'Deactivate' : 'Activate'}</button>
          <button className="secondary" disabled={busy} onClick={() => { if (window.confirm(`Delete “${service.name}”? Reports that matched it keep its name.`)) void run(() => deleteAgencyService(workspace.id, service.id)) }}>Delete</button></div>}
      </li>)}</ul>}
    {draft && <Modal title={draft.id ? 'Edit service' : 'Add a service'} onClose={() => setDraft(null)}>
      <form className="svc-form" onSubmit={event => void save(event)}>
        <label>Name *<input value={draft.name} maxLength={80} required onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Description<textarea rows={2} maxLength={1000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        <fieldset className="svc-types"><legend className="br-muted">Opportunities this service addresses</legend>
          {opportunityTypes.map(type => <label key={type}><input type="checkbox" checked={draft.opportunityTypes.includes(type)} onChange={event => setDraft({ ...draft, opportunityTypes: event.target.checked ? [...draft.opportunityTypes, type] : draft.opportunityTypes.filter(item => item !== type) })} />{opportunityLabels[type]}</label>)}</fieldset>
        <label>Best for (kinds of business, comma separated)<input value={draft.targetCategories} maxLength={500} placeholder="dental, restaurants, law firms — leave empty for any" onChange={event => setDraft({ ...draft, targetCategories: event.target.value })} /></label>
        <label>Pricing<input value={draft.pricing} maxLength={200} placeholder="e.g. from $1,500" onChange={event => setDraft({ ...draft, pricing: event.target.value })} /></label>
        <label>Internal notes (owners and admins only)<textarea rows={2} maxLength={2000} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></label>
        <label className="svc-check" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={draft.active} onChange={event => setDraft({ ...draft, active: event.target.checked })} />Active (used for matching)</label>
        {formError && <p className="br-error" role="alert">{formError}</p>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={() => setDraft(null)}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save service'}</button></div>
      </form>
    </Modal>}
  </section>
}
