import { isTaskDue, taskState } from '../lib/dates'
import { statuses, type Lead, type Status, type Task } from '../lib/model'
import { MetricCard } from './MetricCard'
import { Icon } from './Icon'
interface DashboardProps {leads:Lead[];tasks:Task[];day:string;onLeads:(status?:Status)=>void;onFollowUps:()=>void}
export function DashboardOverview({leads,tasks,day,onLeads,onFollowUps}:DashboardProps) {
  const counts=statuses.map(status=>({status,count:leads.filter(lead=>lead.status===status).length}))
  const due=tasks.filter(task=>isTaskDue(task,day))
  const overdue=due.filter(task=>taskState(task,day)==='Overdue').length
  return <>
    <div className="stats">
      <MetricCard label="Total leads" value={leads.length} hint="Your growing pipeline" icon="users" onClick={()=>onLeads()}/>
      <MetricCard label="New leads" value={counts[0].count} hint="Ready for a first hello" icon="spark" onClick={()=>onLeads('New')}/>
      <MetricCard label="Qualified leads" value={counts[2].count} hint="Potential taking shape" icon="check" onClick={()=>onLeads('Qualified')}/>
      <MetricCard label="Converted leads" value={counts[3].count} hint="New client relationships" icon="arrow" onClick={()=>onLeads('Converted')}/>
      <MetricCard label="Follow-ups due" value={due.length} hint={overdue?`${overdue} overdue · time to reconnect`:'Due today or earlier'} icon="clock" accent onClick={onFollowUps}/>
    </div>
    <div className="overview-grid">
      <section className="panel pipeline" aria-labelledby="pipeline-title">
        <div className="section-heading"><div><h2 id="pipeline-title">Pipeline snapshot</h2><p>From first hello to a new client</p></div><span className="soft-tag">{leads.length} leads</span></div>
        <div className="pipeline-bar" aria-hidden="true">{counts.map(count=><div key={count.status} className={count.status.toLowerCase()} style={{flex:count.count}}/>)}</div>
        <div className="pipeline-legend">{counts.map(count=><button key={count.status} onClick={()=>onLeads(count.status)} aria-label={`View ${count.count} ${count.status.toLowerCase()} leads`}><span className={'legend-dot '+count.status.toLowerCase()}/>{count.status}<strong>{count.count}</strong></button>)}</div>
        <div className="pipeline-foot"><span>{leads.length} leads across five stages</span><button className="text-button" onClick={()=>onLeads()}>View pipeline <Icon name="arrow" size={14}/></button></div>
      </section>
      <section className="focus-card"><span className="eyebrow">Next best action</span><h2>{due.length?`${due.length} follow-up${due.length===1?'':'s'} need${due.length===1?'s':''} you today.`:'You’re all caught up.'}</h2><p>{due.length?(overdue?`${overdue} overdue. A quick message now keeps the conversation warm.`:'Due today or earlier. A quick message now keeps the conversation warm.'):'Plan your next conversation, or run a business report on a new lead.'}</p><button onClick={onFollowUps}>Review follow-ups <Icon name="arrow" size={16}/></button></section>
    </div>
  </>
}
