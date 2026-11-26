import { useId, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../Icon'
import { ThemeToggle } from '../ThemeToggle'
import { HubLink, Avatar } from './hubShared'
import { roleLabel, useHub } from './hubKit'

export type HubSection = 'overview' | 'projects' | 'reviews' | 'messages' | 'files' | 'notifications' | 'settings' | 'none'

const sections: { key: Exclude<HubSection, 'none'>; label: string; icon: IconName; to: string; mobile: boolean }[] = [
  { key: 'overview', label: 'Overview', icon: 'grid', to: '/portal', mobile: true },
  { key: 'projects', label: 'My projects', icon: 'project', to: '/portal/projects', mobile: true },
  { key: 'reviews', label: 'Reviews & approvals', icon: 'check', to: '/portal/reviews', mobile: true },
  { key: 'messages', label: 'Messages', icon: 'chat', to: '/portal/messages', mobile: true },
  { key: 'files', label: 'Files & documents', icon: 'clipboard', to: '/portal/files', mobile: true },
  { key: 'notifications', label: 'Notifications', icon: 'bell', to: '/portal/notifications', mobile: false },
  { key: 'settings', label: 'Account settings', icon: 'gear', to: '/portal/settings', mobile: false },
]
const shortLabel: Partial<Record<HubSection, string>> = { overview: 'Home', projects: 'Projects', reviews: 'Reviews', messages: 'Messages', files: 'Files' }

function AccountSwitcher() {
  const hub = useHub()
  const id = useId()
  if (hub.accounts.length < 2) return null
  return <div className="hb-switch">
    <label htmlFor={id}>Client space</label>
    <select id={id} value={hub.accessId} onChange={event => hub.setAccess(event.target.value)}>
      {hub.accounts.map(account => <option key={account.accessId} value={account.accessId}>{account.clientName} · {account.agencyName}</option>)}
    </select>
  </div>
}

export function HubShell({ section, awaiting, children }: { section: HubSection; awaiting: number; children: ReactNode }) {
  const hub = useHub()
  const [signingOut, setSigningOut] = useState(false)
  const signOut = async () => { setSigningOut(true); await hub.signOut(); setSigningOut(false) }
  const badge = (key: HubSection) => key === 'notifications' ? hub.unread : key === 'reviews' ? awaiting : 0
  return <div className="hb-app">
    <a className="hb-skip" href="#hb-main">Skip to content</a>
    <aside className="hb-side" aria-label="Client portal">
      <div className="hb-side-brand">
        <Avatar name={hub.agencyName} size="lg" />
        <div><strong>{hub.agencyName}</strong><small>Client portal</small></div>
      </div>
      <div className="hb-side-client"><span className="hb-eyebrow">Signed in for</span><strong>{hub.clientName}</strong></div>
      <AccountSwitcher />
      <nav className="hb-nav" aria-label="Portal sections">
        {sections.map(item => <HubLink key={item.key} to={item.to} className={`hb-nav-item${section === item.key ? ' is-active' : ''}`} ariaCurrent={section === item.key ? 'page' : undefined}>
          <Icon name={item.icon} size={18} /><span>{item.label}</span>{badge(item.key) > 0 && <b className="hb-badge" aria-label={`${badge(item.key)} new`}>{badge(item.key) > 99 ? '99+' : badge(item.key)}</b>}
        </HubLink>)}
      </nav>
      <div className="hb-side-foot">
        <div className="hb-me"><Avatar name={hub.name || hub.email} size="sm" /><div><strong>{hub.name || hub.email}</strong><small>{roleLabel[hub.role]}</small></div></div>
        <button type="button" className="hb-btn is-ghost is-sm is-block" onClick={signOut} disabled={signingOut}><Icon name="logout" size={15} /> {signingOut ? 'Signing out…' : 'Sign out'}</button>
        <p className="hb-powered">Powered by LeadFlow</p>
      </div>
    </aside>
    <div className="hb-body">
      <header className="hb-top">
        <div className="hb-top-id"><Avatar name={hub.agencyName} size="sm" /><div><strong>{hub.clientName}</strong><small>{hub.agencyName}</small></div></div>
        <div className="hb-top-actions">
          <HubLink to="/portal/notifications" className={`hb-icon-btn hb-bell${section === 'notifications' ? ' is-active' : ''}`} ariaLabel={hub.unread ? `Notifications, ${hub.unread} unread` : 'Notifications'}>
            <Icon name="bell" size={18} />{hub.unread > 0 && <b className="hb-dot" aria-hidden="true">{hub.unread > 9 ? '9+' : hub.unread}</b>}
          </HubLink>
          <ThemeToggle className="hb-icon-btn" />
          <HubLink to="/portal/settings" className={`hb-icon-btn hb-only-mobile${section === 'settings' ? ' is-active' : ''}`} ariaLabel="Account settings"><Icon name="gear" size={18} /></HubLink>
        </div>
      </header>
      <main id="hb-main" className="hb-main" tabIndex={-1}>{children}</main>
    </div>
    <nav className="hb-bottom" aria-label="Portal sections">
      {sections.filter(item => item.mobile).map(item => <HubLink key={item.key} to={item.to} className={`hb-bottom-item${section === item.key ? ' is-active' : ''}`} ariaCurrent={section === item.key ? 'page' : undefined}>
        <span className="hb-bottom-icon"><Icon name={item.icon} size={20} />{badge(item.key) > 0 && <b className="hb-dot" aria-hidden="true">{badge(item.key) > 9 ? '9+' : badge(item.key)}</b>}</span>
        <span>{shortLabel[item.key]}</span>
      </HubLink>)}
    </nav>
  </div>
}
