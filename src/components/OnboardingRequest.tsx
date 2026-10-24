import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { accessDenied, RequestError, type WorkspaceSummary } from '../lib/backend'
import { dateLabel } from '../lib/format'
import type { Lead } from '../lib/model'
import { blankItem, cleanItem, conflict, describeEvent, handOff, issueLink, itemError, itemStateLabels, kindLabels, loadRequest, portalLink, reminderBlockText, reminderIntervals, removeItem, reviewItem, revokeLinks, saveItem, serviceLabels, serviceTypes, setStatus, statusLabels, updateRequest,
  type Decision, type ItemDefinition, type Member, type RequestChanges, type RequestDetail, type RequestItem, type ReminderRecord, type ResponseValue, type ServiceType } from '../lib/onboarding'
import { ReadinessBadge, ReadinessProgress } from './OnboardingReadiness'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ItemFields } from './OnboardingItemFields'
type LoadState={status:'loading'}|{status:'error';message:string;denied:boolean;missing:boolean}|{status:'ready';detail:RequestDetail}
type Dialog={kind:'details'}|{kind:'item';item:ItemDefinition&{id?:string;locked?:boolean}}|{kind:'review';item:RequestItem;decision:Decision}|{kind:'cancel'}|{kind:'handoff'}
const when=(value:string)=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})
const failed=(cause:unknown):LoadState=>({status:'error',message:cause instanceof Error?cause.message:'Unable to load this onboarding.',denied:accessDenied(cause),missing:cause instanceof RequestError&&cause.code==='P0002'})
const reminderStatus:Record<ReminderRecord['status'],string>={pending:'Retrying',sending:'Sending',accepted:'Accepted by the email provider',failed:'Refused by the email provider',uncertain:'Outcome unknown',cancelled:'Stopped before sending'}
const explanation=(detail:RequestDetail)=>{
  const r=detail.readiness,resolved=r.requiredAccepted+r.requiredWaived,client=r.blockers.filter(b=>b.waitingOn==='client').length,agency=r.blockers.length-client
  switch(r.state){
    case 'not_open':return 'This onboarding is a draft. Review the checklist, then open it so the client can respond.'
    case 'waiting_on_client':return `${resolved} of ${r.requiredTotal} required items are resolved. ${client} ${client===1?'is':'are'} waiting on the client${agency?` and ${agency} on your review`:''}.`
    case 'awaiting_review':return `The client has provided every required item. ${agency} ${agency===1?'needs':'need'} your review before delivery can start.`
    case 'ready':return r.requiredTotal?'Every required item is accepted or marked not required. Confirm readiness to hand this client off to delivery.':'This checklist has no required items, so nothing blocks delivery. Confirm readiness to hand off.'
    case 'paused':return `Paused: the client can view the checklist but can’t respond, and no reminders are sent. ${r.requirementsMet?'All required items are resolved.':`${r.blockers.length} required ${r.blockers.length===1?'item is':'items are'} outstanding.`}`
    case 'cancelled':return `Cancelled${detail.cancelReason?`: ${detail.cancelReason}`:''}. No reminders are sent and the checklist can’t change.`
    case 'handed_off':return `Readiness was confirmed${detail.handoff?` on ${when(detail.handoff.handedOffAt)} by ${detail.handoff.handedOffBy}`:''}.`
  }
}
const safeUrl=(value:string)=>/^https?:\/\//i.test(value)?value:null
function ResponseView({item}:{item:RequestItem}){
  const value:ResponseValue|null=item.response
  if(!value)return <p className="ob-muted">{item.hasDraft?'The client has saved a draft but hasn’t submitted it.':'No response yet.'}</p>
  const note=value.note?<p className="ob-note"><strong>Client note:</strong> {value.note}</p>:null
  if(item.kind==='text')return <p className="message">{value.text}</p>
  if(item.kind==='choice')return <><p className="ob-answer">{value.choice}</p>{note}</>
  if(item.kind==='links')return <><ul className="ob-links">{(value.links??[]).map(link=><li key={link}>{safeUrl(link)?<a href={link} target="_blank" rel="noopener noreferrer nofollow">{link}</a>:link}</li>)}</ul>{note}</>
  return <><p className="ob-answer">{item.state==='accepted'?'Access confirmed by your team':'The client says access has been granted. Check it in the platform before confirming.'}</p>{note}</>
}
interface RequestProps { workspace: WorkspaceSummary; requestId: string; members: Member[]; leads: Lead[]; onBack: (message?: string) => void }
export function OnboardingRequest({workspace,requestId,members,leads,onBack}:RequestProps){
  const [state,setState]=useState<LoadState>({status:'loading'})
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [dialog,setDialog]=useState<Dialog|null>(null),[newLink,setNewLink]=useState<{token:string;expiresAt:string}|null>(null),[linkDays,setLinkDays]=useState(30)
  const [allEvents,setAllEvents]=useState(false)
  const reload=useCallback(()=>loadRequest(workspace.id,requestId).then(detail=>setState({status:'ready',detail}),cause=>setState(failed(cause))),[workspace.id,requestId])
  useEffect(()=>{
    let active=true
    loadRequest(workspace.id,requestId).then(detail=>{if(active)setState({status:'ready',detail})},cause=>{if(active)setState(failed(cause))})
    return()=>{active=false}
  },[workspace.id,requestId])
  /** Runs one change, then reloads. A conflict reloads the latest version so the user can decide again. */
  async function run(action:()=>Promise<unknown>,success:string){
    if(busy)return false
    setBusy(true);setError('');setNotice('')
    try{await action();await reload();setNotice(success);return true}
    catch(cause){
      if(conflict(cause)){await reload();setError(`${cause instanceof Error?cause.message:''} We’ve loaded the latest version.`)}
      else setError(cause instanceof Error?cause.message:'Something went wrong. Please try again.')
      return false
    }finally{setBusy(false)}
  }
  const back=<button className="text-button ob-back" onClick={()=>onBack()}>← All onboarding requests</button>
  if(state.status==='loading')return <div>{back}<div className="content-skeleton" role="status"><span className="sr-only">Loading onboarding…</span><i className="skeleton skeleton-title"/><i className="skeleton skeleton-panel"/></div></div>
  if(state.status==='error')return <div>{back}<div className="error-banner load-error" role="alert"><p><strong>{state.missing?'This onboarding isn’t in this workspace.':state.denied?'You don’t have access to this onboarding.':'We couldn’t load this onboarding.'}</strong> {state.message}</p>{!state.missing&&<button className="secondary" onClick={()=>{setState({status:'loading'});void reload()}}>Try again</button>}</div></div>
  const {detail}=state
  const open=detail.status!=='completed'&&detail.status!=='cancelled'
  const canCancel=workspace.role!=='member'
  const sharedLinks=detail.links.filter(link=>link.purpose==='shared'&&link.active),reminderLinks=detail.links.filter(link=>link.purpose==='reminder'&&link.active)
  const ownerName=detail.ownerId?members.find(member=>member.id===detail.ownerId)?.name??'Former member':'Unassigned'
  const sections=detail.items.reduce<[string,RequestItem[]][]>((groups,item)=>{const group=groups.find(([name])=>name===item.section);if(group)group[1].push(item);else groups.push([item.section,[item]]);return groups},[])
  const review=(item:RequestItem,decision:Decision,note='')=>run(()=>reviewItem(workspace.id,detail.id,item.id,decision,note,item.revision),
    decision==='accept'?`${item.title} accepted.`:decision==='request_changes'?`Changes requested on ${item.title}. The client will see your message.`:decision==='not_required'?`${item.title} marked not required.`:`${item.title} restored.`)
  const status=(transition:'activate'|'pause'|'resume'|'cancel',message:string,reason?:string)=>run(()=>setStatus(workspace.id,detail.id,transition,detail.version,reason),message)
  const events=allEvents?detail.events:detail.events.slice(0,40)
  return <div className="ob-detail">
    {back}
    <header className="panel ob-detail-head">
      <div><p className="eyebrow">{serviceLabels[detail.serviceType].toUpperCase()} · {statusLabels[detail.status].toUpperCase()}</p><h2>{detail.title}</h2><p>{detail.clientName}{detail.contactName?` · ${detail.contactName}`:''} · Owner: {ownerName}</p></div>
      <div className="ob-head-actions">
        {detail.status==='draft'&&<button className="primary" disabled={busy} onClick={()=>status('activate','Opened. Share the client link so they can start.')}>Open to client</button>}
        {detail.status==='active'&&<button className="secondary" disabled={busy} onClick={()=>status('pause','Paused. The client can’t respond and no reminders are sent.')}>Pause</button>}
        {detail.status==='paused'&&<button className="primary" disabled={busy} onClick={()=>status('resume','Resumed. The client can respond again.')}>Resume</button>}
        {open&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'details'})}>Edit details</button>}
        <button className="text-button" disabled={busy} onClick={()=>run(async()=>{},'Showing the latest responses.')}>Check for updates</button>
        {open&&canCancel&&<button className="text-button ob-danger" disabled={busy} onClick={()=>setDialog({kind:'cancel'})}>Cancel onboarding</button>}
      </div>
    </header>
    {busy&&<p role="status" className="sr-only">Saving…</p>}
    {notice&&<div className="toast" role="status">✓ {notice}</div>}
    {error&&<div className="error-banner" role="alert">{error}</div>}
    <div className="ob-detail-grid">
      <div className="ob-main">
        <section className="panel ob-panel ob-readiness" aria-labelledby="ob-readiness-title">
          <div className="settings-heading"><div><h2 id="ob-readiness-title">Readiness</h2><p>{explanation(detail)}</p></div><ReadinessBadge state={detail.readiness.state}/></div>
          <ReadinessProgress readiness={detail.readiness}/>
          <p className="ob-muted">{detail.readiness.requiredAccepted} accepted · {detail.readiness.requiredWaived} marked not required · {detail.readiness.optionalOutstanding} of {detail.readiness.optionalTotal} optional still open (optional items never block)</p>
          {detail.readiness.blockers.length>0&&detail.status!=='cancelled'&&<><h3>Blocking delivery <span className="number-tag">{detail.readiness.blockers.length}</span></h3>
            <ul className="ob-blockers">{detail.readiness.blockers.map(blocker=><li key={blocker.itemId}><a href={`#item-${blocker.itemId}`}>{blocker.title}</a><span>{blocker.reason}</span><span className={`ob-waiting ob-waiting-${blocker.waitingOn}`}>{blocker.waitingOn==='client'?'Client':'Your team'}</span></li>)}</ul></>}
          <details className="ob-how"><summary>How readiness is calculated</summary><p>A request is ready when it is open and every <strong>required</strong> item is accepted by your team or marked not required with a reason. Optional items never block. Anything the client submits, including account access they say they’ve granted, counts only after someone on your team accepts it. LeadFlow doesn’t connect to ad, analytics or email platforms, so it can’t verify access itself. The percentage only summarises this list.</p></details>
          {detail.status==='active'&&detail.readiness.requirementsMet&&<button className="primary" disabled={busy} onClick={()=>setDialog({kind:'handoff'})}>Confirm readiness and hand off</button>}
          {detail.handoff&&<div className="ob-handoff"><strong>Handed off to delivery</strong><p>{when(detail.handoff.handedOffAt)} by {detail.handoff.handedOffBy}. Reference <code>{detail.handoff.id}</code>.</p>{detail.handoff.note&&<p>{detail.handoff.note}</p>}<p className="ob-muted">The handoff records the accepted checklist. Nothing was launched, sent or created in other tools.</p></div>}
        </section>
        <section className="panel ob-panel" aria-labelledby="ob-checklist-title">
          <div className="settings-heading"><div><h2 id="ob-checklist-title">Client checklist</h2><p>{detail.templateName?`Copied from “${detail.templateName}”. Changes here affect only this client.`:'Built for this client.'}</p></div>
            {open&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'item',item:blankItem()})}><Icon name="plus" size={16}/> Add item</button>}</div>
          {detail.items.length===0&&<div className="ob-empty"><p>No items yet. Add what you need from the client before delivery can start.</p></div>}
          {sections.map(([section,items])=><div key={section}><h3 className="ob-section-title">{section}</h3><ul className="ob-items">{items.map(item=><li key={item.id} id={`item-${item.id}`} className={`ob-item ob-item-${item.state}`}>
            <div className="ob-item-head"><div><strong>{item.title}</strong><div className="ob-item-tags"><span className="ob-tag">{item.required?'Required':'Optional'}</span><span className="ob-tag">{kindLabels[item.kind]}</span>{item.dueDate&&<span className="ob-tag">Due {dateLabel(item.dueDate)}</span>}{item.overdue&&<span className="ob-tag ob-tag-overdue">Overdue</span>}</div></div>
              <span className={`ob-state ob-state-${item.state}`}>{itemStateLabels[item.state]}</span></div>
            {item.guidance&&<p className="ob-guidance">{item.guidance}</p>}
            <ResponseView item={item}/>
            {item.clientFeedback&&<p className="ob-feedback"><strong>Your message to the client:</strong> {item.clientFeedback}</p>}
            {item.state==='not_required'&&item.waiveReason&&<p className="ob-internal"><strong>Not required (agency only):</strong> {item.waiveReason}</p>}
            {item.internalNote&&<p className="ob-internal"><strong>Internal note:</strong> {item.internalNote}</p>}
            {open&&<div className="ob-item-actions">
              {item.state==='submitted'&&<button className="primary" disabled={busy} onClick={()=>review(item,'accept')}>{item.kind==='access'?'Confirm access works':'Accept'}</button>}
              {(item.state==='not_started'||item.state==='changes_requested')&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'review',item,decision:'accept'})}>{item.kind==='access'?'Confirm access without submission':'Accept without submission'}</button>}
              {(item.state==='submitted'||item.state==='accepted')&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'review',item,decision:'request_changes'})}>Request changes</button>}
              {item.state==='not_required'?<button className="text-button" disabled={busy} onClick={()=>review(item,'restore')}>Restore</button>:<button className="text-button" disabled={busy} onClick={()=>setDialog({kind:'review',item,decision:'not_required'})}>Mark not required</button>}
              <button className="text-button" disabled={busy} onClick={()=>setDialog({kind:'item',item:{id:item.id,section:item.section,title:item.title,guidance:item.guidance,kind:item.kind,options:item.options,required:item.required,dueDate:item.dueDate,internalNote:item.internalNote,locked:!!item.response||item.hasDraft}})}>Edit item</button>
              {!item.response&&<button className="text-button ob-danger" disabled={busy} onClick={()=>run(()=>removeItem(workspace.id,detail.id,item.id,detail.version),`${item.title} removed.`)}>Remove</button>}
            </div>}
          </li>)}</ul></div>)}
        </section>
        <section className="panel ob-panel" aria-labelledby="ob-activity-title">
          <div className="settings-heading"><div><h2 id="ob-activity-title">Activity</h2><p>Submissions, reviews, reminders and status changes for this onboarding.</p></div><span className="soft-tag">{detail.events.length} events</span></div>
          <ol className="ob-timeline">{events.map(event=><li key={event.id}><span className={`ob-dot ob-dot-${event.actorType}`} aria-hidden="true"/><div><strong>{describeEvent(event)}</strong><small>{event.actorName} · <time dateTime={event.at}>{when(event.at)}</time></small></div></li>)}</ol>
          {detail.events.length>events.length&&<button className="text-button" onClick={()=>setAllEvents(true)}>Show all {detail.events.length} events</button>}
        </section>
      </div>
      <aside className="ob-side">
        <section className="panel ob-panel" aria-labelledby="ob-link-title">
          <div className="settings-heading"><div><h2 id="ob-link-title"><Icon name="link" size={18}/> Client link</h2><p>A private link to this checklist only. The client doesn’t need an account.</p></div></div>
          {newLink&&<NewLink token={newLink.token} expiresAt={newLink.expiresAt}/>}
          {sharedLinks.length>0?<ul className="ob-link-list">{sharedLinks.map(link=><li key={link.id}><span>Created {when(link.createdAt)}<br/>Expires {when(link.expiresAt)} · {link.lastUsedAt?`last opened ${when(link.lastUsedAt)}`:'not opened yet'}</span>{open&&<button className="text-button ob-danger" disabled={busy} onClick={()=>run(()=>revokeLinks(workspace.id,detail.id,link.id),'Link revoked. It stops working immediately.').then(ok=>{if(ok)setNewLink(null)})}>Revoke</button>}</li>)}</ul>
            :<p className="ob-muted">{open?'No active link. Create one to share with the client.':'No active link.'}</p>}
          {reminderLinks.length>0&&<p className="ob-muted">Reminder emails carry their own private links ({reminderLinks.length} active). Revoking all links stops those too.</p>}
          {open&&<div className="ob-link-controls">
            <label>Link lasts<select value={linkDays} onChange={event=>setLinkDays(Number(event.target.value))}>{[7,14,30,60,90].map(days=><option key={days} value={days}>{days} days</option>)}</select></label>
            <button className={sharedLinks.length?'secondary':'primary'} disabled={busy} onClick={async()=>{let issued:{token:string;expiresAt:string}|null=null;if(await run(async()=>{issued=await issueLink(workspace.id,detail.id,linkDays,true)},sharedLinks.length?'New link created. Earlier links no longer work.':'Link created. Copy it now.'))setNewLink(issued)}}>{sharedLinks.length?'Replace link':'Create client link'}</button>
            {(sharedLinks.length>0||reminderLinks.length>0)&&<button className="text-button ob-danger" disabled={busy} onClick={()=>run(()=>revokeLinks(workspace.id,detail.id),'Every link for this onboarding was revoked.').then(ok=>{if(ok)setNewLink(null)})}>Revoke all links</button>}
          </div>}
          {detail.status==='draft'&&<p className="ob-hint">Until you open the request, the link shows the client that their checklist isn’t ready yet.</p>}
        </section>
        <Reminders detail={detail} open={open} busy={busy} onSave={(changes,message)=>run(()=>updateRequest(workspace.id,detail.id,changes,detail.version),message)}/>
        <section className="panel ob-panel" aria-labelledby="ob-details-title">
          <div className="settings-heading"><div><h2 id="ob-details-title">Details</h2></div></div>
          <dl className="settings-meta ob-meta">
            <div><dt>Contact</dt><dd>{detail.contactName||'Not set'}{detail.contactEmail&&<><br/>{detail.contactEmail}</>}</dd></div>
            <div><dt>Start</dt><dd>{detail.startDate?dateLabel(detail.startDate):'Not set'}</dd></div>
            <div><dt>Target kickoff</dt><dd>{detail.targetKickoffDate?dateLabel(detail.targetKickoffDate):'Not set'}</dd></div>
            <div><dt>Client inputs due</dt><dd>{detail.dueDate?dateLabel(detail.dueDate):'Not set'}</dd></div>
            <div><dt>Linked lead</dt><dd>{detail.leadId?(detail.leadExists?leads.find(lead=>lead.id===detail.leadId)?.name??'Linked':'Linked lead no longer exists'):'None'}</dd></div>
            <div><dt>Created</dt><dd>{when(detail.createdAt)}</dd></div>
          </dl>
          {detail.clientInstructions&&<><h3>Instructions for the client</h3><p className="message">{detail.clientInstructions}</p></>}
          {detail.internalNote&&<><h3>Internal note</h3><p className="message">{detail.internalNote}</p></>}
        </section>
      </aside>
    </div>
    {dialog?.kind==='details'&&<DetailsDialog detail={detail} members={members} leads={leads} onClose={()=>setDialog(null)} onSave={async changes=>{if(await run(()=>updateRequest(workspace.id,detail.id,changes,detail.version),'Details saved.'))setDialog(null)}}/>}
    {dialog?.kind==='item'&&<ItemDialog item={dialog.item} busy={busy} onClose={()=>setDialog(null)} onSave={async item=>{if(await run(()=>saveItem(workspace.id,detail.id,item,detail.version),item.id?`${item.title} updated.`:`${item.title} added.`))setDialog(null)}}/>}
    {dialog?.kind==='review'&&<ReviewDialog item={dialog.item} decision={dialog.decision} busy={busy} onClose={()=>setDialog(null)} onSave={async note=>{if(await review(dialog.item,dialog.decision,note))setDialog(null)}}/>}
    {dialog?.kind==='cancel'&&<NoteDialog title="Cancel this onboarding?" label="Reason (optional, agency only)" confirm="Cancel onboarding" busy={busy} onClose={()=>setDialog(null)} onSave={async reason=>{if(await status('cancel','Onboarding cancelled. Reminders stopped.',reason))setDialog(null)}}>
      <p>The client will see that this onboarding is closed, and no more reminders are sent. Their responses stay here for your records. This can’t be undone.</p></NoteDialog>}
    {dialog?.kind==='handoff'&&<NoteDialog title="Confirm readiness and hand off?" label="Handoff note (optional)" confirm="Confirm and hand off" busy={busy} onClose={()=>setDialog(null)} onSave={async note=>{if(await run(()=>handOff(workspace.id,detail.id,note),'Readiness confirmed and recorded.'))setDialog(null)}}>
      <p>All {detail.readiness.requiredTotal} required items are resolved. Confirming records the date and a snapshot of the accepted responses, closes the checklist and stops reminders. It doesn’t launch campaigns, create tasks or notify anyone.</p></NoteDialog>}
  </div>
}
function NewLink({token,expiresAt}:{token:string;expiresAt:string}){
  const [feedback,setFeedback]=useState(''),url=portalLink(token)
  return <div className="ob-new-link"><label>Copy this link now<input readOnly value={url} onFocus={event=>event.currentTarget.select()}/></label>
    <button className="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(url);setFeedback('Copied to clipboard.')}catch{setFeedback('Copy unavailable. Select the link and copy it manually.')}}}>Copy link</button>
    {feedback&&<p role="status">{feedback}</p>}
    <p className="ob-hint">Expires {when(expiresAt)}. LeadFlow keeps only a fingerprint of this link, so it can’t show it again. If it’s lost, replace it.</p></div>
}
function Reminders({detail,open,busy,onSave}:{detail:RequestDetail;open:boolean;busy:boolean;onSave:(changes:RequestChanges,message:string)=>Promise<boolean>}){
  const settings=detail.reminders
  const [every,setEvery]=useState(settings.intervalDays===null?'off':String(settings.intervalDays)),[max,setMax]=useState(settings.max)
  const dirty=(every==='off'?null:Number(every))!==settings.intervalDays||max!==settings.max
  return <section className="panel ob-panel" aria-labelledby="ob-reminders-title">
    <div className="settings-heading"><div><h2 id="ob-reminders-title">Reminders</h2><p>Emails the client a private link listing only the required items still waiting on them.</p></div></div>
    {open&&<form className="ob-reminder-form" onSubmit={event=>{event.preventDefault();void onSave({reminderIntervalDays:every==='off'?null:Number(every),reminderMax:max},every==='off'?'Reminders turned off.':'Reminder settings saved.')}}>
      <label>Send<select value={every} onChange={event=>setEvery(event.target.value)}><option value="off">No reminders</option>{reminderIntervals.map(days=><option key={days} value={days}>Every {days} days</option>)}</select></label>
      <label>At most<select value={max} disabled={every==='off'} onChange={event=>setMax(Number(event.target.value))}>{[1,2,3,4,5].map(count=><option key={count} value={count}>{count} {count===1?'reminder':'reminders'}</option>)}</select></label>
      {dirty&&<button className="secondary" disabled={busy}>Save</button>}
    </form>}
    <p className="ob-reminder-status"><strong>{settings.nextAt?`Next reminder after ${when(settings.nextAt)}`:settings.blockedBy?reminderBlockText[settings.blockedBy]:'No reminder scheduled.'}</strong><br/>{settings.scheduled} of {settings.max} used{detail.contactEmail?` · to ${detail.contactEmail}`:''}</p>
    {settings.history.length>0&&<ul className="ob-reminder-history">{settings.history.map(reminder=><li key={reminder.id}><span>#{reminder.sequence} · {reminderStatus[reminder.status]}</span><small>{when(reminder.updatedAt)}{reminder.lastError?` · ${reminder.lastError}`:''}</small></li>)}</ul>}
    <p className="ob-hint">Reminders go out only when your administrator has scheduled LeadFlow’s reminder worker. Acceptance by the email provider doesn’t confirm delivery.</p>
  </section>
}
function DetailsDialog({detail,members,leads,onClose,onSave}:{detail:RequestDetail;members:Member[];leads:Lead[];onClose:()=>void;onSave:(changes:RequestChanges)=>Promise<void>}){
  const initial={title:detail.title,clientName:detail.clientName,contactName:detail.contactName,contactEmail:detail.contactEmail??'',serviceType:detail.serviceType,ownerId:detail.ownerId??'',startDate:detail.startDate??'',targetKickoffDate:detail.targetKickoffDate??'',dueDate:detail.dueDate??'',leadId:detail.leadId??'',clientInstructions:detail.clientInstructions,internalNote:detail.internalNote}
  const [form,setForm]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    if(!form.title.trim()||!form.clientName.trim()){setError('Enter a project name and a client name.');return}
    if(form.startDate&&form.targetKickoffDate&&form.targetKickoffDate<form.startDate){setError('The target kickoff date cannot be before the start date.');return}
    // Send only what changed; empty values clear optional fields.
    const changes=Object.fromEntries((Object.keys(form) as (keyof typeof form)[]).filter(key=>form[key]!==initial[key]).map(key=>[key,['ownerId','startDate','targetKickoffDate','dueDate','leadId'].includes(key)?form[key]||null:form[key]]))
    if(!Object.keys(changes).length){onClose();return}
    setBusy(true);setError('');try{await onSave(changes)}finally{setBusy(false)}
  }
  const set=(changes:Partial<typeof form>)=>setForm(current=>({...current,...changes}))
  return <Modal title="Edit onboarding details" onClose={onClose}><form noValidate onSubmit={submit}><fieldset className="ob-fieldset" disabled={busy}>
    <div className="form-grid">
      <label>Project name *<input required maxLength={150} value={form.title} onChange={event=>set({title:event.target.value})}/></label>
      <label>Client name *<input required maxLength={150} value={form.clientName} onChange={event=>set({clientName:event.target.value})}/></label>
      <label>Client contact<input maxLength={150} value={form.contactName} onChange={event=>set({contactName:event.target.value})}/></label>
      <label>Contact email<input type="email" maxLength={254} value={form.contactEmail} onChange={event=>set({contactEmail:event.target.value})}/></label>
      <label>Service<select value={form.serviceType} onChange={event=>set({serviceType:event.target.value as ServiceType})}>{serviceTypes.map(type=><option key={type} value={type}>{serviceLabels[type]}</option>)}</select></label>
      <label>Owner<select value={form.ownerId} onChange={event=>set({ownerId:event.target.value})}><option value="">Unassigned</option>{members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label>Start date<input type="date" value={form.startDate} onChange={event=>set({startDate:event.target.value})}/></label>
      <label>Target kickoff<input type="date" value={form.targetKickoffDate} onChange={event=>set({targetKickoffDate:event.target.value})}/></label>
      <label>Client inputs due<input type="date" value={form.dueDate} onChange={event=>set({dueDate:event.target.value})}/></label>
      <label>Linked lead<select value={form.leadId} onChange={event=>set({leadId:event.target.value})}><option value="">No linked lead</option>{form.leadId&&!leads.some(lead=>lead.id===form.leadId)&&<option value={form.leadId}>Removed lead</option>}{leads.map(lead=><option key={lead.id} value={lead.id}>{lead.name}{lead.company?` · ${lead.company}`:''}</option>)}</select></label>
    </div>
    <label>Instructions for the client<textarea rows={3} maxLength={4000} value={form.clientInstructions} onChange={event=>set({clientInstructions:event.target.value})}/></label>
    <label>Internal note (agency only)<textarea rows={2} maxLength={4000} value={form.internalNote} onChange={event=>set({internalNote:event.target.value})}/></label>
  </fieldset>{error&&<p className="field-error" role="alert">{error}</p>}
  <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Saving…':'Save details'}</button></div></form></Modal>
}
function ItemDialog({item,busy,onClose,onSave}:{item:ItemDefinition&{id?:string;locked?:boolean};busy:boolean;onClose:()=>void;onSave:(item:ItemDefinition)=>Promise<void>}){
  const [draft,setDraft]=useState<ItemDefinition>(item),[error,setError]=useState('')
  return <Modal title={item.id?'Edit checklist item':'Add checklist item'} onClose={onClose}><form noValidate onSubmit={async event=>{event.preventDefault();const problem=itemError(draft);if(problem){setError(problem);return}setError('');await onSave({...cleanItem(draft),id:item.id,dueDate:draft.dueDate||null,internalNote:(draft.internalNote??'').trim()})}}>
    <ItemFields idPrefix="request-item" item={draft} forRequest lockType={item.locked} disabled={busy} onChange={setDraft}/>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Saving…':item.id?'Save item':'Add item'}</button></div></form></Modal>
}
function ReviewDialog({item,decision,busy,onClose,onSave}:{item:RequestItem;decision:Decision;busy:boolean;onClose:()=>void;onSave:(note:string)=>Promise<void>}){
  const copy=decision==='request_changes'?{title:`Request changes: ${item.title}`,label:'Message to the client *',hint:'The client sees this next to the item and can resubmit.',confirm:'Send back to client',max:2000}
    :decision==='not_required'?{title:`Mark not required: ${item.title}`,label:'Reason (agency only) *',hint:'The client sees only that the item isn’t needed. A required item marked not required no longer blocks readiness.',confirm:'Mark not required',max:500}
    :{title:`Accept without a submission: ${item.title}`,label:'Why is this already in place? *',hint:item.kind==='access'?'For example: “We already have admin access to this account.” Confirm it in the platform first.':'For example: “Provided by email on 3 November.”',confirm:'Accept item',max:2000}
  return <NoteDialog title={copy.title} label={copy.label} confirm={copy.confirm} max={copy.max} required busy={busy} onClose={onClose} onSave={onSave}><p className="ob-hint">{copy.hint}</p></NoteDialog>
}
function NoteDialog({title,label,confirm,busy,required=false,max=500,children,onClose,onSave}:{title:string;label:string;confirm:string;busy:boolean;required?:boolean;max?:number;children:ReactNode;onClose:()=>void;onSave:(note:string)=>Promise<void>}){
  const [note,setNote]=useState(''),[error,setError]=useState('')
  return <Modal title={title} onClose={onClose}>{children}<form noValidate onSubmit={async event=>{event.preventDefault();if(required&&!note.trim()){setError('This is required.');return}setError('');await onSave(note.trim())}}>
    <label>{label}<textarea rows={3} maxLength={max} value={note} required={required} onChange={event=>setNote(event.target.value)}/></label>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Go back</button><button className="primary" disabled={busy}>{busy?'Saving…':confirm}</button></div></form></Modal>
}
