import { useCallback, useEffect, useMemo, useState } from 'react'
import App from '../App'
import { listWorkspaces, type WorkspaceSummary } from '../lib/backend'
import { useAuth, WorkspaceContext, type WorkspaceValue } from '../lib/session'
import { Icon } from './Icon'
import type { Page } from './Sidebar'
import { WorkspaceForm } from './WorkspaceForm'
import './Workspace.css'
type ListState={status:'loading'}|{status:'error';message:string}|{status:'ready';workspaces:WorkspaceSummary[]}
const none:WorkspaceSummary[]=[]
const listed=(workspaces:WorkspaceSummary[]):ListState=>({status:'ready',workspaces})
const failed=(cause:unknown):ListState=>({status:'error',message:cause instanceof Error?cause.message:'Unable to load your workspaces.'})
export function WorkspaceShell(){
  const {user,signOut}=useAuth()
  // Remembering the last workspace is a convenience only; an ID not in the user's list is ignored.
  const storageKey=`leadflow.workspace.${user.id}`
  const [list,setList]=useState<ListState>({status:'loading'})
  const [activeId,setActiveId]=useState<string|null>(()=>{try{return localStorage.getItem(storageKey)}catch{return null}})
  const [page,setPage]=useState<Page>('Overview'),[notice,setNotice]=useState(''),[locked,setLocked]=useState(false)
  const load=useCallback(()=>listWorkspaces().then(listed,failed).then(setList),[])
  useEffect(()=>{
    let active=true
    listWorkspaces().then(listed,failed).then(next=>{if(active)setList(next)})
    return()=>{active=false}
  },[])
  const select=useCallback((id:string,message:string)=>{setActiveId(id);setNotice(message);try{localStorage.setItem(storageKey,id)}catch{/* optional convenience */}},[storageKey])
  const workspaces=list.status==='ready'?list.workspaces:none
  const active=workspaces.find(workspace=>workspace.id===activeId)??workspaces[0]
  const value=useMemo<WorkspaceValue|null>(()=>active?{workspaces,active,locked,setLocked,
    switchTo:id=>{const target=workspaces.find(workspace=>workspace.id===id);if(target&&!locked)select(id,`Switched to ${target.name}.`)},
    opened:async(id,name)=>{await load();select(id,`${name} is ready.`)},
    refresh:load,openPage:setPage}:null,[workspaces,active,locked,load,select])
  if(list.status==='loading')return <ShellSkeleton/>
  if(list.status==='error')return <main className="shell-message"><div className="panel"><h1>We couldn’t load your workspaces</h1><p role="alert">{list.message}</p><div className="modal-actions"><button className="secondary" onClick={()=>void signOut()}>Sign out</button><button className="primary" onClick={()=>{setList({status:'loading'});void load()}}>Try again</button></div></div></main>
  if(!value)return <Onboarding onCreated={async(id,name)=>{await load();select(id,`${name} is ready. Add your first lead to get started.`)}}/>
  return <WorkspaceContext.Provider value={value}><App key={value.active.id} workspace={value.active} page={page} onPageChange={setPage} initialNotice={notice}/></WorkspaceContext.Provider>
}
export function ShellSkeleton(){
  return <div className="app-shell shell-skeleton" role="status" aria-label="Loading your workspace"><aside className="sidebar"><i className="skeleton skeleton-brand"/><i className="skeleton skeleton-switcher"/>{[0,1,2,3,4].map(item=><i key={item} className="skeleton skeleton-nav"/>)}</aside><main><div className="topbar"><i className="skeleton skeleton-line"/></div><div className="content"><i className="skeleton skeleton-title"/><div className="skeleton-grid">{[0,1,2,3].map(item=><i key={item} className="skeleton skeleton-card"/>)}</div><i className="skeleton skeleton-panel"/></div></main></div>
}
function Onboarding({onCreated}:{onCreated:(id:string,name:string)=>Promise<void>}){
  const {user,signOut}=useAuth()
  const [error,setError]=useState('')
  return <main className="onboarding">
    <header className="onboarding-top"><span className="auth-brand"><span className="brand-mark"><Icon name="arrow" size={22}/></span>LeadFlow<span className="brand-dot">.</span></span><div><span className="onboarding-email">Signed in as <strong>{user.email}</strong></span><button className="text-button" onClick={async()=>setError(await signOut()??'')}>Sign out</button></div></header>
    {error&&<p className="auth-alert" role="alert">{error}</p>}
    <div className="onboarding-body">
      <section className="onboarding-card panel" aria-labelledby="onboarding-title">
        <p className="eyebrow">WELCOME TO LEADFLOW</p>
        <h1 id="onboarding-title">Create your first workspace</h1>
        <p className="onboarding-lead">A workspace keeps one business’s leads, follow-ups and integrations together. You can rename it or add more workspaces later.</p>
        <WorkspaceForm submitLabel="Create workspace" onCreated={onCreated}/>
      </section>
      <ul className="onboarding-points" aria-label="What you can do next">{[['users','Capture every inquiry','Add leads yourself or connect your website form.'],['calendar','Plan the next step','Schedule follow-ups and see what is due today.'],['grid','Switch when you need to','Keep separate workspaces and move between them anytime.']].map(([icon,title,text])=><li key={title}><span><Icon name={icon as 'users'|'calendar'|'grid'}/></span><div><strong>{title}</strong><p>{text}</p></div></li>)}</ul>
    </div>
  </main>
}
