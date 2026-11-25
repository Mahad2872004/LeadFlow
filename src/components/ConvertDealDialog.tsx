import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { dealDetail, errorText, money, shortDate, type DealDetail, type SalesMember } from '../lib/sales'
import { agencyServices, analysesFor, analysisReport, type AgencyService, type Report } from '../lib/analysis'
import { loadOverview, serviceLabels, type ServiceType, type TemplateSummary } from '../lib/onboarding'
import { contactRoleLabels, contactRoles, convertDeal, type ClientContactRole, type ContactInput, type ServiceInput } from '../lib/clients'

interface ContactRow { key: string; sourceId: string | null; include: boolean; fullName: string; jobTitle: string; email: string; phone: string; role: ClientContactRole; isPrimary: boolean }
interface ServiceRow { key: string; serviceId: string | null; name: string; agreedScope: string; deliverables: string; exclusions: string }
const keywords: Record<ServiceType, string[]> = {
  paid_ads: ['ads', 'ppc', 'paid', 'advertising', 'adwords', 'meta ads', 'google ads'], seo: ['seo', 'search', 'ranking', 'digital marketing', 'marketing'], social: ['social', 'instagram', 'facebook', 'tiktok', 'linkedin'],
  email: ['email', 'newsletter', 'klaviyo', 'mailchimp'], website: ['website', 'web', 'site', 'landing', 'shopify', 'wordpress', 'redesign', 'development'], automation: ['automation', 'crm', 'zapier', 'workflow', 'integration'], other: [],
}
/** The template whose service best matches the deal's service and opportunity, with the reason. Only a suggestion. */
function recommend(templates: TemplateSummary[], detail: DealDetail): { id: string; reason: string } | null {
  const text = `${detail.serviceName} ${detail.opportunityTitle} ${detail.opportunityType ?? ''} ${detail.title}`.toLowerCase()
  let best: { template: TemplateSummary; score: number; word: string } | null = null
  for (const template of templates) {
    const words = [...keywords[template.serviceType], template.name.toLowerCase()]
    const hits = words.filter(word => word && text.includes(word))
    if (hits.length && (!best || hits.length > best.score)) best = { template, score: hits.length, word: hits[0] }
  }
  return best ? { id: best.template.id, reason: `matches “${best.word}” in the deal` } : null
}

/**
 * Converts a deal into a client after a review: what the lead, the deal and its business report say, which contacts and
 * services carry over, and whether to start onboarding. One transaction in the database; converting again opens the
 * same client. Deals that aren't won can be converted only by owners and admins, with a reason that is kept.
 */
export function ConvertDealDialog({ workspace, dealId, members, onClose, onConverted }: {
  workspace: WorkspaceSummary; dealId: string; members: SalesMember[]; onClose: () => void
  onConverted: (result: { id: string; existing: boolean; onboardingRequestId?: string | null }, name: string) => void
}) {
  const [detail, setDetail] = useState<DealDetail | null>(null), [report, setReport] = useState<Report | null>(null), [catalog, setCatalog] = useState<AgencyService[]>([])
  const [templates, setTemplates] = useState<TemplateSummary[]>([]), [loadError, setLoadError] = useState('')
  const [name, setName] = useState(''), [website, setWebsite] = useState(''), [industry, setIndustry] = useState(''), [ownerId, setOwnerId] = useState('')
  const [contacts, setContacts] = useState<ContactRow[]>([]), [services, setServices] = useState<ServiceRow[]>([]), [catalogPick, setCatalogPick] = useState('')
  const [template, setTemplate] = useState(''), [onboardingTitle, setOnboardingTitle] = useState(''), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  // One request ID per review: a retry after a lost response returns the client the first attempt created.
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let active = true
    dealDetail(workspace.id, dealId).then(next => {
      if (!active) return
      setDetail(next)
      setName(next.lead?.company || next.lead?.name || next.title); setWebsite(next.lead?.website ?? ''); setIndustry(next.lead?.industry ?? ''); setOwnerId(next.ownerId ?? '')
      setOnboardingTitle(`${next.lead?.company || next.lead?.name || next.title} onboarding`)
      // People carry over by default; a business line only when the lead has no named person.
      const people = next.contacts.some(contact => contact.kind === 'person')
      setContacts(next.contacts.map((contact, index) => ({ key: contact.id, sourceId: contact.id, include: contact.kind === 'person' || (!people && index === 0), fullName: contact.name || contact.email || contact.phone || 'Main contact', jobTitle: contact.jobTitle, email: contact.email, phone: contact.phone,
        role: contact.id === next.contactId ? 'decision_maker' : 'project', isPrimary: next.contactId ? contact.id === next.contactId : index === 0 })))
      if (next.serviceName) setServices([{ key: crypto.randomUUID(), serviceId: next.serviceId, name: next.serviceName, agreedScope: next.description, deliverables: '', exclusions: '' }])
      // The business report, the catalog and templates are context; the review works without them.
      analysesFor(workspace.id, next.leadId).then(list => { const latest = list.find(item => item.status === 'completed' || item.status === 'partial'); return latest ? analysisReport(workspace.id, latest.id) : null })
        .then(value => { if (active) setReport(value) }).catch(() => undefined)
      agencyServices(workspace.id).then(list => { if (active) setCatalog(list.filter(item => item.active)) }).catch(() => undefined)
      loadOverview(workspace.id).then(overview => {
        if (!active) return
        const usable = overview.templates.filter(item => !item.archived)
        setTemplates(usable)
        const suggestion = recommend(usable, next)
        setTemplate(suggestion?.id ?? (usable.length ? '' : 'blank'))
      }).catch(() => undefined)
    }).catch(cause => { if (active) setLoadError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, dealId])
  const suggestion = useMemo(() => detail ? recommend(templates, detail) : null, [templates, detail])

  if (!detail) return <Modal title="Convert to client" onClose={onClose}><p className="sp-loading" role="status">{loadError ? <span className="sp-error" role="alert">{loadError}</span> : 'Loading the deal…'}</p></Modal>
  const won = detail.outcome === 'won', manager = workspace.role !== 'member'
  const blocked = detail.archived ? 'Restore this deal before converting it.' : !won && !manager ? 'Only won deals can be converted. Ask an owner or admin to convert this deal by exception.' : ''
  const included = contacts.filter(contact => contact.include)
  const setContact = (key: string, patch: Partial<ContactRow>) => setContacts(rows => rows.map(row => row.key === key ? { ...row, ...patch } : patch.isPrimary ? { ...row, isPrimary: false } : row))
  const setService = (key: string, patch: Partial<ServiceRow>) => setServices(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row))
  const summary = report?.overview.ai?.summary?.text
  async function submit() {
    setError('')
    if (!name.trim()) return setError('Give the client a name.')
    if (included.some(contact => !contact.fullName.trim())) return setError('Every included contact needs a name.')
    if (!won && !reason.trim()) return setError('Give a reason for converting a deal that isn’t won.')
    const names = services.map(service => service.name.trim().toLowerCase())
    if (names.some(value => !value)) return setError('Every service needs a name.')
    if (new Set(names).size !== names.length) return setError('A service is listed twice.')
    setBusy(true)
    try {
      const primary = included.find(contact => contact.isPrimary) ?? included[0]
      const contactInput: ContactInput[] = included.map(contact => ({ fullName: contact.fullName.trim(), jobTitle: contact.jobTitle.trim(), role: contact.role, email: contact.email.trim(), phone: contact.phone.trim(),
        preferredChannel: 'email', notes: '', isPrimary: contact === primary, sourceContactId: contact.sourceId }))
      const serviceInput: ServiceInput[] = services.map(service => ({ serviceId: service.serviceId, name: service.name.trim(), description: '', agreedScope: service.agreedScope.trim(), deliverables: service.deliverables.trim(), exclusions: service.exclusions.trim(), notes: '' }))
      const result = await convertDeal(workspace.id, detail!.id, { name: name.trim(), website: website.trim(), industry: industry.trim(), ownerId: ownerId || null, contacts: contactInput, services: serviceInput,
        ...(won ? {} : { overrideReason: reason.trim() }), ...(template ? { onboarding: { templateId: template === 'blank' ? null : template, title: onboardingTitle.trim() } } : {}) }, requestId.current)
      onConverted(result, name.trim())
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal id="convert-deal" title="Convert to client" onClose={onClose}>
    <form className="sp-form cl-convert" onSubmit={event => { event.preventDefault(); void submit() }}>
      <p className="sp-intro">Review what carries over before creating the client. The lead, the deal and their history stay as they are; the deal’s handoff is recorded, and the client, its contacts and services{template ? ' and its onboarding checklist' : ''} are created together in one step. Nothing is sent to the client.</p>
      {!won && <p className="sp-caution" role="note">This deal is {detail.outcome === 'lost' ? 'lost' : 'still open'}. Normally only won deals become clients. {manager ? 'You can convert it anyway with a reason, which is kept with the client.' : ''}</p>}
      <section className="cl-review" aria-label="From the deal">
        <div><span>Deal</span><strong>{detail.title}</strong><small>{won ? `Won ${shortDate(detail.actualCloseDate)}` : detail.outcome === 'lost' ? 'Lost' : 'Open'} · {money(won && detail.wonValue !== null ? detail.wonValue : detail.value, detail.currency)}</small></div>
        <div><span>Lead</span><strong>{detail.lead ? detail.lead.company || detail.lead.name : 'Removed'}</strong><small>{detail.lead ? [detail.lead.name, detail.lead.industry].filter(Boolean).join(' · ') : 'The deal keeps its history.'}</small></div>
        <div><span>Opportunity</span><strong>{detail.opportunity?.title || detail.opportunityTitle || 'None'}</strong><small>{detail.serviceName || 'No service linked'}</small></div>
        <div className="cl-review-wide"><span>Business report</span>{report ? <><strong>{report.findingCount} finding{report.findingCount === 1 ? '' : 's'} · {report.opportunities.length} opportunit{report.opportunities.length === 1 ? 'y' : 'ies'}</strong>
          {summary && <small className="sp-pre">{summary}</small>}<small>From the analysis of {report.website} on {shortDate(report.completedAt ?? report.createdAt)}. AI-assisted text is a summary, not a verified fact.</small></>
          : <small>No completed business report for this lead.</small>}</div>
        {detail.notes && <div className="cl-review-wide"><span>Deal notes</span><small className="sp-pre">{detail.notes}</small></div>}
      </section>

      <h3>Client</h3>
      <label>Client name *<input required maxLength={150} value={name} onChange={event => setName(event.target.value)} /></label>
      <div className="sp-row sp-row-3">
        <label>Website<input maxLength={300} value={website} placeholder="https://example.com" onChange={event => setWebsite(event.target.value)} /></label>
        <label>Industry<input maxLength={100} value={industry} onChange={event => setIndustry(event.target.value)} /></label>
        <label>Owner<select value={ownerId} onChange={event => setOwnerId(event.target.value)}><option value="">Me</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      </div>

      <h3>Contacts</h3>
      {contacts.length === 0 && <p className="sp-muted">The lead has no saved contacts. Add one below or later in the client workspace.</p>}
      <ul className="cl-pick-list">{contacts.map(contact => <li key={contact.key} className={contact.include ? '' : 'is-off'}>
        <label className="cl-check"><input type="checkbox" checked={contact.include} onChange={event => setContact(contact.key, { include: event.target.checked, ...(event.target.checked ? {} : { isPrimary: false }) })} /><span className="sr-only">Include {contact.fullName || 'contact'}</span></label>
        <div className="cl-pick-fields">
          <input aria-label="Contact name" maxLength={150} value={contact.fullName} disabled={!contact.include} placeholder="Full name" onChange={event => setContact(contact.key, { fullName: event.target.value })} />
          <input aria-label={`Email for ${contact.fullName || 'contact'}`} type="email" maxLength={254} value={contact.email} disabled={!contact.include} placeholder="Email" onChange={event => setContact(contact.key, { email: event.target.value })} />
          <select aria-label={`Role for ${contact.fullName || 'contact'}`} value={contact.role} disabled={!contact.include} onChange={event => setContact(contact.key, { role: event.target.value as ClientContactRole })}>{contactRoles.map(role => <option key={role} value={role}>{contactRoleLabels[role]}</option>)}</select>
          <label className="cl-radio"><input type="radio" name="primary-contact" checked={contact.isPrimary} disabled={!contact.include} onChange={() => setContact(contact.key, { isPrimary: true })} />Primary</label>
        </div>
        {contact.sourceId && <small>From the lead’s contacts{contact.jobTitle ? ` · ${contact.jobTitle}` : ''}</small>}
      </li>)}</ul>
      <button type="button" className="text-button" onClick={() => setContacts(rows => [...rows, { key: crypto.randomUUID(), sourceId: null, include: true, fullName: '', jobTitle: '', email: '', phone: '', role: 'project', isPrimary: !rows.some(row => row.include) }])}>+ Add a contact</button>

      <h3>Agreed services</h3>
      <p className="sp-muted">Services carried over from the deal are recorded as confirmed. You can refine the scope later, before confirming it with the client.</p>
      {services.map(service => <fieldset key={service.key} className="cl-service-row">
        <legend className="sr-only">Service {service.name}</legend>
        <div className="sp-row"><label>Service *<input required maxLength={80} value={service.name} onChange={event => setService(service.key, { name: event.target.value })} /></label>
          <div className="cl-row-end"><button type="button" className="text-button" onClick={() => setServices(rows => rows.filter(row => row.key !== service.key))}>Remove</button></div></div>
        <label>Agreed scope<textarea rows={2} maxLength={4000} value={service.agreedScope} placeholder="What’s included" onChange={event => setService(service.key, { agreedScope: event.target.value })} /></label>
        <div className="sp-row"><label>Deliverables<textarea rows={2} maxLength={4000} value={service.deliverables} onChange={event => setService(service.key, { deliverables: event.target.value })} /></label>
          <label>Exclusions<textarea rows={2} maxLength={4000} value={service.exclusions} placeholder="What’s not included" onChange={event => setService(service.key, { exclusions: event.target.value })} /></label></div>
      </fieldset>)}
      <div className="sp-actions">
        {catalog.length > 0 && <><select aria-label="Add a service from your catalog" value={catalogPick} onChange={event => setCatalogPick(event.target.value)}><option value="">Add from your services…</option>
          {catalog.filter(item => !services.some(service => service.serviceId === item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <button type="button" className="secondary" disabled={!catalogPick} onClick={() => { const item = catalog.find(entry => entry.id === catalogPick); if (item) setServices(rows => [...rows, { key: crypto.randomUUID(), serviceId: item.id, name: item.name, agreedScope: item.description, deliverables: '', exclusions: '' }]); setCatalogPick('') }}>Add</button></>}
        <button type="button" className="text-button" onClick={() => setServices(rows => [...rows, { key: crypto.randomUUID(), serviceId: null, name: '', agreedScope: '', deliverables: '', exclusions: '' }])}>+ Add a custom service</button>
      </div>

      <h3>Onboarding</h3>
      <label>Start onboarding with<select value={template} onChange={event => setTemplate(event.target.value)}>
        <option value="">Don’t start onboarding yet</option><option value="blank">A blank checklist</option>
        {templates.map(item => <option key={item.id} value={item.id}>{item.name} · {serviceLabels[item.serviceType]}{suggestion?.id === item.id ? ' (recommended)' : ''}</option>)}</select>
        <small>{suggestion ? `Recommended: ${templates.find(item => item.id === suggestion.id)?.name}, because it ${suggestion.reason}. A suggestion only; choose whatever fits.` : templates.length ? 'No template matches the deal’s service; pick one or start with a blank checklist.' : 'No templates yet. Install the starter templates under Onboarding → Templates.'}</small></label>
      {template && <label>Checklist title<input maxLength={150} value={onboardingTitle} onChange={event => setOnboardingTitle(event.target.value)} /></label>}

      {!won && manager && <label>Reason for converting by exception *<textarea required rows={2} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>}
      {blocked && <p className="sp-error" role="alert">{blocked}</p>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !!blocked}>{busy ? 'Converting…' : 'Convert to client'}</button></div>
    </form>
  </Modal>
}
