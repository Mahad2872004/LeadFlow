import { useState, type FormEvent } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { dateLabel } from '../lib/format'
import { blankItem, cleanItem, conflict, installStarterTemplates, itemError, loadTemplate, saveTemplate, serviceLabels, serviceTypes, setTemplateArchived, type ServiceType, type Template, type TemplateSummary } from '../lib/onboarding'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ItemFields } from './OnboardingItemFields'
interface TemplatesProps { workspace: WorkspaceSummary; templates: TemplateSummary[]; onChanged: (message: string) => void; onUse: (templateId: string) => void }
/** Owners and admins manage templates; everyone can start a request from one. The database enforces both. */
export function OnboardingTemplates({workspace,templates,onChanged,onUse}:TemplatesProps){
  const canManage=workspace.role!=='member'
  const [editing,setEditing]=useState<Template|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState('')
  const missingStarters=4-templates.filter(template=>template.starterKey).length
  async function act(key:string,action:()=>Promise<string>){
    if(busy)return
    setBusy(key);setError('')
    try{onChanged(await action())}catch(cause){setError(cause instanceof Error?cause.message:'Something went wrong. Please try again.')}finally{setBusy('')}
  }
  async function open(id:string){
    if(busy)return
    setBusy(id);setError('')
    try{setEditing(await loadTemplate(workspace.id,id))}catch(cause){setError(cause instanceof Error?cause.message:'Unable to open this template.')}finally{setBusy('')}
  }
  const newTemplate=():Template=>({id:'',name:'',serviceType:'paid_ads',description:'',starterKey:null,archived:false,version:0,items:[blankItem()]})
  return <section className="panel ob-panel" aria-labelledby="ob-templates-title">
    <div className="settings-heading"><div><h2 id="ob-templates-title">Onboarding templates</h2><p>Each template is the checklist copied into a new onboarding. Editing a template never changes requests already created.</p></div>
      {canManage&&<button className="secondary" disabled={!!busy} onClick={()=>setEditing(newTemplate())}><Icon name="plus" size={16}/> New template</button>}</div>
    {error&&<div className="auth-alert" role="alert"><p>{error}</p></div>}
    {templates.length===0?<div className="ob-empty"><h3>No templates yet</h3>
      <p>Start with LeadFlow’s four starter templates for paid advertising, SEO, social media management and email marketing, then adjust them to how your agency works.</p>
      {canManage?<button className="primary" disabled={!!busy} onClick={()=>act('install',async()=>`${await installStarterTemplates(workspace.id)} starter templates added.`)}>{busy==='install'?'Adding templates…':'Add the starter templates'}</button>
        :<p className="settings-note">Ask a workspace owner or admin to add templates. You can still start an onboarding from a blank checklist.</p>}
    </div>:<>
      {canManage&&missingStarters>0&&<p className="settings-note">Some starter templates aren’t in this workspace. <button className="text-button" disabled={!!busy} onClick={()=>act('install',async()=>`${await installStarterTemplates(workspace.id)} starter templates added.`)}>Add the missing starter templates</button></p>}
      <ul className="ob-template-grid">{templates.map(template=><li key={template.id} className={template.archived?'ob-template archived':'ob-template'}>
        <div className="ob-template-head"><strong>{template.name}</strong>{template.archived?<span className="ob-tag">Archived</span>:template.starterKey&&<span className="ob-tag">Starter</span>}</div>
        <p>{template.description||'No description.'}</p>
        <dl className="ob-template-meta"><div><dt>Service</dt><dd>{serviceLabels[template.serviceType]}</dd></div><div><dt>Items</dt><dd>{template.itemCount} ({template.requiredCount} required)</dd></div><div><dt>Updated</dt><dd>{dateLabel(template.updatedAt)}</dd></div></dl>
        <div className="ob-template-actions">
          {!template.archived&&<button className="primary" onClick={()=>onUse(template.id)}>Use template</button>}
          <button className="secondary" disabled={!!busy} onClick={()=>open(template.id)}>{busy===template.id?'Opening…':canManage?'View and edit':'View items'}</button>
          {canManage&&<button className="text-button" disabled={!!busy} onClick={()=>act(`archive-${template.id}`,async()=>{await setTemplateArchived(workspace.id,template.id,!template.archived);return template.archived?`${template.name} restored.`:`${template.name} archived. Existing requests are unchanged.`})}>{template.archived?'Restore':'Archive'}</button>}
        </div>
      </li>)}</ul>
    </>}
    {editing&&<TemplateEditor workspace={workspace} template={editing} canManage={canManage} onClose={()=>setEditing(null)} onSaved={message=>{setEditing(null);onChanged(message)}}/>}
  </section>
}
function TemplateEditor({workspace,template,canManage,onClose,onSaved}:{workspace:WorkspaceSummary;template:Template;canManage:boolean;onClose:()=>void;onSaved:(message:string)=>void}){
  const [draft,setDraft]=useState(template),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  // One identity per new template, so a retry after a lost response cannot create a duplicate.
  const [requestId]=useState(()=>crypto.randomUUID())
  const update=(index:number,item:Template['items'][number])=>setDraft(current=>({...current,items:current.items.map((existing,position)=>position===index?item:existing)}))
  const move=(index:number,offset:number)=>setDraft(current=>{const items=[...current.items];const [item]=items.splice(index,1);items.splice(index+offset,0,item);return {...current,items}})
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||!canManage)return
    if(!draft.name.trim()){setError('Give the template a name.');return}
    const problem=draft.items.length?draft.items.map(itemError).find(Boolean):'Add at least one item.'
    if(problem){setError(problem);return}
    setBusy(true);setError('')
    try{
      await saveTemplate(workspace.id,{...(draft.id?{id:draft.id}:{}),name:draft.name.trim(),serviceType:draft.serviceType,description:draft.description.trim(),items:draft.items.map(cleanItem)},draft.id?draft.version:null,draft.id?null:requestId)
      onSaved(draft.id?`${draft.name.trim()} saved. New onboardings use the updated checklist.`:`${draft.name.trim()} created.`)
    }catch(cause){setError(conflict(cause)?'Someone else changed this template. Close it and open it again to see their changes.':cause instanceof Error?cause.message:'Unable to save this template.')}
    finally{setBusy(false)}
  }
  return <Modal title={draft.id?(canManage?'Edit template':draft.name):'New template'} onClose={onClose}>
    <form className="ob-template-form" noValidate onSubmit={submit}>
      <fieldset disabled={!canManage||busy}>
        <div className="form-grid">
          <label>Template name *<input required maxLength={100} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
          <label>Service<select value={draft.serviceType} onChange={event=>setDraft({...draft,serviceType:event.target.value as ServiceType})}>{serviceTypes.map(type=><option key={type} value={type}>{serviceLabels[type]}</option>)}</select></label>
        </div>
        <label>Description<textarea rows={2} maxLength={1000} value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label>
      </fieldset>
      <h3 className="ob-editor-title">Checklist items <span className="number-tag">{draft.items.length}</span></h3>
      <ol className="ob-editor-items">{draft.items.map((item,index)=><li key={index}>
        <div className="ob-editor-item-head"><strong>Item {index+1}</strong>{canManage&&<span>
          <button type="button" className="icon-button" aria-label={`Move item ${index+1} up`} disabled={index===0||busy} onClick={()=>move(index,-1)}>↑</button>
          <button type="button" className="icon-button" aria-label={`Move item ${index+1} down`} disabled={index===draft.items.length-1||busy} onClick={()=>move(index,1)}>↓</button>
          <button type="button" className="text-button" disabled={busy} onClick={()=>setDraft({...draft,items:draft.items.filter((_,position)=>position!==index)})}>Remove</button></span>}</div>
        <ItemFields idPrefix={`template-item-${index}`} item={item} disabled={!canManage||busy} onChange={next=>update(index,next)}/>
      </li>)}</ol>
      {canManage&&<button type="button" className="secondary" disabled={busy||draft.items.length>=100} onClick={()=>setDraft({...draft,items:[...draft.items,blankItem()]})}><Icon name="plus" size={16}/> Add item</button>}
      {!canManage&&<p className="settings-note">Only workspace owners and admins can change templates.</p>}
      {error&&<p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>{canManage?'Cancel':'Close'}</button>{canManage&&<button className="primary" disabled={busy}>{busy?'Saving…':'Save template'}</button>}</div>
    </form>
  </Modal>
}
