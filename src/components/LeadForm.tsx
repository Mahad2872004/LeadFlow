import { useState } from 'react'
import { countries, services, sources, statuses, validateLead, type Lead, type LeadInput, type Status } from '../lib/model'
interface LeadFormProps {
  initial: LeadInput
  initialStatus?: Status
  onSave: (input: LeadInput, status: Status) => void | Promise<void>
  onCancel: () => void
  /** An existing lead this one may duplicate. Creating it then needs a second, explicit confirmation. */
  findDuplicate?: (input: LeadInput) => { lead: Lead; reason: string } | null
}
const detailFields = [['website', 'Website', 300, 'url'], ['industry', 'Industry', 100, 'text'], ['address', 'Address', 300, 'text'], ['city', 'City', 100, 'text'], ['region', 'State or region', 100, 'text'], ['postcode', 'Postcode', 20, 'text']] as const
export function LeadForm({initial,initialStatus,onSave,onCancel,findDuplicate}:LeadFormProps) {
  const [form,setForm]=useState<LeadInput>(()=>({website:'',industry:'',address:'',city:'',region:'',postcode:'',country:'',...initial}))
  const [status,setStatus]=useState<Status>(initialStatus??'New')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [duplicate,setDuplicate]=useState<{lead:Lead;reason:string}|null>(null)
  const hasDetails=[form.website,form.industry,form.address,form.city,form.region,form.postcode,form.country].some(Boolean)
  const change=(next:LeadInput)=>{setForm(next);setDuplicate(null)}
  return <form onSubmit={async event=>{
    event.preventDefault(); if(busy)return
    const validation=validateLead(form)
    if(validation){setError(validation);return}
    setError('')
    if(findDuplicate&&!duplicate){const match=findDuplicate(form);if(match){setDuplicate(match);return}}
    setBusy(true)
    try {await onSave(form,status)} catch(cause){setError(cause instanceof Error?cause.message:'Unable to save this lead.')} finally {setBusy(false)}
  }}>
    <div className="form-grid">
      <div><label>Name *<input required maxLength={150} aria-describedby="lead-name-help" value={form.name} onChange={event=>change({...form,name:event.target.value})}/></label><small id="lead-name-help" className="field-help">A contact person, or the business name if you don’t know one.</small></div>
      <label>Company (optional)<input maxLength={150} value={form.company} onChange={event=>change({...form,company:event.target.value})}/></label>
      <label>Email (optional)<input type="email" maxLength={150} value={form.email} onChange={event=>change({...form,email:event.target.value})}/></label>
      <label>Phone (optional)<input type="tel" maxLength={25} value={form.phone} onChange={event=>change({...form,phone:event.target.value})}/></label>
      <label>Service interest *<select required value={form.service} onChange={event=>change({...form,service:event.target.value})}><option value="">Select service</option>{services.map(value=><option key={value}>{value}</option>)}</select></label>
      <label>Source *<select required value={form.source} onChange={event=>change({...form,source:event.target.value})}><option value="">Select source</option>{sources.map(value=><option key={value}>{value}</option>)}</select></label>
    </div>
    <details className="form-details" open={hasDetails||undefined}>
      <summary>Business details <span className="muted">(optional)</span></summary>
      <div className="form-grid">
        {detailFields.map(([key,label,max,type])=><label key={key}>{label}<input type={type==='url'?'text':type} inputMode={type==='url'?'url':undefined} placeholder={type==='url'?'example.com':undefined} maxLength={max} value={form[key]??''} onChange={event=>change({...form,[key]:event.target.value})}/></label>)}
        <label>Country<select value={form.country??''} onChange={event=>change({...form,country:event.target.value})}><option value="">Not set</option>{countries.map(([code,name])=><option key={code} value={code}>{name}</option>)}{form.country&&!countries.some(([code])=>code===form.country)&&<option value={form.country}>{form.country}</option>}</select></label>
      </div>
    </details>
    {initialStatus&&<label>Status<select aria-label="Status" value={status} onChange={event=>setStatus(event.target.value as Status)}>{statuses.map(value=><option key={value}>{value}</option>)}</select></label>}
    <label>Message (optional)<textarea rows={3} maxLength={2000} value={form.message} onChange={event=>change({...form,message:event.target.value})}/></label>
    {duplicate&&<div className="duplicate-warning" role="alert"><strong>This may already be in LeadFlow.</strong> {duplicate.reason}: <em>{duplicate.lead.name}{duplicate.lead.company&&duplicate.lead.company!==duplicate.lead.name?` · ${duplicate.lead.company}`:''}</em>. Create it anyway, or cancel and update the existing lead.</div>}
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy}>{initialStatus?'Save changes':duplicate?'Create anyway':'Create lead'}</button></div>
  </form>
}
