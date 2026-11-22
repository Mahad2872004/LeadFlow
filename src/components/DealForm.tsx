import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { analysesFor, analysisReport, type Opportunity } from '../lib/analysis'
import { contactName, leadContacts, type LeadContact } from '../lib/outreach'
import type { Lead } from '../lib/model'
import { createDeal, isDuplicate, priorityLabels, salesPipeline, type Deal, type DealInput, type DealSource, type Pipeline, type Priority, errorText } from '../lib/sales'

export interface DealStart { leadId?: string; opportunityId?: string; contactId?: string; sourceDraftId?: string; source?: DealSource; title?: string; stageId?: string }

/**
 * Creates a deal for a lead. Started from a lead, an opportunity in its business report, an outreach draft or the pipeline,
 * it keeps those links. The request ID stays the same until the deal is created, so a double click or a retry after a
 * dropped connection can't create two; an open deal with the same opportunity or title is pointed out before another is made.
 */
export function DealForm({ workspaceId, leads, start, onCreated, onOpenDeal, onClose }: {
  workspaceId: string; leads: Lead[]; start: DealStart; onCreated: (deal: Deal) => void; onOpenDeal: (dealId: string) => void; onClose: () => void
}) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null)
  const [leadId, setLeadId] = useState(start.leadId ?? leads[0]?.id ?? '')
  const [title, setTitle] = useState(start.title ?? ''), [description, setDescription] = useState('')
  const [opportunityId, setOpportunityId] = useState(start.opportunityId ?? ''), [contactId, setContactId] = useState(start.contactId ?? '')
  const [stageId, setStageId] = useState(start.stageId ?? ''), [value, setValue] = useState(''), [currency, setCurrency] = useState('')
  const [probability, setProbability] = useState(''), [closeDate, setCloseDate] = useState(''), [priority, setPriority] = useState<Priority>('medium'), [ownerId, setOwnerId] = useState('')
  const [related, setRelated] = useState<{ leadId: string; opportunities?: Opportunity[]; contacts?: LeadContact[] }>({ leadId: '' })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [duplicate, setDuplicate] = useState<{ message: string; dealId: string } | null>(null)
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let active = true
    salesPipeline(workspaceId).then(config => { if (active) { setPipeline(config); setCurrency(current => current || config.settings.defaultCurrency); setStageId(current => current || config.settings.defaultStageId || '') } })
      .catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspaceId])
  // The lead's opportunities (from its latest completed report) and contacts, to link the deal to.
  useEffect(() => {
    if (!leadId) return
    let active = true
    const keep = (patch: { opportunities?: Opportunity[]; contacts?: LeadContact[] }) => { if (active) setRelated(current => ({ ...(current.leadId === leadId ? current : { leadId }), ...patch })) }
    analysesFor(workspaceId, leadId).then(items => { const latest = items.find(item => item.status === 'completed' || item.status === 'partial'); return latest ? analysisReport(workspaceId, latest.id).then(report => report.opportunities) : [] })
      .then(items => keep({ opportunities: items.filter(item => item.status !== 'dismissed' || item.id === start.opportunityId) })).catch(() => keep({ opportunities: [] }))
    leadContacts(workspaceId, leadId).then(result => { keep({ contacts: result.contacts }); if (active && !start.contactId) setContactId(current => current || result.contacts.find(item => item.isPreferred)?.id || result.contacts.find(item => item.isPrimary)?.id || '') })
      .catch(() => keep({ contacts: [] }))
    return () => { active = false }
  }, [workspaceId, leadId, start.opportunityId, start.contactId])
  const opportunities = related.leadId === leadId ? related.opportunities ?? null : null, contacts = related.leadId === leadId ? related.contacts ?? null : null
  const opportunity = opportunities?.find(item => item.id === opportunityId)
  const lead = leads.find(item => item.id === leadId)
  const placeholder = opportunity?.title ?? (lead ? `${lead.company || lead.name} – ${lead.service && lead.service !== 'Not specified' ? lead.service : 'new project'}` : 'Website redesign')

  async function submit(allowDuplicate = false) {
    if (!pipeline) return
    setBusy(true); setError(''); setDuplicate(null)
    const deal: DealInput = { leadId, title: title.trim() || placeholder, description, stageId, contactId, opportunityId, sourceDraftId: start.sourceDraftId, priority, ownerId, value: value.trim().replace(/,/g, ''), currency, probability: probability.trim(), expectedCloseDate: closeDate,
      source: start.source ?? (opportunityId ? 'opportunity' : start.sourceDraftId ? 'outreach' : start.leadId ? 'lead' : 'pipeline') }
    try { onCreated(await createDeal(workspaceId, deal, requestId.current, allowDuplicate)) }
    catch (cause) {
      if (isDuplicate(cause)) setDuplicate({ message: cause.message, dealId: cause.detail })
      else { setError(errorText(cause)); if (!/reach LeadFlow/.test(errorText(cause))) requestId.current = crypto.randomUUID() }
    } finally { setBusy(false) }
  }
  const openStages = pipeline?.stages.filter(stage => !stage.archived && stage.category === 'open') ?? []
  return <Modal title="New deal" onClose={onClose}>
    {!leads.length ? <div className="empty"><p>Add a lead first. Every deal belongs to a lead, so its company, contacts and history stay connected.</p></div> : !pipeline ? <p className="sp-loading" role="status">{error || 'Loading…'}</p> :
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <p className="sp-intro">A deal is one opportunity to win work from a lead. A lead can have several. Values are optional, and amounts in different currencies are never added together.</p>
      <label>Lead *<select required value={leadId} disabled={!!start.leadId} onChange={event => { setLeadId(event.target.value); setOpportunityId(''); setContactId('') }}>
        {leads.map(item => <option key={item.id} value={item.id}>{item.company ? `${item.company} · ${item.name}` : item.name}</option>)}</select></label>
      <label>Opportunity from the business report<select value={opportunityId} disabled={opportunities === null} onChange={event => setOpportunityId(event.target.value)}>
        <option value="">{opportunities === null ? 'Loading…' : opportunities.length ? 'None' : 'No report opportunities for this lead'}</option>
        {opportunities?.map(item => <option key={item.id} value={item.id}>{item.title}{item.serviceName ? ` · ${item.serviceName}` : ''}</option>)}</select></label>
      <label>Title<input maxLength={150} value={title} placeholder={placeholder} onChange={event => setTitle(event.target.value)} /><small>Leave empty to use “{placeholder}”.</small></label>
      <div className="sp-row">
        <label>Stage<select value={stageId} onChange={event => setStageId(event.target.value)}>{openStages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
        <label>Contact<select value={contactId} disabled={contacts === null} onChange={event => setContactId(event.target.value)}><option value="">{contacts === null ? 'Loading…' : contacts.length ? 'None' : 'No contacts saved'}</option>
          {contacts?.map(item => <option key={item.id} value={item.id}>{contactName(item)}{item.jobTitle ? ` · ${item.jobTitle}` : ''}</option>)}</select></label>
      </div>
      <div className="sp-row sp-row-3">
        <label>Value<input inputMode="decimal" value={value} placeholder="Optional" onChange={event => setValue(event.target.value)} /></label>
        <label>Currency<select value={currency} onChange={event => setCurrency(event.target.value)}>{pipeline.settings.currencies.map(code => <option key={code}>{code}</option>)}</select></label>
        <label>Probability %<input inputMode="numeric" value={probability} placeholder={String(openStages.find(stage => stage.id === stageId)?.probability ?? '')} onChange={event => setProbability(event.target.value.replace(/[^\d]/g, '').slice(0, 3))} /></label>
      </div>
      <div className="sp-row sp-row-3">
        <label>Expected close<input type="date" value={closeDate} onChange={event => setCloseDate(event.target.value)} /></label>
        <label>Priority<select value={priority} onChange={event => setPriority(event.target.value as Priority)}>{(['low', 'medium', 'high'] as const).map(item => <option key={item} value={item}>{priorityLabels[item]}</option>)}</select></label>
        <label>Owner<select value={ownerId} onChange={event => setOwnerId(event.target.value)}><option value="">Unassigned</option>{pipeline.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      </div>
      <label>Description<textarea rows={3} maxLength={4000} value={description} placeholder="What the client needs, scope, decision process…" onChange={event => setDescription(event.target.value)} /></label>
      {duplicate && <div className="sp-confirm" role="alert"><p>{duplicate.message}</p><div className="sp-actions">
        {duplicate.dealId && <button type="button" className="secondary" onClick={() => onOpenDeal(duplicate.dealId)}>Open existing deal</button>}
        <button type="button" className="primary" disabled={busy} onClick={() => void submit(true)}>Create another deal</button></div></div>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !leadId}>{busy ? 'Creating…' : 'Create deal'}</button></div>
    </form>}
  </Modal>
}
