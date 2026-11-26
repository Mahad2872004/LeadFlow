import { Fragment, useEffect, useState } from 'react'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import { advanceNow, cancelRun, duration, errorText, formatValue, humanize, outcomeLabels, rerunRun, retryRun, runDetail, runStatusLabels, type CenterData, type RunDetail, type RunStepRecord } from '../lib/automation'

const stepStatusLabels: Record<RunStepRecord['status'], string> = { completed: 'Completed', failed: 'Failed', skipped: 'Skipped', waiting: 'Waiting', retrying: 'Will retry', cancelled: 'Cancelled' }

/**
 * One execution: the version it ran, what triggered it, the path it took (condition results, branch chosen, waits),
 * every step with its sanitized inputs and outputs, retries and errors. Owners and admins can retry a failed run from the
 * failed step, rerun it from the start (with a warning about repeated side effects) or cancel it.
 */
export function RunDrawer({ workspace, center, runId, onClose, onChanged, onOpenWorkflow }: {
  workspace: WorkspaceSummary; center: CenterData; runId: string; onClose: () => void; onChanged: () => void; onOpenWorkflow: (workflowId: string) => void
}) {
  const [run, setRun] = useState<RunDetail | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [rerun, setRerun] = useState(false)
  const manager = center.role !== 'member'
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    runDetail(workspace.id, runId).then(result => { if (active) { setRun(result); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, runId, reload])
  const act = async (work: () => Promise<unknown>, after?: () => void) => { setBusy(true); setError(''); try { await work(); setReload(value => value + 1); onChanged(); after?.() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }
  const title = run ? `${run.workflowName}${run.version ? ` · v${run.version}` : ''}` : 'Run'
  return <Modal title={title} onClose={onClose} variant="drawer">
    {!run ? <p className="au-muted" role="status">{error || 'Loading run…'}</p> : <div className="au-run">
      <div className="au-run-head">
        <span className={`au-run-status au-run-${run.status}`}>{runStatusLabels[run.status]}</span>
        {run.mode === 'test' && <span className="au-pill au-pill-info">Live test</span>}
        {run.versionKind === 'test' && <span className="au-pill">Draft tested</span>}
        {run.outcome && run.outcome !== 'completed' && <span className="au-pill">{outcomeLabels[run.outcome] ?? humanize(run.outcome)}</span>}
        <button className="text-button" onClick={() => onOpenWorkflow(run.workflowId)}>Open workflow</button>
      </div>
      <dl className="au-kv au-run-facts">
        <dt>Trigger</dt><dd>{center.catalog.triggers.find(t => t.type === run.triggerType)?.label ?? run.triggerType}{run.subject ? ` · ${run.subject}` : ''}</dd>
        <dt>Started</dt><dd>{new Date(run.startedAt ?? run.createdAt).toLocaleString()}</dd>
        <dt>Duration</dt><dd>{run.completedAt ? duration(run.durationMs) : run.nextRunAt ? `Continues ${new Date(run.nextRunAt).toLocaleString()}` : 'In progress'}</dd>
        <dt>Retries</dt><dd>{run.retryCount ? `${run.retryCount} manual` : 'None'}{run.attempts > 1 ? ` · attempt ${run.attempts} of the current step` : ''}</dd>
        <dt>Version</dt><dd>{run.versionKind === 'test' ? 'The draft at the time of the test' : `Version ${run.version}`} · published by {run.publishedBy}</dd>
      </dl>
      {run.error && <div className={run.status === 'attention' ? 'au-warning' : 'au-error'} role="status"><strong>{run.failedStep ? `${run.failedStep}: ` : ''}</strong>{run.error}</div>}
      {run.status === 'attention' && run.errorCode === 'authorization' && <p className="au-help">The member who published this version no longer has the access its actions need. An owner or admin can republish it, then retry.</p>}
      {(run.status === 'failed' || run.status === 'attention') && <p className="au-help">Retry continues from the failed step with the same version. Steps that already completed aren’t repeated, and each step’s request ID makes sure a half-finished step finds what it already created.</p>}
      {error && <p className="au-error" role="alert">{error}</p>}
      {manager && <div className="au-run-actions">
        {run.canRetry && <button className="primary" disabled={busy} onClick={() => void act(async () => { await retryRun(workspace.id, run.id); await advanceNow(workspace.id, run.id).catch(() => null) })}>Retry from failed step</button>}
        {['completed', 'failed', 'cancelled', 'attention'].includes(run.status) && run.mode === 'live' && <button className="secondary" disabled={busy} onClick={() => setRerun(true)}>Run again from the start…</button>}
        {run.canCancel && <button className="secondary danger" disabled={busy} onClick={() => void act(() => cancelRun(workspace.id, run.id))}>Cancel run</button>}
        {run.status === 'queued' && <button className="secondary" disabled={busy} onClick={() => void act(() => advanceNow(workspace.id, run.id))}>Run now</button>}
      </div>}
      <h3>Execution path</h3>
      {!run.steps.length ? <p className="au-muted">{run.status === 'queued' ? 'Queued: the automation worker starts it within about a minute.' : 'No steps ran.'}</p>
        : <ol className="au-path-log">{run.steps.map(step => <li key={step.id} className={`au-step-${step.status}`}>
          <div className="au-trace-head"><strong>{step.label}</strong><span className={`au-pill au-step-pill-${step.status}`}>{stepStatusLabels[step.status]}{step.attempt > 1 ? ` · attempt ${step.attempt}` : ''}</span>
            <small>{new Date(step.startedAt).toLocaleTimeString()}</small></div>
          <StepResult step={step} />
          {step.error && <p className="au-error-text">{step.error}</p>}
          {(step.input && Object.keys(step.input).length > 0) || (step.output && Object.keys(step.output).length > 0) ? <details><summary>Inputs and outputs</summary>
            {step.input && Object.keys(step.input).length > 0 && <><h4>Input</h4><dl className="au-kv">{Object.entries(step.input).map(([key, value]) => <Fragment key={key}><dt>{humanize(key)}</dt><dd>{formatValue(value)}</dd></Fragment>)}</dl></>}
            {step.output && Object.keys(step.output).length > 0 && <><h4>Output</h4><dl className="au-kv">{Object.entries(step.output).map(([key, value]) => <Fragment key={key}><dt>{humanize(key)}</dt><dd>{formatValue(value)}</dd></Fragment>)}</dl></>}
          </details> : null}
        </li>)}</ol>}
      <details className="au-trigger-data"><summary>Trigger data</summary>
        <p className="au-help">What the event carried, as stored for this run. Email addresses, phone numbers and credentials are never kept in run logs.</p>
        <dl className="au-kv">{Object.entries(run.trigger ?? {}).map(([key, value]) => <Fragment key={key}><dt>{humanize(key)}</dt><dd>{formatValue(value)}</dd></Fragment>)}</dl>
      </details>
    </div>}
    {rerun && run && <Modal title="Run again from the start?" onClose={() => setRerun(false)}>
      <p>A full rerun starts a new run of the current published version for the same event. Steps that already created records (tasks, notes, notifications, deals, projects, drafts) run again with new request IDs, so they may create duplicates.</p>
      <p className="au-help">To continue a failed run without repeating anything, use Retry from failed step instead.</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setRerun(false)}>Keep it</button>
        <button className="primary danger" disabled={busy} onClick={() => void act(async () => { const next = await rerunRun(workspace.id, run.id); await advanceNow(workspace.id, next.id).catch(() => null) }, () => setRerun(false))}>Rerun from the start</button></div>
    </Modal>}
  </Modal>
}

function StepResult({ step }: { step: RunStepRecord }) {
  const r = step.result ?? {}
  if (step.type === 'condition') return <p className="au-step-result">{r.matched ? 'Conditions matched: continued.' : 'Conditions not met: the run stopped here.'}</p>
  if (step.type === 'branch') return <p className="au-step-result">Took the path “{String(r.label ?? r.path)}”.</p>
  if (step.type === 'delay') return <p className="au-step-result">{step.status === 'waiting' ? `Waiting until ${new Date(String(r.resumeAt)).toLocaleString()}.` : `Waited until ${new Date(String(r.resumeAt)).toLocaleString()}.`}</p>
  if (step.type === 'wait') return <p className="au-step-result">{step.status === 'waiting' ? `Waiting for ${humanize(String(r.event ?? 'the event').replace('.', ' '))} until ${new Date(String(r.until)).toLocaleString()}.`
    : r.timedOut ? 'Nothing arrived in time.' : 'The event arrived.'}</p>
  if (step.status === 'skipped' && r.reason) return <p className="au-step-result">Skipped: {String(r.reason)}</p>
  return null
}
