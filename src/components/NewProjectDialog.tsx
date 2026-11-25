import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import type { ClientIndexEntry } from '../lib/clients'
import { documentCategoryLabels, formatBytes } from '../lib/onboardingOptions'
import { errorText, money, shortDate, type SalesMember } from '../lib/sales'
import {
  briefFields, briefLabels, createProject, loadTemplates, projectPriorities, projectPriorityLabels, projectSetup, projectTypeLabels, projectTypes, templatePlan,
  type Brief, type Plan, type PlanDeliverable, type PlanMilestone, type PlanTask, type ProjectPriority, type ProjectSetup, type ProjectType, type TemplateSummary,
} from '../lib/projects'

type Included<T> = T & { include: boolean }
interface EditablePlan { milestones: Included<PlanMilestone>[]; deliverables: Included<PlanDeliverable>[]; tasks: Included<PlanTask>[] }
interface Suggestion { key: string; title: string; clientServiceId: string; service: string; include: boolean; milestoneRef: string }
/** Deliverables named in a confirmed service's "deliverables" text: one per line, bullet or semicolon. Suggestions only. */
const splitDeliverables = (text: string) => text.split(/\n|;|•/).map(line => line.replace(/^[\s\-*–\d.)]+/, '').trim()).filter(line => line.length > 1 && line.length <= 200)

/**
 * A new project: pick the client, review what was confirmed (the completed onboarding, or the client's confirmed scope),
 * edit the brief, choose a template plan and adjust it, then create everything in one step. Unconfirmed requirements
 * and proposed services never appear here, so nothing unagreed becomes a project commitment.
 */
export function NewProjectDialog({ workspace, members, clients, start, onClose, onCreated }: {
  workspace: WorkspaceSummary; members: SalesMember[]; clients: ClientIndexEntry[]; start: { clientId?: string }; onClose: () => void
  onCreated: (result: { id: string; workspaceChanged: boolean }, name: string) => void
}) {
  const usable = clients.filter(client => client.status !== 'archived')
  const [clientId, setClientId] = useState(start.clientId ?? ''), [loaded, setLoaded] = useState<{ clientId: string; value: ProjectSetup } | null>(null), [failed, setFailed] = useState<{ clientId: string; message: string } | null>(null)
  const [manual, setManual] = useState(false), [name, setName] = useState(''), [description, setDescription] = useState(''), [projectType, setProjectType] = useState<ProjectType>('other'), [typeTouched, setTypeTouched] = useState(false)
  const [priority, setPriority] = useState<ProjectPriority>('medium'), [ownerId, setOwnerId] = useState(''), [startDate, setStartDate] = useState(''), [targetDate, setTargetDate] = useState('')
  const [agreedValue, setAgreedValue] = useState(''), [currency, setCurrency] = useState('USD'), [tags, setTags] = useState(''), [serviceIds, setServiceIds] = useState<string[]>([]), [contactIds, setContactIds] = useState<string[]>([])
  const [brief, setBrief] = useState<Brief>({}), [templates, setTemplates] = useState<TemplateSummary[]>([]), [templateId, setTemplateId] = useState('')
  const [planData, setPlanData] = useState<{ key: string; plan: EditablePlan } | null>(null), [planFailed, setPlanFailed] = useState(''), [openMilestones, setOpenMilestones] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  // One request ID per dialog: a retry after a lost response returns the project the first attempt created.
  const requestId = useRef(crypto.randomUUID())
  // Results are kept with the client or template (and start date) they belong to; anything else is still loading.
  const setup = loaded?.clientId === clientId ? loaded.value : null, setupError = failed?.clientId === clientId ? failed.message : ''
  const planKey = templateId ? `${templateId}:${startDate}` : ''
  const plan = planKey && planData?.key === planKey ? planData.plan : null
  const planState = !planKey || plan ? 'idle' : planFailed === planKey ? 'error' : 'loading'
  const setPlan = (change: (current: EditablePlan) => EditablePlan) => setPlanData(current => current && { ...current, plan: change(current.plan) })
  const people = members.length ? members : setup?.members ?? []
  // Read inside the plan effect, which reloads only when the template or start date changes.
  const latest = useRef({ templates, typeTouched })
  useEffect(() => { latest.current = { templates, typeTouched } })

  useEffect(() => {
    let active = true
    loadTemplates(workspace.id).then(result => { if (active) setTemplates(result.templates.filter(item => !item.archived)) }).catch(() => { /* Templates are optional: a blank project still works. */ })
    return () => { active = false }
  }, [workspace.id])
  useEffect(() => {
    if (!clientId) return
    let active = true
    projectSetup(workspace.id, clientId).then(value => {
      if (!active) return
      setLoaded({ clientId, value }); setManual(false)
      const current = value.services.filter(service => service.current)
      setName(`${value.client.name}${current[0] ? ` – ${current[0].name}` : ' project'}`); setDescription('')
      setOwnerId(value.client.ownerId ?? ''); setStartDate(value.today); setTargetDate(''); setCurrency(value.deal?.currency ?? 'USD'); setAgreedValue('')
      setServiceIds(current.map(service => service.id)); setContactIds(value.contacts.filter(contact => contact.isPrimary).map(contact => contact.id)); setBrief(value.brief)
      setSuggestions(current.flatMap(service => splitDeliverables(service.deliverables).map((title, index) => ({ key: `${service.id}:${index}`, title, clientServiceId: service.id, service: service.name, include: false, milestoneRef: '' }))))
    }).catch(cause => { if (active) setFailed({ clientId, message: errorText(cause) }) })
    return () => { active = false }
  }, [workspace.id, clientId])
  useEffect(() => {
    if (!planKey) return
    let active = true
    templatePlan(workspace.id, templateId, startDate || null).then(value => {
      if (!active) return
      setPlanData({ key: planKey, plan: { milestones: value.milestones.map(item => ({ ...item, include: true })), deliverables: value.deliverables.map(item => ({ ...item, include: true })), tasks: value.tasks.map(item => ({ ...item, include: true })) } })
      setOpenMilestones([])
      setTargetDate(current => current || value.targetDate || '')
      const template = latest.current.templates.find(item => item.id === templateId)
      if (template && !latest.current.typeTouched) setProjectType(template.projectType)
    }).catch(() => { if (active) setPlanFailed(planKey) })
    return () => { active = false }
  }, [workspace.id, templateId, startDate, planKey])

  const source: 'onboarding' | 'client' | 'manual' = manual || !setup ? 'manual' : setup.source
  const setManualMode = (value: boolean) => {
    setManual(value)
    if (!setup) return
    if (value) { setBrief({}); setServiceIds([]) } else { setBrief(setup.brief); setServiceIds(setup.services.filter(service => service.current).map(service => service.id)) }
  }
  const counts = useMemo(() => {
    if (!plan) return { milestones: 0, deliverables: suggestions.filter(item => item.include).length, tasks: 0 }
    const kept = new Set(plan.milestones.filter(item => item.include).map(item => item.ref))
    const inPlan = (item: { include: boolean; milestoneRef?: string }) => item.include && (!item.milestoneRef || kept.has(item.milestoneRef))
    return { milestones: kept.size, deliverables: plan.deliverables.filter(inPlan).length + suggestions.filter(item => item.include).length, tasks: plan.tasks.filter(inPlan).length }
  }, [plan, suggestions])
  const toggle = (list: string[], id: string, on: boolean) => on ? [...new Set([...list, id])] : list.filter(item => item !== id)
  const editMilestone = (ref: string, patch: Partial<Included<PlanMilestone>>) => setPlan(current => ({ ...current, milestones: current.milestones.map(item => item.ref === ref ? { ...item, ...patch } : item) }))
  const editDeliverable = (ref: string, patch: Partial<Included<PlanDeliverable>>) => setPlan(current => ({ ...current, deliverables: current.deliverables.map(item => item.ref === ref ? { ...item, ...patch } : item) }))
  const editTask = (ref: string, patch: Partial<Included<PlanTask>>) => setPlan(current => ({ ...current, tasks: current.tasks.map(item => item.ref === ref ? { ...item, ...patch } : item) }))

  function buildPlan(): Plan {
    const kept = new Set(plan?.milestones.filter(item => item.include).map(item => item.ref) ?? [])
    const strip = <T extends { include: boolean }>({ include: _include, ...rest }: T) => rest
    const inPlan = (item: { include: boolean; milestoneRef?: string }) => item.include && (!item.milestoneRef || kept.has(item.milestoneRef))
    return {
      milestones: (plan?.milestones ?? []).filter(item => item.include).map(item => ({ ...strip(item), name: item.name.trim() })),
      deliverables: [...(plan?.deliverables ?? []).filter(inPlan).map(item => ({ ...strip(item), title: item.title.trim() })),
        ...suggestions.filter(item => item.include).map(item => ({ title: item.title.trim(), clientServiceId: item.clientServiceId, priority: 'medium' as const, ...(item.milestoneRef && kept.has(item.milestoneRef) ? { milestoneRef: item.milestoneRef } : {}) }))],
      tasks: (plan?.tasks ?? []).filter(inPlan).map(item => ({ ...strip(item), title: item.title.trim() })),
    }
  }
  async function submit() {
    setError('')
    if (!setup) return setError('Choose a client.')
    if (!name.trim()) return setError('Give the project a name.')
    if (startDate && targetDate && targetDate < startDate) return setError('The target completion date is before the start date.')
    if (agreedValue.trim() && !(Number(agreedValue.replace(/,/g, '')) >= 0)) return setError('Enter the agreed value as an amount, or leave it empty.')
    const built = buildPlan()
    if ([...built.milestones.map(item => item.name), ...built.deliverables.map(item => item.title), ...built.tasks.map(item => item.title)].some(text => !text)) return setError('Every milestone, deliverable and task in the plan needs a name.')
    setBusy(true)
    try {
      const result = await createProject(workspace.id, {
        clientId: setup.client.id, source, completionId: source === 'onboarding' ? setup.completion?.id ?? null : null, templateId: templateId || null,
        name: name.trim(), description: description.trim(), projectType, priority, ownerId: ownerId || null, startDate: startDate || null, targetDate: targetDate || null,
        agreedValue: agreedValue.trim() ? agreedValue.trim().replace(/,/g, '') : null, currency: currency.trim().toUpperCase() || 'USD',
        tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), brief: Object.fromEntries(Object.entries(brief).map(([key, value]) => [key, (value ?? '').trim()]).filter(([, value]) => value)) as Brief,
        serviceIds, contactIds,
        briefSources: source === 'manual' ? {} : { source, completionId: setup.completion?.id ?? null, serviceIds: setup.services.map(service => service.id), requirementIds: setup.requirements.map(requirement => requirement.id) },
        plan: built }, requestId.current)
      onCreated({ id: result.id, workspaceChanged: result.workspaceChanged }, name.trim())
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }

  return <Modal id="new-project" title="New project" onClose={onClose}>
    <form className="sp-form pf-new" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label>Client *<select required value={clientId} disabled={!!start.clientId} onChange={event => setClientId(event.target.value)}>
        <option value="">Choose a client…</option>{usable.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select>
        {!usable.length && <small>Add a client first: convert a won deal or add one under Clients.</small>}</label>
      {setupError && <p className="sp-error" role="alert">{setupError}</p>}
      {clientId && !setup && !setupError && <p className="sp-loading" role="status">Loading what was agreed with this client…</p>}
      {setup && <>
        <div className="sp-segment" role="group" aria-label="Start from">
          <button type="button" aria-pressed={!manual} onClick={() => setManualMode(false)}>{setup.source === 'onboarding' ? 'The completed onboarding' : 'The confirmed scope'}</button>
          <button type="button" aria-pressed={manual} onClick={() => setManualMode(true)}>Start blank</button>
        </div>
        <p className="pf-source">{manual ? 'A blank project for this client: nothing is copied from onboarding.'
          : setup.source === 'onboarding' ? <>From the onboarding completed on {shortDate(setup.completion!.completedAt)}: the services, scope and requirements agreed then.{setup.completion?.overrideReason ? ' Onboarding was completed with items outstanding.' : ''}</>
          : 'From the client’s currently confirmed services and requirements. Onboarding isn’t completed yet.'}
          {' '}Only confirmed services and requirements are used. Drafts and items under review stay out until they’re confirmed.</p>
        {setup.existingProjects.length > 0 && <p className="sp-caution" role="note">{setup.client.name} already has {setup.existingProjects.length} project{setup.existingProjects.length === 1 ? '' : 's'}: {setup.existingProjects.map(item => item.name).join(', ')}. A new project is separate, with its own scope, plan and tasks.</p>}

        <h3>Project</h3>
        <label>Project name *<input required maxLength={150} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Description<textarea rows={2} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} /></label>
        <div className="sp-row sp-row-3">
          <label>Type<select value={projectType} onChange={event => { setProjectType(event.target.value as ProjectType); setTypeTouched(true) }}>{projectTypes.map(type => <option key={type} value={type}>{projectTypeLabels[type]}</option>)}</select></label>
          <label>Priority<select value={priority} onChange={event => setPriority(event.target.value as ProjectPriority)}>{projectPriorities.map(item => <option key={item} value={item}>{projectPriorityLabels[item]}</option>)}</select></label>
          <label>Owner<select value={ownerId} onChange={event => setOwnerId(event.target.value)}><option value="">Me</option>{people.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        </div>
        <div className="sp-row sp-row-3">
          <label>Start date<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
          <label>Target completion<input type="date" value={targetDate} min={startDate || undefined} onChange={event => setTargetDate(event.target.value)} /></label>
          <label>Tags<input maxLength={300} value={tags} placeholder="e.g. retainer, phase 1" onChange={event => setTags(event.target.value)} /><small>Separate with commas.</small></label>
        </div>
        <div className="sp-row">
          <label>Agreed value for this project<input inputMode="decimal" value={agreedValue} placeholder="Optional" onChange={event => setAgreedValue(event.target.value)} />
            <small>What the client agreed to pay for this project. It isn’t taken from the deal{setup.deal ? `; the deal “${setup.deal.title}” was worth ${money(setup.deal.wonValue ?? setup.deal.value, setup.deal.currency)} in total` : ''}.</small></label>
          <label>Currency<input maxLength={3} value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())} /></label>
        </div>

        {(setup.services.length > 0 || setup.contacts.length > 0) && <div className="pf-links">
          {setup.services.length > 0 && <fieldset><legend>Services this project delivers</legend>{setup.services.map(service => <label key={service.id} className="cl-check-label">
            <input type="checkbox" disabled={!service.current} checked={serviceIds.includes(service.id)} onChange={event => setServiceIds(list => toggle(list, service.id, event.target.checked))} />
            {service.name}{!service.current && <small> (no longer a confirmed service)</small>}</label>)}</fieldset>}
          {setup.contacts.length > 0 && <fieldset><legend>Client contacts</legend>{setup.contacts.map(contact => <label key={contact.id} className="cl-check-label">
            <input type="checkbox" checked={contactIds.includes(contact.id)} onChange={event => setContactIds(list => toggle(list, contact.id, event.target.checked))} />
            {contact.fullName}{contact.isPrimary && <small> (primary)</small>}</label>)}</fieldset>}
        </div>}

        <h3>Brief</h3>
        <p className="sp-muted">{manual ? 'Write the brief for this project.' : 'Prefilled from the confirmed scope only. Edit it to fit this project; it’s your team’s working brief, not something the client signs.'}</p>
        <div className="pf-brief">{briefFields.map(field => <label key={field} className={field === 'scopeSummary' ? 'is-wide' : ''}>{briefLabels[field]}
          <textarea rows={field === 'scopeSummary' ? 5 : 3} maxLength={field === 'scopeSummary' ? 8000 : 4000} value={brief[field] ?? ''} onChange={event => setBrief(current => ({ ...current, [field]: event.target.value }))} /></label>)}</div>

        {(setup.documents.length > 0 || setup.dates.length > 0) && <details className="pf-reference"><summary>From the client: {setup.documents.length} file{setup.documents.length === 1 ? '' : 's'} and {setup.dates.length} important date{setup.dates.length === 1 ? '' : 's'}</summary>
          {setup.documents.length > 0 && <><p className="pf-label">Files (stay with the client; the project’s Files tab lists them)</p><ul>{setup.documents.map(document => <li key={document.id}>{document.fileName} <small>{documentCategoryLabels[document.category]} · {formatBytes(document.size)}{document.uploaderType === 'client' ? ' · from the client' : ''}</small></li>)}</ul></>}
          {setup.dates.length > 0 && <><p className="pf-label">Important dates</p><ul>{setup.dates.map((item, index) => <li key={index}>{item.label}: {shortDate(item.date)}</li>)}</ul></>}
        </details>}

        <h3>Plan</h3>
        <label>Start from a template<select value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="">No template: plan it later</option>
          {templates.map(template => <option key={template.id} value={template.id}>{template.name} · {template.milestoneCount} milestones</option>)}</select>
          <small>Dates are counted from the start date; changing the start date recalculates them. Untick anything you don’t need; you can change everything later.</small></label>
        {planState === 'loading' && <p className="sp-loading" role="status">Preparing the plan…</p>}
        {planState === 'error' && <p className="sp-error" role="alert">The template couldn’t be loaded. Choose it again, or continue without one.</p>}
        {plan && <ol className="pf-plan">{plan.milestones.map(milestone => {
          const deliverables = plan.deliverables.filter(item => item.milestoneRef === milestone.ref), tasks = plan.tasks.filter(item => item.milestoneRef === milestone.ref), open = openMilestones.includes(milestone.ref)
          return <li key={milestone.ref} className={milestone.include ? '' : 'is-off'}>
            <div className="pf-plan-row">
              <input type="checkbox" aria-label={`Include ${milestone.name}`} checked={milestone.include} onChange={event => editMilestone(milestone.ref, { include: event.target.checked })} />
              <input aria-label="Milestone name" className="pf-plan-name" maxLength={150} value={milestone.name} disabled={!milestone.include} onChange={event => editMilestone(milestone.ref, { name: event.target.value })} />
              <input aria-label={`Start of ${milestone.name}`} type="date" value={milestone.startDate ?? ''} disabled={!milestone.include} onChange={event => editMilestone(milestone.ref, { startDate: event.target.value || null })} />
              <input aria-label={`Due date of ${milestone.name}`} type="date" value={milestone.dueDate ?? ''} disabled={!milestone.include} onChange={event => editMilestone(milestone.ref, { dueDate: event.target.value || null })} />
              <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpenMilestones(list => toggle(list, milestone.ref, !open))}>{deliverables.length} deliverable{deliverables.length === 1 ? '' : 's'}, {tasks.length} task{tasks.length === 1 ? '' : 's'}</button>
            </div>
            {open && <ul className="pf-plan-items">
              {deliverables.map(item => <li key={item.ref}><input type="checkbox" aria-label={`Include deliverable ${item.title}`} checked={item.include} disabled={!milestone.include} onChange={event => editDeliverable(item.ref!, { include: event.target.checked })} />
                <span className="pf-kind">Deliverable</span><input aria-label="Deliverable title" maxLength={200} value={item.title} disabled={!milestone.include || !item.include} onChange={event => editDeliverable(item.ref!, { title: event.target.value })} />
                <input aria-label={`Due date of ${item.title}`} type="date" value={item.dueDate ?? ''} disabled={!milestone.include || !item.include} onChange={event => editDeliverable(item.ref!, { dueDate: event.target.value || null })} /></li>)}
              {tasks.map(item => <li key={item.ref}><input type="checkbox" aria-label={`Include task ${item.title}`} checked={item.include} disabled={!milestone.include} onChange={event => editTask(item.ref!, { include: event.target.checked })} />
                <span className="pf-kind">Task</span><input aria-label="Task title" maxLength={2000} value={item.title} disabled={!milestone.include || !item.include} onChange={event => editTask(item.ref!, { title: event.target.value })} />
                <input aria-label={`Due date of ${item.title}`} type="date" value={item.dueDate ?? ''} disabled={!milestone.include || !item.include} onChange={event => editTask(item.ref!, { dueDate: event.target.value || null })} /></li>)}
            </ul>}
          </li>
        })}</ol>}
        {suggestions.length > 0 && !manual && <fieldset className="pf-suggestions"><legend>Deliverables named in the confirmed services</legend>
          <p className="sp-muted">Suggestions only: tick the ones that belong to this project.</p>
          {suggestions.map(item => <div key={item.key} className="pf-suggestion">
            <label className="cl-check-label"><input type="checkbox" checked={item.include} onChange={event => setSuggestions(list => list.map(entry => entry.key === item.key ? { ...entry, include: event.target.checked } : entry))} />
              {item.title} <small>({item.service})</small></label>
            {item.include && plan && <select aria-label={`Milestone for ${item.title}`} value={item.milestoneRef} onChange={event => setSuggestions(list => list.map(entry => entry.key === item.key ? { ...entry, milestoneRef: event.target.value } : entry))}>
              <option value="">No milestone</option>{plan.milestones.filter(milestone => milestone.include).map(milestone => <option key={milestone.ref} value={milestone.ref}>{milestone.name}</option>)}</select>}
          </div>)}</fieldset>}
        <p className="pf-summary-line" role="status">Creates the project{counts.milestones + counts.deliverables + counts.tasks > 0 ? ` with ${counts.milestones} milestone${counts.milestones === 1 ? '' : 's'}, ${counts.deliverables} deliverable${counts.deliverables === 1 ? '' : 's'} and ${counts.tasks} task${counts.tasks === 1 ? '' : 's'}` : ' with no plan yet'}. Nothing is sent to the client.</p>
      </>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !setup}>{busy ? 'Creating…' : 'Create project'}</button></div>
    </form>
  </Modal>
}
