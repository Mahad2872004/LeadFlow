import type { Lead, Task } from '../lib/model'
import { taskState } from '../lib/dates'
import { dateLabel } from '../lib/format'
import { priorityLabels, taskTypeLabels } from '../lib/sales'
/** clients names client tasks (M10), which have no lead; onOpenClient opens the client. */
interface TaskListProps {tasks:Task[];leads:Lead[];day:string;onToggle:(task:Task)=>void;onSelect:(id:string)=>void;emptyMessage?:string;onCancel?:(task:Task)=>void;onOpenDeal?:(dealId:string)=>void;members?:Map<string,string>;clients?:Map<string,string>;onOpenClient?:(clientId:string)=>void}
export function TaskList({tasks,leads,day,onToggle,onSelect,emptyMessage='No follow-ups to show.',onCancel,onOpenDeal,members,clients,onOpenClient}:TaskListProps) {
  if(!tasks.length) return <div className="empty"><h3>All clear here</h3><p>{emptyMessage}</p></div>
  return <div className="task-list">{tasks.toSorted((a,b)=>a.due.localeCompare(b.due)).map(task=>{
    const state=taskState(task,day)
    // Type, priority, deal and assignee exist on follow-ups planned since M9; older ones show as before.
    const assignee=task.assigneeId?members?.get(task.assigneeId):undefined
    const chips=(task.taskType&&task.taskType!=='follow_up')||task.priority==='high'||task.dealId||assignee
    return <div className={'task '+(task.completed||task.cancelled?'done':'')} key={task.id}>
      <input type="checkbox" checked={task.completed} disabled={task.cancelled} aria-label={`${task.completed?'Reopen':'Complete'} ${task.notes}`} onChange={()=>onToggle(task)}/>
      <div><strong>{task.notes}</strong>{task.leadId?<button className="text-button" onClick={()=>onSelect(task.leadId!)}>{leads.find(lead=>lead.id===task.leadId)?.name}</button>
        :task.clientId&&<button className="text-button" disabled={!onOpenClient} onClick={()=>onOpenClient?.(task.clientId!)}>{clients?.get(task.clientId)??'Client'}<span className="sr-only"> (client)</span></button>}
        {chips&&<span className="task-chips">{task.taskType&&task.taskType!=='follow_up'&&<span className="sp-chip">{taskTypeLabels[task.taskType]}</span>}{task.priority==='high'&&<span className="sp-chip is-high">{priorityLabels.high} priority</span>}
          {task.dealId&&(onOpenDeal?<button className="sp-chip" onClick={()=>onOpenDeal(task.dealId!)}>Deal</button>:<span className="sp-chip">Deal</span>)}{assignee&&<span className="sp-chip">{assignee}</span>}</span>}
        {onCancel&&!task.completed&&<button className="text-button task-cancel" onClick={()=>onCancel(task)}>{task.cancelled?'Restore':'Cancel'}</button>}</div>
      <span className={'due-date task-state '+state.toLowerCase().replace(' ','-')}><span>{state}</span><time dateTime={task.due} title={task.due}>{dateLabel(task.due)}</time></span>
    </div>
  })}</div>
}
