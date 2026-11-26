import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WorkspaceSummary } from '../lib/backend'
import type { ClientDetail } from '../lib/clients'
import { errorText, shortDate } from '../lib/sales'
import {
  clientRoleHelp, clientRoleLabels, clientRoles, collabTime, conflict, invitationLink, inviteClientUser, portalAccess, renewInvitation, revokeInvitation, setPortalPersonActive,
  updatePortalPerson, type ClientRole, type Invitation, type PortalAccess, type PortalPerson,
} from '../lib/collaboration'
import './ProjectCollaboration.css'

const emailStatusText = (status: Invitation['emailStatus']) => status === null ? 'Not emailed'
  : status === 'pending' || status === 'uncertain' || status === 'sending' ? 'Email queued (sent once email delivery is configured)'
  : status === 'accepted' ? 'Email accepted by the email provider' : status === 'failed' ? 'Email failed' : 'Email cancelled'
const invitationStatusText: Record<Invitation['status'], string> = { pending: 'Pending', expired: 'Expired', accepted: 'Accepted', revoked: 'Revoked' }

/**
 * Who at the client can sign in to the client portal, and the invitations sent to them. Owners and admins invite,
 * change roles and project access, and revoke or restore access; the database checks every portal request against it.
 */
export function ClientPortalAccess({ workspace, detail, locked, onChanged }: { workspace: WorkspaceSummary; detail: ClientDetail; locked: boolean; onChanged: (message: string) => void }) {
  const [data, setData] = useState<PortalAccess | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [inviting, setInviting] = useState(false), [editing, setEditing] = useState<PortalPerson | null>(null), [revoking, setRevoking] = useState<PortalPerson | null>(null)
  const [link, setLink] = useState<{ email: string; token: string } | null>(null)
  const manager = workspace.role !== 'member', canChange = manager && !locked
  const load = useCallback(() => portalAccess(workspace.id, detail.id).then(value => { setData(value); setError('') }), [workspace.id, detail.id])
  useEffect(() => {
    let active = true
    portalAccess(workspace.id, detail.id).then(value => { if (active) setData(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, detail.id])
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('')
    try { await action(); await load(); setNotice(message); onChanged(message); return true }
    catch (cause) { setError(conflict(cause) ? 'This person changed in another window. It has been reloaded; try again.' : errorText(cause)); await load().catch(() => undefined); return false }
    finally { setBusy(false) }
  }
  const projectName = new Map((data?.projects ?? []).map(project => [project.id, project.name]))
  const access = (person: Pick<PortalPerson, 'projectAccess' | 'projectIds'>) => person.projectAccess === 'all' ? 'All shared projects'
    : person.projectIds.map(id => projectName.get(id) ?? 'A removed project').join(', ') || 'No projects'
  const shared = (data?.projects ?? []).filter(project => project.shared).length
  return <section className="panel" aria-labelledby="cb-access-title">
    <div className="section-heading"><div><h2 id="cb-access-title">Client portal access</h2>
      <p>People at {detail.name} who can sign in to the client portal at <strong>/portal</strong>. They see only shared projects, and only what you mark visible. {shared} of {data?.projects.length ?? 0} project{data?.projects.length === 1 ? '' : 's'} shared.</p></div>
      {canChange && <div className="cb-heading-actions"><button className="primary" onClick={() => setInviting(true)}><Icon name="plus" size={15} /> Invite someone</button></div>}</div>
    {!manager && <p className="sp-muted sp-inset">Owners and admins invite people and change their access.</p>}
    {notice && <p className="sp-notice sp-inset" role="status">{notice}</p>}
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {link && <div className="sp-inset"><LinkBox email={link.email} token={link.token} onDone={() => setLink(null)} /></div>}
    {!data ? !error && <p className="sp-loading" role="status">Loading portal access…</p> : <>
      <h3 className="sp-inset">People <span className="number-tag">{data.people.filter(person => person.status === 'active').length}</span></h3>
      {!data.people.length ? <p className="sp-muted sp-inset">Nobody has portal access yet.{canChange ? ' Invite someone to start.' : ''}</p>
        : <ul className="cb-people">{data.people.map(person => <li key={person.id} className={`cb-person${person.status === 'revoked' ? ' is-revoked' : ''}`}>
          <div><strong>{person.name || person.email}</strong>
            <small>{person.name ? `${person.email} · ` : ''}{clientRoleLabels[person.role]} · {access(person)}</small>
            <small>{person.status === 'revoked' ? `Access revoked ${shortDate(person.revokedAt)}` : `Joined ${shortDate(person.activatedAt)} · ${person.lastSeenAt ? `last seen ${collabTime(person.lastSeenAt)}` : 'not signed in since'}`}</small></div>
          {canChange && <div className="cb-person-actions">
            {person.status === 'active' && <button className="text-button" onClick={() => setEditing(person)}>Change access<span className="sr-only"> for {person.email}</span></button>}
            {person.status === 'active' ? <button className="text-button" onClick={() => setRevoking(person)}>Revoke<span className="sr-only"> {person.email}</span></button>
              : <button className="text-button" disabled={busy} onClick={() => void run(() => setPortalPersonActive(workspace.id, person.id, true), `Access restored for ${person.email}.`)}>Restore access<span className="sr-only"> for {person.email}</span></button>}
          </div>}
        </li>)}</ul>}
      <h3 className="sp-inset" style={{ marginTop: 18 }}>Invitations</h3>
      {!data.invitations.length ? <p className="sp-muted sp-inset">No recent invitations.</p>
        : <div className="sp-table-wrap cb-wrap"><table className="sp-table">
          <thead><tr><th>Invited</th><th>Role and access</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{data.invitations.map(invitation => <tr key={invitation.id}>
            <td><strong>{invitation.name || invitation.email}</strong><small>{invitation.name ? invitation.email : ''}{invitation.name ? ' · ' : ''}by {invitation.invitedBy} · {shortDate(invitation.createdAt)}</small></td>
            <td>{clientRoleLabels[invitation.role]}<small>{access(invitation)}</small></td>
            <td>{invitationStatusText[invitation.status]}<small>{invitation.status === 'pending' ? `Expires ${collabTime(invitation.expiresAt)}` : invitation.status === 'expired' ? `Expired ${collabTime(invitation.expiresAt)}` : ''}</small>
              {(invitation.status === 'pending' || invitation.status === 'expired') && <small>{emailStatusText(invitation.emailStatus)}</small>}</td>
            <td className="cl-doc-actions">{canChange && (invitation.status === 'pending' || invitation.status === 'expired') && <>
              <button className="text-button" disabled={busy} onClick={() => void renewInvitation(workspace.id, invitation.id, false).then(async result => { setLink({ email: invitation.email, token: result.token }); await load(); onChanged(`New invitation link for ${invitation.email}.`) }).catch(cause => setError(errorText(cause)))}>New link<span className="sr-only"> for {invitation.email}</span></button>
              <button className="text-button" disabled={busy} onClick={() => void renewInvitation(workspace.id, invitation.id, true).then(async result => { setLink({ email: invitation.email, token: result.token }); await load(); onChanged(`Invitation renewed and queued for email to ${invitation.email}.`) }).catch(cause => setError(errorText(cause)))}>Renew and email</button>
              {invitation.status === 'pending' && <button className="text-button" disabled={busy} onClick={() => void run(() => revokeInvitation(workspace.id, invitation.id), `Invitation for ${invitation.email} revoked.`)}>Revoke</button>}</>}</td>
          </tr>)}</tbody>
        </table></div>}
      <p className="sp-muted sp-inset">Invitation links work once and expire after 7 days. Renewing makes a new link and stops the old one. Client people set their own password; LeadFlow never asks for or stores it.</p>
    </>}
    {inviting && data && <InviteDialog workspace={workspace} client={detail} projects={data.projects} onClose={() => setInviting(false)}
      onInvited={async (email, token) => { setInviting(false); if (token) setLink({ email, token }); await load(); const message = token ? `Invitation created for ${email}.` : `That invitation already existed for ${email}; use New link to get a link.`; setNotice(message); onChanged(message) }} />}
    {editing && data && <EditAccessDialog workspace={workspace} person={editing} projects={data.projects} onClose={() => setEditing(null)}
      onSaved={async message => { setEditing(null); await load(); setNotice(message); onChanged(message) }} onConflict={async () => { setEditing(null); await load(); setError('This person changed in another window. It has been reloaded; try again.') }} />}
    {revoking && <Modal title={`Revoke portal access for ${revoking.email}?`} onClose={() => setRevoking(null)}>
      <p>They can no longer open the portal or any project, file or message, starting with their next request. Emails not yet sent to them are cancelled. Their feedback, approvals and messages stay in the history. You can restore access later.</p>
      <div className="modal-actions"><button className="secondary" onClick={() => setRevoking(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => { const person = revoking; setRevoking(null); void run(() => setPortalPersonActive(workspace.id, person.id, false), `Access revoked for ${person.email}.`) }}>Revoke access</button></div>
    </Modal>}
  </section>
}

function LinkBox({ email, token, onDone }: { email: string; token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const url = invitationLink(token)
  return <div className="cb-link-box" role="status">
    <p><strong>Invitation link for {email}</strong></p>
    <code>{url}</code>
    <p>It works once, expires in 7 days, and isn’t shown again. Send it to {email} yourself, or renew it later for a new one. Anyone with the link can create the account for this address, so share it only with them.</p>
    <div className="sp-actions"><button className="secondary" onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined)}><Icon name="copy" size={15} /> {copied ? 'Copied' : 'Copy link'}</button>
      <button className="text-button" onClick={onDone}>Done</button></div>
  </div>
}

function ProjectPicker({ projects, value, onChange }: { projects: PortalAccess['projects']; value: string[]; onChange: (next: string[]) => void }) {
  if (!projects.length) return <p className="sp-muted">This client has no projects yet.</p>
  return <div className="cb-projects-pick" role="group" aria-label="Projects">{projects.map(project => <label key={project.id} className="cb-check">
    <input type="checkbox" checked={value.includes(project.id)} onChange={event => onChange(event.target.checked ? [...value, project.id] : value.filter(item => item !== project.id))} />
    {project.name}{!project.shared && <span className="sp-muted"> · not shared yet</span>}</label>)}</div>
}

function RoleFields({ role, onRole, projectAccess, onAccess, projectIds, onProjects, projects }: {
  role: ClientRole; onRole: (role: ClientRole) => void; projectAccess: 'all' | 'selected'; onAccess: (value: 'all' | 'selected') => void
  projectIds: string[]; onProjects: (ids: string[]) => void; projects: PortalAccess['projects']
}) {
  return <>
    <label>Role<select value={role} onChange={event => onRole(event.target.value as ClientRole)}>{clientRoles.map(item => <option key={item} value={item}>{clientRoleLabels[item]}</option>)}</select></label>
    <p className="cb-role-help">{clientRoleHelp[role]}</p>
    {role === 'admin' ? <p className="sp-muted">Client admins see every project you share with this client.</p> : <>
      <label>Projects<select value={projectAccess} onChange={event => onAccess(event.target.value as 'all' | 'selected')}>
        <option value="all">All projects shared with this client</option><option value="selected">Only the projects I choose</option></select></label>
      {projectAccess === 'selected' && <ProjectPicker projects={projects} value={projectIds} onChange={onProjects} />}</>}
  </>
}

function InviteDialog({ workspace, client, projects, onClose, onInvited }: {
  workspace: WorkspaceSummary; client: ClientDetail; projects: PortalAccess['projects']; onClose: () => void; onInvited: (email: string, token: string | null) => Promise<void>
}) {
  const [email, setEmail] = useState(''), [name, setName] = useState(''), [role, setRole] = useState<ClientRole>('member'), [projectAccess, setProjectAccess] = useState<'all' | 'selected'>('all')
  const [projectIds, setProjectIds] = useState<string[]>([]), [sendEmail, setSendEmail] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  async function invite() {
    setBusy(true); setError('')
    try {
      const result = await inviteClientUser(workspace.id, client.id, { email: email.trim(), name: name.trim(), role, projectAccess: role === 'admin' ? 'all' : projectAccess, projectIds: projectAccess === 'selected' ? projectIds : [], sendEmail }, requestId.current)
      await onInvited(result.invitation.email, result.token)
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal title={`Invite someone from ${client.name}`} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void invite() }}>
      <p className="sp-intro">They get a single-use link to set their own password and open the client portal. Nothing is sent unless you tick the email option.</p>
      <div className="sp-row"><label>Email *<input type="email" required maxLength={254} autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Name<input maxLength={150} value={name} onChange={event => setName(event.target.value)} /></label></div>
      <RoleFields role={role} onRole={setRole} projectAccess={projectAccess} onAccess={setProjectAccess} projectIds={projectIds} onProjects={setProjectIds} projects={projects} />
      <label className="cb-check"><input type="checkbox" checked={sendEmail} onChange={event => setSendEmail(event.target.checked)} />Also send the invitation by email</label>
      <small>The email is queued and goes out only when email delivery is configured. You’ll see the link once either way.</small>
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !email.trim() || (role !== 'admin' && projectAccess === 'selected' && !projectIds.length)}>{busy ? 'Creating…' : 'Create invitation'}</button></div>
    </form>
  </Modal>
}

function EditAccessDialog({ workspace, person, projects, onClose, onSaved, onConflict }: {
  workspace: WorkspaceSummary; person: PortalPerson; projects: PortalAccess['projects']; onClose: () => void; onSaved: (message: string) => Promise<void>; onConflict: () => Promise<void>
}) {
  const [name, setName] = useState(person.name), [role, setRole] = useState<ClientRole>(person.role), [projectAccess, setProjectAccess] = useState(person.projectAccess)
  const [projectIds, setProjectIds] = useState(person.projectIds), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function save() {
    setBusy(true); setError('')
    try { await updatePortalPerson(workspace.id, person.id, { name: name.trim(), role, projectAccess: role === 'admin' ? 'all' : projectAccess, projectIds }, person.version); await onSaved(`Access updated for ${person.email}.`) }
    catch (cause) { if (conflict(cause)) await onConflict(); else setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Modal title={`Access for ${person.email}`} onClose={onClose}>
    <form className="sp-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <label>Name<input maxLength={150} value={name} onChange={event => setName(event.target.value)} /></label>
      <RoleFields role={role} onRole={setRole} projectAccess={projectAccess} onAccess={setProjectAccess} projectIds={projectIds} onProjects={setProjectIds} projects={projects} />
      <p className="sp-muted">Changes apply to their next request.</p>
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || (role !== 'admin' && projectAccess === 'selected' && !projectIds.length)}>Save access</button></div>
    </form>
  </Modal>
}
