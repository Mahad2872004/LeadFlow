import { useEffect, useState, type FormEvent } from 'react'
import { accessDenied, type WorkspaceSummary } from '../lib/backend'
import { localDate } from '../lib/dates'
import { dateLabel } from '../lib/format'
import type { Lead } from '../lib/model'
import { createRequest, loadOverview, nextAction, readinessLabels, readinessStates, serviceLabels, serviceTypes, type Overview, type ReadinessState, type ServiceType } from '../lib/onboarding'
import { useAuth, useWorkspaces } from '../lib/session'
import { Icon } from './Icon'
import { MetricCard } from './MetricCard'
import { Modal } from './Modal'
import { ReadinessBadge, ReadinessProgress } from './OnboardingReadiness'
import { OnboardingRequest } from './OnboardingRequest'
import { OnboardingTemplates } from './OnboardingTemplates'
import './Onboarding.css'
type LoadState={status:'loading'}|{status:'error';message:string;denied:boolean}|{status:'ready';overview:Overview}
type DueFilter='all'|'overdue'|'week'|'none'
interface Filters { search: string; state: ReadinessState | 'all'; service: ServiceType | 'all'; owner: string; due: DueFilter }
const noFilters:Filters={search:'',state:'all',service:'all',owner:'all',due:'all'}
const addDays=(day:string,days:number)=>{const date=new Date(`${day}T12:00:00`);date.setDate(date.getDate()+days);return localDate(date)}
/** `startLead` opens the new-onboarding form prefilled from that lead when this section mounts. */
interface OnboardingProps { workspace: WorkspaceSummary; leads: Lead[]; startLead: Lead | null }
/** Client onboarding for one workspace: readiness dashboard, requests, templates and request details. */
export function ClientOnboarding({workspace,leads,startLead}:OnboardingProps){
  const {refresh}=useWorkspaces()
  const [state,setState]=useState<LoadState>({status:'loading'}),[attempt,setAttempt]=useState(0)
  const [tab,setTab]=useState<'requests'|'templates'>('requests'),[openId,setOpenId]=useState<string|null>(null)
  const [creating,setCreating]=useState<{lead?:Lead;templateId?:string}|null>(()=>startLead?{lead:startLead}:null),[notice,setNotice]=useState('')
  const [filters,setFilters]=useState<Filters>(noFilters)
  useEffect(()=>{
    let active=true
    loadOverview(workspace.id).then(overview=>{if(active)setState({status:'ready',overview})}).catch(cause=>{if(active)setState({status:'error',message:cause instanceof Error?cause.message:'Unable to load client onboarding.',denied:accessDenied(cause)})})
    return()=>{active=false}
  },[workspace.id,attempt])
  const reload=(message='')=>{setNotice(message);setAttempt(value=>value+1)}
  if(state.status==='loading')return <div className="content-skeleton" role="status"><span className="sr-only">Loading client onboarding…</span><div className="skeleton-grid">{[0,1,2,3].map(item=><i key={item} className="skeleton skeleton-card"/>)}</div><i className="skeleton skeleton-panel"/></div>
  if(state.status==='error')return <div className="error-banner load-error" role="alert"><p><strong>{state.denied?'You don’t have access to this workspace’s onboarding.':'We couldn’t load client onboarding.'}</strong> {state.message}</p>
    <button className="secondary" onClick={()=>{setState({status:'loading'});setAttempt(value=>value+1)}}>Try again</button>{state.denied&&<button className="secondary" onClick={()=>void refresh()}>Refresh workspace list</button>}</div>
  const {overview}=state
  if(openId)return <OnboardingRequest key={openId} workspace={workspace} requestId={openId} members={overview.members} leads={leads} onBack={message=>{setOpenId(null);reload(message)}}/>
  const {requests,today}=overview
  const ownerName=(id:string|null)=>id?overview.members.find(member=>member.id===id)?.name??'Former member':'Unassigned'
  const current=requests.filter(request=>['draft','active','paused'].includes(request.status))
  const weekAhead=addDays(today,7)
  const visible=requests.filter(request=>(filters.state==='all'||request.readiness.state===filters.state)&&(filters.service==='all'||request.serviceType===filters.service)
    &&(filters.owner==='all'||(filters.owner==='none'?!request.ownerId:request.ownerId===filters.owner))
    &&(filters.due==='all'||(filters.due==='overdue'?request.counts.overdue>0:filters.due==='none'?!request.dueDate:!!request.dueDate&&request.dueDate>=today&&request.dueDate<=weekAhead))
    &&`${request.title} ${request.clientName}`.toLowerCase().includes(filters.search.trim().toLowerCase()))
  const filtered=JSON.stringify(filters)!==JSON.stringify(noFilters)
  const show=(next:Partial<Filters>)=>{setTab('requests');setFilters({...noFilters,...next})}
  return <div className="ob">
    {notice&&<div className="toast" role="status">✓ {notice}</div>}
    <div className="ob-toolbar">
      <div className="ob-tabs" role="tablist" aria-label="Client onboarding views">
        <button role="tab" aria-selected={tab==='requests'} className={tab==='requests'?'active':''} onClick={()=>setTab('requests')}>Requests <span className="number-tag">{requests.length}</span></button>
        <button role="tab" aria-selected={tab==='templates'} className={tab==='templates'?'active':''} onClick={()=>setTab('templates')}>Templates <span className="number-tag">{overview.templates.filter(template=>!template.archived).length}</span></button>
      </div>
      <div className="ob-toolbar-actions"><button className="text-button" onClick={()=>reload('Showing the latest responses.')}>Check for updates</button><button className="primary" onClick={()=>setCreating({})}><Icon name="plus" size={17}/> New onboarding</button></div>
    </div>
    {tab==='templates'?<OnboardingTemplates workspace={workspace} templates={overview.templates} onChanged={reload} onUse={templateId=>{setTab('requests');setCreating({templateId})}}/>:<>
      <div className="stats ob-stats">
        <MetricCard label="In progress" value={current.length} hint="Drafts, open and paused" icon="clipboard" onClick={()=>show({})}/>
        <MetricCard label="Waiting on client" value={requests.filter(request=>request.readiness.state==='waiting_on_client').length} hint="Required items not yet provided" icon="users" onClick={()=>show({state:'waiting_on_client'})}/>
        <MetricCard label="Items to review" value={current.reduce((sum,request)=>sum+request.counts.awaitingReview,0)} hint="Submitted by clients" icon="check" onClick={()=>show({state:'awaiting_review'})}/>
        <MetricCard label="Overdue items" value={current.reduce((sum,request)=>sum+request.counts.overdue,0)} hint="Required and past their due date" icon="clock" onClick={()=>show({due:'overdue'})}/>
        <MetricCard label="Ready for handoff" value={requests.filter(request=>request.readiness.state==='ready').length} hint="Every required item resolved" icon="arrow" accent onClick={()=>show({state:'ready'})}/>
      </div>
      <section className="panel" aria-labelledby="ob-requests-title">
        <div className="section-heading"><div><h2 id="ob-requests-title">Onboarding requests</h2><p>What each client still needs to provide, and what your team needs to review.</p></div></div>
        {requests.length>0&&<div className="filters">
          <label className="search"><Icon name="search" size={18}/><input aria-label="Search onboarding requests" placeholder="Search client or project…" value={filters.search} onChange={event=>setFilters({...filters,search:event.target.value})}/></label>
          <select aria-label="Filter by status" value={filters.state} onChange={event=>setFilters({...filters,state:event.target.value as Filters['state']})}><option value="all">All statuses</option>{readinessStates.map(value=><option key={value} value={value}>{readinessLabels[value]}</option>)}</select>
          <select aria-label="Filter by service" value={filters.service} onChange={event=>setFilters({...filters,service:event.target.value as Filters['service']})}><option value="all">All services</option>{serviceTypes.map(value=><option key={value} value={value}>{serviceLabels[value]}</option>)}</select>
          <select aria-label="Filter by owner" value={filters.owner} onChange={event=>setFilters({...filters,owner:event.target.value})}><option value="all">All owners</option><option value="none">Unassigned</option>{overview.members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select>
          <select aria-label="Filter by due date" value={filters.due} onChange={event=>setFilters({...filters,due:event.target.value as DueFilter})}><option value="all">Any due date</option><option value="overdue">Has overdue items</option><option value="week">Inputs due within 7 days</option><option value="none">No due date</option></select>
          <span className="results" role="status">{visible.length} of {requests.length}</span>
          {filtered&&<button className="text-button" onClick={()=>setFilters(noFilters)}>Clear filters</button>}
        </div>}
        {requests.length===0?<div className="ob-empty"><h3>Start your first client onboarding</h3>
          <p>Create an onboarding when a client signs. Pick a service template, adjust the checklist for this client, then share one private link. You’ll see exactly which required items are blocking delivery.</p>
          <div className="welcome-actions"><button className="primary" onClick={()=>setCreating({})}><Icon name="plus" size={17}/> New onboarding</button>{overview.templates.length===0&&<button className="secondary" onClick={()=>setTab('templates')}>Set up templates</button>}</div></div>
        :visible.length===0?<div className="ob-empty"><p>No onboarding requests match these filters.</p><button className="secondary" onClick={()=>setFilters(noFilters)}>Clear filters</button></div>
        :<ul className="ob-list">{visible.map(request=><li key={request.id}><button className="ob-row" onClick={()=>setOpenId(request.id)} aria-label={`Open ${request.title} for ${request.clientName}`}>
          <span className="ob-row-main"><strong>{request.title}</strong><small>{request.clientName} · {serviceLabels[request.serviceType]}</small></span>
          <span className="ob-row-status"><ReadinessBadge state={request.readiness.state}/><ReadinessProgress readiness={request.readiness}/></span>
          <span className="ob-row-counts"><span>{request.counts.requiredOutstanding} required outstanding</span><span>{request.counts.awaitingReview} to review</span>{request.counts.overdue>0&&<span className="ob-overdue">{request.counts.overdue} overdue</span>}</span>
          <span className="ob-row-meta"><span><small>Owner</small>{ownerName(request.ownerId)}</span><span><small>Target kickoff</small>{request.targetKickoffDate?dateLabel(request.targetKickoffDate):'Not set'}</span></span>
          <span className="ob-row-next"><small>Next action</small>{nextAction(request)}</span>
        </button></li>)}</ul>}
      </section>
    </>}
    {creating&&<CreateRequest workspace={workspace} overview={overview} leads={leads} initial={creating} onClose={()=>setCreating(null)} onCreated={id=>{setCreating(null);setNotice('');setOpenId(id)}}/>}
  </div>
}
function CreateRequest({workspace,overview,leads,initial,onClose,onCreated}:{workspace:WorkspaceSummary;overview:Overview;leads:Lead[];initial:{lead?:Lead;templateId?:string};onClose:()=>void;onCreated:(id:string)=>void}){
  const {user}=useAuth()
  const templates=overview.templates.filter(template=>!template.archived),lead=initial.lead
  const firstTemplate=templates.find(template=>template.id===initial.templateId)??templates[0]
  const [form,setForm]=useState({templateId:firstTemplate?.id??'',serviceType:(firstTemplate?.serviceType??'other') as ServiceType,title:lead?`${lead.company||lead.name} onboarding`:'',clientName:lead?lead.company||lead.name:'',
    contactName:lead?.name??'',contactEmail:lead?.email??'',ownerId:overview.members.some(member=>member.id===user.id)?user.id:'',startDate:'',targetKickoffDate:'',dueDate:'',leadId:lead?.id??'',clientInstructions:''})
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  // Kept while the dialog is open, so retrying after a lost response returns the same request.
  const [requestId]=useState(()=>crypto.randomUUID())
  const set=(changes:Partial<typeof form>)=>{setForm(current=>({...current,...changes}));setError('')}
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    if(!form.title.trim()||!form.clientName.trim()){setError('Enter a project name and a client name.');return}
    if(form.contactEmail.trim()&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail.trim())){setError('Enter a valid contact email address, or leave it blank.');return}
    if(form.startDate&&form.targetKickoffDate&&form.targetKickoffDate<form.startDate){setError('The target kickoff date cannot be before the start date.');return}
    setBusy(true);setError('')
    try{onCreated(await createRequest(workspace.id,{templateId:form.templateId||null,serviceType:form.serviceType,title:form.title,clientName:form.clientName,contactName:form.contactName,contactEmail:form.contactEmail,
      ownerId:form.ownerId||null,startDate:form.startDate||null,targetKickoffDate:form.targetKickoffDate||null,dueDate:form.dueDate||null,leadId:form.leadId||null,clientInstructions:form.clientInstructions},requestId))}
    catch(cause){setError(cause instanceof Error?cause.message:'Unable to create this onboarding.')}
    finally{setBusy(false)}
  }
  const chosen=templates.find(template=>template.id===form.templateId)
  return <Modal title="New client onboarding" onClose={onClose}>
    <p className="modal-intro">Nothing is sent to the client yet. You’ll review the checklist, then open it and share a private link.</p>
    <form noValidate onSubmit={submit}><fieldset className="ob-fieldset" disabled={busy}>
      <label>Template<select value={form.templateId} onChange={event=>{const template=templates.find(item=>item.id===event.target.value);set({templateId:event.target.value,serviceType:template?.serviceType??form.serviceType})}}>
        <option value="">Blank checklist</option>{templates.map(template=><option key={template.id} value={template.id}>{template.name} ({template.itemCount} items)</option>)}</select></label>
      <p className="ob-hint">{chosen?`The ${chosen.itemCount} items are copied into this onboarding. You can change them for this client without changing the template.`:'Start empty and add items yourself.'}</p>
      <div className="form-grid">
        <label>Project name *<input required maxLength={150} value={form.title} onChange={event=>set({title:event.target.value})} placeholder="Spring campaign onboarding"/></label>
        <label>Client name *<input required maxLength={150} value={form.clientName} onChange={event=>set({clientName:event.target.value})}/></label>
        <label>Client contact (optional)<input maxLength={150} value={form.contactName} onChange={event=>set({contactName:event.target.value})}/></label>
        <label>Contact email (optional)<input type="email" maxLength={254} value={form.contactEmail} onChange={event=>set({contactEmail:event.target.value})} aria-describedby="ob-email-hint"/></label>
        <label>Service<select value={form.serviceType} onChange={event=>set({serviceType:event.target.value as ServiceType})}>{serviceTypes.map(type=><option key={type} value={type}>{serviceLabels[type]}</option>)}</select></label>
        <label>Owner<select value={form.ownerId} onChange={event=>set({ownerId:event.target.value})}><option value="">Unassigned</option>{overview.members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>Start date<input type="date" value={form.startDate} onChange={event=>set({startDate:event.target.value})}/></label>
        <label>Target kickoff<input type="date" value={form.targetKickoffDate} onChange={event=>set({targetKickoffDate:event.target.value})}/></label>
        <label>Client inputs due<input type="date" value={form.dueDate} onChange={event=>set({dueDate:event.target.value})}/></label>
        <label>Linked lead (optional)<select value={form.leadId} onChange={event=>set({leadId:event.target.value})}><option value="">No linked lead</option>{leads.map(item=><option key={item.id} value={item.id}>{item.name}{item.company?` · ${item.company}`:''}</option>)}</select></label>
      </div>
      <p id="ob-email-hint" className="ob-hint">The contact email is used only for optional reminders. Nothing is emailed when you create the onboarding.</p>
      <label>Instructions for the client (optional)<textarea rows={3} maxLength={4000} value={form.clientInstructions} onChange={event=>set({clientInstructions:event.target.value})} placeholder="Welcome! Here’s what we need before your first campaign…"/></label>
    </fieldset>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Creating…':'Create onboarding'}</button></div></form>
  </Modal>
}
