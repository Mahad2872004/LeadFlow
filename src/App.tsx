import { NotificationCenter } from './components/NotificationCenter'
import { useLocalDay } from './hooks/useLocalDay'
import { isTaskDue, taskState } from './lib/dates'
import { ActivityTimeline } from './components/ActivityTimeline'
import { useEffect, useState } from 'react'
import { LeadForm } from './components/LeadForm'
import { Modal } from './components/Modal'
import { changeStatus, createLead, createTask, statuses, today, toggleTask, updateLead, sources, type Data, type LeadInput } from './lib/model'
import { loadData, saveData } from './lib/storage'
import { sampleData } from './lib/seed'
import { Sidebar, type Page } from './components/Sidebar'
import { DashboardOverview } from './components/DashboardOverview'
import { LeadTable } from './components/LeadTable'
import { TaskList } from './components/TaskList'
import { Icon } from './components/Icon'
import './App.css'


const blank:LeadInput={name:'',email:'',phone:'',company:'',service:'',source:'',message:''}

function App() {
 const day=useLocalDay()
 const [data,setData]=useState<Data|null>(null)
 const [error,setError]=useState<string|null>(null)
 const [blocked,setBlocked]=useState(false)
 const [page,setPage]=useState<Page>('Overview')
 const [search,setSearch]=useState('')
 const [filter,setFilter]=useState('All statuses')
 const [sourceFilter,setSourceFilter]=useState('All sources')
 const [modal,setModal]=useState<'lead'|'edit'|'task'|'reset'|null>(null)
 const [selected,setSelected]=useState<string|null>(null)
 const [formError,setFormError]=useState('')
 const [notice,setNotice]=useState<string[]>([])
 const [showNotices,setShowNotices]=useState(false)
 const [resetVersion,setResetVersion]=useState(0)
 const [taskLead,setTaskLead]=useState('')
 const [taskDue,setTaskDue]=useState(today())
 const [taskNotes,setTaskNotes]=useState('')
 const [taskFilter,setTaskFilter]=useState('Open')
 useEffect(()=>{const timer=window.setTimeout(()=>{try {const result=loadData();setData(result.data);setError(result.error);setBlocked(!!result.error);if(!result.error) setError(saveData(result.data))}catch{setData({version:1,leads:[],tasks:[],activities:[]});setError('Browser storage is unavailable. Changes will only last for this session.')}},0);return ()=>window.clearTimeout(timer)},[])
 function commit(next:Data,message:string,force=false){setData(next);if(!blocked||force)setError(saveData(next));else setError('Saved data could not be read and has not been overwritten. New changes are only in memory and will be lost on refresh. Reset the demo to recover.');setNotice(n=>force?[message]:[message,...n].slice(0,20))}
 function openModal(kind:'lead'|'edit'|'task'|'reset',leadId=''){setFormError('');setTaskLead(leadId||data?.leads[0]?.id||'');setTaskDue(today());setTaskNotes('');setModal(kind)}
 if(!data) return <div className="loading" role="status">Loading your workspace…</div>
 const due=data.tasks.filter(t=>isTaskDue(t,day))
 const visible=data.leads.filter(l=>(filter==='All statuses'||l.status===filter)&&(sourceFilter==='All sources'||l.source===sourceFilter)&&`${l.name} ${l.company} ${l.email} ${l.service}`.toLowerCase().includes(search.trim().toLowerCase()))
 const activeLead=data.leads.find(l=>l.id===selected)

 const tasks=data.tasks.filter(t=>taskFilter==='All'||(taskFilter==='Completed'?t.completed:taskFilter==='Due'?isTaskDue(t,day):taskFilter==='Overdue'?taskState(t,day)==='Overdue':taskFilter==='Upcoming'?taskState(t,day)==='Upcoming':!t.completed)).sort((a,b)=>a.due.localeCompare(b.due))
 function showLeads(status = 'All statuses'){setSearch('');setSourceFilter('All sources');setFilter(status);setPage('Leads')}
 function showDueTasks(){setPage('Follow-ups');setTaskFilter('Due')}
 const displayedLeads=page==='Overview'?visible.toSorted((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5):visible
 function taskList(items:typeof tasks){return <TaskList day={day} tasks={items} leads={data!.leads} onSelect={setSelected} onToggle={task=>commit(toggleTask(data!,task.id),task.completed?'Follow-up reopened.':'Follow-up completed. Nice work!')}/>}
 return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><Sidebar page={page} dueCount={due.length} onNavigate={next=>{setPage(next);setShowNotices(false);if(next==='Leads'){setSearch('');setSourceFilter('All sources');setFilter('All statuses')}if(next==='Follow-ups')setTaskFilter('Open')}} onReset={()=>openModal('reset')}/>
 <main id="main-content" tabIndex={-1}><header className="topbar"><div>Workspace <span>/</span> <strong>{page}</strong></div><div className="header-actions"><span className="local-label"><span className="live-dot"/> Local demo</span><NotificationCenter key={resetVersion} events={notice} tasks={data.tasks} leads={data.leads} day={day} open={showNotices} onOpen={setShowNotices} onClear={()=>setNotice([])} onReview={setSelected}/></div></header>
 <div className="content">{error&&<div className="error-banner" role="alert">{error}{!blocked&&<button className="secondary" onClick={()=>{const failure=saveData(data);setError(failure);if(!failure)setNotice(n=>['Workspace saved successfully.',...n].slice(0,20))}}>Retry saving</button>}</div>}{notice[0]&&<div className="toast" role="status">✓ {notice[0]}</div>}
 <div className="page-heading"><div><div className="eyebrow">YOUR PIPELINE, IN FOCUS</div><h1>{page==='Overview'?'A clear view. A better follow-up.':page}</h1><p>{page==='Overview'?"Keep good conversations moving. Here’s where things stand.":page==='Leads'?'Every opportunity, organized and ready for the next step.':page==='Follow-ups'?'Make the next conversation happen.':'A running history of your workspace.'}</p></div><button className="primary" onClick={()=>openModal(page==='Follow-ups'?'task':'lead')}><Icon name="plus" size={17}/> {page==='Follow-ups'?'Add follow-up':'Add lead'}</button></div>
 {page==='Overview'&&<DashboardOverview day={day} leads={data.leads} tasks={data.tasks} onLeads={showLeads} onFollowUps={showDueTasks}/>}
 {(page==='Overview'||page==='Leads')&&<section className="panel leads-panel"><div className="section-heading"><div><h2>{page==='Overview'?'Recent leads':'All leads'} <span className="number-tag">{data.leads.length}</span></h2><p>{page==='Overview'?'Your five most recent opportunities.':'Every conversation in one place.'}</p></div>{page==='Overview'&&<button className="text-button" onClick={()=>showLeads()}>View all leads <Icon name="arrow" size={16}/></button>}</div><div className="filters"><label className="search"><Icon name="search" size={18}/><input aria-label="Search leads" placeholder="Search name, company, or email…" value={search} onChange={e=>setSearch(e.target.value)}/></label><select aria-label="Filter by status" value={filter} onChange={e=>setFilter(e.target.value)}><option>All statuses</option>{statuses.map(s=><option key={s}>{s}</option>)}</select><select aria-label="Filter by source" value={sourceFilter} onChange={event=>setSourceFilter(event.target.value)}><option>All sources</option>{sources.map(source=><option key={source}>{source}</option>)}</select><span className="results" role="status">{visible.length} results</span>{(search||filter!=='All statuses'||sourceFilter!=='All sources')&&<button className="text-button" onClick={()=>{setSearch('');setFilter('All statuses');setSourceFilter('All sources')}}>Clear filters</button>}</div><LeadTable leads={displayedLeads} onSelect={setSelected} onAdd={()=>openModal('lead')} onStatus={(lead,status)=>commit(changeStatus(data,lead.id,status),`${lead.name} moved to ${status}.`)}/><div className="table-footer">Showing {displayedLeads.length} of {visible.length} matching leads<span>All sample contacts are fictional</span></div></section>}
 {page==='Overview'&&<section className="panel"><div className="section-heading"><div><h2>On your radar</h2><p>Follow-ups due today or earlier</p></div><button className="text-button" onClick={()=>{setPage('Follow-ups');setTaskFilter('Open')}}>View all ↗</button></div>{taskList(due)}</section>}
 {page==='Follow-ups'&&<section className="panel"><div className="section-heading"><h2>Your next steps</h2><select aria-label="Filter tasks" value={taskFilter} onChange={e=>setTaskFilter(e.target.value)}>{['Open','Due','Overdue','Upcoming','Completed','All'].map(s=><option key={s}>{s}</option>)}</select></div>{taskList(tasks)}</section>}
 {page==='Activity'&&<section className="panel"><div className="section-heading"><h2>Workspace activity</h2><span className="soft-tag">{data.activities.length} events</span></div><ActivityTimeline activities={data.activities} leads={data.leads} onSelect={setSelected}/></section>}
 <footer><button className="mobile-reset text-button" onClick={()=>openModal('reset')}>Reset demo data</button>Built for better client relationships.<span>LeadFlow · Demo workspace</span></footer></div></main>
 {(modal==='lead'||modal==='edit')&&<Modal title={modal==='edit'?'Edit lead':'Capture a new lead'} onClose={()=>setModal(null)}><p className="modal-intro">{modal==='edit'?'Keep contact details and your next steps up to date.':'Start a conversation worth following up on.'}</p><LeadForm initial={modal==='edit'&&activeLead?activeLead:blank} initialStatus={modal==='edit'?activeLead?.status:undefined} onCancel={()=>setModal(null)} onSave={(input,status)=>{const next=modal==='edit'&&activeLead?updateLead(data,activeLead.id,input,status):createLead(data,input);commit(next,modal==='edit'?`${input.name.trim()} was updated.${activeLead&&activeLead.status!==status?' Status changed to '+status+'.':''}`:`${input.name.trim()} was added to your leads.`);setModal(null)}}/></Modal>}
 {modal==='task'&&<Modal title="Plan a follow-up" onClose={()=>setModal(null)}>{data.leads.length===0?<div className="empty"><p>Add a lead before scheduling a follow-up.</p><button className="primary" onClick={()=>openModal('lead')}>Add lead</button></div>:<form onSubmit={e=>{e.preventDefault();try{commit(createTask(data,taskLead,taskDue,taskNotes),'Follow-up scheduled.');setModal(null)}catch(err){setFormError(err instanceof Error?err.message:'Unable to create task.')}}}><label>Lead *<select value={taskLead} required onChange={e=>setTaskLead(e.target.value)}>{data.leads.map(l=><option key={l.id} value={l.id}>{l.name} · {l.company||l.email}</option>)}</select></label><label>Due date *<input type="date" required min="0001-01-01" max="9999-12-31" aria-describedby="due-date-help" value={taskDue} onChange={e=>setTaskDue(e.target.value)}/></label><p id="due-date-help" className="muted">Dates use your local calendar. Past dates are allowed and marked overdue; tasks due today become overdue tomorrow.</p><label>Notes *<textarea required maxLength={2000} rows={4} placeholder="What’s the next step?" value={taskNotes} onChange={e=>setTaskNotes(e.target.value)}/></label>{formError&&<p role="alert" className="field-error">{formError}</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={()=>setModal(null)}>Cancel</button><button className="primary">Schedule follow-up</button></div></form>}</Modal>}
 {modal==='reset'&&<Modal title="Reset your demo workspace?" onClose={()=>setModal(null)}><p>This replaces all leads, follow-ups, and activity in this browser with fresh fictional sample data. This cannot be undone.</p><div className="modal-actions"><button className="secondary" onClick={()=>setModal(null)}>Keep my data</button><button className="primary" onClick={()=>{setBlocked(false);setResetVersion(value=>value+1);setShowNotices(false);setSourceFilter('All sources');setTaskFilter('Open');commit(sampleData(),'Demo data restored.',true);setSearch('');setFilter('All statuses');setSelected(null);setModal(null)}}>Reset demo data</button></div></Modal>}
 {activeLead&&!modal&&<Modal title={activeLead.name} onClose={()=>setSelected(null)}><div className="lead-summary"><span className={'status '+activeLead.status.toLowerCase()}>{activeLead.status}</span><p>{activeLead.company||'Independent contact'} · {activeLead.service}</p><a href={`mailto:${activeLead.email}`}>{activeLead.email}</a>{activeLead.phone&&<p><a href={`tel:${activeLead.phone}`}>{activeLead.phone}</a></p>}<p className="muted">Source: {activeLead.source}</p><p className="message">{activeLead.message||'No message provided.'}</p><div className="lead-actions"><button className="primary" onClick={()=>openModal('task',activeLead.id)}>＋ Add follow-up</button><button className="secondary" onClick={()=>openModal('edit')}>Edit lead</button></div></div><h3>Follow-ups</h3>{taskList(data.tasks.filter(t=>t.leadId===activeLead.id))}<h3>Activity history</h3><ActivityTimeline activities={data.activities.filter(a=>a.leadId===activeLead.id)}/></Modal>}
 </div>
}
export default App





