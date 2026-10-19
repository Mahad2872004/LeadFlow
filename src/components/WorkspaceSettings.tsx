import { useEffect, useId, useState, type FormEvent } from 'react'
import { listWorkspaceMembers, updateWorkspace, type WorkspaceMember, type WorkspaceSummary } from '../lib/backend'
import { dateLabel, initials } from '../lib/format'
import { useAuth, useWorkspaces } from '../lib/session'
import { businessTypes, roleLabels, roleSummaries, workspaceNameError, type BusinessType, type WorkspaceRole } from '../lib/workspaceOptions'
import { Icon } from './Icon'
const timeZones=(()=>{try{return Intl.supportedValuesOf('timeZone')}catch{return ['UTC']}})()
const permissions:[string,WorkspaceRole[]][]=[['View, add and update leads, follow-ups and activity',['owner','admin','member']],['Remove leads or follow-ups, or reset demo data',['owner','admin']],['Edit workspace details and the website form',['owner','admin']],['Revoke integration credentials',['owner','admin']],['Grant or remove the admin role',['owner']]]
export function WorkspaceSettings({workspace}:{workspace:WorkspaceSummary}){
  return <div className="settings-grid">
    <WorkspaceDetails key={workspace.id} workspace={workspace}/>
    <section className="panel settings-panel settings-access" aria-labelledby="settings-access-title">
      <div className="settings-heading"><div><h2 id="settings-access-title">Your access</h2><p>What your role allows in this workspace.</p></div><span className={`role-badge role-${workspace.role}`}>{roleLabels[workspace.role]}</span></div>
      <p className="settings-copy">{roleSummaries[workspace.role]}</p>
      <ul className="permission-list">{permissions.map(([label,roles])=>{const allowed=roles.includes(workspace.role);return <li key={label} className={allowed?'allowed':'denied'}><span aria-hidden="true">{allowed?<Icon name="check" size={17}/>:'—'}</span>{label}<span className="sr-only">{allowed?': allowed':': not allowed'}</span></li>})}</ul>
      <p className="settings-fine">LeadFlow checks these permissions in the database on every request, not only in this screen.</p>
    </section>
    <Members workspaceId={workspace.id}/>
  </div>
}
function WorkspaceDetails({workspace}:{workspace:WorkspaceSummary}){
  const {refresh}=useWorkspaces()
  const canEdit=workspace.role!=='member',id=useId()
  const [name,setName]=useState(workspace.name),[type,setType]=useState<BusinessType|''>(workspace.businessType??''),[zone,setZone]=useState(workspace.timezone)
  const [nameError,setNameError]=useState(''),[error,setError]=useState(''),[saved,setSaved]=useState(''),[busy,setBusy]=useState(false)
  const dirty=name.trim()!==workspace.name||(type||null)!==workspace.businessType||zone!==workspace.timezone
  const zones=timeZones.includes(zone)?timeZones:[zone,...timeZones]
  const edited=()=>{setSaved('');setError('')}
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!canEdit||busy||!dirty)return
    const problem=workspaceNameError(name);setNameError(problem??'');if(problem)return
    setBusy(true);setError('');setSaved('')
    try{await updateWorkspace(workspace.id,{name:name.trim(),timezone:zone,businessType:type||null});await refresh();setSaved('Workspace details saved.')}
    catch(cause){setError(cause instanceof Error?cause.message:'Unable to save workspace details.')}
    finally{setBusy(false)}
  }
  return <section className="panel settings-panel settings-details" aria-labelledby={`${id}-title`}>
    <div className="settings-heading"><div><h2 id={`${id}-title`}>Workspace details</h2><p>Everyone in this workspace sees these details.</p></div></div>
    <form noValidate onSubmit={submit}>
      <fieldset disabled={!canEdit||busy}>
        <div className="field"><label htmlFor={`${id}-name`}>Workspace name</label><input id={`${id}-name`} maxLength={100} value={name} aria-invalid={nameError?true:undefined} aria-describedby={nameError?`${id}-name-error`:undefined} onChange={event=>{setName(event.target.value);setNameError('');edited()}}/>{nameError&&<p id={`${id}-name-error`} className="field-error">{nameError}</p>}</div>
        <div className="form-grid">
          <div className="field"><label htmlFor={`${id}-type`}>Business type</label><select id={`${id}-type`} value={type} onChange={event=>{setType(event.target.value as BusinessType|'');edited()}}><option value="">Not specified</option>{businessTypes.map(option=><option key={option}>{option}</option>)}</select></div>
          <div className="field"><label htmlFor={`${id}-zone`}>Time zone</label><select id={`${id}-zone`} value={zone} aria-describedby={`${id}-zone-hint`} onChange={event=>{setZone(event.target.value);edited()}}>{zones.map(option=><option key={option}>{option}</option>)}</select><small id={`${id}-zone-hint`}>Saved for workspace scheduling. Follow-up dates still use each person’s own calendar.</small></div>
        </div>
      </fieldset>
      <dl className="settings-meta"><div><dt>Created</dt><dd>{dateLabel(workspace.createdAt)}</dd></div><div><dt>Workspace ID</dt><dd><code>{workspace.id}</code></dd></div></dl>
      {!canEdit&&<p className="settings-note">Only owners and admins can change workspace details.</p>}
      {error&&<div className="auth-alert" role="alert"><p>{error}</p></div>}
      {saved&&<p className="auth-success" role="status">{saved}</p>}
      {canEdit&&<div className="modal-actions"><button type="button" className="secondary" disabled={!dirty||busy} onClick={()=>{setName(workspace.name);setType(workspace.businessType??'');setZone(workspace.timezone);setNameError('');edited()}}>Discard changes</button><button className="primary" disabled={!dirty||busy}>{busy?'Saving…':'Save changes'}</button></div>}
    </form>
  </section>
}
type MemberState={status:'loading'}|{status:'error';message:string}|{status:'ready';members:WorkspaceMember[]}
function Members({workspaceId}:{workspaceId:string}){
  const {user}=useAuth()
  const [state,setState]=useState<MemberState>({status:'loading'}),[attempt,setAttempt]=useState(0)
  useEffect(()=>{
    let active=true
    listWorkspaceMembers(workspaceId).then(members=>{if(active)setState({status:'ready',members})}).catch(cause=>{if(active)setState({status:'error',message:cause instanceof Error?cause.message:'Unable to load members.'})})
    return()=>{active=false}
  },[workspaceId,attempt])
  return <section className="panel settings-panel settings-members" aria-labelledby="settings-members-title">
    <div className="settings-heading"><div><h2 id="settings-members-title">Members</h2><p>People who can open this workspace, and their roles.</p></div>{state.status==='ready'&&<span className="soft-tag">{state.members.length} {state.members.length===1?'member':'members'}</span>}</div>
    {state.status==='loading'?<ul className="member-list" aria-busy="true"><li className="sr-only" role="status">Loading members…</li>{[0,1].map(item=><li key={item} className="member-skeleton"><i className="skeleton skeleton-avatar"/><i className="skeleton skeleton-line"/></li>)}</ul>
    :state.status==='error'?<div className="settings-error"><p role="alert">{state.message}</p><button className="secondary" onClick={()=>{setState({status:'loading'});setAttempt(value=>value+1)}}>Try again</button></div>
    :<ul className="member-list">{state.members.map(member=><li key={member.userId}>
      <span className="avatar" aria-hidden="true">{initials(member.displayName||member.email)}</span>
      <div><strong>{member.displayName||member.email}{member.userId===user.id&&<span className="you-tag">You</span>}</strong><small>{member.displayName?`${member.email} · `:''}Joined {dateLabel(member.joinedAt)}</small></div>
      <span className={`role-badge role-${member.role}`}>{roleLabels[member.role]}</span>
    </li>)}</ul>}
    <div className="settings-note"><strong>Team invitations aren’t available yet.</strong> Inviting people and changing roles from LeadFlow is planned. For now, a LeadFlow administrator adds members.</div>
  </section>
}
