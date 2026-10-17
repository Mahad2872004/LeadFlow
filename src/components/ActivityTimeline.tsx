import type { Activity, Lead } from '../lib/model'
interface ActivityTimelineProps {activities:Activity[];leads?:Lead[];onSelect?:(id:string)=>void}
export function ActivityTimeline({activities,leads,onSelect}:ActivityTimelineProps) {
  if(!activities.length) return <div className="empty">Your activity will appear here.</div>
  return <ol className="activity-timeline" aria-label="Activity timeline">{activities.toSorted((a,b)=>b.at.localeCompare(a.at)).map(event=><li className="activity" key={event.id}>
    <span className="activity-dot" aria-hidden="true"/>
    <div><strong>{event.text}</strong>{leads&&onSelect&&<button className="text-button" onClick={()=>onSelect(event.leadId)}>{leads.find(lead=>lead.id===event.leadId)?.name||'Lead'}</button>}
    <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></div>
  </li>)}</ol>
}
