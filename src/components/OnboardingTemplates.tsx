import { useEffect, useState, type FormEvent } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { dateLabel } from '../lib/format'
import { autoStepLabels, blankItem, cleanItem, conflict, installStarterTemplates, itemError, loadStages, loadTemplate, saveTemplate, serviceLabels, serviceTypes, setTemplateArchived,
  type AutoStepKey, type ServiceType, type Stage, type StepDefinition, type Template, type TemplateSummary } from '../lib/onboarding'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ItemFields } from './OnboardingItemFields'
import { Glyph } from './OnboardingReadiness'
interface TemplatesProps { workspace: WorkspaceSummary; templates: TemplateSummary[]; onChanged: (message: string) => void; onUse: (templateId: string) => void }
/** LeadFlow's starter templates; keep in step with install_starter_templates. */
const starterCount=7
/** Owners and admins manage templates; everyone can start a request from one. The database enforces both. */
export function OnboardingTemplates({workspace,templates,onChanged,onUse}:TemplatesProps){
  const canManage=workspace.role!=='member'
  const [editing,setEditing]=useState<Template|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState('')
  const missingStarters=starterCount-templates.filter(template=>template.starterKey).length
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
  const newTemplate=():Template=>({id:'',name:'',serviceType:'paid_ads',description:'',starterKey:null,archived:false,version:0,items:[blankItem()],steps:[]})
  return <section className="panel ob-panel" aria-labelledby="ob-templates-title">
    <div className="settings-heading"><div><h2 id="ob-templates-title">Onboarding templates</h2><p>Each template is the checklist, and the internal steps for your team, copied into a new onboarding. Editing a template never changes requests already created.</p></div>
      {canManage&&<button className="secondary" disabled={!!busy} onClick={()=>setEditing(newTemplate())}><Icon name="plus" size={16}/> New template</button>}</div>
    {error&&<div className="auth-alert" role="alert"><p>{error}</p></div>}
    {templates.length===0?<div className="ob-empty"><span className="ob-empty-icon" aria-hidden="true"><Icon name="grid" size={24}/></span><h3>No templates yet</h3>
      <p>Start with LeadFlow’s seven starter templates (paid advertising, SEO, social media, email marketing, website design and development, digital marketing and SEO, and automation or custom software), then adjust them to how your agency works.</p>
      {canManage?<button className="primary" disabled={!!busy} onClick={()=>act('install',async()=>`${await installStarterTemplates(workspace.id)} starter templates added.`)}>{busy==='install'?'Adding templates…':'Add the starter templates'}</button>
        :<p className="settings-note">Ask a workspace owner or admin to add templates. You can still start an onboarding from a blank checklist.</p>}
    </div>:<>
      {canManage&&missingStarters>0&&<p className="settings-note">Some starter templates aren’t in this workspace. <button className="text-button" disabled={!!busy} onClick={()=>act('install',async()=>`${await installStarterTemplates(workspace.id)} starter templates added.`)}>Add the missing starter templates</button></p>}
      <ul className="ob-template-grid">{templates.map(template=><li key={template.id} className={template.archived?'ob-template archived':'ob-template'}>
        <div className="ob-template-head"><span className={`ob-template-icon ob-service-${template.serviceType}`} aria-hidden="true"><Glyph name={template.serviceType} size={20}/></span><strong>{template.name}</strong>{template.archived?<span className="ob-tag">Archived</span>:template.starterKey&&<span className="ob-tag">Starter</span>}</div>
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
const blankStep=():StepDefinition=>({title:'',description:'',required:true,autoKey:null,stageId:null})
/** The stage picker for a step; an archived stage the step already uses stays listed. */
function StagePicker({stages,value,onChange}:{stages:Stage[];value:string|null;onChange:(value:string|null)=>void}){
  const archived=stages.find(stage=>stage.id===value&&stage.archived)
  return <label>Stage<select value={value??''} onChange={event=>onChange(event.target.value||null)}><option value="">No stage</option>
    {archived&&<option value={archived.id}>{archived.name} (archived: choose another stage to save)</option>}
    {stages.filter(stage=>!stage.archived).map(stage=><option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
}
/** One internal agency step: what the team does, never shown to the client. */
export function StepFields({step,stages,onChange,idPrefix}:{step:StepDefinition;stages:Stage[];onChange:(next:StepDefinition)=>void;idPrefix:string}){
  return <fieldset className="ob-item-fields">
    <div className="form-grid">
      <label>Step title *<input required maxLength={200} value={step.title} onChange={event=>onChange({...step,title:event.target.value})}/></label>
      <StagePicker stages={stages} value={step.stageId} onChange={stageId=>onChange({...step,stageId})}/>
      <label>Completes<select value={step.autoKey??''} aria-describedby={`${idPrefix}-auto`} onChange={event=>onChange({...step,autoKey:(event.target.value||null) as AutoStepKey|null})}>
        <option value="">When someone marks it done</option>{(Object.keys(autoStepLabels) as AutoStepKey[]).map(key=><option key={key} value={key}>{autoStepLabels[key]}</option>)}</select></label>
      <label className="ob-check"><input type="checkbox" checked={step.required} onChange={event=>onChange({...step,required:event.target.checked})}/>Required step</label>
    </div>
    <p id={`${idPrefix}-auto`} className="ob-hint">{step.autoKey?'On a client’s onboarding, LeadFlow marks this step done when that happens, and reopens it if it’s undone. Without a client, someone marks it done.':'Your team marks this step done, or not required with a reason.'}</p>
    <label>Description<textarea rows={2} maxLength={2000} value={step.description} onChange={event=>onChange({...step,description:event.target.value})}/></label>
  </fieldset>
}
function TemplateEditor({workspace,template,canManage,onClose,onSaved}:{workspace:WorkspaceSummary;template:Template;canManage:boolean;onClose:()=>void;onSaved:(message:string)=>void}){
  const [draft,setDraft]=useState<Template>({...template,steps:template.steps??[]}),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [stages,setStages]=useState<Stage[]>([])
  // One identity per new template, so a retry after a lost response cannot create a duplicate.
  const [requestId]=useState(()=>crypto.randomUUID())
  useEffect(()=>{let active=true;loadStages(workspace.id).then(result=>{if(active)setStages(result.stages)}).catch(()=>{/* Without stages, items keep the stage they have. */});return()=>{active=false}},[workspace.id])
  const update=(index:number,item:Template['items'][number])=>setDraft(current=>({...current,items:current.items.map((existing,position)=>position===index?item:existing)}))
  const move=(index:number,offset:number)=>setDraft(current=>{const items=[...current.items];const [item]=items.splice(index,1);items.splice(index+offset,0,item);return {...current,items}})
  const updateStep=(index:number,step:StepDefinition)=>setDraft(current=>({...current,steps:current.steps.map((existing,position)=>position===index?step:existing)}))
  const moveStep=(index:number,offset:number)=>setDraft(current=>{const steps=[...current.steps];const [step]=steps.splice(index,1);steps.splice(index+offset,0,step);return {...current,steps}})
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||!canManage)return
    if(!draft.name.trim()){setError('Give the template a name.');return}
    const problem=draft.items.length?draft.items.map(itemError).find(Boolean):'Add at least one item.'
    if(problem){setError(problem);return}
    if(draft.steps.some(step=>!step.title.trim())){setError('Give every internal step a title.');return}
    setBusy(true);setError('')
    try{
      await saveTemplate(workspace.id,{...(draft.id?{id:draft.id}:{}),name:draft.name.trim(),serviceType:draft.serviceType,description:draft.description.trim(),
        items:draft.items.map(item=>{const clean=cleanItem(item);return {section:clean.section,title:clean.title,guidance:clean.guidance,kind:clean.kind,options:clean.options,required:clean.required,config:clean.config??{},stageId:clean.stageId??null,formName:clean.formName??null}}),
        steps:draft.steps.map(step=>({title:step.title.trim(),description:step.description.trim(),required:step.required,autoKey:step.autoKey,stageId:step.stageId}))},draft.id?draft.version:null,draft.id?null:requestId)
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
        <ItemFields idPrefix={`template-item-${index}`} item={item} stages={stages.length?stages:undefined} disabled={!canManage||busy} onChange={next=>update(index,next)}/>
      </li>)}</ol>
      {canManage&&<button type="button" className="secondary" disabled={busy||draft.items.length>=100} onClick={()=>setDraft({...draft,items:[...draft.items,blankItem()]})}><Icon name="plus" size={16}/> Add item</button>}
      <h3 className="ob-editor-title">Internal steps for your team <span className="number-tag">{draft.steps.length}</span></h3>
      <p className="ob-hint ob-editor-hint">Work your agency does during onboarding, such as reviewing answers or verifying access. Clients never see these. Required steps must be done (or marked not required) before the onboarding is ready.</p>
      {draft.steps.length>0&&<ol className="ob-editor-items">{draft.steps.map((step,index)=><li key={index}>
        <div className="ob-editor-item-head"><strong>Step {index+1}</strong>{canManage&&<span>
          <button type="button" className="icon-button" aria-label={`Move step ${index+1} up`} disabled={index===0||busy} onClick={()=>moveStep(index,-1)}>↑</button>
          <button type="button" className="icon-button" aria-label={`Move step ${index+1} down`} disabled={index===draft.steps.length-1||busy} onClick={()=>moveStep(index,1)}>↓</button>
          <button type="button" className="text-button" disabled={busy} onClick={()=>setDraft({...draft,steps:draft.steps.filter((_,position)=>position!==index)})}>Remove</button></span>}</div>
        <fieldset className="ob-fieldset" disabled={!canManage||busy}><StepFields idPrefix={`template-step-${index}`} step={step} stages={stages} onChange={next=>updateStep(index,next)}/></fieldset>
      </li>)}</ol>}
      {canManage&&<button type="button" className="secondary" disabled={busy||draft.steps.length>=50} onClick={()=>setDraft({...draft,steps:[...draft.steps,blankStep()]})}><Icon name="plus" size={16}/> Add step</button>}
      {!canManage&&<p className="settings-note">Only workspace owners and admins can change templates.</p>}
      {error&&<p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>{canManage?'Cancel':'Close'}</button>{canManage&&<button className="primary" disabled={busy}>{busy?'Saving…':'Save template'}</button>}</div>
    </form>
  </Modal>
}
