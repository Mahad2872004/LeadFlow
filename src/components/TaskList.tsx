import type { Lead, Task } from '../lib/model'
import { taskState } from '../lib/dates'
import { dateLabel } from '../lib/format'
interface TaskListProps {tasks:Task[];leads:Lead[];day:string;onToggle:(task:Task)=>void;onSelect:(id:string)=>void;emptyMessage?:string}
export function TaskList({tasks,leads,day,onToggle,onSelect,emptyMessage='No follow-ups to show.'}:TaskListProps) {
  if(!tasks.length) return <div className="empty"><h3>All clear here</h3><p>{emptyMessage}</p></div>
  return <div className="task-list">{tasks.toSorted((a,b)=>a.due.localeCompare(b.due)).map(task=>{
    const state=taskState(task,day)
    return <div className={'task '+(task.completed?'done':'')} key={task.id}>
      <input type="checkbox" checked={task.completed} aria-label={`${task.completed?'Reopen':'Complete'} ${task.notes}`} onChange={()=>onToggle(task)}/>
      <div><strong>{task.notes}</strong><button className="text-button" onClick={()=>onSelect(task.leadId)}>{leads.find(lead=>lead.id===task.leadId)?.name}</button></div>
      <span className={'due-date task-state '+state.toLowerCase().replace(' ','-')}><span>{state}</span><time dateTime={task.due} title={task.due}>{dateLabel(task.due)}</time></span>
    </div>
  })}</div>
}
