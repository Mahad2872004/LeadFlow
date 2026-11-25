import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { accessDenied, RequestError, type WorkspaceSummary } from '../lib/backend'
import { dateLabel } from '../lib/format'
import type { Lead } from '../lib/model'
import { assignForm, autoStepLabels, blankItem, cleanItem, conflict, describeEvent, formatBytes, handOff, isDisplayKind, issueLink, itemError, itemHistory, itemStateLabels, kindLabels, loadForms, loadRequest, loadStages, portalLink, reminderBlockText, reminderIntervals,
  removeItem, removeStep, reviewItem, revokeLinks, saveItem, saveStep, serviceLabels, serviceTypes, setStatus, setStepStatus, statusLabels, updateRequest,
  type Decision, type FormSummary, type ItemDefinition, type Member, type RequestChanges, type RequestDetail, type RequestItem, type RequestStep, type ReminderRecord, type ResponseValue, type ServiceType, type Stage, type StepDefinition, type Submission } from '../lib/onboarding'
import { downloadDocument, requirementCategories, requirementCategoryLabels, saveRequirement, type RequirementCategory } from '../lib/clients'
import { Glyph, ReadinessBadge, ReadinessProgress, ReadinessRing } from './OnboardingReadiness'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ItemFields } from './OnboardingItemFields'
import { StepFields } from './OnboardingTemplates'
type LoadState={status:'loading'}|{status:'error';message:string;denied:boolean;missing:boolean}|{status:'ready';detail:RequestDetail}
type StepDraft=StepDefinition&{dueDate:string|null;assigneeId:string|null}
type Dialog={kind:'details'}|{kind:'item';item:ItemDefinition&{id?:string;locked?:boolean}}|{kind:'review';item:RequestItem;decision:Decision}|{kind:'cancel'}|{kind:'handoff'}
  |{kind:'step';step:StepDraft}|{kind:'skip-step';step:RequestStep}|{kind:'history';item:RequestItem}|{kind:'requirement';item:RequestItem}|{kind:'form'}
const when=(value:string)=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})
const failed=(cause:unknown):LoadState=>({status:'error',message:cause instanceof Error?cause.message:'Unable to load this onboarding.',denied:accessDenied(cause),missing:cause instanceof RequestError&&cause.code==='P0002'})
const reminderStatus:Record<ReminderRecord['status'],string>={pending:'Retrying',sending:'Sending',accepted:'Accepted by the email provider',failed:'Refused by the email provider',uncertain:'Outcome unknown',cancelled:'Stopped before sending'}
const stepStatusLabels:Record<RequestStep['status'],string>={pending:'To do',done:'Done',not_required:'Not required'}
const reviewStateLabels:Record<string,string>={pending:'Waiting for review',accepted:'Accepted',changes_requested:'Changes requested',not_required:'Marked not required',superseded:'Replaced by a later submission'}
const plural=(count:number,word:string)=>`${count} ${word}${count===1?'':'s'}`
const explanation=(detail:RequestDetail)=>{
  const r=detail.readiness,resolved=r.requiredAccepted+r.requiredWaived
  const client=r.blockers.filter(b=>b.waitingOn==='client').length,steps=r.blockers.filter(b=>b.kind==='internal').length,review=r.blockers.length-client-steps
  const withSteps=!!detail.steps?.some(step=>step.required),units=withSteps?'required items and steps':'required items'
  switch(r.state){
    case 'not_open':return 'This onboarding is a draft. Review the checklist, then open it so the client can respond.'
    case 'waiting_on_client':return `${resolved} of ${r.requiredTotal} ${units} are resolved. ${client} ${client===1?'is':'are'} waiting on the client${review?`, ${review} on your review`:''}${steps?`, and ${plural(steps,'internal step')} on your team`:''}.`
    case 'awaiting_review':return `The client has provided every required item. ${review} ${review===1?'needs':'need'} your review${steps?`, and ${plural(steps,'internal step')} ${steps===1?'is':'are'} still open`:''} before delivery can start.`
    case 'agency_steps':return `Everything required from the client is resolved. ${plural(steps,'required internal step')} for your team ${steps===1?'is':'are'} still open.`
    case 'ready':return r.requiredTotal?`Every ${withSteps?'required item and internal step':'required item'} is resolved. Confirm readiness to hand this client off to delivery.`:'This checklist has nothing required, so nothing blocks delivery. Confirm readiness to hand off.'
    case 'paused':return `Paused: the client can view the checklist but can’t respond, and no reminders are sent. ${r.requirementsMet?'Everything required is resolved.':`${r.blockers.length} required ${r.blockers.length===1?'item or step is':'items or steps are'} outstanding.`}`
    case 'cancelled':return `Cancelled${detail.cancelReason?`: ${detail.cancelReason}`:''}. No reminders are sent and the checklist can’t change.`
    case 'handed_off':return `Readiness was confirmed${detail.handoff?` on ${when(detail.handoff.handedOffAt)} by ${detail.handoff.handedOffBy}`:''}.`
  }
}
const safeUrl=(value:string)=>/^https?:\/\//i.test(value)?value:null
/** A one-paragraph summary of an answer, for a requirement's description. */
function answerSummary(item:RequestItem,value:ResponseValue|null):string{
  if(!value)return ''
  const files=(item.files??[]).filter(file=>value.files?.includes(file.id)).map(file=>file.name)
  const main=item.kind==='choice'?value.choice??'':item.kind==='multi_choice'?(value.choices??[]).join(', '):item.kind==='links'?(value.links??[]).join('\n'):item.kind==='number'?String(value.number??'')
    :item.kind==='date'?value.date??'':item.kind==='checkbox'?(value.checked?'Confirmed by the client':''):item.kind==='access'?'The client reports access was granted':item.kind==='file'?files.join(', '):value.text??''
  return [main,value.note?`Client note: ${value.note}`:''].filter(Boolean).join('\n\n').slice(0,4000)
}
/** One answer, for any field type. Files are listed by name and downloaded through a short-lived signed link. */
function AnswerView({item,value,onDownload}:{item:RequestItem;value:ResponseValue;onDownload?:(fileId:string)=>void}){
  const note=value.note?<p className="ob-note"><strong>Client note:</strong> {value.note}</p>:null
  switch(item.kind){
    case 'text':return <p className="message">{value.text}</p>
    case 'short_text':case 'phone':return <p className="ob-answer">{value.text}</p>
    case 'email':return <p className="ob-answer">{value.text?<a href={`mailto:${value.text}`}>{value.text}</a>:null}</p>
    case 'url':return <p className="ob-answer">{value.text&&safeUrl(value.text)?<a href={value.text} target="_blank" rel="noopener noreferrer nofollow">{value.text}</a>:value.text}</p>
    case 'number':return <><p className="ob-answer">{value.number??'No number given'}</p>{note}</>
    case 'date':return <><p className="ob-answer">{value.date?dateLabel(value.date):'No date given'}</p>{note}</>
    case 'choice':return <><p className="ob-answer">{value.choice}</p>{note}</>
    case 'multi_choice':return <><ul className="ob-answer ob-answer-list">{(value.choices??[]).map(choice=><li key={choice}>{choice}</li>)}</ul>{note}</>
    case 'checkbox':return <><p className="ob-answer">{value.checked?'✓ Confirmed by the client':'Not confirmed'}</p>{note}</>
    case 'links':return <><ul className="ob-links">{(value.links??[]).map(link=><li key={link}>{safeUrl(link)?<a href={link} target="_blank" rel="noopener noreferrer nofollow">{link}</a>:link}</li>)}</ul>{note}</>
    case 'file':return <><FileList files={(value.files??[]).map(id=>item.files?.find(file=>file.id===id)??{id,name:'A file that has since been removed',size:0,mimeType:'',status:'removed' as const})} onDownload={onDownload}/>{note}</>
    case 'access':return <><p className="ob-answer">{item.state==='accepted'?'Access confirmed by your team':'The client says access has been granted. Check it in the platform before confirming.'}</p>{note}</>
    default:return null
  }
}
function FileList({files,onDownload}:{files:{id:string;name:string;size:number;status:'available'|'pending'|'removed'}[];onDownload?:(fileId:string)=>void}){
  if(!files.length)return <p className="ob-answer">No files</p>
  return <ul className="ob-files">{files.map(file=><li key={file.id}><span className="ob-file-icon" aria-hidden="true"><Icon name="clipboard" size={15}/></span>
    <span className="ob-file-name">{file.name}{file.size>0&&<small>{formatBytes(file.size)}</small>}</span>
    {file.status==='available'?onDownload&&<button type="button" className="text-button" onClick={()=>onDownload(file.id)}>Download<span className="sr-only"> {file.name}</span></button>
      :<span className="ob-file-status">{file.status==='pending'?'Being checked':'Removed'}</span>}</li>)}</ul>
}
function ResponseView({item,onDownload}:{item:RequestItem;onDownload:(fileId:string)=>void}){
  const value:ResponseValue|null=item.response
  if(!value)return <>
    <p className="ob-muted">{item.hasDraft?'The client has saved a draft but hasn’t submitted it.':'No response yet.'}</p>
    {item.kind==='file'&&!!item.files?.length&&<><p className="ob-files-caption">Uploaded so far, not submitted yet:</p><FileList files={item.files} onDownload={onDownload}/></>}
  </>
  return <AnswerView item={item} value={value} onDownload={onDownload}/>
}
interface RequestProps { workspace: WorkspaceSummary; requestId: string; members: Member[]; leads: Lead[]; onBack: (message?: string) => void; onOpenClient?: (clientId: string) => void }
export function OnboardingRequest({workspace,requestId,members,leads,onBack,onOpenClient}:RequestProps){
  const [state,setState]=useState<LoadState>({status:'loading'})
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [dialog,setDialog]=useState<Dialog|null>(null),[newLink,setNewLink]=useState<{token:string;expiresAt:string}|null>(null),[linkDays,setLinkDays]=useState(30)
  const [allEvents,setAllEvents]=useState(false),[stages,setStages]=useState<Stage[]>([])
  const reload=useCallback(()=>loadRequest(workspace.id,requestId).then(detail=>setState({status:'ready',detail}),cause=>setState(failed(cause))),[workspace.id,requestId])
  useEffect(()=>{
    let active=true
    loadRequest(workspace.id,requestId).then(detail=>{if(active)setState({status:'ready',detail})},cause=>{if(active)setState(failed(cause))})
    return()=>{active=false}
  },[workspace.id,requestId])
  // Stages for the item, step and form pickers. Optional: without them items keep the stage they have.
  useEffect(()=>{let active=true;loadStages(workspace.id).then(result=>{if(active)setStages(result.stages)}).catch(()=>{});return()=>{active=false}},[workspace.id])
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
  async function download(fileId:string){
    setError('')
    try{await downloadDocument(workspace.id,fileId)}catch(cause){setError(cause instanceof Error?cause.message:'Unable to download this file.')}
  }
  const back=<button className="text-button ob-back" onClick={()=>onBack()}>← All onboarding requests</button>
  if(state.status==='loading')return <div>{back}<div className="content-skeleton" role="status"><span className="sr-only">Loading onboarding…</span><i className="skeleton skeleton-title"/><i className="skeleton skeleton-panel"/></div></div>
  if(state.status==='error')return <div>{back}<div className="error-banner load-error" role="alert"><p><strong>{state.missing?'This onboarding isn’t in this workspace.':state.denied?'You don’t have access to this onboarding.':'We couldn’t load this onboarding.'}</strong> {state.message}</p>{!state.missing&&<button className="secondary" onClick={()=>{setState({status:'loading'});void reload()}}>Try again</button>}</div></div>
  const {detail}=state
  const open=detail.status!=='completed'&&detail.status!=='cancelled'
  const canCancel=workspace.role!=='member'
  const sharedLinks=detail.links.filter(link=>link.purpose==='shared'&&link.active),reminderLinks=detail.links.filter(link=>link.purpose==='reminder'&&link.active)
  const memberName=(id:string|null)=>id?members.find(member=>member.id===id)?.name??'Former member':'Unassigned'
  const ownerName=memberName(detail.ownerId)
  const steps=detail.steps??[],assignments=detail.assignments??[]
  // Stage names from the request's own progress (which includes archived stages still holding work) and the workspace list.
  const stageNames=new Map<string,string>([...stages.map(stage=>[stage.id,stage.name] as [string,string]),...(detail.stages??[]).filter(stage=>stage.stageId).map(stage=>[stage.stageId!,stage.name] as [string,string])])
  const activeStages=(detail.stages??[]).filter(stage=>stage.total>0)
  const sections=detail.items.reduce<[string,RequestItem[]][]>((groups,item)=>{const group=groups.find(([name])=>name===item.section);if(group)group[1].push(item);else groups.push([item.section,[item]]);return groups},[])
  const review=(item:RequestItem,decision:Decision,note='')=>run(()=>reviewItem(workspace.id,detail.id,item.id,decision,note,item.revision),
    decision==='accept'?`${item.title} accepted.`:decision==='request_changes'?`Changes requested on ${item.title}. The client will see your message.`:decision==='not_required'?`${item.title} marked not required.`:`${item.title} restored.`)
  const status=(transition:'activate'|'pause'|'resume'|'cancel',message:string,reason?:string)=>run(()=>setStatus(workspace.id,detail.id,transition,detail.version,reason),message)
  const stepStatus=(step:RequestStep,next:RequestStep['status'],note:string,message:string)=>run(()=>setStepStatus(workspace.id,detail.id,step.id,next,note,step.revision),message)
  const events=allEvents?detail.events:detail.events.slice(0,40)
  const resolved=detail.readiness.requiredAccepted+detail.readiness.requiredWaived,toReview=detail.items.filter(item=>item.state==='submitted').length
  const editItem=(item:RequestItem)=>setDialog({kind:'item',item:{id:item.id,section:item.section,title:item.title,guidance:item.guidance,kind:item.kind,options:item.options,required:item.required,dueDate:item.dueDate,
    internalNote:item.internalNote,config:item.config??{},stageId:item.stageId??null,formName:item.formName??null,locked:!!item.response||item.hasDraft}})
  return <div className="ob-detail">
    {back}
    <header className="panel ob-detail-head">
      <span className={`ob-hero-icon ob-service-${detail.serviceType}`} aria-hidden="true"><Glyph name={detail.serviceType} size={22}/></span>
      <div><p className="eyebrow">{serviceLabels[detail.serviceType].toUpperCase()} · {statusLabels[detail.status].toUpperCase()}</p><h2>{detail.title}</h2><p>{detail.clientName}{detail.contactName?` · ${detail.contactName}`:''} · Owner: {ownerName}</p></div>
      <div className="ob-head-actions">
        {detail.status==='draft'&&<button className="primary" disabled={busy} onClick={()=>status('activate','Opened. Share the client link so they can start.')}>Open to client</button>}
        {detail.status==='active'&&<button className="secondary" disabled={busy} onClick={()=>status('pause','Paused. The client can’t respond and no reminders are sent.')}>Pause</button>}
        {detail.status==='paused'&&<button className="primary" disabled={busy} onClick={()=>status('resume','Resumed. The client can respond again.')}>Resume</button>}
        {open&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'details'})}>Edit details</button>}
        {detail.client&&onOpenClient&&<button className="secondary" disabled={busy} onClick={()=>onOpenClient(detail.client!.id)}>Open client</button>}
        <button className="text-button" disabled={busy} onClick={()=>run(async()=>{},'Showing the latest responses.')}>Check for updates</button>
        {open&&canCancel&&<button className="text-button ob-danger" disabled={busy} onClick={()=>setDialog({kind:'cancel'})}>Cancel onboarding</button>}
      </div>
      <div className="ob-hero-stats" aria-hidden="true">
        <span className="ob-hero-readiness"><ReadinessRing percent={detail.readiness.percent}/><span><small>Status</small><ReadinessBadge state={detail.readiness.state}/></span></span>
        <span className="ob-hero-fact"><small>Required done</small><b>{resolved}<i>/{detail.readiness.requiredTotal}</i></b></span>
        <span className="ob-hero-fact"><small>To review</small><b>{toReview}</b></span>
        <span className="ob-hero-fact"><small>Kickoff</small><b>{detail.targetKickoffDate?dateLabel(detail.targetKickoffDate):'Not set'}</b></span>
        <span className="ob-hero-fact"><small>Inputs due</small><b>{detail.dueDate?dateLabel(detail.dueDate):'Not set'}</b></span>
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
          <p className="ob-muted">{detail.readiness.requiredAccepted} accepted or done · {detail.readiness.requiredWaived} marked not required · {detail.readiness.optionalOutstanding} of {detail.readiness.optionalTotal} optional still open (optional items never block)</p>
          {detail.readiness.blockers.length>0&&detail.status!=='cancelled'&&<><h3>Blocking delivery <span className="number-tag">{detail.readiness.blockers.length}</span></h3>
            <ul className="ob-blockers">{detail.readiness.blockers.map(blocker=>{const target=blocker.stepId?`step-${blocker.stepId}`:`item-${blocker.itemId}`;return <li key={target}><a href={`#${target}`}>{blocker.title}</a><span>{blocker.reason}</span>
              <span className={`ob-waiting ob-waiting-${blocker.waitingOn}`}>{blocker.waitingOn==='client'?'Client':blocker.kind==='internal'?'Internal step':'Your team'}</span></li>})}</ul></>}
          <details className="ob-how"><summary>How readiness is calculated</summary><p>A request is ready when it is open, every <strong>required</strong> item is accepted by your team or marked not required with a reason, and every required internal step is done or marked not required. Optional items never block, and headings and instructions are never counted. Anything the client submits, including account access they say they’ve granted, counts only after someone on your team accepts it. LeadFlow doesn’t connect to ad, analytics or email platforms, so it can’t verify access itself. The percentage only summarises this list.</p></details>
          {detail.status==='active'&&detail.readiness.requirementsMet&&<button className="primary" disabled={busy} onClick={()=>setDialog({kind:'handoff'})}>Confirm readiness and hand off</button>}
          {detail.handoff&&<div className="ob-handoff"><strong>Handed off to delivery</strong><p>{when(detail.handoff.handedOffAt)} by {detail.handoff.handedOffBy}. Reference <code>{detail.handoff.id}</code>.</p>{detail.handoff.note&&<p>{detail.handoff.note}</p>}<p className="ob-muted">The handoff records the accepted checklist. Nothing was launched, sent or created in other tools.</p></div>}
        </section>
        {activeStages.length>0&&<section className="panel ob-panel" aria-labelledby="ob-stages-title">
          <div className="settings-heading"><div><h2 id="ob-stages-title">Stages</h2><p>Progress through each onboarding stage, counted from the checklist and your internal steps.</p></div></div>
          <ol className="ob-stage-strip">{activeStages.map((stage,index)=><li key={stage.stageId??'other'} className={`ob-stage ob-stage-${stage.state}`}>
            <span className="ob-stage-index" aria-hidden="true">{stage.state==='complete'?'✓':index+1}</span>
            <div><strong>{stage.name}</strong><small>{stage.required?`${stage.resolved} of ${stage.required} required done`:`${plural(stage.total,'optional item')}`}{stage.state==='complete'?' · complete':''}</small>
              {(stage.waitingOnClient>0||stage.awaitingReview>0||stage.agencySteps>0||stage.overdue>0)&&<span className="ob-stage-waits">
                {stage.waitingOnClient>0&&<span className="ob-waiting ob-waiting-client">{stage.waitingOnClient} on client</span>}
                {stage.awaitingReview>0&&<span className="ob-waiting ob-waiting-agency">{stage.awaitingReview} to review</span>}
                {stage.agencySteps>0&&<span className="ob-waiting ob-waiting-agency">{plural(stage.agencySteps,'step')}</span>}
                {stage.overdue>0&&<span className="ob-tag ob-tag-overdue">{stage.overdue} overdue</span>}</span>}</div>
          </li>)}</ol>
        </section>}
        <section className="panel ob-panel" aria-labelledby="ob-checklist-title">
          <div className="settings-heading"><div><h2 id="ob-checklist-title">Client checklist</h2><p>{detail.templateName?`Copied from “${detail.templateName}”. Changes here affect only this client.`:'Built for this client.'}</p></div>
            {open&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'item',item:blankItem()})}><Icon name="plus" size={16}/> Add item</button>}</div>
          {detail.items.length===0&&<div className="ob-empty"><p>No items yet. Add what you need from the client before delivery can start.</p></div>}
          {sections.map(([section,items])=>{const answerable=items.filter(item=>!isDisplayKind(item.kind)),done=answerable.filter(item=>item.state==='accepted'||item.state==='not_required').length
            return <div key={section} className="ob-section"><div className="ob-section-head"><h3 className="ob-section-title">{section}</h3>{answerable.length>0&&<span className="ob-section-count" aria-hidden="true"><i><b style={{width:`${Math.round(100*done/answerable.length)}%`}}/></i>{done}/{answerable.length}</span>}</div><ul className="ob-items">{items.map(item=>isDisplayKind(item.kind)
            ?<li key={item.id} id={`item-${item.id}`} className={`ob-display ob-display-${item.kind}`}>
              <div className="ob-display-body">{item.kind==='heading'?<h4>{item.title}</h4>:<strong>{item.title}</strong>}{item.guidance&&<p>{item.guidance}</p>}
                <span className="ob-tag">{item.kind==='heading'?'Heading':'Instructions'} · shown to the client</span>{item.stageId&&stageNames.get(item.stageId)&&<span className="ob-tag">{stageNames.get(item.stageId)}</span>}</div>
              {open&&<div className="ob-display-actions"><button className="text-button" disabled={busy} onClick={()=>editItem(item)}>Edit<span className="sr-only"> {item.title}</span></button>
                <button className="text-button ob-danger" disabled={busy} onClick={()=>run(()=>removeItem(workspace.id,detail.id,item.id,detail.version),`${item.title} removed.`)}>Remove<span className="sr-only"> {item.title}</span></button></div>}
            </li>
            :<li key={item.id} id={`item-${item.id}`} className={`ob-item ob-item-${item.state}`}>
            <div className="ob-item-head"><div><strong>{item.title}</strong><div className="ob-item-tags"><span className="ob-tag">{item.required?'Required':'Optional'}</span><span className="ob-tag">{kindLabels[item.kind]}</span>
              {item.stageId&&stageNames.get(item.stageId)&&<span className="ob-tag">{stageNames.get(item.stageId)}</span>}{item.formName&&<span className="ob-tag">Form: {item.formName}</span>}
              {item.dueDate&&<span className="ob-tag">Due {dateLabel(item.dueDate)}</span>}{item.overdue&&<span className="ob-tag ob-tag-overdue">Overdue</span>}{(item.submissions??0)>1&&<span className="ob-tag">{item.submissions} submissions</span>}</div></div>
              <span className={`ob-state ob-state-${item.state}`}>{itemStateLabels[item.state]}</span></div>
            {item.guidance&&<p className="ob-guidance">{item.guidance}</p>}
            <ResponseView item={item} onDownload={download}/>
            {item.clientFeedback&&<p className="ob-feedback"><strong>Your message to the client:</strong> {item.clientFeedback}</p>}
            {item.state==='not_required'&&item.waiveReason&&<p className="ob-internal"><strong>Not required (agency only):</strong> {item.waiveReason}</p>}
            {item.internalNote&&<p className="ob-internal"><strong>Internal note:</strong> {item.internalNote}</p>}
            {(open||(item.submissions??0)>0||(!!detail.clientId&&!!item.response))&&<div className="ob-item-actions">
              {open&&item.state==='submitted'&&<button className="primary" disabled={busy} onClick={()=>review(item,'accept')}>{item.kind==='access'?'Confirm access works':'Accept'}</button>}
              {open&&(item.state==='not_started'||item.state==='changes_requested')&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'review',item,decision:'accept'})}>{item.kind==='access'?'Confirm access without submission':'Accept without submission'}</button>}
              {open&&(item.state==='submitted'||item.state==='accepted')&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'review',item,decision:'request_changes'})}>Request changes</button>}
              {open&&(item.state==='not_required'?<button className="text-button" disabled={busy} onClick={()=>review(item,'restore')}>Restore</button>:<button className="text-button" disabled={busy} onClick={()=>setDialog({kind:'review',item,decision:'not_required'})}>Mark not required</button>)}
              {(item.submissions??0)>0&&<button className="text-button" disabled={busy} onClick={()=>setDialog({kind:'history',item})}>History<span className="sr-only"> of {item.title}</span></button>}
              {!!detail.clientId&&!!item.response&&(item.state==='submitted'||item.state==='accepted')&&<button className="text-button" disabled={busy} onClick={()=>setDialog({kind:'requirement',item})}>Create requirement</button>}
              {open&&<button className="text-button" disabled={busy} onClick={()=>editItem(item)}>Edit item</button>}
              {open&&!item.response&&<button className="text-button ob-danger" disabled={busy} onClick={()=>run(()=>removeItem(workspace.id,detail.id,item.id,detail.version),`${item.title} removed.`)}>Remove</button>}
            </div>}
          </li>)}</ul></div>})}
        </section>
        <section className="panel ob-panel" aria-labelledby="ob-steps-title">
          <div className="settings-heading"><div><h2 id="ob-steps-title">Internal steps</h2><p>Work your team finishes during onboarding. The client never sees these.</p></div>
            {open&&<button className="secondary" disabled={busy||steps.length>=50} onClick={()=>setDialog({kind:'step',step:{title:'',description:'',required:true,autoKey:null,stageId:null,dueDate:null,assigneeId:null}})}><Icon name="plus" size={16}/> Add step</button>}</div>
          {steps.length===0?<p className="ob-muted">No internal steps. Add the work your team must finish before this client is ready, such as verifying access or preparing the kickoff.</p>
          :<ul className="ob-steps">{steps.map(step=>{const automatic=!!step.autoKey&&!!detail.clientId
            return <li key={step.id} id={`step-${step.id}`} className={`ob-step ob-step-${step.status}`}>
            <div className="ob-item-head"><div><strong>{step.title}</strong><div className="ob-item-tags"><span className="ob-tag">{step.required?'Required':'Optional'}</span>
              {step.stageId&&stageNames.get(step.stageId)&&<span className="ob-tag">{stageNames.get(step.stageId)}</span>}{step.autoKey&&<span className="ob-tag ob-tag-auto">Automatic</span>}
              {step.assigneeId&&<span className="ob-tag">{memberName(step.assigneeId)}</span>}{step.dueDate&&<span className="ob-tag">Due {dateLabel(step.dueDate)}</span>}{step.overdue&&<span className="ob-tag ob-tag-overdue">Overdue</span>}</div></div>
              <span className={`ob-state ob-step-state-${step.status}`}>{stepStatusLabels[step.status]}</span></div>
            {step.description&&<p className="ob-guidance">{step.description}</p>}
            {step.autoKey&&<p className="ob-step-rule">{autoStepLabels[step.autoKey]}{detail.clientId?'.':'. This onboarding has no client record, so mark it done yourself.'}</p>}
            {step.status!=='pending'&&<p className="ob-step-done">{step.status==='done'?(step.doneBy?`Done by ${step.doneBy}`:'Completed automatically'):`Marked not required${step.doneBy?` by ${step.doneBy}`:''}`}{step.doneAt?` · ${when(step.doneAt)}`:''}{step.note?`: ${step.note}`:''}</p>}
            {open&&<div className="ob-item-actions">
              {step.status==='pending'?<>
                {automatic?<span className="ob-step-auto-note">Completes automatically</span>:<button className="primary" disabled={busy} onClick={()=>stepStatus(step,'done','',`${step.title} marked done.`)}>Mark done</button>}
                <button className="text-button" disabled={busy} onClick={()=>setDialog({kind:'skip-step',step})}>Mark not required</button>
                <button className="text-button" disabled={busy} onClick={()=>setDialog({kind:'step',step:{id:step.id,title:step.title,description:step.description,required:step.required,autoKey:step.autoKey,stageId:step.stageId,dueDate:step.dueDate,assigneeId:step.assigneeId}})}>Edit step</button>
                <button className="text-button ob-danger" disabled={busy} onClick={()=>run(()=>removeStep(workspace.id,detail.id,step.id,detail.version),`${step.title} removed.`)}>Remove</button>
              </>:<button className="secondary" disabled={busy} onClick={()=>stepStatus(step,'pending','',`${step.title} reopened.`)}>Reopen</button>}
            </div>}
          </li>})}</ul>}
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
          {sharedLinks.length>0?<ul className="ob-link-list">{sharedLinks.map(link=><li key={link.id}><span className="ob-link-icon" aria-hidden="true"><Glyph name="lock" size={16}/></span><span>Created {when(link.createdAt)}<br/>Expires {when(link.expiresAt)} · {link.lastUsedAt?`last opened ${when(link.lastUsedAt)}`:'not opened yet'}</span>{open&&<button className="text-button ob-danger" disabled={busy} onClick={()=>run(()=>revokeLinks(workspace.id,detail.id,link.id),'Link revoked. It stops working immediately.').then(ok=>{if(ok)setNewLink(null)})}>Revoke</button>}</li>)}</ul>
            :<p className="ob-muted">{open?'No active link. Create one to share with the client.':'No active link.'}</p>}
          {reminderLinks.length>0&&<p className="ob-muted">Reminder emails carry their own private links ({reminderLinks.length} active). Revoking all links stops those too.</p>}
          {open&&<div className="ob-link-controls">
            <label>Link lasts<select value={linkDays} onChange={event=>setLinkDays(Number(event.target.value))}>{[7,14,30,60,90].map(days=><option key={days} value={days}>{days} days</option>)}</select></label>
            <button className={sharedLinks.length?'secondary':'primary'} disabled={busy} onClick={async()=>{let issued:{token:string;expiresAt:string}|null=null;if(await run(async()=>{issued=await issueLink(workspace.id,detail.id,linkDays,true)},sharedLinks.length?'New link created. Earlier links no longer work.':'Link created. Copy it now.'))setNewLink(issued)}}>{sharedLinks.length?'Replace link':'Create client link'}</button>
            {(sharedLinks.length>0||reminderLinks.length>0)&&<button className="text-button ob-danger" disabled={busy} onClick={()=>run(()=>revokeLinks(workspace.id,detail.id),'Every link for this onboarding was revoked.').then(ok=>{if(ok)setNewLink(null)})}>Revoke all links</button>}
          </div>}
          {detail.status==='draft'&&<p className="ob-hint">Until you open the request, the link shows the client that their checklist isn’t ready yet.</p>}
        </section>
        <section className="panel ob-panel" aria-labelledby="ob-forms-title">
          <div className="settings-heading"><div><h2 id="ob-forms-title">Forms</h2><p>Reusable forms added to this checklist. Their fields appear in the checklist, grouped by the form’s sections.</p></div></div>
          {assignments.length?<ul className="ob-form-list">{assignments.map(assignment=><li key={assignment.id}><strong>{assignment.formName}</strong>
            <small>{plural(assignment.fields,'field')} · {assignment.submitted} submitted · {assignment.accepted} accepted or not required</small><small>Added {when(assignment.assignedAt)} (version {assignment.formVersion})</small></li>)}</ul>
            :<p className="ob-muted">No forms added. Add one of your workspace’s forms to ask the same questions every time.</p>}
          {open&&<button className="secondary" disabled={busy} onClick={()=>setDialog({kind:'form'})}>Add a form</button>}
        </section>
        <Reminders detail={detail} open={open} busy={busy} onSave={(changes,message)=>run(()=>updateRequest(workspace.id,detail.id,changes,detail.version),message)}/>
        <section className="panel ob-panel" aria-labelledby="ob-details-title">
          <div className="settings-heading"><div><h2 id="ob-details-title">Details</h2></div></div>
          <dl className="settings-meta ob-meta">
            {detail.client&&<div><dt>Client record</dt><dd>{onOpenClient?<button className="text-button" onClick={()=>onOpenClient(detail.client!.id)}>{detail.client.name}</button>:detail.client.name}</dd></div>}
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
    {dialog?.kind==='item'&&<ItemDialog item={dialog.item} stages={stages} busy={busy} onClose={()=>setDialog(null)} onSave={async item=>{if(await run(()=>saveItem(workspace.id,detail.id,item,detail.version),item.id?`${item.title} updated.`:`${item.title} added.`))setDialog(null)}}/>}
    {dialog?.kind==='review'&&<ReviewDialog item={dialog.item} decision={dialog.decision} busy={busy} onClose={()=>setDialog(null)} onSave={async note=>{if(await review(dialog.item,dialog.decision,note))setDialog(null)}}/>}
    {dialog?.kind==='cancel'&&<NoteDialog title="Cancel this onboarding?" label="Reason (optional, agency only)" confirm="Cancel onboarding" busy={busy} onClose={()=>setDialog(null)} onSave={async reason=>{if(await status('cancel','Onboarding cancelled. Reminders stopped.',reason))setDialog(null)}}>
      <p>The client will see that this onboarding is closed, and no more reminders are sent. Their responses stay here for your records. This can’t be undone.</p></NoteDialog>}
    {dialog?.kind==='handoff'&&<NoteDialog title="Confirm readiness and hand off?" label="Handoff note (optional)" confirm="Confirm and hand off" busy={busy} onClose={()=>setDialog(null)} onSave={async note=>{if(await run(()=>handOff(workspace.id,detail.id,note),'Readiness confirmed and recorded.'))setDialog(null)}}>
      <p>All {detail.readiness.requiredTotal} required items{steps.some(step=>step.required)?' and internal steps':''} are resolved. Confirming records the date and a snapshot of the accepted responses, closes the checklist and stops reminders. It doesn’t launch campaigns, create tasks or notify anyone.</p></NoteDialog>}
    {dialog?.kind==='step'&&<StepDialog step={dialog.step} stages={stages} members={members} busy={busy} onClose={()=>setDialog(null)} onSave={async step=>{if(await run(()=>saveStep(workspace.id,detail.id,step,detail.version),step.id?`${step.title} updated.`:`${step.title} added.`))setDialog(null)}}/>}
    {dialog?.kind==='skip-step'&&<NoteDialog title={`Mark not required: ${dialog.step.title}`} label="Reason (agency only) *" confirm="Mark not required" required busy={busy} onClose={()=>setDialog(null)} onSave={async note=>{if(await stepStatus(dialog.step,'not_required',note,`${dialog.step.title} marked not required.`))setDialog(null)}}>
      <p className="ob-hint">A required step marked not required no longer blocks readiness. You can reopen it later.</p></NoteDialog>}
    {dialog?.kind==='history'&&<HistoryDialog workspaceId={workspace.id} requestId={detail.id} item={dialog.item} onDownload={download} onClose={()=>setDialog(null)}/>}
    {dialog?.kind==='requirement'&&detail.clientId&&<RequirementDialog item={dialog.item} busy={busy} onClose={()=>setDialog(null)}
      onSave={async (requirement,requestKey)=>{if(await run(()=>saveRequirement(workspace.id,detail.clientId!,{...requirement,priority:'medium',status:'draft',source:'client_form',sourceRequestId:detail.id,sourceItemId:dialog.item.id,notes:''},null,requestKey),
        `Requirement “${requirement.title}” added to ${detail.client?.name??'the client'} as a draft.`))setDialog(null)}}/>}
    {dialog?.kind==='form'&&<AssignFormDialog workspaceId={workspace.id} stages={stages} busy={busy} onClose={()=>setDialog(null)}
      onSave={async (form,stageId)=>{if(await run(()=>assignForm(workspace.id,detail.id,form.id,stageId,detail.version),`The form “${form.name}” was added: ${plural(form.fieldCount,'field')}.`))setDialog(null)}}/>}
  </div>
}
function NewLink({token,expiresAt}:{token:string;expiresAt:string}){
  const [feedback,setFeedback]=useState(''),url=portalLink(token)
  return <div className="ob-new-link"><label><Glyph name="lock" size={14}/>Copy this link now<input readOnly value={url} onFocus={event=>event.currentTarget.select()}/></label>
    <button className="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(url);setFeedback('Copied to clipboard.')}catch{setFeedback('Copy unavailable. Select the link and copy it manually.')}}}><Glyph name="copy" size={16}/>Copy link</button>
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
function ItemDialog({item,stages,busy,onClose,onSave}:{item:ItemDefinition&{id?:string;locked?:boolean};stages:Stage[];busy:boolean;onClose:()=>void;onSave:(item:ItemDefinition)=>Promise<void>}){
  const [draft,setDraft]=useState<ItemDefinition>(item),[error,setError]=useState('')
  return <Modal title={item.id?'Edit checklist item':'Add checklist item'} onClose={onClose}><form noValidate onSubmit={async event=>{event.preventDefault();const problem=itemError(draft);if(problem){setError(problem);return}setError('')
    const clean=cleanItem(draft);await onSave({...clean,id:item.id,dueDate:isDisplayKind(clean.kind)?null:draft.dueDate||null,internalNote:(draft.internalNote??'').trim(),config:clean.config??{},stageId:clean.stageId??null,formName:clean.formName??null})}}>
    <ItemFields idPrefix="request-item" item={draft} forRequest lockType={item.locked} disabled={busy} stages={stages.length?stages:undefined} onChange={setDraft}/>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Saving…':item.id?'Save item':'Add item'}</button></div></form></Modal>
}
function StepDialog({step,stages,members,busy,onClose,onSave}:{step:StepDraft;stages:Stage[];members:Member[];busy:boolean;onClose:()=>void;onSave:(step:StepDraft)=>Promise<void>}){
  const [draft,setDraft]=useState<StepDraft>(step),[error,setError]=useState('')
  return <Modal title={step.id?'Edit internal step':'Add internal step'} onClose={onClose}><form noValidate onSubmit={async event=>{event.preventDefault();if(!draft.title.trim()){setError('Give the step a title.');return}setError('')
    await onSave({...draft,title:draft.title.trim(),description:draft.description.trim()})}}>
    <fieldset className="ob-fieldset" disabled={busy}>
      <StepFields idPrefix="request-step" step={draft} stages={stages} onChange={next=>setDraft(current=>({...current,...next}))}/>
      <div className="form-grid">
        <label>Assigned to<select value={draft.assigneeId??''} onChange={event=>setDraft({...draft,assigneeId:event.target.value||null})}><option value="">Unassigned</option>{members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>Due date (optional)<input type="date" min="2000-01-01" max="2100-12-31" value={draft.dueDate??''} onChange={event=>setDraft({...draft,dueDate:event.target.value||null})}/></label>
      </div>
    </fieldset>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Saving…':step.id?'Save step':'Add step'}</button></div></form></Modal>
}
/** Every submission of one item, newest first, with the review each one received. Read-only. */
function HistoryDialog({workspaceId,requestId,item,onDownload,onClose}:{workspaceId:string;requestId:string;item:RequestItem;onDownload:(fileId:string)=>void;onClose:()=>void}){
  const [state,setState]=useState<{status:'loading'}|{status:'error';message:string}|{status:'ready';entries:Submission[]}>({status:'loading'})
  useEffect(()=>{let active=true;itemHistory(workspaceId,requestId,item.id).then(entries=>{if(active)setState({status:'ready',entries})},cause=>{if(active)setState({status:'error',message:cause instanceof Error?cause.message:'Unable to load the history.'})});return()=>{active=false}},[workspaceId,requestId,item.id])
  return <Modal title={`Submissions: ${item.title}`} onClose={onClose}>
    <p className="ob-hint">Every answer the client submitted for this item is kept, with the review it received. Drafts the client saved but didn’t submit aren’t listed.</p>
    {state.status==='loading'&&<p role="status">Loading submissions…</p>}
    {state.status==='error'&&<p className="field-error" role="alert">{state.message}</p>}
    {state.status==='ready'&&(state.entries.length===0?<p className="ob-muted">No submissions yet.</p>:<ol className="ob-history">{state.entries.map((entry,index)=><li key={entry.id}>
      <div className="ob-history-head"><strong>Submission {state.entries.length-index}</strong><span className={`ob-history-state ob-history-${entry.reviewState}`}>{reviewStateLabels[entry.reviewState]??entry.reviewState}</span></div>
      <small>Submitted {when(entry.submittedAt)}{entry.reviewedAt?` · reviewed ${when(entry.reviewedAt)}${entry.reviewedBy?` by ${entry.reviewedBy}`:''}`:''}</small>
      <AnswerView item={item} value={entry.response} onDownload={onDownload}/>
      {entry.reviewNote&&<p className="ob-feedback"><strong>Review note:</strong> {entry.reviewNote}</p>}
    </li>)}</ol>)}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
  </Modal>
}
/** Records a client answer as a draft requirement on the client, linked back to this item. */
function RequirementDialog({item,busy,onClose,onSave}:{item:RequestItem;busy:boolean;onClose:()=>void;onSave:(requirement:{title:string;description:string;category:RequirementCategory},requestKey:string)=>Promise<void>}){
  const [form,setForm]=useState({title:item.title.slice(0,200),description:answerSummary(item,item.response),category:'functional' as RequirementCategory}),[error,setError]=useState('')
  // Kept while the dialog is open, so a retry after a lost response doesn't add the requirement twice.
  const [requestKey]=useState(()=>crypto.randomUUID())
  return <Modal title="Create a requirement from this answer" onClose={onClose}><form noValidate onSubmit={async event=>{event.preventDefault();if(!form.title.trim()){setError('Give the requirement a title.');return}setError('')
    await onSave({title:form.title.trim(),description:form.description.trim(),category:form.category},requestKey)}}>
    <p className="ob-hint">The requirement is added to the client as a draft, linked to this answer. Review and confirm it in the client’s requirements.</p>
    <fieldset className="ob-fieldset" disabled={busy}>
      <label>Requirement title *<input required maxLength={200} value={form.title} onChange={event=>setForm({...form,title:event.target.value})}/></label>
      <label>Category<select value={form.category} onChange={event=>setForm({...form,category:event.target.value as RequirementCategory})}>{requirementCategories.map(category=><option key={category} value={category}>{requirementCategoryLabels[category]}</option>)}</select></label>
      <label>Description<textarea rows={5} maxLength={4000} value={form.description} onChange={event=>setForm({...form,description:event.target.value})}/></label>
    </fieldset>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Saving…':'Add requirement'}</button></div></form></Modal>
}
/** Copies one of the workspace's forms into this checklist. Later edits to the form never change the copy. */
function AssignFormDialog({workspaceId,stages,busy,onClose,onSave}:{workspaceId:string;stages:Stage[];busy:boolean;onClose:()=>void;onSave:(form:FormSummary,stageId:string|null)=>Promise<void>}){
  const [forms,setForms]=useState<FormSummary[]|null>(null),[loadError,setLoadError]=useState(''),[formId,setFormId]=useState(''),[stageId,setStageId]=useState(''),[error,setError]=useState('')
  useEffect(()=>{let active=true;loadForms(workspaceId).then(result=>{if(!active)return;const usable=result.forms.filter(form=>!form.archived);setForms(usable);setFormId(usable[0]?.id??'')},cause=>{if(active)setLoadError(cause instanceof Error?cause.message:'Unable to load forms.')});return()=>{active=false}},[workspaceId])
  const chosen=forms?.find(form=>form.id===formId)
  return <Modal title="Add a form to this checklist" onClose={onClose}>
    {loadError?<p className="field-error" role="alert">{loadError}</p>:forms===null?<p role="status">Loading forms…</p>:forms.length===0?<p className="ob-muted">This workspace has no active forms yet. Owners and admins create them in Client onboarding → Forms.</p>
    :<form noValidate onSubmit={async event=>{event.preventDefault();if(!chosen){setError('Choose a form.');return}setError('');await onSave(chosen,stageId||null)}}>
      <fieldset className="ob-fieldset" disabled={busy}>
        <label>Form<select value={formId} onChange={event=>setFormId(event.target.value)}>{forms.map(form=><option key={form.id} value={form.id}>{form.name} ({plural(form.fieldCount,'field')})</option>)}</select></label>
        <label>Stage<select value={stageId} onChange={event=>setStageId(event.target.value)}><option value="">No stage</option>{stages.filter(stage=>!stage.archived).map(stage=><option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
      </fieldset>
      {chosen&&<p className="ob-hint">{chosen.description?`${chosen.description} `:''}Its {plural(chosen.fieldCount,'field')} ({chosen.requiredCount} required) are copied into this checklist. Later changes to the form don’t change this copy.</p>}
      {error&&<p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Adding…':'Add form'}</button></div>
    </form>}
    {(loadError||forms?.length===0)&&<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Close</button></div>}
  </Modal>
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
