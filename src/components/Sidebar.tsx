import { Icon, type IconName } from './Icon'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { initials } from '../lib/format'
import { roleLabels, type WorkspaceRole } from '../lib/workspaceOptions'

export type Page = 'Overview' | 'Leads' | 'Follow-ups' | 'Onboarding' | 'Activity' | 'Integrations' | 'Settings'
const navigation: {page: Page; icon: IconName}[] = [
  {page:'Overview',icon:'grid'}, {page:'Leads',icon:'users'},
  {page:'Follow-ups',icon:'calendar'}, {page:'Onboarding',icon:'clipboard'}, {page:'Activity',icon:'clock'}, {page:'Integrations',icon:'spark'}, {page:'Settings',icon:'gear'},
]
interface SidebarProps { page: Page; dueCount: number; email: string; role: WorkspaceRole; onNavigate:(page:Page)=>void; onReset?:()=>void }
export function Sidebar({page,dueCount,email,role,onNavigate,onReset}:SidebarProps) {
  return <aside className="sidebar">
    <a className="brand" aria-label="LeadFlow overview" href="#overview" onClick={event=>{event.preventDefault();onNavigate('Overview')}}>
      <span className="brand-mark"><Icon name="arrow" size={27}/></span>LeadFlow<span className="brand-dot">.</span>
    </a>
    <WorkspaceSwitcher/>
    <div className="nav-label">WORKSPACE</div>
    <nav aria-label="Main navigation">{navigation.map(item=><button key={item.page} aria-current={page===item.page?'page':undefined} className={page===item.page?'nav-item active':'nav-item'} onClick={()=>onNavigate(item.page)}>
      <Icon name={item.icon}/><span>{item.page}</span>{item.page==='Follow-ups'&&dueCount>0&&<span className="nav-count">{dueCount}</span>}
    </button>)}</nav>
    <div className="sidebar-bottom"><div className="demo-card"><span className="live-dot"/> SHARED WITH YOUR TEAM<p>A little pipeline.<br/>A lot of possibilities.</p><small>Changes here are saved for everyone in this workspace.</small>{onReset&&<button onClick={onReset}><Icon name="reset" size={14}/> Reset demo data</button>}</div><div className="profile"><span className="avatar" aria-hidden="true">{initials(email)}</span><div><strong className="profile-email">{email}</strong><small>{roleLabels[role]} in this workspace</small></div></div></div>
  </aside>
}
