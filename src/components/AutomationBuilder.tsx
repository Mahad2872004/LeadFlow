import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import {
  advanceNow, assigneeLabels, countConditions, exampleData, formatInputs, withExamples, defaultInputs, describeGroup, dryRun, duplicateStep, emptyDefinition, emptyGroup, errorText, fieldsAt, findStep, humanize, isGroup, issuesFor,
  issueWebhookSecret, moveStep, newStep, revokeWebhook, operatorLabels, parentOf, publishWorkflow, recipientLabels, removeStep, replaceStep, restoreVersion, sampleFor, saveWorkflow, setWorkflowStatus,
  startLiveTest, statusLabels, stepSummary, updateList, validateDefinition, valueless, workflowDetail,
  type ActionDef, type ActionInput, type ActionStep, type BranchStep, type CenterData, type Condition, type Definition, type DryRun, type Due, type Field, type Group, type IssuedWebhook,
  type Sample, type Step, type StepType, type Validation, type WebhookField, type WorkflowDetail,
} from '../lib/automation'

interface Initial { name: string; description: string; definition: Definition }
const stepIcons: Record<StepType | 'trigger', string> = { trigger: '⚡', condition: '?', action: '▶', delay: '⏱', wait: '⏸', branch: '⑂' }
const stepTypeLabels: Record<StepType, string> = { action: 'Action', condition: 'Condition', delay: 'Delay', wait: 'Wait for event', branch: 'Branch' }
const addOptions: [StepType, string, string][] = [['action', 'Action', 'Create, notify, start or update something'], ['condition', 'Condition', 'Continue only when conditions match'],
  ['branch', 'Branch', 'Different steps for different cases'], ['delay', 'Delay', 'Wait minutes, hours or days'], ['wait', 'Wait for event', 'Pause until something happens to a record']]
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The visual workflow builder. A workflow reads top to bottom: its trigger, then steps; a branch splits into paths that
 * each continue with the steps after it. Editing changes only the draft: the published version (and every run in
 * progress) stays as it was until a person publishes again. Validation, dry runs and publishing happen on the server.
 */
export function AutomationBuilder({ workspace, center, workflowId, initial, onClose, onNotice, onOpenRun }: {
  workspace: WorkspaceSummary; center: CenterData; workflowId: string | null; initial?: Initial
  onClose: (changed: boolean) => void; onNotice: (message: string) => void; onOpenRun: (runId: string) => void
}) {
  const { catalog } = center
  const manager = center.role !== 'member'
  const [id, setId] = useState(workflowId)
  const [detail, setDetail] = useState<WorkflowDetail | null>(null)
  const [name, setName] = useState(initial?.name ?? 'Untitled workflow'), [description, setDescription] = useState(initial?.description ?? '')
  const [definition, setDefinition] = useState<Definition>(initial?.definition ?? emptyDefinition())
  const [selected, setSelected] = useState<string>('trigger')
  const [validation, setValidation] = useState<Validation | null>(null)
  const [dirty, setDirty] = useState(!workflowId), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(!!workflowId)
  const [dialog, setDialog] = useState<'test' | 'publish' | 'versions' | 'leave' | 'webhook' | null>(null)
  const [changed, setChanged] = useState(false)

  useEffect(() => {
    if (!workflowId) return
    let active = true
    workflowDetail(workspace.id, workflowId).then(result => {
      if (!active) return
      setDetail(result); setName(result.name); setDescription(result.description); setDefinition(result.definition); setValidation(result.validation); setLoading(false)
    }).catch(cause => { if (active) { setError(errorText(cause)); setLoading(false) } })
    return () => { active = false }
  }, [workspace.id, workflowId])
  // The server is the judge: every edit is checked against the registry shortly after it is made.
  useEffect(() => {
    if (loading) return
    let active = true
    const timer = window.setTimeout(() => { validateDefinition(workspace.id, definition).then(result => { if (active) setValidation(result) }).catch(() => {}) }, 450)
    return () => { active = false; window.clearTimeout(timer) }
  }, [workspace.id, definition, loading])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const edit = (next: Definition) => { setDefinition(next); setDirty(true) }
  const selectedStep = selected === 'trigger' ? null : findStep(definition, selected)
  const reload = async (workflow: string) => { const result = await workflowDetail(workspace.id, workflow); setDetail(result); setValidation(result.validation); return result }

  async function save(): Promise<string | null> {
    setBusy(true); setError('')
    try {
      const result = await saveWorkflow(workspace.id, id, name, description, definition, detail?.version ?? null)
      setId(result.id); setValidation(result.validation); setDirty(false); setChanged(true)
      await reload(result.id)
      onNotice('Draft saved. The published version is unchanged until you publish.')
      return result.id
    } catch (cause) { setError(errorText(cause)); return null } finally { setBusy(false) }
  }
  async function changeStatus(status: 'active' | 'paused') {
    if (!id) return
    setBusy(true); setError('')
    try { await setWorkflowStatus(workspace.id, id, status); await reload(id); setChanged(true); onNotice(status === 'active' ? 'Workflow activated.' : 'Workflow paused. Queued runs wait until it is active again.') }
    catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const leave = () => dirty ? setDialog('leave') : onClose(changed)

  const insert = (parent: string, index: number, type: StepType) => {
    const step = newStep(type, definition, catalog)
    edit(updateList(definition, parent, steps => { const next = [...steps]; next.splice(index, 0, step); return next }))
    setSelected(step.id)
  }
  const issuesCount = validation?.issues.length ?? 0
  const canvas = useRef<HTMLElement>(null)
  useEffect(() => { const element = canvas.current; if (element && element.scrollWidth > element.clientWidth) element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2 }, [loading])
  const triggerDef = catalog.triggers.find(t => t.type === definition.trigger.type)

  if (loading) return <section className="panel au-panel"><p className="au-muted" role="status">Loading workflow…</p></section>
  return <div className="au-builder">
    <header className="au-builder-head panel">
      <button className="secondary au-back" onClick={leave}><Icon name="chevron" size={16} /> Workflows</button>
      <div className="au-title">
        <label className="sr-only" htmlFor="au-name">Workflow name</label>
        <input id="au-name" className="au-name" value={name} maxLength={120} disabled={!manager} onChange={event => { setName(event.target.value); setDirty(true) }} />
        <div className="au-title-meta">
          <span className={`au-status au-status-${detail?.status ?? 'draft'}`}>{statusLabels[detail?.status ?? 'draft']}</span>
          {detail?.publishedVersion ? <span>Published version {detail.publishedVersion}{detail.draftChanged || dirty ? ' · draft has unpublished changes' : ''}</span> : <span>Not published yet</span>}
          {dirty && <span className="au-unsaved">Unsaved changes</span>}
          <span className={issuesCount ? 'au-issues-count' : 'au-valid'}>{validation ? issuesCount ? `${issuesCount} issue${issuesCount === 1 ? '' : 's'} to fix` : 'Valid' : 'Checking…'}</span>
        </div>
      </div>
      <div className="au-head-actions">
        {detail && detail.versions.length > 0 && <button className="secondary" onClick={() => setDialog('versions')}><Icon name="history" size={16} /> Versions</button>}
        <button className="secondary" onClick={() => setDialog('test')}><Icon name="check" size={16} /> Test</button>
        {manager && <button className="secondary" disabled={busy || (!dirty && !!id)} onClick={() => void save()}>Save draft</button>}
        {manager && detail?.status === 'active' && <button className="secondary" disabled={busy} onClick={() => void changeStatus('paused')}>Pause</button>}
        {manager && detail?.status === 'paused' && <button className="secondary" disabled={busy} onClick={() => void changeStatus('active')}>Activate</button>}
        {manager && <button className="primary" disabled={busy} onClick={() => setDialog('publish')}>Publish</button>}
      </div>
      {!manager && <p className="au-note">Owners and admins edit and publish workflows. You can explore it and run a dry test.</p>}
      {error && <p className="au-error" role="alert">{error}</p>}
      {detail?.attention && <p className="au-warning" role="status"><strong>Needs attention:</strong> {detail.attention.message}</p>}
    </header>
    <div className="au-builder-body">
      <section className="au-canvas" aria-label="Workflow steps" ref={canvas}>
        <div className="au-flow">
          <NodeCard icon={stepIcons.trigger} kind="Trigger" title={triggerDef?.label ?? 'Choose a trigger'} active={selected === 'trigger'} issues={issuesFor(validation, 'trigger').length}
            summary={triggerDef ? `${triggerDef.description}${definition.trigger.filter && countConditions(definition.trigger.filter) ? ` · Only when ${describeGroup(definition.trigger.filter, triggerDef.fields)}` : ''}` : 'What starts this workflow'}
            onSelect={() => setSelected('trigger')} />
          <StepList parent="root" steps={definition.steps} definition={definition} center={center} selected={selected} validation={validation} manager={manager}
            onSelect={setSelected} onInsert={insert} />
          <div className="au-end" aria-hidden="true">End</div>
        </div>
      </section>
      <aside className="au-config panel" aria-label="Step settings">
        {selected === 'trigger'
          ? <TriggerPanel center={center} definition={definition} validation={validation} manager={manager} workflowId={id} detail={detail}
            onChange={edit} onWebhook={() => setDialog('webhook')} />
          : selectedStep
            ? <StepPanel key={selectedStep.id} step={selectedStep} definition={definition} center={center} validation={validation} manager={manager}
              onChange={step => edit(replaceStep(definition, selectedStep.id, step))}
              onMove={offset => edit(moveStep(definition, selectedStep.id, offset))}
              onDuplicate={() => { const result = duplicateStep(definition, selectedStep.id); edit(result.definition); if (result.id) setSelected(result.id) }}
              onRemove={() => { const parent = parentOf(definition, selectedStep.id); edit(removeStep(definition, selectedStep.id)); setSelected(parent === 'root' || !parent ? 'trigger' : parent.split(':')[0]) }} />
            : <p className="au-muted">Choose a step to configure it.</p>}
        {selected === 'trigger' && <div className="au-about">
          <label>Description<textarea rows={2} maxLength={1000} disabled={!manager} value={description} onChange={event => { setDescription(event.target.value); setDirty(true) }} placeholder="What this workflow is for (optional)" /></label>
        </div>}
        {validation && validation.issues.some(issue => !issue.node || !findStep(definition, issue.node) && issue.node !== 'trigger') && <div className="au-issues">
          <h4>Workflow</h4><ul>{validation.issues.filter(issue => !issue.node || (!findStep(definition, issue.node) && issue.node !== 'trigger')).map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div>}
      </aside>
    </div>
    {dialog === 'test' && <TestDialog workspace={workspace} center={center} definition={definition} workflowId={id} dirty={dirty} valid={!!validation?.valid} manager={manager}
      onClose={() => setDialog(null)} onOpenRun={run => { setDialog(null); onOpenRun(run) }} />}
    {dialog === 'publish' && <PublishDialog center={center} definition={definition} validation={validation} detail={detail} dirty={dirty} busy={busy} onClose={() => setDialog(null)}
      onPublish={async note => {
        let workflow = id
        if (dirty || !workflow) workflow = await save()
        if (!workflow) return
        setBusy(true); setError('')
        try {
          const current = await workflowDetail(workspace.id, workflow)
          const published = await publishWorkflow(workspace.id, workflow, current.version, note)
          await reload(workflow); setChanged(true); setDialog(null)
          onNotice(`Version ${published.publishedVersion} published and active. Runs already in progress keep their version.`)
        } catch (cause) { setError(errorText(cause)); setDialog(null) } finally { setBusy(false) }
      }} />}
    {dialog === 'versions' && detail && <Modal title="Version history" onClose={() => setDialog(null)}>
      <p className="au-muted">Each published version is kept unchanged. Restoring copies it into the draft; nothing changes for runs until you publish.</p>
      <ul className="au-versions">{detail.versions.map(version => <li key={version.number}>
        <div><strong>Version {version.number}</strong>{version.current && <span className="au-pill au-pill-success">Live</span>}<small>{new Date(version.publishedAt).toLocaleString()} · {version.publishedBy}{version.note ? ` · ${version.note}` : ''}</small></div>
        {manager && <button className="secondary" disabled={busy} onClick={async () => {
          setBusy(true)
          try { const restored = await restoreVersion(workspace.id, detail.id, version.number); setDefinition(restored.definition); setValidation(restored.validation); await reload(detail.id); setDirty(false); setChanged(true); setDialog(null); onNotice(`Version ${version.number} copied into the draft. Publish it to make it live.`) }
          catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
        }}>Restore to draft</button>}
      </li>)}</ul>
    </Modal>}
    {dialog === 'leave' && <Modal title="Leave without saving?" onClose={() => setDialog(null)}>
      <p>Your changes to this draft haven’t been saved. The published version isn’t affected either way.</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setDialog(null)}>Keep editing</button><button className="primary danger" onClick={() => onClose(changed)}>Discard changes</button></div>
    </Modal>}
    {dialog === 'webhook' && id && <WebhookDialog workspace={workspace} workflowId={id} existing={detail?.webhook ?? null} onClose={() => setDialog(null)} onChanged={() => { void reload(id); setChanged(true) }} />}
  </div>
}

// ---------- Canvas ----------

function NodeCard({ icon, kind, title, summary, active, issues, side, onSelect, children }: { icon: string; kind: string; title: string; summary: string; active: boolean; issues: number
  side?: 'consequential' | 'ai' | null; onSelect: () => void; children?: ReactNode }) {
  return <div className={`au-node${active ? ' active' : ''}${issues ? ' invalid' : ''}`}>
    <button className="au-node-button" onClick={onSelect} aria-pressed={active}>
      <span className="au-node-icon" aria-hidden="true">{icon}</span>
      <span className="au-node-text">
        <small>{kind}{side === 'consequential' && <span className="au-pill au-pill-warning">Consequential</span>}{side === 'ai' && <span className="au-pill au-pill-ai">AI</span>}</small>
        <strong>{title}</strong>
        <span>{summary}</span>
      </span>
      {issues > 0 && <span className="au-node-issues" aria-label={`${issues} issue${issues === 1 ? '' : 's'}`}>{issues}</span>}
    </button>
    {children}
  </div>
}

function AddStep({ onAdd, disabled }: { onAdd: (type: StepType) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return <div className="au-connector" ref={ref}>
    <span className="au-line" aria-hidden="true" />
    {!disabled && <button className="au-add" aria-label="Add a step here" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="plus" size={14} /></button>}
    {open && <div className="au-add-menu" role="menu" onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
      {addOptions.map(([type, label, help]) => <button key={type} role="menuitem" onClick={() => { setOpen(false); onAdd(type) }}>
        <span aria-hidden="true">{stepIcons[type]}</span><span><strong>{label}</strong><small>{help}</small></span></button>)}
    </div>}
  </div>
}

function StepList({ parent, steps, definition, center, selected, validation, manager, onSelect, onInsert }: {
  parent: string; steps: Step[]; definition: Definition; center: CenterData; selected: string; validation: Validation | null; manager: boolean
  onSelect: (id: string) => void; onInsert: (parent: string, index: number, type: StepType) => void
}) {
  const { catalog, lookups } = center
  return <>
    <AddStep disabled={!manager} onAdd={type => onInsert(parent, 0, type)} />
    {steps.map((step, index) => {
      const action = step.type === 'action' ? catalog.actions.find(a => a.type === step.action) : null
      const title = step.label || (step.type === 'action' ? action?.label ?? 'Choose an action' : stepTypeLabels[step.type])
      const card = <NodeCard icon={stepIcons[step.type]} kind={step.type === 'action' && action ? action.group : stepTypeLabels[step.type]} title={title}
        summary={stepSummary(step, catalog, definition, lookups)} active={selected === step.id} issues={issuesFor(validation, step.id).length}
        side={action?.side === 'consequential' ? 'consequential' : action?.ai ? 'ai' : null} onSelect={() => onSelect(step.id)}>
        {step.type === 'branch' && <BranchPaths branch={step} definition={definition} center={center} selected={selected} validation={validation} manager={manager} onSelect={onSelect} onInsert={onInsert} />}
      </NodeCard>
      return <Fragment key={step.id}>{card}<AddStep disabled={!manager} onAdd={type => onInsert(parent, index + 1, type)} /></Fragment>
    })}
  </>
}

function BranchPaths({ branch, definition, center, selected, validation, manager, onSelect, onInsert }: {
  branch: BranchStep; definition: Definition; center: CenterData; selected: string; validation: Validation | null; manager: boolean
  onSelect: (id: string) => void; onInsert: (parent: string, index: number, type: StepType) => void
}) {
  const fields = fieldsAt(center.catalog, definition, branch.id)
  return <div className="au-paths">
    {[...branch.cases.map(c => ({ key: c.id, label: c.label, condition: describeGroup(c.when, fields), steps: c.steps })), { key: 'otherwise', label: 'Otherwise', condition: 'Everything else', steps: branch.otherwise.steps }]
      .map(path => <div className={`au-path${path.key === 'otherwise' ? ' au-otherwise' : ''}`} key={path.key}>
        <div className="au-path-head"><strong>{path.label}</strong><small>{path.condition}</small></div>
        <StepList parent={`${branch.id}:${path.key}`} steps={path.steps} definition={definition} center={center} selected={selected} validation={validation} manager={manager} onSelect={onSelect} onInsert={onInsert} />
      </div>)}
  </div>
}

// ---------- Panels ----------

function Issues({ validation, node }: { validation: Validation | null; node: string }) {
  const issues = issuesFor(validation, node)
  if (!issues.length) return null
  return <div className="au-issues" role="alert"><h4>To fix</h4><ul>{issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div>
}

function TriggerPanel({ center, definition, validation, manager, workflowId, detail, onChange, onWebhook }: {
  center: CenterData; definition: Definition; validation: Validation | null; manager: boolean; workflowId: string | null; detail: WorkflowDetail | null
  onChange: (definition: Definition) => void; onWebhook: () => void
}) {
  const { catalog } = center
  const def = catalog.triggers.find(t => t.type === definition.trigger.type)
  const groups = [...new Set(catalog.triggers.map(t => t.group))]
  const config = definition.trigger.config ?? {}
  const setConfig = (patch: Record<string, unknown>) => onChange({ ...definition, trigger: { ...definition.trigger, config: { ...config, ...patch } } })
  const fields = fieldsAt(catalog, definition, 'trigger')
  const webhookFields = (config.fields as WebhookField[] | undefined) ?? []
  return <div className="au-panel-body">
    <p className="au-kicker">Trigger</p>
    <h3>{def?.label ?? 'Choose what starts this workflow'}</h3>
    <label>Starts when
      <select value={definition.trigger.type} disabled={!manager} onChange={event => {
        const next = catalog.triggers.find(t => t.type === event.target.value)
        onChange({ ...definition, trigger: { type: event.target.value, config: Object.fromEntries((next?.config ?? []).map(c => [c.key, c.default])), filter: null } })
      }}>
        <option value="">Choose a trigger…</option>
        {groups.map(group => <optgroup key={group} label={group}>{catalog.triggers.filter(t => t.group === group).map(t => <option key={t.type} value={t.type}>{t.label}</option>)}</optgroup>)}
      </select>
    </label>
    {def && <p className="au-help">{def.description}</p>}
    {def?.config?.map(c => <label key={c.key}>{c.label}<input type="number" min={c.min} max={c.max} disabled={!manager} value={Number(config[c.key] ?? c.default)}
      onChange={event => setConfig({ [c.key]: Number(event.target.value) })} /></label>)}
    {definition.trigger.type === 'schedule.time' && <fieldset className="au-fieldset"><legend>Schedule ({center.timezone})</legend>
      <label>How often<select disabled={!manager} value={String(config.frequency ?? '')} onChange={event => setConfig({ frequency: event.target.value })}>
        <option value="">Choose…</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option><option value="once">Once</option></select></label>
      <label>At<input type="time" disabled={!manager} value={String(config.time ?? '09:00')} onChange={event => setConfig({ time: event.target.value })} /></label>
      {config.frequency === 'weekly' && <label>On<select disabled={!manager} value={String(config.weekday ?? '1')} onChange={event => setConfig({ weekday: Number(event.target.value) })}>
        {weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
      {config.frequency === 'monthly' && <label>Day of the month<input type="number" min={1} max={28} disabled={!manager} value={Number(config.dayOfMonth ?? 1)} onChange={event => setConfig({ dayOfMonth: Number(event.target.value) })} /></label>}
      {config.frequency === 'once' && <label>Date<input type="date" disabled={!manager} value={String(config.date ?? '')} onChange={event => setConfig({ date: event.target.value })} /></label>}
      <p className="au-help">Times use the workspace’s time zone ({center.timezone}). Change it in Settings.</p>
    </fieldset>}
    {definition.trigger.type === 'webhook.received' && <fieldset className="au-fieldset"><legend>Data the sender may include</legend>
      <p className="au-help">Only these fields are accepted, each checked against its type. Up to 20.</p>
      {webhookFields.map((field, index) => <div className="au-row" key={index}>
        <input aria-label="Field key" placeholder="key" disabled={!manager} value={field.key} onChange={event => setConfig({ fields: webhookFields.map((f, i) => i === index ? { ...f, key: event.target.value } : f) })} />
        <select aria-label="Field type" disabled={!manager} value={field.type} onChange={event => setConfig({ fields: webhookFields.map((f, i) => i === index ? { ...f, type: event.target.value as WebhookField['type'] } : f) })}>
          <option value="text">Text</option><option value="number">Number</option><option value="boolean">True/false</option><option value="date">Date</option></select>
        <label className="au-check"><input type="checkbox" disabled={!manager} checked={!!field.required} onChange={event => setConfig({ fields: webhookFields.map((f, i) => i === index ? { ...f, required: event.target.checked } : f) })} />Required</label>
        {manager && <button className="text-button" aria-label="Remove field" onClick={() => setConfig({ fields: webhookFields.filter((_, i) => i !== index) })}>Remove</button>}
      </div>)}
      {manager && webhookFields.length < 20 && <button className="secondary" onClick={() => setConfig({ fields: [...webhookFields, { key: '', type: 'text' }] })}><Icon name="plus" size={14} /> Add field</button>}
      <div className="au-webhook-box">
        {detail?.webhook ? <p>Endpoint {detail.webhook.status === 'active' ? 'active' : 'revoked'} · key version {detail.webhook.version} · {detail.webhook.received} received, {detail.webhook.rejected} rejected
          {detail.webhook.lastReceivedAt ? ` · last ${new Date(detail.webhook.lastReceivedAt).toLocaleString()}` : ''}</p> : <p>No endpoint yet.</p>}
        {manager && <button className="secondary" disabled={!workflowId} onClick={onWebhook}>{detail?.webhook ? 'Manage endpoint' : 'Create endpoint'}</button>}
        {!workflowId && <p className="au-help">Save the draft first.</p>}
      </div>
    </fieldset>}
    {def && <fieldset className="au-fieldset"><legend>Only when (optional)</legend>
      <p className="au-help">Filter which events start a run. Events that don’t match start nothing and aren’t counted.</p>
      <GroupEditor group={definition.trigger.filter ?? emptyGroup()} fields={fields} operators={catalog.operators} disabled={!manager} depth={1}
        onChange={group => onChange({ ...definition, trigger: { ...definition.trigger, filter: group.conditions.length ? group : null } })} />
    </fieldset>}
    {def && <DataList title="Data from this trigger" fields={fields} />}
    <Issues validation={validation} node="trigger" />
  </div>
}

function StepPanel({ step, definition, center, validation, manager, onChange, onMove, onDuplicate, onRemove }: {
  step: Step; definition: Definition; center: CenterData; validation: Validation | null; manager: boolean
  onChange: (step: Step) => void; onMove: (offset: -1 | 1) => void; onDuplicate: () => void; onRemove: () => void
}) {
  const { catalog } = center
  const fields = fieldsAt(catalog, definition, step.id)
  const action = step.type === 'action' ? catalog.actions.find(a => a.type === step.action) : null
  return <div className="au-panel-body">
    <p className="au-kicker">{stepTypeLabels[step.type]}</p>
    <label>Step name<input value={step.label ?? ''} maxLength={120} disabled={!manager} placeholder={action?.label ?? stepTypeLabels[step.type]} onChange={event => onChange({ ...step, label: event.target.value })} /></label>
    {step.type === 'condition' && <>
      <p className="au-help">If these conditions aren’t met when the run gets here, it stops (recorded as “condition not met”).</p>
      <GroupEditor group={step.when} fields={fields} operators={catalog.operators} disabled={!manager} depth={1} onChange={when => onChange({ ...step, when })} />
    </>}
    {step.type === 'branch' && <>
      <p className="au-help">The run takes the first path whose conditions match, otherwise the Otherwise path. Each path continues with the steps after the branch.</p>
      {step.cases.map((c, index) => <fieldset className="au-fieldset" key={c.id}><legend>Path {index + 1}</legend>
        <label>Path name<input value={c.label} maxLength={60} disabled={!manager} onChange={event => onChange({ ...step, cases: step.cases.map(x => x.id === c.id ? { ...x, label: event.target.value } : x) })} /></label>
        <GroupEditor group={c.when} fields={fields} operators={catalog.operators} disabled={!manager} depth={1} onChange={when => onChange({ ...step, cases: step.cases.map(x => x.id === c.id ? { ...x, when } : x) })} />
        {manager && <div className="au-inline-actions">
          <button className="text-button" disabled={index === 0} onClick={() => { const cases = [...step.cases]; [cases[index - 1], cases[index]] = [cases[index], cases[index - 1]]; onChange({ ...step, cases }) }}>Move up</button>
          <button className="text-button" disabled={step.cases.length === 1} onClick={() => onChange({ ...step, cases: step.cases.filter(x => x.id !== c.id) })}>Remove path</button>
        </div>}
      </fieldset>)}
      {manager && step.cases.length < 5 && <button className="secondary" onClick={() => {
        const taken = new Set<string>(); const collect = (steps: Step[]) => steps.forEach(s => { taken.add(s.id); if (s.type === 'branch') { s.cases.forEach(x => { taken.add(x.id); collect(x.steps) }); collect(s.otherwise.steps) } })
        collect(definition.steps); let n = 1; while (taken.has(`b${n}`)) n++
        onChange({ ...step, cases: [...step.cases, { id: `b${n}`, label: `Path ${step.cases.length + 1}`, when: emptyGroup(), steps: [] }] })
      }}><Icon name="plus" size={14} /> Add path</button>}
    </>}
    {step.type === 'delay' && <>
      <label>Delay<select disabled={!manager} value={step.mode} onChange={event => onChange({ ...step, mode: event.target.value as 'duration' | 'until' })}>
        <option value="duration">For a length of time</option><option value="until">Until a date and time</option></select></label>
      {step.mode === 'duration' ? <div className="au-row">
        <input type="number" aria-label="Amount" min={1} disabled={!manager} value={step.amount ?? 1} onChange={event => onChange({ ...step, amount: Number(event.target.value) })} />
        <select aria-label="Unit" disabled={!manager} value={step.unit ?? 'days'} onChange={event => onChange({ ...step, unit: event.target.value as 'minutes' | 'hours' | 'days' })}>
          <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select>
      </div> : <label>Until<input type="datetime-local" disabled={!manager} value={step.until ? toLocalInput(step.until) : ''} onChange={event => onChange({ ...step, until: event.target.value ? new Date(event.target.value).toISOString() : '' })} /></label>}
      <p className="au-help">The run’s place is saved; nothing waits in memory. Up to 90 days.</p>
    </>}
    {step.type === 'wait' && <WaitFields step={step} fields={fields} center={center} disabled={!manager} onChange={onChange} />}
    {step.type === 'action' && <>
      <label>Action<select disabled={!manager} value={step.action} onChange={event => {
        const next = catalog.actions.find(a => a.type === event.target.value)
        onChange({ ...step, action: event.target.value, inputs: next ? defaultInputs(next, fields) : {} })
      }}>
        <option value="">Choose an action…</option>
        {[...new Set(catalog.actions.map(a => a.group))].map(group => <optgroup key={group} label={group}>{catalog.actions.filter(a => a.group === group).map(a =>
          <option key={a.type} value={a.type}>{a.label}{a.side === 'consequential' ? ' (consequential)' : ''}</option>)}</optgroup>)}
      </select></label>
      {action && <>
        <p className="au-help">{action.description}</p>
        {action.side === 'consequential' && <p className="au-warning">Consequential: it changes a status or something the client sees. It needs your confirmation below, and an owner or admin publishes it.</p>}
        {action.ai && <p className="au-info">Uses AI and counts toward the workspace’s monthly AI allowance. Drafts are saved for a person to review and are never sent.</p>}
        {action.inputs.map(input => <InputField key={input.key} input={input} value={step.inputs[input.key]} fields={fields} center={center} disabled={!manager}
          onChange={value => onChange({ ...step, inputs: { ...(step as ActionStep).inputs, [input.key]: value } })} />)}
        <DataList title="Data this step provides" fields={action.outputs.map(o => ({ ...o, path: `steps.${step.id}.${o.path}` }))} />
      </>}
    </>}
    <DataList title="Data available here" fields={fields} collapsed />
    <Issues validation={validation} node={step.id} />
    {manager && <div className="au-step-actions">
      <button className="text-button" onClick={() => onMove(-1)}>Move up</button>
      <button className="text-button" onClick={() => onMove(1)}>Move down</button>
      <button className="text-button" onClick={onDuplicate}>Duplicate</button>
      <button className="text-button danger" onClick={onRemove}>Delete step</button>
    </div>}
  </div>
}

const toLocalInput = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

function WaitFields({ step, fields, center, disabled, onChange }: { step: Extract<Step, { type: 'wait' }>; fields: Field[]; center: CenterData; disabled: boolean; onChange: (step: Step) => void }) {
  const wait = center.catalog.waits.find(w => w.event === step.event)
  const subjects = fields.filter(f => f.type === 'ref' && f.entity === wait?.entity)
  return <>
    <label>Wait until<select disabled={disabled} value={step.event} onChange={event => {
      const next = center.catalog.waits.find(w => w.event === event.target.value)
      onChange({ ...step, event: event.target.value, subject: fields.find(f => f.type === 'ref' && f.entity === next?.entity)?.path ?? '' })
    }}>{center.catalog.waits.map(w => <option key={w.event} value={w.event}>{w.label}</option>)}</select></label>
    <label>For which {wait?.entity ?? 'record'}<select disabled={disabled} value={step.subject} onChange={event => onChange({ ...step, subject: event.target.value })}>
      <option value="">Choose…</option>{subjects.map(f => <option key={f.path} value={f.path}>{f.label}</option>)}</select></label>
    {!subjects.length && <p className="au-warning">This trigger has no {wait?.entity} to wait for. Choose another event, or add a step that creates one first.</p>}
    <div className="au-row"><label>Give up after<input type="number" min={1} disabled={disabled} value={step.timeout.amount} onChange={event => onChange({ ...step, timeout: { ...step.timeout, amount: Number(event.target.value) } })} /></label>
      <label>&nbsp;<select aria-label="Timeout unit" disabled={disabled} value={step.timeout.unit} onChange={event => onChange({ ...step, timeout: { ...step.timeout, unit: event.target.value as 'hours' | 'days' } })}>
        <option value="hours">hours</option><option value="days">days</option></select></label></div>
    <label>If nothing arrives in time<select disabled={disabled} value={step.onTimeout} onChange={event => onChange({ ...step, onTimeout: event.target.value as 'continue' | 'stop' })}>
      <option value="stop">Stop the run</option><option value="continue">Continue (the step reports it didn’t arrive)</option></select></label>
  </>
}

function InputField({ input, value, fields, center, disabled, onChange }: { input: ActionInput; value: unknown; fields: Field[]; center: CenterData; disabled: boolean; onChange: (value: unknown) => void }) {
  const { lookups } = center
  const id = `au-input-${input.key}`
  const label = <span className="au-label-text">{input.label}{input.required && <span className="au-required" aria-hidden="true"> *</span>}</span>
  const area = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  switch (input.kind) {
    case 'subject': {
      const options = fields.filter(f => f.type === 'ref' && input.entities?.includes(f.entity ?? ''))
      return <label htmlFor={id}>{label}<select id={id} disabled={disabled} value={String(value ?? '')} onChange={event => onChange(event.target.value || null)}>
        <option value="">{input.required ? 'Choose…' : 'None'}</option>{options.map(f => <option key={f.path} value={f.path}>{f.label}</option>)}</select>
        {!options.length && <small className="au-warning-text">Nothing here provides a {input.entities?.join(' or ')}.</small>}</label>
    }
    case 'template': {
      const insertVariable = (path: string) => {
        const element = area.current, text = String(value ?? ''), token = `{{${path}}}`
        const start = element?.selectionStart ?? text.length, end = element?.selectionEnd ?? text.length
        onChange((text.slice(0, start) + token + text.slice(end)).slice(0, input.max ?? 2000))
        requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + token.length, start + token.length) })
      }
      const usable = fields.filter(f => f.type !== 'ref')
      return <div className="au-template">
        <label htmlFor={id}>{label}</label>
        {input.multiline ? <textarea id={id} ref={area} rows={3} maxLength={input.max} disabled={disabled} value={String(value ?? '')} onChange={event => onChange(event.target.value)} />
          : <input id={id} ref={area} maxLength={input.max} disabled={disabled} value={String(value ?? '')} onChange={event => onChange(event.target.value)} />}
        {!disabled && <select className="au-variable" aria-label={`Insert a variable into ${input.label}`} value="" onChange={event => { if (event.target.value) insertVariable(event.target.value) }}>
          <option value="">Insert variable…</option>{usable.map(f => <option key={f.path} value={f.path}>{f.label}</option>)}</select>}
        {input.help && <small className="au-help">{input.help}</small>}
      </div>
    }
    case 'enum':
      return <label htmlFor={id}>{label}<select id={id} disabled={disabled} value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
        {!input.required && input.default === undefined && <option value="">Default</option>}{input.required && !value && <option value="">Choose…</option>}
        {input.options?.map(option => <option key={option} value={option}>{humanize(option)}</option>)}</select></label>
    case 'number':
      return <label htmlFor={id}>{label}<input id={id} type="number" min={input.min} max={input.max} disabled={disabled} value={Number(value ?? input.default ?? 0)} onChange={event => onChange(Number(event.target.value))} /></label>
    case 'boolean':
      return <label className="au-check"><input type="checkbox" disabled={disabled} checked={value === true} onChange={event => onChange(event.target.checked)} />{input.label}</label>
    case 'confirm':
      return <label className="au-check au-confirm"><input type="checkbox" disabled={disabled} checked={value === true} onChange={event => onChange(event.target.checked)} />{input.label}</label>
    case 'assignee':
      return <label htmlFor={id}>{label}<select id={id} disabled={disabled} value={String(value ?? 'none')} onChange={event => onChange(event.target.value)}>
        {Object.entries(assigneeLabels).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
        <optgroup label="Members">{lookups.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup></select></label>
    case 'recipients': {
      const list = Array.isArray(value) ? value as string[] : []
      const toggle = (key: string, on: boolean) => onChange(on ? [...new Set([...list, key])] : list.filter(x => x !== key))
      return <fieldset className="au-fieldset au-recipients"><legend>{label}</legend>
        {Object.entries(recipientLabels).map(([key, text]) => <label key={key} className="au-check"><input type="checkbox" disabled={disabled} checked={list.includes(key)} onChange={event => toggle(key, event.target.checked)} />{text}</label>)}
        {lookups.members.map(m => <label key={m.id} className="au-check"><input type="checkbox" disabled={disabled} checked={list.includes(m.id)} onChange={event => toggle(m.id, event.target.checked)} />{m.name}</label>)}
        <small className="au-help">A record without an owner notifies owners and admins instead.</small>
      </fieldset>
    }
    case 'due': {
      const due = (value ?? { mode: 'days', days: 1 }) as Due
      const dates = fields.filter(f => f.type === 'date' || f.type === 'datetime')
      return <fieldset className="au-fieldset"><legend>{label}</legend>
        <select aria-label="Due mode" disabled={disabled} value={due.mode} onChange={event => onChange(event.target.value === 'days' ? { mode: 'days', days: 1 } : { mode: 'relative', path: dates[0]?.path ?? '', offset: -1 })}>
          <option value="days">A number of days after the run</option><option value="relative">Relative to a date</option></select>
        {due.mode === 'days' ? <label>Days<input type="number" min={0} max={365} disabled={disabled} value={due.days ?? 1} onChange={event => onChange({ ...due, days: Number(event.target.value) })} /></label>
          : <div className="au-row"><label>Date<select disabled={disabled} value={due.path ?? ''} onChange={event => onChange({ ...due, path: event.target.value })}>{dates.map(f => <option key={f.path} value={f.path}>{f.label}</option>)}</select></label>
            <label>Days (− before)<input type="number" min={-365} max={365} disabled={disabled} value={due.offset ?? 0} onChange={event => onChange({ ...due, offset: Number(event.target.value) })} /></label></div>}
      </fieldset>
    }
    case 'stage':
      return <label htmlFor={id}>{label}<select id={id} disabled={disabled} value={String(value ?? '')} onChange={event => onChange(event.target.value || null)}>
        <option value="">{input.required ? 'Choose…' : 'The default stage'}</option>{lookups.stages.filter(s => s.category === 'open').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    case 'onboarding_template':
      return <label htmlFor={id}>{label}<select id={id} disabled={disabled} value={String(value ?? '')} onChange={event => onChange(event.target.value || null)}>
        <option value="">None (a blank checklist)</option>{lookups.onboardingTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    case 'project_template':
      return <label htmlFor={id}>{label}<select id={id} disabled={disabled} value={String(value ?? '')} onChange={event => onChange(event.target.value || null)}>
        <option value="">No plan (add one later)</option>{lookups.projectTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
  }
}

function GroupEditor({ group, fields, operators, disabled, depth, onChange }: { group: Group; fields: Field[]; operators: Record<string, string[]>; disabled: boolean; depth: number; onChange: (group: Group) => void }) {
  const set = (index: number, item: Condition | Group | null) => onChange({ ...group, conditions: item ? group.conditions.map((x, i) => i === index ? item : x) : group.conditions.filter((_, i) => i !== index) })
  return <div className={`au-group depth-${depth}`}>
    {group.conditions.length > 1 && <label className="au-match">Match<select disabled={disabled} value={group.match} onChange={event => onChange({ ...group, match: event.target.value as 'all' | 'any' })}>
      <option value="all">all of these</option><option value="any">any of these</option></select></label>}
    {group.conditions.map((item, index) => isGroup(item)
      ? <div className="au-subgroup" key={index}><GroupEditor group={item} fields={fields} operators={operators} disabled={disabled} depth={depth + 1} onChange={next => set(index, next)} />
        {!disabled && <button className="text-button" onClick={() => set(index, null)}>Remove group</button>}</div>
      : <ConditionRow key={index} condition={item} fields={fields} operators={operators} disabled={disabled} onChange={next => set(index, next)} onRemove={() => set(index, null)} />)}
    {!group.conditions.length && <p className="au-muted">No conditions: always.</p>}
    {!disabled && <div className="au-inline-actions">
      <button className="secondary" onClick={() => { const first = fields.find(f => f.type !== 'ref') ?? fields[0]; onChange({ ...group, conditions: [...group.conditions, { path: first?.path ?? '', op: operators[first?.type ?? 'text']?.[0] ?? 'equals', value: '' }] }) }}><Icon name="plus" size={14} /> Condition</button>
      {depth < 3 && <button className="text-button" onClick={() => onChange({ ...group, conditions: [...group.conditions, { match: 'any', conditions: [] }] })}>Add group</button>}
    </div>}
  </div>
}

function ConditionRow({ condition, fields, operators, disabled, onChange, onRemove }: { condition: Condition; fields: Field[]; operators: Record<string, string[]>; disabled: boolean; onChange: (condition: Condition) => void; onRemove: () => void }) {
  const field = fields.find(f => f.path === condition.path)
  const ops = operators[field?.type ?? 'text'] ?? []
  const setField = (path: string) => { const next = fields.find(f => f.path === path); onChange({ path, op: (operators[next?.type ?? 'text'] ?? ['equals'])[0], value: '' }) }
  let valueInput: ReactNode = null
  if (field && !valueless(condition.op)) {
    if (field.type === 'enum' && (condition.op === 'in' || condition.op === 'not_in')) {
      const list = Array.isArray(condition.value) ? condition.value : []
      valueInput = <div className="au-multi">{field.options?.map(option => <label key={option} className="au-check"><input type="checkbox" disabled={disabled} checked={list.includes(option)}
        onChange={event => onChange({ ...condition, value: event.target.checked ? [...list, option] : list.filter(x => x !== option) })} />{humanize(option)}</label>)}</div>
    } else if (field.type === 'enum') {
      valueInput = <select aria-label="Value" disabled={disabled} value={String(condition.value ?? '')} onChange={event => onChange({ ...condition, value: event.target.value })}>
        <option value="">Choose…</option>{field.options?.map(option => <option key={option} value={option}>{humanize(option)}</option>)}</select>
    } else if (field.type === 'number') {
      valueInput = <><input aria-label="Value" type="number" disabled={disabled} value={String(condition.value ?? '')} onChange={event => onChange({ ...condition, value: event.target.value })} />
        {condition.op === 'between' && <input aria-label="Upper value" type="number" disabled={disabled} value={condition.value2 ?? ''} onChange={event => onChange({ ...condition, value2: event.target.value })} />}</>
    } else if ((field.type === 'date' || field.type === 'datetime') && condition.op === 'within_next_days') {
      valueInput = <input aria-label="Days" type="number" min={0} max={999} disabled={disabled} value={String(condition.value ?? '')} onChange={event => onChange({ ...condition, value: event.target.value })} />
    } else if (field.type === 'date' || field.type === 'datetime') {
      valueInput = <input aria-label="Date" type="date" disabled={disabled} value={String(condition.value ?? '')} onChange={event => onChange({ ...condition, value: event.target.value })} />
    } else {
      valueInput = <input aria-label="Value" maxLength={200} disabled={disabled} value={String(condition.value ?? '')} onChange={event => onChange({ ...condition, value: event.target.value })} />
    }
  }
  return <div className="au-condition">
    <select aria-label="Field" disabled={disabled} value={condition.path} onChange={event => setField(event.target.value)}>
      {!field && <option value={condition.path}>{condition.path || 'Choose a field…'}</option>}
      {fields.map(f => <option key={f.path} value={f.path}>{f.label}</option>)}</select>
    <select aria-label="Comparison" disabled={disabled} value={condition.op} onChange={event => onChange({ ...condition, op: event.target.value, value: event.target.value === 'in' || event.target.value === 'not_in' ? [] : '' })}>
      {ops.map(op => <option key={op} value={op}>{operatorLabels[op] ?? op}{op === 'within_next_days' ? ' (days)' : ''}</option>)}</select>
    {valueInput}
    {!disabled && <button className="icon-button" aria-label="Remove condition" onClick={onRemove}>✕</button>}
  </div>
}

function DataList({ title, fields, collapsed = false }: { title: string; fields: Field[]; collapsed?: boolean }) {
  if (!fields.length) return null
  return <details className="au-data" open={!collapsed}><summary>{title} <span className="number-tag">{fields.length}</span></summary>
    <ul>{fields.map(f => <li key={f.path}><span>{f.label}</span><code>{`{{${f.path}}}`}</code><small>{f.type === 'ref' ? `${f.entity} reference` : f.type}</small></li>)}</ul></details>
}

// ---------- Test, publish and webhook dialogs ----------

function flatten(data: Record<string, unknown>): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [inner, v] of Object.entries(value as Record<string, unknown>)) { if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out.push([`${key}.${inner}`, v]) }
    else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out.push([key, value])
  }
  return out
}
function setPath(data: Record<string, unknown>, path: string, value: unknown) {
  const copy = structuredClone(data), [head, tail] = path.split('.')
  if (tail) copy[head] = { ...(copy[head] as Record<string, unknown>), [tail]: value }; else copy[head] = value
  return copy
}

function TestDialog({ workspace, center, definition, workflowId, dirty, valid, manager, onClose, onOpenRun }: {
  workspace: WorkspaceSummary; center: CenterData; definition: Definition; workflowId: string | null; dirty: boolean; valid: boolean; manager: boolean
  onClose: () => void; onOpenRun: (runId: string) => void
}) {
  const [sample, setSample] = useState<Sample | null>(null), [data, setData] = useState<Record<string, unknown>>({}), [record, setRecord] = useState<string>('')
  const [result, setResult] = useState<DryRun | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false)
  const type = definition.trigger.type
  useEffect(() => {
    if (!type) return
    let active = true
    const triggerFields = center.catalog.triggers.find(t => t.type === type)?.fields ?? []
    sampleFor(workspace.id, type, type === 'webhook.received' ? workflowId : record || null).then(next => {
      if (active) { setSample(next); setData(withExamples(exampleData(triggerFields), next.data)) }
    }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, type, record, workflowId, center])
  const fields = useMemo(() => flatten(data), [data])
  const run = async () => { setBusy(true); setError(''); try { setResult(await dryRun(workspace.id, definition, data)) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }
  const live = async () => {
    if (!workflowId) return
    setBusy(true); setError('')
    try { const started = await startLiveTest(workspace.id, workflowId, data); await advanceNow(workspace.id, started.id).catch(() => null); onOpenRun(started.id) }
    catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal title="Test workflow" onClose={onClose} variant="drawer">
    <div className="au-test">
      {!type ? <p className="au-warning">Choose a trigger first.</p> : <>
        <section><h3>1. Test data</h3>
          {sample?.options.length ? <label>Use a record from this workspace<select value={record || sample.entity?.id || ''} onChange={event => setRecord(event.target.value)}>
            {sample.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            : sample?.empty ? <p className="au-muted">No matching record yet: edit the example values below.</p> : null}
          <p className="au-help">Adjust any value to see how the workflow reacts. The test uses this data only.</p>
          <div className="au-sample">{fields.map(([path, value]) => <label key={path}><span>{path}</span>
            {typeof value === 'boolean' ? <select value={String(value)} onChange={event => setData(setPath(data, path, event.target.value === 'true'))}><option value="true">true</option><option value="false">false</option></select>
              : <input value={value === null ? '' : String(value)} onChange={event => setData(setPath(data, path, typeof value === 'number' && event.target.value !== '' && !Number.isNaN(Number(event.target.value)) ? Number(event.target.value) : event.target.value))} />}
          </label>)}</div>
        </section>
        <section><h3>2. Dry run</h3>
          <p className="au-help">Evaluates the filter, conditions and branches and shows which actions would run with which inputs. Nothing is created, changed, sent or notified.</p>
          <button className="primary" disabled={busy} onClick={() => void run()}>Run dry test</button>
          {result && <DryRunResult result={result} center={center} />}
        </section>
        {manager && <section className="au-live"><h3>3. Live test (optional)</h3>
          <p className="au-help">Runs the current draft’s real actions once with the data above, as you. It is labelled “Live test” in history and kept out of production numbers.</p>
          {(dirty || !workflowId) && <p className="au-warning">Save the draft first.</p>}
          {!valid && <p className="au-warning">Fix the workflow’s issues first.</p>}
          <label className="au-check au-confirm"><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} />I understand this creates real records, notifications or client-visible changes.</label>
          <button className="secondary" disabled={busy || !confirm || dirty || !workflowId || !valid} onClick={() => void live()}>Run live test</button>
        </section>}
      </>}
      {error && <p className="au-error" role="alert">{error}</p>}
    </div>
  </Modal>
}

function DryRunResult({ result, center }: { result: DryRun; center: CenterData }) {
  return <div className="au-dry" aria-live="polite">
    <p className={result.filterMatched ? 'au-info' : 'au-warning'}>{result.note}</p>
    {!result.valid && result.issues.length > 0 && <p className="au-warning">This draft has {result.issues.length} issue{result.issues.length === 1 ? '' : 's'} to fix before it can be published.</p>}
    <ol className="au-trace">{result.steps.map(step => {
      const action = step.action ? center.catalog.actions.find(a => a.type === step.action) : null
      const r = step.result as Record<string, unknown>
      return <li key={step.node} className={`au-trace-${step.type}`}>
        <div className="au-trace-head"><span aria-hidden="true">{stepIcons[step.type]}</span><strong>{step.label || action?.label || stepTypeLabels[step.type]}</strong>
          {step.type === 'condition' && <span className={`au-pill ${r.matched ? 'au-pill-success' : 'au-pill-danger'}`}>{r.matched ? 'Matched' : 'Not met: the run stops'}</span>}
          {step.type === 'branch' && <span className="au-pill au-pill-info">Takes “{String(r.label)}”</span>}
          {step.type === 'delay' && <span className="au-pill">Would wait {String(r.wouldWait)}</span>}
          {step.type === 'wait' && <span className="au-pill">Would wait up to {String(r.for)} for: {String(r.wouldWaitFor)}</span>}
          {step.type === 'action' && <span className={`au-pill ${step.side === 'consequential' ? 'au-pill-warning' : 'au-pill-success'}`}>Would run{step.side === 'consequential' ? ' · consequential' : ''}{step.ai ? ' · AI' : ''}{step.client ? ' · client sees it' : ''}</span>}
        </div>
        {step.input && Object.keys(step.input).length > 0 && <dl className="au-kv">{formatInputs(action, step.input, center).map(([label, text]) => <Fragment key={label}><dt>{label}</dt><dd>{text}</dd></Fragment>)}</dl>}
      </li>
    })}</ol>
    {result.outcome === 'completed' && result.steps.length > 0 && <p className="au-muted">The run would complete here.</p>}
  </div>
}

function PublishDialog({ center, definition, validation, detail, dirty, busy, onClose, onPublish }: {
  center: CenterData; definition: Definition; validation: Validation | null; detail: WorkflowDetail | null; dirty: boolean; busy: boolean; onClose: () => void; onPublish: (note: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const effects: string[] = []
  const visit = (steps: Step[]) => steps.forEach(step => {
    if (step.type === 'branch') { step.cases.forEach(c => visit(c.steps)); visit(step.otherwise.steps); return }
    if (step.type !== 'action') return
    const action: ActionDef | undefined = center.catalog.actions.find(a => a.type === step.action)
    if (!action) return
    if (action.side === 'consequential') effects.push(`${step.label || action.label}: consequential${action.client ? ', the client sees it' : ''}.`)
    if (action.ai) effects.push(`${step.label || action.label}: uses AI (drafts only, never sent).`)
    if (step.inputs.email === true) effects.push(`${step.label || action.label}: emails members who allow automation emails.`)
  })
  visit(definition.steps)
  const valid = !!validation?.valid
  return <Modal title={`Publish version ${(detail?.versions[0]?.number ?? 0) + 1}`} onClose={onClose}>
    <div className="au-publish">
      <p>Publishing makes this draft the live version and activates the workflow. Runs already in progress keep the version they started with.</p>
      {!valid && <div className="au-issues"><h4>Fix these first</h4><ul>{validation?.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div>}
      {effects.length > 0 && <div className="au-effects"><h4>Side effects to be aware of</h4><ul>{effects.map((effect, index) => <li key={index}>{effect}</li>)}</ul></div>}
      <p className="au-help">Actions run with your authority as the publisher, and your access is checked again on every action. Nothing sends outreach, marks deals won or lost, confirms scope or approves on a client’s behalf.</p>
      <label>Version note (optional)<input maxLength={300} value={note} onChange={event => setNote(event.target.value)} placeholder="What changed" /></label>
      {dirty && <p className="au-muted">Your unsaved changes are saved first.</p>}
      <div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!valid || busy} onClick={() => void onPublish(note)}>Publish and activate</button></div>
    </div>
  </Modal>
}

function WebhookDialog({ workspace, workflowId, existing, onClose, onChanged }: { workspace: WorkspaceSummary; workflowId: string; existing: WorkflowDetail['webhook']; onClose: () => void; onChanged: () => void }) {
  const [issued, setIssued] = useState<IssuedWebhook | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const issue = async (rotate: boolean) => { setBusy(true); setError(''); try { setIssued(await issueWebhookSecret(workspace.id, workflowId, rotate)); onChanged() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }
  return <Modal title="Webhook endpoint" onClose={onClose}>
    <div className="au-webhook">
      <p>External systems (Zapier, Make, n8n, your CRM) start this workflow by sending a signed POST request. The signing key is shown once; LeadFlow stores no copy.</p>
      {issued ? <>
        <label>Endpoint URL<input readOnly value={issued.url} onFocus={event => event.target.select()} /></label>
        <label>Webhook ID (X-LeadFlow-Webhook)<input readOnly value={issued.id} onFocus={event => event.target.select()} /></label>
        <label>Signing key<input readOnly value={issued.secret} onFocus={event => event.target.select()} /></label>
        <p className="au-warning">{issued.note}</p>
        <pre className="au-code">{`POST ${issued.url}
Content-Type: application/json
X-LeadFlow-Webhook: ${issued.id}
X-LeadFlow-Timestamp: <Unix seconds>
X-LeadFlow-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the signing key>

{"eventId":"<unique per event>","data":{ …the fields you declared… }}`}</pre>
      </> : <p className="au-muted">{existing ? `Key version ${existing.version}, ${existing.status}.` : 'No endpoint yet.'}</p>}
      {error && <p className="au-error" role="alert">{error}</p>}
      <div className="modal-actions">
        {existing?.status === 'active' && !issued && <button className="secondary danger" disabled={busy} onClick={async () => { setBusy(true); try { await revokeWebhook(workspace.id, workflowId); onChanged(); onClose() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }}>Revoke endpoint</button>}
        {!issued && <button className="primary" disabled={busy} onClick={() => void issue(!!existing)}>{existing ? 'Rotate key (the old one stops working)' : 'Create endpoint and key'}</button>}
        {issued && <button className="primary" onClick={onClose}>Done</button>}
      </div>
    </div>
  </Modal>
}
