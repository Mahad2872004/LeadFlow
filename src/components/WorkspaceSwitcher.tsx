import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { initials } from '../lib/format'
import { useWorkspaces } from '../lib/session'
import { roleLabels } from '../lib/workspaceOptions'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { WorkspaceForm } from './WorkspaceForm'
export function WorkspaceSwitcher(){
  const {workspaces,active,locked,switchTo,opened,openPage}=useWorkspaces()
  const [open,setOpen]=useState(false),[creating,setCreating]=useState(false)
  const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),menuId=useId()
  const close=(restoreFocus=true)=>{setOpen(false);if(restoreFocus)trigger.current?.focus()}
  useEffect(()=>{
    if(!open)return
    menu.current?.querySelector<HTMLElement>('[data-item][aria-current="true"]:not(:disabled),[data-item]:not(:disabled)')?.focus()
    const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setOpen(false)}
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside)
  },[open])
  function onKeyDown(event:KeyboardEvent<HTMLDivElement>){
    if(event.key==='Escape'){event.preventDefault();close();return}
    if(event.key==='Tab'){setOpen(false);return}
    const items=Array.from(menu.current?.querySelectorAll<HTMLElement>('[data-item]:not(:disabled)')??[])
    const index=items.indexOf(document.activeElement as HTMLElement)
    const next=event.key==='ArrowDown'?(index+1)%items.length:event.key==='ArrowUp'?(index-1+items.length)%items.length:event.key==='Home'?0:event.key==='End'?items.length-1:-1
    if(next>=0){event.preventDefault();items[next]?.focus()}
  }
  return <div className="workspace-switcher">
    <button ref={trigger} type="button" className="workspace-trigger" aria-haspopup="true" aria-expanded={open} aria-controls={open?menuId:undefined} aria-label={`Switch workspace. Current workspace: ${active.name}`} onClick={()=>setOpen(!open)} onKeyDown={event=>{if(event.key==='ArrowDown'&&!open){event.preventDefault();setOpen(true)}}}>
      <span className="workspace-icon" aria-hidden="true">{initials(active.name)}</span>
      <span className="workspace-trigger-text"><strong>{active.name}</strong><small>{roleLabels[active.role]}{active.businessType?` · ${active.businessType}`:''}</small></span>
      <Icon name="chevron" size={18}/>
    </button>
    {open&&<div id={menuId} ref={menu} className="workspace-menu" onKeyDown={onKeyDown}>
      <p className="workspace-menu-label" id={`${menuId}-label`}>Your workspaces</p>
      {locked&&<p className="workspace-menu-note">Saving is unfinished. Retry or reload this workspace before switching.</p>}
      <ul aria-labelledby={`${menuId}-label`}>{workspaces.map(workspace=><li key={workspace.id}>
        <button type="button" data-item className="workspace-option" aria-current={workspace.id===active.id?'true':undefined} disabled={locked&&workspace.id!==active.id} onClick={()=>{close();if(workspace.id!==active.id)switchTo(workspace.id)}}>
          <span className="workspace-icon" aria-hidden="true">{initials(workspace.name)}</span>
          <span className="workspace-option-text"><strong>{workspace.name}</strong><small>{roleLabels[workspace.role]}</small></span>
          {workspace.id===active.id&&<span className="workspace-current"><Icon name="check" size={17}/><span className="sr-only">Current workspace</span></span>}
        </button></li>)}</ul>
      <div className="workspace-menu-actions">
        <button type="button" data-item disabled={locked} onClick={()=>{close(false);setCreating(true)}}><Icon name="plus" size={17}/>Create workspace</button>
        <button type="button" data-item onClick={()=>{close();openPage('Settings')}}><Icon name="gear" size={17}/>Workspace settings</button>
      </div>
    </div>}
    {creating&&<Modal title="Create a workspace" onClose={()=>setCreating(false)}><p className="modal-intro">Each workspace has its own leads, follow-ups, activity and integrations. You’ll be its owner.</p><WorkspaceForm submitLabel="Create workspace" onCancel={()=>setCreating(false)} onCreated={async(id,name)=>{await opened(id,name);setCreating(false)}}/></Modal>}
  </div>
}
