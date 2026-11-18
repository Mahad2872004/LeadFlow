import { isTaskDue, taskState } from '../lib/dates'
import { leadsPerDay, runningTotal } from '../lib/insights'
import { statuses, type Lead, type Status, type Task } from '../lib/model'
import { MetricCard } from './MetricCard'
import { Icon, type IconName } from './Icon'

interface DashboardProps {
  leads: Lead[]; tasks: Task[]; day: string
  onLeads: (status?: Status) => void; onFollowUps: () => void
  onOpenLead: (id: string) => void; onPlan: (leadId: string) => void; onDiscovery: () => void
}
interface Suggestion { id: string; icon: IconName; title: string; detail: string; action: string; run: () => void }
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const domainOf = (url?: string) => { try { return url ? new URL(url).hostname.replace(/^www\./, '') : '' } catch { return '' } }

export function DashboardOverview({ leads, tasks, day, onLeads, onFollowUps, onOpenLead, onPlan, onDiscovery }: DashboardProps) {
  const counts = statuses.map(status => ({ status, count: leads.filter(lead => lead.status === status).length }))
  const [fresh, , qualified, converted, lost] = counts.map(item => item.count)
  const total = leads.length
  const due = tasks.filter(task => isTaskDue(task, day))
  const overdue = due.filter(task => taskState(task, day) === 'Overdue').length
  const perDay = leadsPerDay(leads, day)
  const thisWeek = perDay.slice(-7).reduce((sum, value) => sum + value, 0)
  const share = (count: number) => total ? count / total : 0
  const closed = converted + lost
  const winRate = closed ? Math.round(converted / closed * 100) : null
  const largest = Math.max(1, ...counts.map(item => item.count))

  // Suggestions come from the pipeline itself: deterministic rules, not AI.
  const withOpenTask = new Set(tasks.filter(task => !task.completed).map(task => task.leadId))
  const suggestions: Suggestion[] = []
  if (due.length) suggestions.push({ id: 'due', icon: 'calendar', title: `${plural(due.length, 'follow-up')} need${due.length === 1 ? 's' : ''} you today.`, detail: overdue ? `${overdue} overdue. A quick message now keeps the conversation warm.` : 'Due today. A quick message now keeps the conversation warm.', action: 'Review follow-ups', run: onFollowUps })
  const newLeads = leads.filter(lead => lead.status === 'New')
  if (newLeads.length) suggestions.push({ id: 'new', icon: 'spark', title: `${plural(newLeads.length, 'new lead')} waiting for a first reply`, detail: newLeads.slice(0, 2).map(lead => lead.name).join(', ') + (newLeads.length > 2 ? ` and ${newLeads.length - 2} more` : ''), action: 'See new leads', run: () => onLeads('New') })
  const stalled = leads.find(lead => lead.status === 'Qualified' && !withOpenTask.has(lead.id))
  if (stalled) suggestions.push({ id: 'stalled', icon: 'clock', title: `Plan the next step with ${stalled.name}`, detail: 'Qualified, with no follow-up scheduled.', action: 'Plan follow-up', run: () => onPlan(stalled.id) })
  const researchable = leads.filter(lead => lead.website && lead.status !== 'Lost' && lead.status !== 'Converted').toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (researchable) suggestions.push({ id: 'report', icon: 'search', title: `Know ${researchable.company || researchable.name} before you reach out`, detail: `Open the lead and run a business report on ${domainOf(researchable.website) || 'their website'}.`, action: 'Open lead', run: () => onOpenLead(researchable.id) })
  if (!leads.some(lead => lead.source === 'Lead discovery')) suggestions.push({ id: 'discover', icon: 'compass', title: 'Find businesses worth talking to', detail: 'Search a business directory, use Apollo, or import a CSV.', action: 'Open Discovery', run: onDiscovery })
  const [top, ...more] = suggestions

  return <>
    <div className="stats">
      <MetricCard label="Total leads" value={total} hint={thisWeek ? `+${thisWeek} in the last 7 days` : 'No new leads this week'} icon="users" trend={runningTotal(leads, day)} onClick={() => onLeads()}/>
      <MetricCard label="New leads" value={fresh} hint="Waiting for a first reply" icon="spark" trend={perDay} onClick={() => onLeads('New')}/>
      <MetricCard label="Qualified leads" value={qualified} hint={`${Math.round(share(qualified) * 100)}% of your pipeline`} icon="check" meter={share(qualified)} onClick={() => onLeads('Qualified')}/>
      <MetricCard label="Converted leads" value={converted} hint={winRate === null ? 'No closed deals yet' : `${winRate}% win rate`} icon="arrow" meter={share(converted)} onClick={() => onLeads('Converted')}/>
      <MetricCard label="Follow-ups due" value={due.length} hint={overdue ? `${overdue} overdue · time to reconnect` : 'Due today or earlier'} icon="clock" accent onClick={onFollowUps}/>
    </div>
    <div className="overview-grid">
      <section className="panel pipeline" aria-labelledby="pipeline-title">
        <div className="section-heading"><div><h2 id="pipeline-title">Pipeline snapshot</h2><p>From first hello to a new client</p></div><span className="soft-tag">{total} leads</span></div>
        <div className="pipeline-bar" aria-hidden="true">{counts.map(item => <div key={item.status} className={item.status.toLowerCase()} style={{ flex: item.count }}/>)}</div>
        <div className="pipeline-legend funnel">{counts.map(item => <button key={item.status} className="funnel-row" onClick={() => onLeads(item.status)} aria-label={`View ${item.count} ${item.status.toLowerCase()} leads`}>
          <span className="funnel-name"><span className={'legend-dot ' + item.status.toLowerCase()}/>{item.status}</span>
          <span className="funnel-track" aria-hidden="true"><span className={'funnel-fill ' + item.status.toLowerCase()} style={{ width: `${item.count ? Math.max(6, item.count / largest * 100) : 0}%` }}/></span>
          <strong>{item.count}</strong><small>{total ? Math.round(item.count / total * 100) : 0}%</small>
        </button>)}</div>
        <div className="pipeline-foot"><span>{winRate === null ? `${total} leads across five stages` : `Win rate ${winRate}% · ${converted} won, ${lost} lost`}</span><button className="text-button" onClick={() => onLeads()}>View pipeline <Icon name="arrow" size={14}/></button></div>
      </section>
      <section className="focus-card" aria-labelledby="next-action-title">
        <span className="eyebrow"><Icon name="spark" size={14}/> Next best action</span>
        <h2 id="next-action-title">{top ? top.title : 'You’re all caught up.'}</h2>
        <p>{top ? top.detail : 'Plan your next conversation, or run a business report on a new lead.'}</p>
        {top && <button onClick={top.run}>{top.action} <Icon name="arrow" size={16}/></button>}
        {more.length > 0 && <ul className="focus-list" aria-label="More suggestions">{more.slice(0, 3).map(item => <li key={item.id}>
          <span className="focus-icon"><Icon name={item.icon} size={16}/></span>
          <span className="focus-text"><strong>{item.title}</strong><small>{item.detail}</small></span>
          <button className="focus-action" onClick={item.run}>{item.action}</button>
        </li>)}</ul>}
      </section>
    </div>
  </>
}
