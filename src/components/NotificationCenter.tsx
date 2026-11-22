import { useId, useState } from 'react'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { isTaskDue, taskState } from '../lib/dates'
import type { Lead, Task } from '../lib/model'
import type { SalesReminders } from '../lib/sales'
interface NotificationCenterProps {
  events:string[];tasks:Task[];leads:Lead[];day:string;open:boolean
  onOpen:(open:boolean)=>void;onClear:()=>void;onReview:(leadId:string)=>void
  /** M9: meetings in the next two days and deals due to close; shown only while relevant. */
  sales?:SalesReminders|null;onOpenDeal?:(dealId:string)=>void;userId?:string
}
export function NotificationCenter({events,tasks,leads,day,open,onOpen,onClear,onReview,sales,onOpenDeal,userId}:NotificationCenterProps) {
  const [dismissed,setDismissed]=useState<string[]>([])
  const id=useId()
  const reminders=tasks.filter(task=>isTaskDue(task,day)&&!dismissed.includes(`${day}:${task.id}`))
  const meetings=(sales?.meetings??[]).filter(item=>!dismissed.includes(`${day}:meeting:${item.id}`))
  const closing=(sales?.closing??[]).filter(item=>!dismissed.includes(`${day}:close:${item.dealId}`))
  const count=events.length+reminders.length+meetings.length+closing.length
  return <>
    <button className="notification-button" aria-label="Notifications" aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>onOpen(!open)}><Icon name="bell"/>{count>0&&<span aria-hidden="true">{count}</span>}<span className="sr-only">{count} notifications</span></button>
    {open&&<Modal title="Notifications" onClose={()=>onOpen(false)} id={id}>
      <p className="muted">Simulated workspace updates. Reminders stay inside this app; no messages are sent.</p>
      {count>0?<><button className="text-button" onClick={()=>{onClear();setDismissed(previous=>[...previous,...reminders.map(task=>`${day}:${task.id}`),...meetings.map(item=>`${day}:meeting:${item.id}`),...closing.map(item=>`${day}:close:${item.dealId}`)])}}>Clear all notifications</button>
      <ul className="notification-list">{meetings.map(item=><li key={`meeting:${item.id}`}>
        <div><strong>Meeting soon · {item.dealTitle}</strong><p>{item.title}</p><time dateTime={item.startsAt}>{new Date(item.startsAt).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'})}</time></div>
        <div className="notification-actions">{onOpenDeal&&<button className="text-button" onClick={()=>{onOpen(false);onOpenDeal(item.dealId)}}>Open deal</button>}<button className="text-button" aria-label={`Dismiss reminder: ${item.title}`} onClick={()=>setDismissed(previous=>[...previous,`${day}:meeting:${item.id}`])}>Dismiss</button></div>
      </li>)}{closing.map(item=><li key={`close:${item.dealId}`}>
        <div><strong>{item.overdue?'Close date passed':'Closing soon'} · {item.title}</strong><p>{item.overdue?'Update the expected close date, or mark the deal won or lost.':'Expected to close'}{userId&&item.ownerId===userId?' · You own this deal':''}</p><time dateTime={item.expectedCloseDate}>{item.expectedCloseDate}</time></div>
        <div className="notification-actions">{onOpenDeal&&<button className="text-button" onClick={()=>{onOpen(false);onOpenDeal(item.dealId)}}>Open deal</button>}<button className="text-button" aria-label={`Dismiss reminder: ${item.title}`} onClick={()=>setDismissed(previous=>[...previous,`${day}:close:${item.dealId}`])}>Dismiss</button></div>
      </li>)}{reminders.map(task=><li key={task.id}>
        <div><strong>{taskState(task,day)} · {leads.find(lead=>lead.id===task.leadId)?.name}</strong><p>{task.notes}{userId&&task.assigneeId===userId?' · Assigned to you':''}</p><time dateTime={task.due}>{task.due}</time></div>
        <div className="notification-actions"><button className="text-button" onClick={()=>{onOpen(false);onReview(task.leadId)}}>View follow-up</button><button className="text-button" aria-label={`Dismiss reminder: ${task.notes}`} onClick={()=>setDismissed(previous=>[...previous,`${day}:${task.id}`])}>Dismiss</button></div>
      </li>)}{events.map((event,index)=><li key={`${index}:${event}`}><p>{event}</p></li>)}</ul></>:<div className="empty"><h3>You’re all caught up</h3><p>No new notifications.</p></div>}
      <p className="notification-help">Clearing a reminder does not complete the task. Uncleared tasks can remind you again tomorrow or after a refresh.</p>
    </Modal>}
  </>
}
