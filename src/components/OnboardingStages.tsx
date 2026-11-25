import { useEffect, useState, type FormEvent } from 'react'
import { accessDenied, type WorkspaceSummary } from '../lib/backend'
import { loadStages, reorderStages, saveStage, setStageArchived, type Stage } from '../lib/onboarding'
import { Icon } from './Icon'
import { Modal } from './Modal'
type LoadState={status:'loading'}|{status:'error';message:string;denied:boolean}|{status:'ready';canConfigure:boolean;stages:Stage[]}
/**
 * The workspace's onboarding stages: the phases every checklist item and internal step can be grouped into. Owners and
 * admins rename, add, reorder and archive them; archived stages stay on the work already in them.
 */
export function OnboardingStages({workspace}:{workspace:WorkspaceSummary}){
  const [state,setState]=useState<LoadState>({status:'loading'}),[attempt,setAttempt]=useState(0)
  const [editing,setEditing]=useState<{id?:string;name:string;description:string}|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('')
  useEffect(()=>{
    let active=true
    loadStages(workspace.id).then(result=>{if(active)setState({status:'ready',canConfigure:result.canConfigure,stages:result.stages})},cause=>{if(active)setState({status:'error',message:cause instanceof Error?cause.message:'Unable to load stages.',denied:accessDenied(cause)})})
    return()=>{active=false}
  },[workspace.id,attempt])
  async function act(key:string,action:()=>Promise<string>){
    if(busy)return false
    setBusy(key);setError('');setNotice('')
    try{setNotice(await action());setAttempt(value=>value+1);return true}
    catch(cause){setError(cause instanceof Error?cause.message:'Something went wrong. Please try again.');setAttempt(value=>value+1);return false}
    finally{setBusy('')}
  }
  if(state.status==='loading')return <div className="content-skeleton" role="status"><span className="sr-only">Loading stages…</span><i className="skeleton skeleton-panel"/></div>
  if(state.status==='error')return <div className="error-banner load-error" role="alert"><p><strong>{state.denied?'You don’t have access to this workspace’s stages.':'We couldn’t load the stages.'}</strong> {state.message}</p><button className="secondary" onClick={()=>{setState({status:'loading'});setAttempt(value=>value+1)}}>Try again</button></div>
  const {canConfigure,stages}=state
  const active=stages.filter(stage=>!stage.archived),archived=stages.filter(stage=>stage.archived)
  const move=(index:number,offset:number)=>{const ids=active.map(stage=>stage.id);const [id]=ids.splice(index,1);ids.splice(index+offset,0,id)
    return act(`move-${id}`,async()=>{await reorderStages(workspace.id,ids);return `${active[index].name} moved ${offset<0?'up':'down'}.`})}
  const row=(stage:Stage,index:number)=><li key={stage.id} className={stage.archived?'ob-stage-row archived':'ob-stage-row'}>
    <span className="ob-stage-index" aria-hidden="true">{stage.archived?'–':index+1}</span>
    <div className="ob-stage-row-main"><strong>{stage.name}</strong>{stage.description&&<p>{stage.description}</p>}
      <small>{stage.inUse?`Used by ${stage.inUse} item${stage.inUse===1?'':'s'} or step${stage.inUse===1?'':'s'}`:'Not used yet'}{stage.key?' · LeadFlow default':''}{stage.archived?' · Archived: kept on existing work, not offered for new items':''}</small></div>
    {canConfigure&&<div className="ob-stage-row-actions">
      {!stage.archived&&<><button type="button" className="icon-button" aria-label={`Move ${stage.name} up`} disabled={!!busy||index===0} onClick={()=>void move(index,-1)}>↑</button>
        <button type="button" className="icon-button" aria-label={`Move ${stage.name} down`} disabled={!!busy||index===active.length-1} onClick={()=>void move(index,1)}>↓</button></>}
      <button type="button" className="text-button" disabled={!!busy} onClick={()=>setEditing({id:stage.id,name:stage.name,description:stage.description})}>Edit<span className="sr-only"> {stage.name}</span></button>
      <button type="button" className="text-button" disabled={!!busy||(!stage.archived&&active.length<=2)} onClick={()=>void act(`archive-${stage.id}`,async()=>{await setStageArchived(workspace.id,stage.id,!stage.archived);return stage.archived?`${stage.name} restored.`:`${stage.name} archived. Work already in it keeps the stage.`})}>{stage.archived?'Restore':'Archive'}<span className="sr-only"> {stage.name}</span></button>
    </div>}
  </li>
  return <section className="panel ob-panel" aria-labelledby="ob-stages-list-title">
    <div className="settings-heading"><div><h2 id="ob-stages-list-title">Onboarding stages</h2><p>The phases of your onboarding process. Checklist items, form fields and internal steps can each belong to a stage, and every request shows its progress stage by stage.</p></div>
      {canConfigure&&<button className="secondary" disabled={!!busy||stages.length>=30} onClick={()=>setEditing({name:'',description:''})}><Icon name="plus" size={16}/> Add stage</button>}</div>
    {notice&&<div className="toast" role="status">✓ {notice}</div>}
    {error&&<div className="auth-alert" role="alert"><p>{error}</p></div>}
    {!canConfigure&&<p className="settings-note">Only workspace owners and admins can change the stages.</p>}
    <ol className="ob-stage-list">{active.map(row)}</ol>
    {archived.length>0&&<><h3>Archived stages</h3><ol className="ob-stage-list">{archived.map(row)}</ol></>}
    {canConfigure&&<p className="ob-hint ob-stage-hint">At least two stages stay active. New stages go before “Onboarding completed”; reorder them with the arrows.</p>}
    {editing&&<StageDialog stage={editing} onClose={()=>setEditing(null)} onSave={async stage=>{
      // Errors stay in the dialog, so the name can be corrected (for example a duplicate).
      await saveStage(workspace.id,stage);setEditing(null);setError('');setNotice(stage.id?`${stage.name} saved.`:`${stage.name} added.`);setAttempt(value=>value+1)}}/>}
  </section>
}
function StageDialog({stage,onClose,onSave}:{stage:{id?:string;name:string;description:string};onClose:()=>void;onSave:(stage:{id?:string;name:string;description:string})=>Promise<void>}){
  const [draft,setDraft]=useState(stage),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    if(!draft.name.trim()){setError('Give the stage a name.');return}
    setBusy(true);setError('')
    try{await onSave({...(stage.id?{id:stage.id}:{}),name:draft.name.trim(),description:draft.description.trim()})}
    catch(cause){setError(cause instanceof Error?cause.message:'Unable to save this stage.')}
    finally{setBusy(false)}
  }
  return <Modal title={stage.id?'Edit stage':'Add stage'} onClose={onClose}><form noValidate onSubmit={submit}>
    <fieldset className="ob-fieldset" disabled={busy}>
      <label>Stage name *<input required maxLength={60} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
      <label>Description<textarea rows={3} maxLength={500} value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label>
    </fieldset>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Saving…':stage.id?'Save stage':'Add stage'}</button></div>
  </form></Modal>
}
