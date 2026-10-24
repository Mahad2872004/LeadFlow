import { readinessLabels, type Readiness, type ReadinessState } from '../lib/onboarding'
export function ReadinessBadge({state}:{state:ReadinessState}){return <span className={`ob-badge ob-${state}`}>{readinessLabels[state]}</span>}
/** Required items resolved. A supplement to the blocker list, never a substitute for it. */
export function ReadinessProgress({readiness}:{readiness:Readiness}){
  const resolved=readiness.requiredAccepted+readiness.requiredWaived
  return <div className="ob-progress-wrap"><div className="ob-progress" role="progressbar" aria-label="Required items resolved" aria-valuemin={0} aria-valuemax={readiness.requiredTotal} aria-valuenow={resolved} aria-valuetext={`${resolved} of ${readiness.requiredTotal} required items resolved`}><i style={{width:`${readiness.percent}%`}}/></div><small>{resolved}/{readiness.requiredTotal} required</small></div>
}
