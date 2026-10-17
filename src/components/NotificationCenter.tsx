import { useId, useState } from 'react'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { isTaskDue, taskState } from '../lib/dates'
import type { Lead, Task } from '../lib/model'
interface NotificationCenterProps {
  events:string[];tasks:Task[];leads:Lead[];day:string;open:boolean
  onOpen:(open:boolean)=>void;onClear:()=>void;onReview:(leadId:string)=>void
}
export function NotificationCenter({events,tasks,leads,day,open,onOpen,onClear,onReview}:NotificationCenterProps) {
  const [dismissed,setDismissed]=useState<string[]>([])
  const id=useId()
  const reminders=tasks.filter(task=>isTaskDue(task,day)&&!dismissed.includes(`${day}:${task.id}`))
  const count=events.length+reminders.length
  return <>
    <button className="notification-button" aria-label="Notifications" aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>onOpen(!open)}><Icon name="bell"/>{count>0&&<span aria-hidden="true">{count}</span>}<span className="sr-only">{count} notifications</span></button>
    {open&&<Modal title="Notifications" onClose={()=>onOpen(false)} id={id}>
      <p className="muted">Simulated workspace updates. Reminders stay inside this app; no messages are sent.</p>
      {count>0?<><button className="text-button" onClick={()=>{onClear();setDismissed(previous=>[...previous,...reminders.map(task=>`${day}:${task.id}`)])}}>Clear all notifications</button>
      <ul className="notification-list">{reminders.map(task=><li key={task.id}>
        <div><strong>{taskState(task,day)} · {leads.find(lead=>lead.id===task.leadId)?.name}</strong><p>{task.notes}</p><time dateTime={task.due}>{task.due}</time></div>
        <div className="notification-actions"><button className="text-button" onClick={()=>{onOpen(false);onReview(task.leadId)}}>View follow-up</button><button className="text-button" aria-label={`Dismiss reminder: ${task.notes}`} onClick={()=>setDismissed(previous=>[...previous,`${day}:${task.id}`])}>Dismiss</button></div>
      </li>)}{events.map((event,index)=><li key={`${index}:${event}`}><p>{event}</p></li>)}</ul></>:<div className="empty"><h3>You’re all caught up</h3><p>No new notifications.</p></div>}
      <p className="notification-help">Clearing a reminder does not complete the task. Uncleared tasks can remind you again tomorrow or after a refresh.</p>
    </Modal>}
  </>
}
