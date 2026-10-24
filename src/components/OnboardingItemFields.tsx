import { itemKinds, kindLabels, type ItemDefinition } from '../lib/onboardingOptions'
/** The fields that define one checklist item. Request items also have a due date and an agency-only note. */
export function ItemFields({item,onChange,idPrefix,forRequest=false,lockType=false,disabled=false}:{item:ItemDefinition;onChange:(next:ItemDefinition)=>void;idPrefix:string;forRequest?:boolean;lockType?:boolean;disabled?:boolean}){
  return <fieldset className="ob-item-fields" disabled={disabled}>
    <div className="form-grid">
      <label>Item title *<input required maxLength={200} value={item.title} onChange={event=>onChange({...item,title:event.target.value})}/></label>
      <label>Section<input maxLength={60} placeholder="General" value={item.section} onChange={event=>onChange({...item,section:event.target.value})}/></label>
      <label>Response type<select value={item.kind} disabled={lockType} aria-describedby={lockType?`${idPrefix}-locked`:undefined} onChange={event=>onChange({...item,kind:event.target.value as ItemDefinition['kind']})}>{itemKinds.map(kind=><option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label>
      <label className="ob-check"><input type="checkbox" checked={item.required} onChange={event=>onChange({...item,required:event.target.checked})}/>Required for readiness</label>
    </div>
    {lockType&&<p id={`${idPrefix}-locked`} className="ob-hint">The client has answered this item, so its type and options are fixed. Mark it not required and add a new item to ask something different.</p>}
    {item.kind==='choice'&&<label>Options, one per line *<textarea rows={4} disabled={lockType} value={item.options.join('\n')} onChange={event=>onChange({...item,options:event.target.value.split('\n')})}/></label>}
    <label>Guidance for the client<textarea rows={3} maxLength={2000} value={item.guidance} onChange={event=>onChange({...item,guidance:event.target.value})}/></label>
    {item.kind==='access'&&<p className="ob-hint">Explain how to grant access through the platform’s own sharing or partner settings. Never ask for passwords, API keys or recovery codes: the client portal doesn’t accept them.</p>}
    {forRequest&&<div className="form-grid">
      <label>Due date (optional)<input type="date" min="2000-01-01" max="2100-12-31" value={item.dueDate??''} onChange={event=>onChange({...item,dueDate:event.target.value||null})}/></label>
      <label>Internal note (agency only)<input maxLength={2000} value={item.internalNote??''} onChange={event=>onChange({...item,internalNote:event.target.value})}/></label>
    </div>}
  </fieldset>
}
