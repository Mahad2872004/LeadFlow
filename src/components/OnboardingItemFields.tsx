import { choiceKinds, documentCategories, documentCategoryLabels, isDisplayKind, itemKinds, kindLabels, secretPattern, type DocumentCategory, type ItemConfig, type ItemDefinition, type ItemKind } from '../lib/onboardingOptions'
import type { Stage } from '../lib/onboarding'
const placeholderKinds:readonly ItemKind[]=['text','short_text','email','phone','url','number']
const lengthLimit:Partial<Record<ItemKind,number>>={text:4000,short_text:300}
/** A whole-number setting: empty means "not set". */
const numberOrUndefined=(value:string)=>value.trim()===''||!Number.isFinite(Number(value))?undefined:Number(value)
/**
 * The fields that define one checklist item, template item or form field. Request items also have a due date and an
 * agency-only note. With `stages`, the item can be placed in an onboarding stage (active stages only; an archived stage
 * it already uses stays listed so it isn't silently dropped).
 */
export function ItemFields({item,onChange,idPrefix,forRequest=false,lockType=false,disabled=false,stages}:{item:ItemDefinition;onChange:(next:ItemDefinition)=>void;idPrefix:string;forRequest?:boolean;lockType?:boolean;disabled?:boolean;stages?:Stage[]}){
  const display=isDisplayKind(item.kind),config=item.config??{}
  const setConfig=(changes:Partial<ItemConfig>)=>onChange({...item,config:{...config,...changes}})
  // A new type starts with clean settings: options and limits of another type don't carry over.
  const setKind=(kind:ItemKind)=>onChange({...item,kind,options:choiceKinds.includes(kind)?item.options:[],config:{},required:isDisplayKind(kind)?false:item.required})
  const asksForSecrets=secretPattern.test(`${item.title} ${item.guidance}`)
  const activeStages=(stages??[]).filter(stage=>!stage.archived),currentArchived=(stages??[]).find(stage=>stage.id===item.stageId&&stage.archived)
  return <fieldset className="ob-item-fields" disabled={disabled}>
    <div className="form-grid">
      <label>{item.kind==='heading'?'Heading *':item.kind==='info'?'Instruction title *':'Item title *'}<input required maxLength={200} value={item.title} onChange={event=>onChange({...item,title:event.target.value})}/></label>
      <label>Section<input maxLength={60} placeholder="General" value={item.section} onChange={event=>onChange({...item,section:event.target.value})}/></label>
      <label>Response type<select value={item.kind} disabled={lockType} aria-describedby={lockType?`${idPrefix}-locked`:undefined} onChange={event=>setKind(event.target.value as ItemKind)}>{itemKinds.map(kind=><option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label>
      {display?<p className="ob-hint ob-display-hint">Shown to the client as {item.kind==='heading'?'a heading':'instructions'}. It takes no answer and never affects readiness.</p>
        :<label className="ob-check"><input type="checkbox" checked={item.required} onChange={event=>onChange({...item,required:event.target.checked})}/>Required for readiness</label>}
    </div>
    {lockType&&<p id={`${idPrefix}-locked`} className="ob-hint">The client has answered this item, so its type and options are fixed. Mark it not required and add a new item to ask something different.</p>}
    {choiceKinds.includes(item.kind)&&<label>Options, one per line *<textarea rows={4} disabled={lockType} value={item.options.join('\n')} onChange={event=>onChange({...item,options:event.target.value.split('\n')})}/></label>}
    <label>{item.kind==='info'?'Instructions shown to the client':item.kind==='heading'?'Text under the heading (optional)':'Guidance for the client'}<textarea rows={3} maxLength={2000} value={item.guidance} onChange={event=>onChange({...item,guidance:event.target.value})}/></label>
    {asksForSecrets&&<p className="ob-secret-warning">Never ask for passwords or secrets; ask the client to grant access through the platform’s own sharing. The client portal refuses usernames and passwords in links.</p>}
    {item.kind==='access'&&<p className="ob-hint">Explain how to grant access through the platform’s own sharing or partner settings. Never ask for passwords, API keys or recovery codes: the client portal doesn’t accept them.</p>}
    {(placeholderKinds.includes(item.kind)||lengthLimit[item.kind]||item.kind==='number'||item.kind==='file')&&<div className="form-grid ob-settings">
      {placeholderKinds.includes(item.kind)&&<label>Placeholder (optional)<input maxLength={150} value={config.placeholder??''} onChange={event=>setConfig({placeholder:event.target.value||undefined})}/></label>}
      {lengthLimit[item.kind]&&<label>Maximum length (optional)<input type="number" inputMode="numeric" min={1} max={lengthLimit[item.kind]} step={1} placeholder={`Up to ${lengthLimit[item.kind]}`} value={config.maxLength??''} onChange={event=>setConfig({maxLength:numberOrUndefined(event.target.value)})}/></label>}
      {item.kind==='number'&&<><label>Minimum (optional)<input type="number" step="any" value={config.min??''} onChange={event=>setConfig({min:numberOrUndefined(event.target.value)})}/></label>
        <label>Maximum (optional)<input type="number" step="any" value={config.max??''} onChange={event=>setConfig({max:numberOrUndefined(event.target.value)})}/></label></>}
      {item.kind==='file'&&<><label>Files allowed<select value={config.maxFiles??5} onChange={event=>setConfig({maxFiles:Number(event.target.value)})}>{[1,2,3,4,5,6,7,8,9,10].map(count=><option key={count} value={count}>Up to {count} file{count===1?'':'s'}</option>)}</select></label>
        <label>Store uploads as<select value={config.category??'other'} onChange={event=>setConfig({category:event.target.value as DocumentCategory})}>{documentCategories.map(category=><option key={category} value={category}>{documentCategoryLabels[category]}</option>)}</select></label></>}
    </div>}
    {item.kind==='file'&&<p className="ob-hint">Clients upload PDF, images, Office documents, text, CSV, ZIP, video or audio files. Each upload is checked before your team can download it.</p>}
    {stages&&<label>Onboarding stage<select value={item.stageId??''} onChange={event=>onChange({...item,stageId:event.target.value||null})}>
      <option value="">No stage</option>
      {currentArchived&&<option value={currentArchived.id}>{currentArchived.name} (archived: choose another stage to save)</option>}
      {activeStages.map(stage=><option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>}
    {item.formName&&<p className="ob-hint">Part of the form “{item.formName}”. Changes here affect only this copy, never the form itself.</p>}
    {forRequest&&<div className="form-grid">
      {!display&&<label>Due date (optional)<input type="date" min="2000-01-01" max="2100-12-31" value={item.dueDate??''} onChange={event=>onChange({...item,dueDate:event.target.value||null})}/></label>}
      <label>Internal note (agency only)<input maxLength={2000} value={item.internalNote??''} onChange={event=>onChange({...item,internalNote:event.target.value})}/></label>
    </div>}
  </fieldset>
}
