import { useEffect, useRef, useState, type FormEvent } from 'react'
import { accessDenied, type WorkspaceSummary } from '../lib/backend'
import { dateLabel } from '../lib/format'
import { blankItem, cleanItem, conflict, duplicateForm, itemError, loadForm, loadForms, saveForm, setFormArchived, type FormDefinition, type FormSummary } from '../lib/onboarding'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ItemFields } from './OnboardingItemFields'
type LoadState={status:'loading'}|{status:'error';message:string;denied:boolean}|{status:'ready';canEdit:boolean;forms:FormSummary[]}
/**
 * Reusable onboarding forms. Owners and admins build them; anyone can add one to a client's checklist, which copies its
 * fields. Editing a form never changes copies already added to checklists. The database enforces both.
 */
export function OnboardingForms({workspace,onChanged}:{workspace:WorkspaceSummary;onChanged?:(message:string)=>void}){
  const [state,setState]=useState<LoadState>({status:'loading'}),[attempt,setAttempt]=useState(0)
  const [editing,setEditing]=useState<FormDefinition|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('')
  // One request ID per form until its copy succeeds, so retrying after a lost response doesn't make a second copy.
  const copyIds=useRef(new Map<string,string>())
  const copyId=(form:string)=>{const existing=copyIds.current.get(form);if(existing)return existing;const created=crypto.randomUUID();copyIds.current.set(form,created);return created}
  useEffect(()=>{
    let active=true
    loadForms(workspace.id).then(result=>{if(active)setState({status:'ready',canEdit:result.canEdit,forms:result.forms})},cause=>{if(active)setState({status:'error',message:cause instanceof Error?cause.message:'Unable to load forms.',denied:accessDenied(cause)})})
    return()=>{active=false}
  },[workspace.id,attempt])
  const reload=(message='')=>{setNotice(message);if(message)onChanged?.(message);setAttempt(value=>value+1)}
  async function act(key:string,action:()=>Promise<string>){
    if(busy)return
    setBusy(key);setError('');setNotice('')
    try{reload(await action())}catch(cause){setError(cause instanceof Error?cause.message:'Something went wrong. Please try again.')}finally{setBusy('')}
  }
  async function open(id:string){
    if(busy)return
    setBusy(id);setError('')
    try{setEditing(await loadForm(workspace.id,id))}catch(cause){setError(cause instanceof Error?cause.message:'Unable to open this form.')}finally{setBusy('')}
  }
  if(state.status==='loading')return <div className="content-skeleton" role="status"><span className="sr-only">Loading forms…</span><i className="skeleton skeleton-panel"/></div>
  if(state.status==='error')return <div className="error-banner load-error" role="alert"><p><strong>{state.denied?'You don’t have access to this workspace’s forms.':'We couldn’t load the forms.'}</strong> {state.message}</p><button className="secondary" onClick={()=>{setState({status:'loading'});setAttempt(value=>value+1)}}>Try again</button></div>
  const {canEdit,forms}=state
  const newForm=():FormDefinition=>({id:'',name:'',description:'',archived:false,version:0,fields:[blankItem()]})
  return <section className="panel ob-panel" aria-labelledby="ob-forms-list-title">
    <div className="settings-heading"><div><h2 id="ob-forms-list-title">Onboarding forms</h2><p>Reusable sets of questions, such as a brand questionnaire or a technical intake. Add a form to any client’s checklist; its fields are copied there, so editing a form later never changes checklists it was already added to.</p></div>
      {canEdit&&<button className="secondary" disabled={!!busy} onClick={()=>setEditing(newForm())}><Icon name="plus" size={16}/> New form</button>}</div>
    {notice&&<div className="toast" role="status">✓ {notice}</div>}
    {error&&<div className="auth-alert" role="alert"><p>{error}</p></div>}
    {!canEdit&&<p className="settings-note">Only workspace owners and admins can create or change forms. You can add any active form to a client’s checklist from the checklist itself.</p>}
    {forms.length===0?<div className="ob-empty ob-empty-compact"><span className="ob-empty-icon" aria-hidden="true"><Icon name="list" size={22}/></span><h3>No forms yet</h3>
      <p>{canEdit?'Create a form for the questions you ask every client, then add it to checklists in one step.':'Ask a workspace owner or admin to create forms.'}</p>
      {canEdit&&<button className="primary" onClick={()=>setEditing(newForm())}><Icon name="plus" size={16}/> New form</button>}</div>
    :<ul className="ob-template-grid">{forms.map(form=><li key={form.id} className={form.archived?'ob-template ob-form-card archived':'ob-template ob-form-card'}>
      <div className="ob-template-head"><span className="ob-template-icon ob-form-icon" aria-hidden="true"><Icon name="list" size={19}/></span><strong>{form.name}</strong>{form.archived&&<span className="ob-tag">Archived</span>}</div>
      <p>{form.description||'No description.'}</p>
      <dl className="ob-template-meta"><div><dt>Fields</dt><dd>{form.fieldCount} ({form.requiredCount} required)</dd></div><div><dt>Added to checklists</dt><dd>{form.assignments} time{form.assignments===1?'':'s'}</dd></div><div><dt>Updated</dt><dd>{dateLabel(form.updatedAt)}</dd></div></dl>
      <div className="ob-template-actions">
        <button className="secondary" disabled={!!busy} onClick={()=>open(form.id)}>{busy===form.id?'Opening…':canEdit?'View and edit':'View fields'}</button>
        {canEdit&&<button className="text-button ob-inline-action" disabled={!!busy} onClick={()=>act(`copy-${form.id}`,async()=>{await duplicateForm(workspace.id,form.id,copyId(form.id));copyIds.current.delete(form.id);return `${form.name} duplicated.`})}>Duplicate</button>}
        {canEdit&&<button className="text-button" disabled={!!busy} onClick={()=>act(`archive-${form.id}`,async()=>{await setFormArchived(workspace.id,form.id,!form.archived);return form.archived?`${form.name} restored.`:`${form.name} archived. Checklists it was added to are unchanged.`})}>{form.archived?'Restore':'Archive'}</button>}
      </div>
    </li>)}</ul>}
    {editing&&<FormEditor workspace={workspace} form={editing} canEdit={canEdit} onClose={()=>setEditing(null)} onSaved={message=>{setEditing(null);reload(message)}} onConflict={()=>{setEditing(null);reload()}}/>}
  </section>
}
function FormEditor({workspace,form,canEdit,onClose,onSaved,onConflict}:{workspace:WorkspaceSummary;form:FormDefinition;canEdit:boolean;onClose:()=>void;onSaved:(message:string)=>void;onConflict:()=>void}){
  const [draft,setDraft]=useState(form),[error,setError]=useState(''),[busy,setBusy]=useState(false),[stale,setStale]=useState(false)
  // One identity per new form, so a retry after a lost response cannot create a duplicate.
  const [requestId]=useState(()=>crypto.randomUUID())
  const update=(index:number,field:FormDefinition['fields'][number])=>setDraft(current=>({...current,fields:current.fields.map((existing,position)=>position===index?field:existing)}))
  const move=(index:number,offset:number)=>setDraft(current=>{const fields=[...current.fields];const [field]=fields.splice(index,1);fields.splice(index+offset,0,field);return {...current,fields}})
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||!canEdit)return
    if(!draft.name.trim()){setError('Give the form a name.');return}
    const problem=draft.fields.length?draft.fields.map(itemError).find(Boolean):'Add at least one field.'
    if(problem){setError(problem);return}
    setBusy(true);setError('')
    try{
      await saveForm(workspace.id,{...(draft.id?{id:draft.id}:{}),name:draft.name.trim(),description:draft.description.trim(),
        fields:draft.fields.map(field=>{const clean=cleanItem(field);return {section:clean.section,title:clean.title,guidance:clean.guidance,kind:clean.kind,options:clean.options,required:clean.required,config:clean.config??{}}})},
        draft.id?draft.version:null,draft.id?null:requestId)
      onSaved(draft.id?`${draft.name.trim()} saved. Checklists it was already added to keep their copy.`:`${draft.name.trim()} created.`)
    }catch(cause){
      if(conflict(cause)){setStale(true);setError('Someone else changed this form while you were editing. Reload it to see their changes, then make yours again.')}
      else setError(cause instanceof Error?cause.message:'Unable to save this form.')
    }finally{setBusy(false)}
  }
  return <Modal title={draft.id?(canEdit?'Edit form':draft.name):'New form'} onClose={onClose}>
    <form className="ob-template-form" noValidate onSubmit={submit}>
      <fieldset disabled={!canEdit||busy}>
        <label>Form name *<input required maxLength={100} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
        <label>Description<textarea rows={2} maxLength={1000} value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label>
      </fieldset>
      {draft.id!==''&&<p className="ob-hint ob-editor-hint">Saving changes this form for the next time it’s added. Checklists it was already added to keep the fields they were given.</p>}
      <h3 className="ob-editor-title">Fields <span className="number-tag">{draft.fields.length}</span></h3>
      <ol className="ob-editor-items">{draft.fields.map((field,index)=><li key={index}>
        <div className="ob-editor-item-head"><strong>Field {index+1}</strong>{canEdit&&<span>
          <button type="button" className="icon-button" aria-label={`Move field ${index+1} up`} disabled={index===0||busy} onClick={()=>move(index,-1)}>↑</button>
          <button type="button" className="icon-button" aria-label={`Move field ${index+1} down`} disabled={index===draft.fields.length-1||busy} onClick={()=>move(index,1)}>↓</button>
          <button type="button" className="text-button" disabled={busy||draft.fields.length===1} onClick={()=>setDraft({...draft,fields:draft.fields.filter((_,position)=>position!==index)})}>Remove</button></span>}</div>
        <ItemFields idPrefix={`form-field-${index}`} item={field} disabled={!canEdit||busy} onChange={next=>update(index,next)}/>
      </li>)}</ol>
      {canEdit&&<button type="button" className="secondary" disabled={busy||draft.fields.length>=100} onClick={()=>setDraft({...draft,fields:[...draft.fields,blankItem()]})}><Icon name="plus" size={16}/> Add field</button>}
      {!canEdit&&<p className="settings-note">Only workspace owners and admins can change forms.</p>}
      {error&&<p className="field-error" role="alert">{error}{stale&&<> <button type="button" className="text-button" onClick={onConflict}>Reload forms</button></>}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>{canEdit?'Cancel':'Close'}</button>{canEdit&&<button className="primary" disabled={busy||stale}>{busy?'Saving…':'Save form'}</button>}</div>
    </form>
  </Modal>
}
