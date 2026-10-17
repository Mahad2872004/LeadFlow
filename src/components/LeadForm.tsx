import { useState } from 'react'
import { services, sources, statuses, validateLead, type LeadInput, type Status } from '../lib/model'
interface LeadFormProps {
  initial: LeadInput
  initialStatus?: Status
  onSave: (input: LeadInput, status: Status) => void
  onCancel: () => void
}
export function LeadForm({initial,initialStatus,onSave,onCancel}:LeadFormProps) {
  const [form,setForm]=useState(initial)
  const [status,setStatus]=useState<Status>(initialStatus??'New')
  const [error,setError]=useState('')
  return <form onSubmit={event=>{
    event.preventDefault()
    const validation=validateLead(form)
    if(validation){setError(validation);return}
    try {onSave(form,status)} catch(cause){setError(cause instanceof Error?cause.message:'Unable to save this lead.')}
  }}>
    <div className="form-grid">
      {(['name','email','phone','company'] as const).map(key=><label key={key}>
        {key==='name'?'Full name':key[0].toUpperCase()+key.slice(1)} {key==='name'||key==='email'?'*':'(optional)'}
        <input required={key==='name'||key==='email'} type={key==='email'?'email':key==='phone'?'tel':'text'} maxLength={key==='phone'?25:150} value={form[key]} onChange={event=>setForm({...form,[key]:event.target.value})}/>
      </label>)}
      <label>Service interest *<select required value={form.service} onChange={event=>setForm({...form,service:event.target.value})}><option value="">Select service</option>{services.map(value=><option key={value}>{value}</option>)}</select></label>
      <label>Source *<select required value={form.source} onChange={event=>setForm({...form,source:event.target.value})}><option value="">Select source</option>{sources.map(value=><option key={value}>{value}</option>)}</select></label>
    </div>
    {initialStatus&&<label>Status<select aria-label="Status" value={status} onChange={event=>setStatus(event.target.value as Status)}>{statuses.map(value=><option key={value}>{value}</option>)}</select></label>}
    <label>Message (optional)<textarea rows={3} maxLength={2000} value={form.message} onChange={event=>setForm({...form,message:event.target.value})}/></label>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary">{initialStatus?'Save changes':'Create lead'}</button></div>
  </form>
}

