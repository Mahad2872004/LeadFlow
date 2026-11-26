import { useEffect, useId, useState } from 'react'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { isTaskDue, taskState } from '../lib/dates'
import type { Lead, Task } from '../lib/model'
import type { SalesReminders } from '../lib/sales'
import { collabTime, markMemberNotifications, memberNotifications, type MemberNotification } from '../lib/collaboration'
import './ProjectCollaboration.css'
interface NotificationCenterProps {
  events:string[];tasks:Task[];leads:Lead[];day:string;open:boolean
  onOpen:(open:boolean)=>void;onClear:()=>void;onReview:(leadId:string)=>void
  /** M10: client tasks have no lead; they name and open their client. */
  clients?:Map<string,string>;onOpenClient?:(clientId:string)=>void
  /** M9: meetings in the next two days and deals due to close; shown only while relevant. */
  sales?:SalesReminders|null;onOpenDeal?:(dealId:string)=>void;userId?:string
  /** M12: client activity from the client portal (stored notifications, read state per member). */
  workspaceId?:string;onOpenProject?:(projectId:string,deliverableId?:string|null)=>void
}
export function NotificationCenter({events,tasks,leads,day,open,onOpen,onClear,onReview,sales,onOpenDeal,userId,clients,onOpenClient,workspaceId,onOpenProject}:NotificationCenterProps) {
  const [dismissed,setDismissed]=useState<string[]>([])
  const [activity,setActivity]=useState<{items:MemberNotification[];unread:number}|null>(null)
  // Checked when the bell mounts, when it opens and every minute; stops when it unmounts.
  useEffect(()=>{
    if(!workspaceId)return
    let active=true
    const check=()=>memberNotifications(workspaceId).then(value=>{if(active)setActivity(value)}).catch(()=>undefined)
    void check()
    const timer=window.setInterval(()=>void check(),60000)
    return()=>{active=false;window.clearInterval(timer)}
  },[workspaceId,open])
  const unreadClient=activity?.unread??0
  const markRead=(ids:number[]|null)=>{if(!workspaceId)return;setActivity(current=>current&&{items:current.items.map(item=>ids===null||ids.includes(item.id)?{...item,readAt:item.readAt??new Date().toISOString()}:item),unread:ids===null?0:Math.max(0,current.unread-current.items.filter(item=>ids.includes(item.id)&&!item.readAt).length)});void markMemberNotifications(workspaceId,ids).catch(()=>undefined)}
  const id=useId()
  const reminders=tasks.filter(task=>isTaskDue(task,day)&&!dismissed.includes(`${day}:${task.id}`))
  const meetings=(sales?.meetings??[]).filter(item=>!dismissed.includes(`${day}:meeting:${item.id}`))
  const closing=(sales?.closing??[]).filter(item=>!dismissed.includes(`${day}:close:${item.dealId}`))
  const count=events.length+reminders.length+meetings.length+closing.length
  const badge=count+unreadClient
  return <>
    <button className="notification-button" aria-label="Notifications" aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>onOpen(!open)}><Icon name="bell"/>{badge>0&&<span aria-hidden="true">{badge}</span>}<span className="sr-only">{badge} notifications</span></button>
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
        <div><strong>{taskState(task,day)} · {task.leadId?leads.find(lead=>lead.id===task.leadId)?.name:clients?.get(task.clientId??'')??'Client task'}</strong><p>{task.notes}{userId&&task.assigneeId===userId?' · Assigned to you':''}</p><time dateTime={task.due}>{task.due}</time></div>
        <div className="notification-actions">{task.leadId?<button className="text-button" onClick={()=>{onOpen(false);onReview(task.leadId!)}}>View follow-up</button>:task.clientId&&onOpenClient&&<button className="text-button" onClick={()=>{onOpen(false);onOpenClient(task.clientId!)}}>Open client</button>}<button className="text-button" aria-label={`Dismiss reminder: ${task.notes}`} onClick={()=>setDismissed(previous=>[...previous,`${day}:${task.id}`])}>Dismiss</button></div>
      </li>)}{events.map((event,index)=><li key={`${index}:${event}`}><p>{event}</p></li>)}</ul></>:unreadClient?null:<div className="empty"><h3>You’re all caught up</h3><p>No new notifications.</p></div>}
      {activity&&activity.items.length>0&&<PortalActivity items={activity.items} unread={unreadClient} onMarkAll={()=>markRead(null)}
        onOpenItem={item=>{if(!item.readAt)markRead([item.id]);if(item.projectId&&onOpenProject){onOpen(false);onOpenProject(item.projectId,item.deliverableId)}}}/>}
      <p className="notification-help">Clearing a reminder does not complete the task. Uncleared tasks can remind you again tomorrow or after a refresh.</p>
    </Modal>}
  </>
}

/** M12: what clients did on the client portal, newest first. */
function PortalActivity({items,unread,onMarkAll,onOpenItem}:{items:MemberNotification[];unread:number;onMarkAll:()=>void;onOpenItem:(item:MemberNotification)=>void}){
  return <section className="cb-activity" aria-labelledby="cb-activity-title">
    <div className="cb-activity-head"><h3 id="cb-activity-title">Client activity{unread>0&&<span className="number-tag">{unread}</span>}</h3>{unread>0&&<button className="text-button" onClick={onMarkAll}>Mark all read</button>}</div>
    <ul className="cb-activity-list">{items.slice(0,15).map(item=><li key={item.id} className={item.readAt?'':'is-unread'}>
      <div><strong>{item.title}</strong>{item.body&&<p>{item.body}</p>}<time dateTime={item.createdAt}>{collabTime(item.createdAt)}</time></div>
      <button className="text-button" onClick={()=>onOpenItem(item)}>{item.projectId?'Open':'Mark read'}<span className="sr-only">: {item.title}</span></button>
    </li>)}</ul>
  </section>
}
