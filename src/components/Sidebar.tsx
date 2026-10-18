import { Icon, type IconName } from './Icon'

export type Page = 'Overview' | 'Leads' | 'Follow-ups' | 'Activity' | 'Integrations'
const navigation: {page: Page; icon: IconName}[] = [
  {page:'Overview',icon:'grid'}, {page:'Leads',icon:'users'},
  {page:'Follow-ups',icon:'calendar'}, {page:'Activity',icon:'clock'}, {page:'Integrations',icon:'spark'},
]
interface SidebarProps { page: Page; dueCount: number; onNavigate:(page:Page)=>void; onReset:()=>void }
export function Sidebar({page,dueCount,onNavigate,onReset}:SidebarProps) {
  return <aside className="sidebar">
    <a className="brand" aria-label="LeadFlow overview" href="#overview" onClick={event=>{event.preventDefault();onNavigate('Overview')}}>
      <span className="brand-mark"><Icon name="arrow" size={27}/></span>LeadFlow<span className="brand-dot">.</span>
    </a>
    <div className="workspace"><span className="workspace-icon">S</span><div><strong>Studio workspace</strong><small>Personal workspace</small></div></div>
    <div className="nav-label">WORKSPACE</div>
    <nav aria-label="Main navigation">{navigation.map(item=><button key={item.page} aria-current={page===item.page?'page':undefined} className={page===item.page?'nav-item active':'nav-item'} onClick={()=>onNavigate(item.page)}>
      <Icon name={item.icon}/><span>{item.page}</span>{item.page==='Follow-ups'&&dueCount>0&&<span className="nav-count">{dueCount}</span>}
    </button>)}</nav>
    <div className="sidebar-bottom"><div className="demo-card"><span className="live-dot"/> PRIVATE WORKSPACE<p>A little pipeline.<br/>A lot of possibilities.</p><small>Your leads, securely saved in Supabase.</small><button onClick={onReset}><Icon name="reset" size={14}/> Reset demo data</button></div><div className="profile"><span className="avatar">YO</span><div><strong>Your workspace</strong><small>Supabase workspace</small></div></div></div>
  </aside>
}

