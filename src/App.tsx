import { NotificationCenter } from './components/NotificationCenter'
import { useLocalDay } from './hooks/useLocalDay'
import { isTaskDue, taskState } from './lib/dates'
import { ActivityTimeline } from './components/ActivityTimeline'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LeadForm } from './components/LeadForm'
import { Modal } from './components/Modal'
import { changeStatus, createLead, createTask, statuses, today, toggleTask, updateLead, sources, type Data, type Lead, type LeadInput } from './lib/model'
import { isData, STORAGE_KEY } from './lib/storage'
import { accessDenied, loadWorkspace, saveWorkspace, type WorkspaceSummary } from './lib/backend'
import { useAuth, useWorkspaces } from './lib/session'
import { sampleData } from './lib/seed'
import { Sidebar, type Page } from './components/Sidebar'
import { DashboardOverview } from './components/DashboardOverview'
import { LeadTable } from './components/LeadTable'
import { TaskList } from './components/TaskList'
import { Icon } from './components/Icon'
import { WorkspaceSettings } from './components/WorkspaceSettings'
import './App.css'
import { IntegrationsHub } from './components/IntegrationsHub'
import { ClientOnboarding } from './components/ClientOnboarding'
import { LeadDiscovery } from './components/LeadDiscovery'
import { LeadProvenance } from './components/LeadProvenance'
import { duplicateIndex, forgetOrigins, reasonLabels } from './lib/discovery'


const blank:LeadInput={name:'',email:'',phone:'',company:'',service:'',source:'',message:''}
const headings:Record<Page,[string,string]>={
 Overview:['A clear view. A better follow-up.','Keep good conversations moving. Here’s where things stand.'],
 Leads:['Leads','Every opportunity, organized and ready for the next step.'],
 Discovery:['Lead discovery','Find businesses that match your ideal client, then add the right ones to your pipeline.'],
 'Follow-ups':['Follow-ups','Make the next conversation happen.'],
 Onboarding:['Client onboarding','Collect what each new client needs to provide, review it, and know exactly when they’re ready for delivery.'],
 Activity:['Activity','A running history of your workspace.'],
 Integrations:['Integrations','Connect your website and tools. Keep every opportunity in one place.'],
 Settings:['Workspace settings','Details, members, and your access for this workspace.'],
}

/** One workspace's dashboard. WorkspaceShell remounts it (by key) when the workspace changes. */
function App({workspace,page,onPageChange:setPage,initialNotice}:{workspace:WorkspaceSummary;page:Page;onPageChange:(page:Page)=>void;initialNotice:string}) {
 const day=useLocalDay()
 const {user,signOut}=useAuth()
 const {setLocked,refresh}=useWorkspaces()
 const [data,setData]=useState<Data|null>(null)
 const [error,setError]=useState<string|null>(null)
 // Set when the database refuses this workspace, e.g. after the user was removed from it.
 const [accessLost,setAccessLost]=useState(false)
 const [revision,setRevision]=useState(0)
 const [busy,setBusy]=useState(false)
 const saving=useRef(false)
 const [pending,setPending]=useState<{next:Data;message:string;force:boolean;id:string}|null>(null)
 const [{legacy,legacyError}]=useState(()=>{
   try {const raw=localStorage.getItem(STORAGE_KEY);if(!raw)return {legacy:null,legacyError:''};const parsed:unknown=JSON.parse(raw);if(!isData(parsed))throw new Error();return {legacy:parsed,legacyError:''}}
   catch{return {legacy:null,legacyError:'Existing browser data could not be read. It has been left untouched. Export or repair it before importing.'}}
 })
 const [search,setSearch]=useState('')
 const [filter,setFilter]=useState('All statuses')
 const [sourceFilter,setSourceFilter]=useState('All sources')
 const [modal,setModal]=useState<'lead'|'edit'|'task'|'reset'|'import'|null>(null)
 const [selected,setSelected]=useState<string|null>(null)
 const [formError,setFormError]=useState('')
 const [notice,setNotice]=useState<string[]>(()=>initialNotice?[initialNotice]:[])
 const [showNotices,setShowNotices]=useState(false)
 const [resetVersion,setResetVersion]=useState(0)
 const [taskLead,setTaskLead]=useState('')
 const [taskDue,setTaskDue]=useState(today())
 const [taskNotes,setTaskNotes]=useState('')
 const [taskFilter,setTaskFilter]=useState('Open')
 // A lead handed to Client onboarding to prefill a new request. Cleared by any other navigation.
 const [onboardingLead,setOnboardingLead]=useState<Lead|null>(null)
 // An unsaved attempt belongs to this workspace, so switching waits until it is retried or discarded.
 useEffect(()=>{setLocked(busy||!!pending)},[busy,pending,setLocked])
 useEffect(()=>()=>setLocked(false),[setLocked])
 useEffect(()=>{
   let active=true
   loadWorkspace(workspace.id).then(result=>{if(active){setData(result.data);setRevision(result.revision)}}).catch(cause=>{if(active){setError(cause.message);setAccessLost(accessDenied(cause))}})
   return ()=>{active=false}
 },[workspace.id])
 async function commit(next:Data,message:string,force=false,retryId?:string){
   if(saving.current || (pending&&!retryId)) return false
   saving.current=true;setBusy(true);setError(null)
   const id=retryId??crypto.randomUUID()
   try {
     const savedRevision=await saveWorkspace(next,revision,id,workspace.id)
     setData(next);setRevision(savedRevision);setPending(null);setModal(null)
     if(force){setResetVersion(value=>value+1);setShowNotices(false);setSourceFilter('All sources');setTaskFilter('Open');setSearch('');setFilter('All statuses');setSelected(null)}
     setNotice(n=>force?[message]:[message,...n].slice(0,20))
     return true
   } catch(cause){setModal(null);setSelected(null);setNotice([]);setPending({next,message,force,id});setAccessLost(accessDenied(cause));setError((cause instanceof Error?cause.message:'Unable to save.')+' Retry uses the same request ID. Reload discards this unsaved attempt.');return false}
   finally {saving.current=false;setBusy(false)}
 }
 async function reload(){
   if(saving.current)return
   setBusy(true);saving.current=true
   try{const result=await loadWorkspace(workspace.id);setData(result.data);setRevision(result.revision);setPending(null);setError(null);setAccessLost(false);setModal(null)}
   catch(cause){setError(cause instanceof Error?cause.message:'Unable to load workspace.');setAccessLost(accessDenied(cause))}
   finally{setBusy(false);saving.current=false}
 }
 async function leave(){const problem=await signOut();if(problem)setError(problem)}
 function openModal(kind:'lead'|'edit'|'task'|'reset'|'import',leadId=''){setFormError('');setTaskLead(leadId||data?.leads[0]?.id||'');setTaskDue(today());setTaskNotes('');setModal(kind)}
 function navigateTo(next:Page){setPage(next);setShowNotices(false);setOnboardingLead(null);if(next==='Leads'){setSearch('');setSourceFilter('All sources');setFilter('All statuses')}if(next==='Follow-ups')setTaskFilter('Open')}
 const due=data?data.tasks.filter(t=>isTaskDue(t,day)):[]
 // Matches save_workspace_for: only owners and admins may remove records, which a reset does.
 const canReset=workspace.role!=='member'
 const emptyHint=`Your database workspace is empty. Add a lead, import browser data${canReset?', or use Reset demo data to load fictional samples':''}.`
 const [title,description]=headings[page]
 const dataPage=page!=='Integrations'&&page!=='Settings'&&page!=='Onboarding'&&page!=='Discovery'
 function shell(content:ReactNode){
  return <div className="app-shell" aria-busy={busy||!data} onClickCapture={event=>{if((busy||pending)&&!(event.target as HTMLElement).closest('[data-recovery]')){event.preventDefault();event.stopPropagation()}}}><a className="skip-link" href="#main-content">Skip to content</a><Sidebar page={page} dueCount={due.length} email={user.email} role={workspace.role} onNavigate={navigateTo} onReset={canReset?()=>data&&openModal('reset'):undefined}/>
  <main id="main-content" tabIndex={-1}><header className="topbar"><div className="breadcrumb"><span className="breadcrumb-workspace">{workspace.name}</span> <span>/</span> <strong>{page}</strong></div><div className="header-actions"><span className="local-label"><span className="live-dot"/> Supabase workspace</span><button className="text-button" data-recovery disabled={busy||!!pending} onClick={leave}>Sign out</button>{data&&<><button className="text-button" disabled={busy||!!pending} onClick={reload}>Refresh</button><NotificationCenter key={resetVersion} events={notice} tasks={data.tasks} leads={data.leads} day={day} open={showNotices} onOpen={setShowNotices} onClear={()=>setNotice([])} onReview={setSelected}/></>}</div></header>
  <div className="content">{content}
  <footer>{canReset&&<button className="mobile-reset text-button" onClick={()=>data&&openModal('reset')}>Reset demo data</button>}Built for better client relationships.<span>LeadFlow · {workspace.name}</span></footer></div></main></div>
 }
 if(!data) return shell(error?<div className="error-banner load-error" role="alert"><p><strong>We couldn’t open {workspace.name}.</strong> {error}</p><button className="secondary" disabled={busy} onClick={reload}>Retry loading</button><button className="secondary" onClick={()=>void refresh()}>Refresh workspace list</button></div>
  :<div className="content-skeleton" role="status"><span className="sr-only">Loading your workspace…</span><i className="skeleton skeleton-title"/><div className="skeleton-grid">{[0,1,2,3].map(item=><i key={item} className="skeleton skeleton-card"/>)}</div><i className="skeleton skeleton-panel"/></div>)
 const visible=data.leads.filter(l=>(filter==='All statuses'||l.status===filter)&&(sourceFilter==='All sources'||l.source===sourceFilter)&&`${l.name} ${l.company} ${l.email} ${l.service} ${l.website??""} ${l.industry??""} ${l.city??""}`.toLowerCase().includes(search.trim().toLowerCase()))
 const activeLead=data.leads.find(l=>l.id===selected)
 // Warns before creating a lead that matches one already here, using the same rules as imports.
 function findDuplicate(input:LeadInput){const match=duplicateIndex(data!.leads,[]).find({businessName:input.company,contactName:input.name,email:input.email,phone:input.phone,website:input.website??'',city:input.city??'',postcode:input.postcode??''});return match?.lead?{lead:match.lead,reason:reasonLabels[match.reason]}:null}

 const tasks=data.tasks.filter(t=>taskFilter==='All'||(taskFilter==='Completed'?t.completed:taskFilter==='Due'?isTaskDue(t,day):taskFilter==='Overdue'?taskState(t,day)==='Overdue':taskFilter==='Upcoming'?taskState(t,day)==='Upcoming':!t.completed)).sort((a,b)=>a.due.localeCompare(b.due))
 function showLeads(status = 'All statuses'){setSearch('');setSourceFilter('All sources');setFilter(status);setPage('Leads')}
 function showDueTasks(){setPage('Follow-ups');setTaskFilter('Due')}
 const displayedLeads=page==='Overview'?visible.toSorted((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5):visible
 function taskList(items:typeof tasks){return <TaskList day={day} tasks={items} leads={data!.leads} onSelect={setSelected} onToggle={task=>commit(toggleTask(data!,task.id),task.completed?'Follow-up reopened.':'Follow-up completed. Nice work!')}/>}
 return <>{shell(<>{notice[0]&&<div className="toast" role="status">✓ {notice[0]}</div>}{busy&&<p role="status">Saving or loading workspace…</p>}{error&&<div className="error-banner" role="alert">{error}{pending&&<button data-recovery className="secondary" disabled={busy} onClick={()=>commit(pending.next,pending.message,pending.force,pending.id)}>Retry saving</button>}<button data-recovery className="secondary" disabled={busy} onClick={reload}>Reload workspace{pending?' and discard attempt':''}</button>{accessLost&&<button data-recovery className="secondary" disabled={busy} onClick={()=>void refresh()}>Refresh workspace list</button>}</div>}
 {dataPage&&legacyError&&<p role="alert">{legacyError}</p>}
 {dataPage&&legacy&&data.leads.length===0&&<div className="error-banner">Found {legacy.leads.length} leads saved by M1 in this browser. <button className="secondary" onClick={()=>openModal('import')}>Import browser data</button></div>}
 {dataPage&&data.leads.length===0&&(page==='Overview'?<section className="panel welcome-panel"><div><p className="eyebrow">GETTING STARTED</p><h2>{workspace.name} is ready for its first lead</h2><p>{emptyHint}</p></div><div className="welcome-actions"><button className="primary" onClick={()=>openModal('lead')}><Icon name="plus" size={17}/> Add your first lead</button><button className="secondary" onClick={()=>setPage('Integrations')}>Connect your website</button></div></section>:<p>{emptyHint}</p>)}
 <div className="page-heading"><div><div className="eyebrow">{page==='Settings'?'MANAGE YOUR WORKSPACE':page==='Onboarding'?'FROM SIGNED TO READY':page==='Discovery'?'FIND YOUR NEXT CLIENTS':'YOUR PIPELINE, IN FOCUS'}</div><h1>{title}</h1><p>{description}</p></div>{dataPage&&<button className="primary" onClick={()=>openModal(page==='Follow-ups'?'task':'lead')}><Icon name="plus" size={17}/> {page==='Follow-ups'?'Add follow-up':'Add lead'}</button>}</div>
 {page==='Integrations'&&<IntegrationsHub workspaceId={workspace.id} role={workspace.role}/>}
 {page==='Settings'&&<WorkspaceSettings workspace={workspace}/>}
 {page==='Onboarding'&&<ClientOnboarding workspace={workspace} leads={data.leads} startLead={onboardingLead}/>}
 {page==='Discovery'&&<LeadDiscovery workspace={workspace} leads={data.leads} blocked={busy||!!pending} onImported={async message=>{forgetOrigins(workspace.id);await reload();setNotice(n=>[message,...n].slice(0,20))}} onAddLead={()=>openModal('lead')}/>}
 {page==='Overview'&&<DashboardOverview day={day} leads={data.leads} tasks={data.tasks} onLeads={showLeads} onFollowUps={showDueTasks}/>}
 {(page==='Overview'||page==='Leads')&&<section className="panel leads-panel"><div className="section-heading"><div><h2>{page==='Overview'?'Recent leads':'All leads'} <span className="number-tag">{data.leads.length}</span></h2><p>{page==='Overview'?'Your five most recent opportunities.':'Every conversation in one place.'}</p></div>{page==='Overview'&&<button className="text-button" onClick={()=>showLeads()}>View all leads <Icon name="arrow" size={16}/></button>}</div><div className="filters"><label className="search"><Icon name="search" size={18}/><input aria-label="Search leads" placeholder="Search name, company, or email…" value={search} onChange={e=>setSearch(e.target.value)}/></label><select aria-label="Filter by status" value={filter} onChange={e=>setFilter(e.target.value)}><option>All statuses</option>{statuses.map(s=><option key={s}>{s}</option>)}</select><select aria-label="Filter by source" value={sourceFilter} onChange={event=>setSourceFilter(event.target.value)}><option>All sources</option>{sources.map(source=><option key={source}>{source}</option>)}</select><span className="results" role="status">{visible.length} results</span>{(search||filter!=='All statuses'||sourceFilter!=='All sources')&&<button className="text-button" onClick={()=>{setSearch('');setFilter('All statuses');setSourceFilter('All sources')}}>Clear filters</button>}</div><LeadTable leads={displayedLeads} onSelect={setSelected} onAdd={()=>openModal('lead')} onStatus={(lead,status)=>commit(changeStatus(data,lead.id,status),`${lead.name} moved to ${status}.`)}/><div className="table-footer">Showing {displayedLeads.length} of {visible.length} matching leads<span>All sample contacts are fictional</span></div></section>}
 {page==='Overview'&&<section className="panel"><div className="section-heading"><div><h2>On your radar</h2><p>Follow-ups due today or earlier</p></div><button className="text-button" onClick={()=>{setPage('Follow-ups');setTaskFilter('Open')}}>View all ↗</button></div>{taskList(due)}</section>}
 {page==='Follow-ups'&&<section className="panel"><div className="section-heading"><h2>Your next steps</h2><select aria-label="Filter tasks" value={taskFilter} onChange={e=>setTaskFilter(e.target.value)}>{['Open','Due','Overdue','Upcoming','Completed','All'].map(s=><option key={s}>{s}</option>)}</select></div>{taskList(tasks)}</section>}
 {page==='Activity'&&<section className="panel"><div className="section-heading"><h2>Workspace activity</h2><span className="soft-tag">{data.activities.length} events</span></div><ActivityTimeline activities={data.activities} leads={data.leads} onSelect={setSelected}/></section>}
 </>)}
 {(modal==='lead'||modal==='edit')&&<Modal title={modal==='edit'?'Edit lead':'Capture a new lead'} onClose={()=>setModal(null)}><p className="modal-intro">{modal==='edit'?'Keep contact details and your next steps up to date.':'Start a conversation worth following up on.'}</p><LeadForm initial={modal==='edit'&&activeLead?activeLead:blank} initialStatus={modal==="edit"?activeLead?.status:undefined} findDuplicate={modal==="lead"?findDuplicate:undefined} onCancel={()=>setModal(null)} onSave={async(input,status)=>{const next=modal==='edit'&&activeLead?updateLead(data,activeLead.id,input,status):createLead(data,input);const saved=await commit(next,modal==='edit'?`${input.name.trim()} was updated.${activeLead&&activeLead.status!==status?' Status changed to '+status+'.':''}`:`${input.name.trim()} was added to your leads.`);if(saved)setModal(null)}}/></Modal>}
 {modal==='task'&&<Modal title="Plan a follow-up" onClose={()=>setModal(null)}>{data.leads.length===0?<div className="empty"><p>Add a lead before scheduling a follow-up.</p><button className="primary" onClick={()=>openModal('lead')}>Add lead</button></div>:<form onSubmit={async e=>{e.preventDefault();try{const saved=await commit(createTask(data,taskLead,taskDue,taskNotes),'Follow-up scheduled.');if(saved)setModal(null)}catch(err){setFormError(err instanceof Error?err.message:'Unable to create task.')}}}><label>Lead *<select value={taskLead} required onChange={e=>setTaskLead(e.target.value)}>{data.leads.map(l=><option key={l.id} value={l.id}>{l.name} · {l.company||l.email}</option>)}</select></label><label>Due date *<input type="date" required min="0001-01-01" max="9999-12-31" aria-describedby="due-date-help" value={taskDue} onChange={e=>setTaskDue(e.target.value)}/></label><p id="due-date-help" className="muted">Dates use your local calendar. Past dates are allowed and marked overdue; tasks due today become overdue tomorrow.</p><label>Notes *<textarea required maxLength={2000} rows={4} placeholder="What’s the next step?" value={taskNotes} onChange={e=>setTaskNotes(e.target.value)}/></label>{formError&&<p role="alert" className="field-error">{formError}</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={()=>setModal(null)}>Cancel</button><button className="primary">Schedule follow-up</button></div></form>}</Modal>}
 {modal==='reset'&&<Modal title="Reset your demo workspace?" onClose={()=>setModal(null)}><p>This replaces all leads, follow-ups, and activity in <strong>{workspace.name}</strong> with fresh fictional sample data, for everyone in this workspace. Browser demo records remain untouched. This cannot be undone.</p><div className="modal-actions"><button className="secondary" onClick={()=>setModal(null)}>Keep my data</button><button className="primary" onClick={async()=>{if(!await commit(sampleData(),'Demo data restored.',true))return;setResetVersion(value=>value+1);setShowNotices(false);setSourceFilter('All sources');setTaskFilter('Open');setSearch('');setFilter('All statuses');setSelected(null);setModal(null)}}>Reset demo data</button></div></Modal>}
 {modal==='import'&&<Modal title="Import browser data?" onClose={()=>setModal(null)}><p>Copy {legacy?.leads.length} leads, {legacy?.tasks.length} follow-ups, and their history into {workspace.name}. The original browser data will be kept. No existing server records will be merged or replaced.</p><div className="modal-actions"><button className="secondary" onClick={()=>setModal(null)}>Cancel</button><button className="primary" onClick={async()=>{if(legacy&&data.leads.length===0&&await commit(legacy,'Browser data imported.'))setModal(null)}}>Confirm import</button></div></Modal>}
 {activeLead&&!modal&&<Modal title={activeLead.name} onClose={()=>setSelected(null)}><div className="lead-summary"><span className={'status '+activeLead.status.toLowerCase()}>{activeLead.status}</span><p>{activeLead.company||'Independent contact'} · {activeLead.service}</p>{activeLead.email&&<a href={`mailto:${activeLead.email}`}>{activeLead.email}</a>}{activeLead.phone&&<p><a href={`tel:${activeLead.phone}`}>{activeLead.phone}</a></p>}<LeadProvenance workspaceId={workspace.id} lead={activeLead}/><p className="muted">Source: {activeLead.source}</p><p className="message">{activeLead.message||'No message provided.'}</p><div className="lead-actions"><button className="primary" onClick={()=>openModal('task',activeLead.id)}>＋ Add follow-up</button><button className="secondary" onClick={()=>openModal('edit')}>Edit lead</button><button className="secondary" onClick={()=>{setOnboardingLead(activeLead);setSelected(null);setPage('Onboarding')}}>Start client onboarding</button></div></div><h3>Follow-ups</h3>{taskList(data.tasks.filter(t=>t.leadId===activeLead.id))}<h3>Activity history</h3><ActivityTimeline activities={data.activities.filter(a=>a.leadId===activeLead.id)}/></Modal>}
 </>
}
export default App
