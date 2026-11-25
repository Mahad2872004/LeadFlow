import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { initials } from '../lib/format'
import { navigation, type Page } from '../lib/pages'
import { roleLabels, type WorkspaceRole } from '../lib/workspaceOptions'

export type { Page } from '../lib/pages'
const groups = ['Pipeline', 'Sales', 'Clients', 'Delivery', 'Grow', 'Workspace'] as const
interface SidebarProps { page: Page; dueCount: number; email: string; role: WorkspaceRole; onNavigate:(page:Page)=>void; onReset?:()=>void }
export function Sidebar({page,dueCount,email,role,onNavigate,onReset}:SidebarProps) {
  const nav=useRef<HTMLElement>(null)
  // On narrow screens the navigation scrolls sideways; keep the current section visible. Only the bar scrolls, never the page.
  useEffect(()=>{
    const bar=nav.current,item=bar?.querySelector<HTMLElement>('[aria-current="page"]')
    if(bar&&item&&bar.scrollWidth>bar.clientWidth)bar.scrollLeft=item.offsetLeft-bar.offsetLeft-(bar.clientWidth-item.offsetWidth)/2
  },[page])
  return <aside className="sidebar">
    <a className="brand" aria-label="LeadFlow overview" href="#overview" onClick={event=>{event.preventDefault();onNavigate('Overview')}}>
      <span className="brand-mark"><Icon name="arrow" size={27}/></span>LeadFlow<span className="brand-dot">.</span>
    </a>
    <WorkspaceSwitcher/>
    <nav ref={nav} aria-label="Main navigation">{groups.map(group=><div className="nav-group" key={group}>
      <span className="nav-label" aria-hidden="true">{group}</span>
      {navigation.filter(item=>item.group===group).map(item=><button key={item.page} aria-current={page===item.page?'page':undefined} className={page===item.page?'nav-item active':'nav-item'} onClick={()=>onNavigate(item.page)}>
        <Icon name={item.icon}/><span>{item.page}</span>{item.page==='Follow-ups'&&dueCount>0&&<span className="nav-count">{dueCount}</span>}
      </button>)}
    </div>)}</nav>
    <div className="sidebar-bottom"><div className="demo-card"><span className="live-dot"/> Shared workspace<p>Everyone here sees the same pipeline.</p><small>Changes are saved for every member of this workspace.</small>{onReset&&<button onClick={onReset}><Icon name="reset" size={14}/> Reset demo data</button>}</div><div className="profile"><span className="avatar" aria-hidden="true">{initials(email)}</span><div><strong className="profile-email">{email}</strong><small>{roleLabels[role]} in this workspace</small></div></div></div>
  </aside>
}
