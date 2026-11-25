import { healthLabels, progressText, projectPriorityLabels, projectStatusLabels, type Health, type ProjectPriority, type ProjectStatus, type Progress } from '../lib/projects'
import './ProjectBits.css'

/** Small pieces every project screen shares: status, health, priority and progress. */
export const ProjectStatusChip = ({ status }: { status: ProjectStatus }) => <span className={`pj-status is-${status}`}>{projectStatusLabels[status]}</span>
export const PriorityChip = ({ priority }: { priority: ProjectPriority }) => priority === 'high' || priority === 'critical' ? <span className={`pj-priority is-${priority}`}>{projectPriorityLabels[priority]}</span> : null

/** Health from the documented rules, with the reasons on hover and for screen readers. */
export function HealthBadge({ health, showReasons = false }: { health: Health; showReasons?: boolean }) {
  const reasons = health.reasons.map(reason => reason.text).join('; ')
  return <span className="pj-health-wrap">
    <span className={`pj-health is-${health.state}`} title={reasons || undefined}><i aria-hidden="true" />{healthLabels[health.state]}{reasons && <span className="sr-only">: {reasons}</span>}</span>
    {showReasons && health.reasons.length > 0 && <ul className="pj-reasons">{health.reasons.map(reason => <li key={reason.code} className={`is-${reason.level}`}>{reason.text}</li>)}</ul>}
  </span>
}

/** Progress with its basis named, so a percentage is never shown without what it counts. */
export function ProgressBar({ progress, compact = false }: { progress: Progress; compact?: boolean }) {
  const label = progressText(progress)
  return <span className={`pj-progress${compact ? ' is-compact' : ''}`} title={label}>
    <span className="pj-progress-head"><strong>{progress.percent}%</strong>{!compact && <small>{label}</small>}</span>
    <span className="pj-progress-track" role="progressbar" aria-label={`${progress.percent}% — ${label}`} aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${progress.percent}%` }} /></span>
  </span>
}
