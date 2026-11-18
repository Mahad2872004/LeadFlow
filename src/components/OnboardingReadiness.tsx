import { useId, type ReactNode } from 'react'
import { readinessLabels, type Readiness, type ReadinessState, type ServiceType } from '../lib/onboarding'
export function ReadinessBadge({state}:{state:ReadinessState}){return <span className={`ob-badge ob-${state}`}>{readinessLabels[state]}</span>}
/** Required items resolved. A supplement to the blocker list, never a substitute for it. */
export function ReadinessProgress({readiness}:{readiness:Readiness}){
  const resolved=readiness.requiredAccepted+readiness.requiredWaived
  return <div className="ob-progress-wrap"><div className="ob-progress" role="progressbar" aria-label="Required items resolved" aria-valuemin={0} aria-valuemax={readiness.requiredTotal} aria-valuenow={resolved} aria-valuetext={`${resolved} of ${readiness.requiredTotal} required items resolved`}><i style={{width:`${readiness.percent}%`}}/></div><small>{resolved}/{readiness.requiredTotal} required</small></div>
}
/** Decorative readiness ring. The progress bar and blocker list carry the accessible information. */
export function ReadinessRing({percent}:{percent:number}){
  const gradient=`ob-ring-${useId().replace(/[^\w-]/g,'')}`,value=Math.max(0,Math.min(100,Math.round(percent))),length=2*Math.PI*15.5
  return <span className="ob-ring" aria-hidden="true"><svg viewBox="0 0 36 36" focusable="false"><defs><linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5ee0a8"/><stop offset="1" stopColor="#c4f26a"/></linearGradient></defs>
    <circle className="ob-ring-track" cx="18" cy="18" r="15.5"/>{value>0&&<circle className="ob-ring-value" cx="18" cy="18" r="15.5" stroke={`url(#${gradient})`} strokeDasharray={`${length*value/100} ${length}`} transform="rotate(-90 18 18)"/>}</svg><b>{value}%</b></span>
}
const glyphs={
  paid_ads:<><path d="M4 10.5v3a1 1 0 0 0 1 1h2.5L13 19V5L7.5 9.5H5a1 1 0 0 0-1 1Z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/></>,
  seo:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M7.5 12l2-2 1.5 1.5 2.5-3"/></>,
  social:<><path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L3.5 20l1.4-4.9a8 8 0 1 1 15.6-3.6Z"/><path d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01"/></>,
  email:<><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></>,
  other:<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>,
  lock:<><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2"/></>,
  copy:<><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/></>,
  flag:<><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></>,
} satisfies Record<string,ReactNode>
export type GlyphName=keyof typeof glyphs
/** Decorative icon for a service type or an onboarding detail. Always hidden from assistive technology. */
export function Glyph({name,size=18}:{name:GlyphName|ServiceType;size?:number}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{glyphs[name]}</svg>
}
