import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { errorText, shortDate } from '../lib/sales'
import {
  conflict, loadTemplate, loadTemplates, projectTypeLabels, projectTypes, saveTemplate, setTemplateArchived,
  type ProjectTemplate, type ProjectType, type TemplateMilestone, type TemplateSummary,
} from '../lib/projects'

const blankMilestone = (offset = 0): TemplateMilestone => ({ name: '', description: '', startOffsetDays: offset, durationDays: 7, deliverables: [], tasks: [] })
const weeks = (days: number) => days >= 14 ? `${Math.round(days / 7)} weeks` : `${days} day${days === 1 ? '' : 's'}`

/**
 * Reusable project plans: milestones with their usual deliverables and tasks, as days from the project start. Owners and
 * admins edit them; everyone can use them when creating a project. Editing a template never changes existing projects.
 */
export function ProjectTemplates({ workspace, onChanged }: { workspace: WorkspaceSummary; onChanged: (message: string) => void }) {
  const [state, setState] = useState<{ canEdit: boolean; templates: TemplateSummary[] } | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const [showArchived, setShowArchived] = useState(false), [viewing, setViewing] = useState<string | null>(null), [editing, setEditing] = useState<ProjectTemplate | 'new' | null>(null), [busy, setBusy] = useState('')
  useEffect(() => {
    let active = true
    loadTemplates(workspace.id).then(value => { if (active) { setState(value); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, attempt])
  async function archive(template: TemplateSummary) {
    setBusy(template.id); setError('')
    try { await setTemplateArchived(workspace.id, template.id, !template.archived); onChanged(template.archived ? `${template.name} restored.` : `${template.name} archived.`); setAttempt(value => value + 1) }
    catch (cause) { setError(errorText(cause)) } finally { setBusy('') }
  }
  async function edit(id: string) {
    setBusy(id); setError('')
    try { setEditing(await loadTemplate(workspace.id, id)) } catch (cause) { setError(errorText(cause)) } finally { setBusy('') }
  }
  if (!state) return <section className="panel pf-panel">{error ? <p className="sp-error sp-inset" role="alert">{error}</p> : <p className="sp-loading" role="status">Loading templates…</p>}</section>
  const list = state.templates.filter(template => showArchived || !template.archived), archived = state.templates.filter(template => template.archived).length
  return <section className="panel pf-panel">
    <div className="section-heading sp-heading"><div><h2>Project templates</h2><p>Milestones, deliverables and tasks you reuse. Dates are days from the project’s start; you review and adjust everything when creating a project.</p></div>
      {state.canEdit && <div className="sp-heading-actions"><button className="primary" onClick={() => setEditing('new')}><Icon name="plus" size={17} /> New template</button></div>}</div>
    {!state.canEdit && <p className="sp-caution pf-inset">Only owners and admins can edit templates. You can view them and use them for new projects. To reuse a project’s plan, ask an owner or admin to save it as a template.</p>}
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {!list.length ? <div className="empty"><p>No templates{archived ? ' (some are archived)' : ''}.</p></div>
      : <ul className="pf-templates">{list.map(template => <li key={template.id} className={template.archived ? 'is-archived' : ''}>
        <div className="pf-template-main">
          <strong>{template.name}</strong>{template.starterKey && <span className="sp-chip">Starter</span>}{template.archived && <span className="sp-chip">Archived</span>}
          <p className="sp-muted">{projectTypeLabels[template.projectType]} · {template.milestoneCount} milestones · {template.deliverableCount} deliverables · {template.taskCount} tasks · about {weeks(template.durationDays)}</p>
          {template.description && <p>{template.description}</p>}
          <small className="sp-muted">Used by {template.projects} project{template.projects === 1 ? '' : 's'} · updated {shortDate(template.updatedAt)}</small>
        </div>
        <div className="sp-actions">
          <button className="text-button" onClick={() => setViewing(template.id)}>View</button>
          {state.canEdit && !template.archived && <button className="text-button" disabled={busy === template.id} onClick={() => void edit(template.id)}>Edit</button>}
          {state.canEdit && <button className="text-button" disabled={busy === template.id} onClick={() => void archive(template)}>{template.archived ? 'Restore' : 'Archive'}</button>}
        </div>
      </li>)}</ul>}
    {archived > 0 && <button className="text-button pf-toggle" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide' : 'Show'} {archived} archived template{archived === 1 ? '' : 's'}</button>}
    {viewing && <TemplateView workspace={workspace} id={viewing} onClose={() => setViewing(null)} />}
    {editing && <TemplateEditor workspace={workspace} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
      onSaved={message => { setEditing(null); setAttempt(value => value + 1); onChanged(message) }} />}
  </section>
}

function TemplateView({ workspace, id, onClose }: { workspace: WorkspaceSummary; id: string; onClose: () => void }) {
  const [template, setTemplate] = useState<ProjectTemplate | null>(null), [error, setError] = useState('')
  useEffect(() => { let active = true; loadTemplate(workspace.id, id).then(value => { if (active) setTemplate(value) }).catch(cause => { if (active) setError(errorText(cause)) }); return () => { active = false } }, [workspace.id, id])
  return <Modal id="project-template" title={template?.name ?? 'Template'} onClose={onClose}>
    {error ? <p className="sp-error" role="alert">{error}</p> : !template ? <p className="sp-muted" role="status">Loading…</p> : <>
      <p className="sp-intro">{projectTypeLabels[template.projectType]}{template.description ? ` · ${template.description}` : ''}</p>
      <ol className="pf-template-outline">{template.milestones.map((milestone, index) => <li key={milestone.id ?? index}>
        <p><strong>{milestone.name}</strong> <span className="sp-muted">day {milestone.startOffsetDays + 1} · {weeks(milestone.durationDays)}</span></p>
        {milestone.description && <p className="sp-muted">{milestone.description}</p>}
        {milestone.deliverables.length > 0 && <p><span className="pf-label">Deliverables</span> {milestone.deliverables.map(item => item.title).join(', ')}</p>}
        {milestone.tasks.length > 0 && <p><span className="pf-label">Tasks</span> {milestone.tasks.map(item => item.title).join(', ')}</p>}
      </li>)}</ol>
    </>}
  </Modal>
}

function TemplateEditor({ workspace, template, onClose, onSaved }: { workspace: WorkspaceSummary; template: ProjectTemplate | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [name, setName] = useState(template?.name ?? ''), [description, setDescription] = useState(template?.description ?? ''), [projectType, setProjectType] = useState<ProjectType>(template?.projectType ?? 'other')
  const [milestones, setMilestones] = useState<TemplateMilestone[]>(template?.milestones.map(item => ({ ...item, deliverables: [...item.deliverables], tasks: [...item.tasks] })) ?? [blankMilestone()])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false)
  const requestId = useRef(crypto.randomUUID())
  const update = (index: number, patch: Partial<TemplateMilestone>) => setMilestones(list => list.map((item, at) => at === index ? { ...item, ...patch } : item))
  const move = (index: number, by: number) => setMilestones(list => { const next = [...list]; const [item] = next.splice(index, 1); next.splice(index + by, 0, item); return next })
  async function save() {
    setError('')
    if (!name.trim()) return setError('Give the template a name.')
    if (!milestones.length) return setError('Add at least one milestone.')
    const problem = milestones.findIndex(item => !item.name.trim() || item.deliverables.some(d => !d.title.trim()) || item.tasks.some(t => !t.title.trim()))
    if (problem >= 0) return setError(`Milestone ${problem + 1}: give it, and each of its deliverables and tasks, a name.`)
    setBusy(true)
    try {
      await saveTemplate(workspace.id, { ...(template ? { id: template.id } : {}), name: name.trim(), description: description.trim(), projectType,
        milestones: milestones.map(item => ({ name: item.name.trim(), description: item.description.trim(), startOffsetDays: item.startOffsetDays, durationDays: item.durationDays,
          deliverables: item.deliverables.map(d => ({ title: d.title.trim(), description: d.description.trim() })), tasks: item.tasks.map(t => ({ title: t.title.trim(), durationDays: t.durationDays, priority: t.priority })) })) },
        template?.version ?? null, template ? null : requestId.current)
      onSaved(template ? `Template “${name.trim()}” saved.` : `Template “${name.trim()}” created.`)
    } catch (cause) { if (conflict(cause)) setStale(true); setError(conflict(cause) ? 'This template was changed in another session. Close this editor and open it again to see the latest version.' : errorText(cause)) }
    finally { setBusy(false) }
  }
  const last = milestones[milestones.length - 1]
  return <Modal id="project-template" title={template ? `Edit ${template.name}` : 'New project template'} onClose={onClose}>
    <form className="sp-form pf-template-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <p className="sp-intro">Editing a template doesn’t change projects already created from it.</p>
      <div className="sp-row"><label>Name *<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Project type<select value={projectType} onChange={event => setProjectType(event.target.value as ProjectType)}>{projectTypes.map(type => <option key={type} value={type}>{projectTypeLabels[type]}</option>)}</select></label></div>
      <label>Description<textarea rows={2} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <h3>Milestones</h3>
      <ol className="pf-template-edit">{milestones.map((milestone, index) => <li key={index}>
        <fieldset><legend>Milestone {index + 1}</legend>
          <div className="pf-template-row">
            <label>Name *<input required maxLength={150} value={milestone.name} onChange={event => update(index, { name: event.target.value })} /></label>
            <label>Starts on day<input type="number" min={1} max={3651} value={milestone.startOffsetDays + 1} onChange={event => update(index, { startOffsetDays: Math.max(0, Math.min(3650, Number(event.target.value || 1) - 1)) })} /></label>
            <label>Days<input type="number" min={1} max={3650} value={milestone.durationDays} onChange={event => update(index, { durationDays: Math.max(1, Math.min(3650, Number(event.target.value || 1))) })} /></label>
          </div>
          <label>Description<input maxLength={2000} value={milestone.description} onChange={event => update(index, { description: event.target.value })} /></label>
          <div className="pf-template-lists">
            <div><span className="pf-label">Deliverables</span>
              {milestone.deliverables.map((item, at) => <div className="pf-inline-row" key={at}>
                <input aria-label={`Deliverable ${at + 1} of milestone ${index + 1}`} maxLength={200} value={item.title} onChange={event => update(index, { deliverables: milestone.deliverables.map((d, i) => i === at ? { ...d, title: event.target.value } : d) })} />
                <button type="button" className="text-button" aria-label={`Remove deliverable ${at + 1}`} onClick={() => update(index, { deliverables: milestone.deliverables.filter((_, i) => i !== at) })}>Remove</button></div>)}
              {milestone.deliverables.length < 20 && <button type="button" className="text-button" onClick={() => update(index, { deliverables: [...milestone.deliverables, { title: '', description: '' }] })}>+ Deliverable</button>}
            </div>
            <div><span className="pf-label">Tasks</span>
              {milestone.tasks.map((item, at) => <div className="pf-inline-row" key={at}>
                <input aria-label={`Task ${at + 1} of milestone ${index + 1}`} maxLength={300} value={item.title} onChange={event => update(index, { tasks: milestone.tasks.map((t, i) => i === at ? { ...t, title: event.target.value } : t) })} />
                <input aria-label={`Days for task ${at + 1}`} className="pf-days" type="number" min={1} max={3650} value={item.durationDays} onChange={event => update(index, { tasks: milestone.tasks.map((t, i) => i === at ? { ...t, durationDays: Math.max(1, Number(event.target.value || 1)) } : t) })} />
                <select aria-label={`Priority of task ${at + 1}`} value={item.priority} onChange={event => update(index, { tasks: milestone.tasks.map((t, i) => i === at ? { ...t, priority: event.target.value as 'low' | 'medium' | 'high' } : t) })}>
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>
                <button type="button" className="text-button" aria-label={`Remove task ${at + 1}`} onClick={() => update(index, { tasks: milestone.tasks.filter((_, i) => i !== at) })}>Remove</button></div>)}
              {milestone.tasks.length < 30 && <button type="button" className="text-button" onClick={() => update(index, { tasks: [...milestone.tasks, { title: '', durationDays: 3, priority: 'medium' }] })}>+ Task</button>}
            </div>
          </div>
          <div className="sp-actions">
            <button type="button" className="text-button" disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
            <button type="button" className="text-button" disabled={index === milestones.length - 1} onClick={() => move(index, 1)}>Move down</button>
            <button type="button" className="text-button" disabled={milestones.length === 1} onClick={() => setMilestones(list => list.filter((_, at) => at !== index))}>Remove milestone</button>
          </div>
        </fieldset></li>)}</ol>
      {milestones.length < 30 && <button type="button" className="secondary" onClick={() => setMilestones(list => [...list, blankMilestone(last ? last.startOffsetDays + last.durationDays : 0)])}>+ Add milestone</button>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || stale}>{busy ? 'Saving…' : 'Save template'}</button></div>
    </form>
  </Modal>
}
