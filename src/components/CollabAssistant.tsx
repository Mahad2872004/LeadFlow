import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import type { WorkspaceSummary } from '../lib/backend'
import { askAssistant, assistantConfig, type AiPoint, type AiResult, type CollabAiOperation } from '../lib/projects'
import { assistantMessage } from '../lib/collaboration'

const categoryLabels: Record<string, string> = { content: 'Content changes', design: 'Design changes', functional: 'Functional changes', technical: 'Technical issues', clarification: 'Needs clarification' }

/** Turns fact IDs (F1, F2…) into what they say, so every suggestion shows what it rests on. */
export function BasedOn({ ids, result }: { ids: string[]; result: AiResult }) {
  if (!ids.length) return null
  const labels = ids.map(id => { const fact = result.facts.find(item => item.id === id); return fact ? `${fact.label}: ${fact.value}` : id })
  return <span className="cb-based" title={labels.join('\n')}> (based on {ids.join(', ')})</span>
}
function Points({ title, points, result }: { title: string; points: AiPoint[]; result: AiResult }) {
  if (!points.length) return null
  return <><h4>{title}</h4><ul>{points.map((point, index) => <li key={index}>{point.text}<BasedOn ids={point.basedOn} result={result} /></li>)}</ul></>
}

/** Shows an AI result: always labelled as a suggestion, with the recorded facts it used. */
export function AssistantResult({ result }: { result: AiResult }) {
  return <div className="cb-ai-result">
    <span className="cb-ai-label"><Icon name="spark" size={13} /> AI suggestion · check before using</span>
    {result.feedbackSummary && <><p>{result.feedbackSummary.overview}</p>
      {result.feedbackSummary.groups.map(group => <Points key={group.category} title={categoryLabels[group.category] ?? group.category} points={group.points} result={result} />)}</>}
    {result.reviewPrep && <><Points title="What changed" points={result.reviewPrep.changed} result={result} /><Points title="Feedback addressed" points={result.reviewPrep.addressed} result={result} />
      <Points title="Still open" points={result.reviewPrep.unresolved} result={result} /></>}
    {result.discussionSummary && <><p>{result.discussionSummary.overview}</p><Points title="Agreed" points={result.discussionSummary.decisions} result={result} />
      <Points title="Open questions" points={result.discussionSummary.openQuestions} result={result} /></>}
    {result.responseDraft && <p>{result.responseDraft.body}<BasedOn ids={result.responseDraft.basedOn} result={result} /></p>}
    {result.warnings.length > 0 && <ul className="sp-muted">{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    {result.facts.length > 0 && <details><summary className="sp-muted">Facts used ({result.facts.length})</summary><ul>{result.facts.map(fact => <li key={fact.id}><strong>{fact.id}</strong> {fact.label}: {fact.value}</li>)}</ul></details>}
  </div>
}

/**
 * Optional help with client feedback. Every answer is a suggestion from the recorded feedback, versions and messages; it
 * never resolves feedback, approves, sends or promises anything. Core collaboration works without it.
 */
export function CollabAssistant({ workspace, projectId, deliverableId }: { workspace: WorkspaceSummary; projectId: string; deliverableId?: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null), [running, setRunning] = useState<CollabAiOperation | null>(null)
  const [result, setResult] = useState<AiResult | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    assistantConfig(workspace.id).then(value => { if (active) setConfigured(value.configured) }).catch(() => { if (active) setConfigured(false) })
    return () => { active = false }
  }, [workspace.id])
  async function run(operation: CollabAiOperation) {
    setRunning(operation); setError(''); setResult(null)
    try { setResult(await askAssistant(workspace.id, projectId, operation, { deliverableId })) } catch (cause) { setError(assistantMessage(cause)) } finally { setRunning(null) }
  }
  return <section className="cb-ai" aria-label="AI assistance">
    <h3><Icon name="spark" size={15} /> AI assistance <span className="cb-tag">Optional</span></h3>
    {configured === null ? <p className="sp-muted">Checking AI assistance…</p> : !configured ? <p className="sp-muted">AI assistance isn’t set up for this workspace. Everything else here works without it.</p> : <>
      <p className="sp-muted">Suggestions from the recorded feedback, versions and messages. They never resolve feedback, approve, send or promise anything.</p>
      <div className="cb-ai-buttons">
        <button type="button" className="secondary" disabled={!!running} onClick={() => void run('feedback_summary')}>{running === 'feedback_summary' ? 'Summarizing…' : 'Summarize feedback'}</button>
        {deliverableId && <button type="button" className="secondary" disabled={!!running} onClick={() => void run('review_prep')}>{running === 'review_prep' ? 'Preparing…' : 'Prepare review notes'}</button>}
        <button type="button" className="secondary" disabled={!!running} onClick={() => void run('discussion_summary')}>{running === 'discussion_summary' ? 'Summarizing…' : 'Summarize discussion'}</button>
      </div></>}
    {error && <p className="sp-error" role="alert">{error}</p>}
    {result && <AssistantResult result={result} />}
  </section>
}
