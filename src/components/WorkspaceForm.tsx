import { useId, useRef, useState, type FormEvent } from 'react'
import { createWorkspace } from '../lib/backend'
import { businessTypes, workspaceNameError, type BusinessType } from '../lib/workspaceOptions'
export function WorkspaceForm({submitLabel,onCreated,onCancel}:{submitLabel:string;onCreated:(id:string,name:string)=>Promise<void>;onCancel?:()=>void}){
  const [name,setName]=useState(''),[type,setType]=useState<BusinessType|''>(''),[nameError,setNameError]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  // One request ID per set of details: resubmitting after a lost response returns the same workspace.
  const attempt=useRef<{key:string;id:string}|null>(null),lock=useRef(false),nameInput=useRef<HTMLInputElement>(null)
  const id=useId()
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(lock.current)return
    const problem=workspaceNameError(name)
    setNameError(problem??'');if(problem){nameInput.current?.focus();return}
    const clean=name.trim(),key=`${clean}\n${type}`
    if(attempt.current?.key!==key)attempt.current={key,id:crypto.randomUUID()}
    lock.current=true;setBusy(true);setError('')
    try{await onCreated(await createWorkspace(clean,type||null,attempt.current.id),clean)}
    catch(cause){setError(`${cause instanceof Error?cause.message:'Unable to create the workspace.'} Your details are kept; trying again won’t create a duplicate.`)}
    finally{lock.current=false;setBusy(false)}
  }
  return <form className="workspace-form" noValidate onSubmit={submit}>
    <div className="field"><label htmlFor={`${id}-name`}>Workspace name</label>
      <input ref={nameInput} id={`${id}-name`} name="workspace-name" autoComplete="organization" maxLength={100} placeholder="e.g. Northline Studio" value={name} disabled={busy}
        aria-invalid={nameError?true:undefined} aria-describedby={`${id}-name-hint${nameError?` ${id}-name-error`:''}`} onChange={event=>{setName(event.target.value);if(nameError)setNameError('')}}/>
      <small id={`${id}-name-hint`}>Usually your business or client name. You can change it later.</small>
      {nameError&&<p id={`${id}-name-error`} className="field-error">{nameError}</p>}</div>
    <div className="field"><label htmlFor={`${id}-type`}>Business type <span className="optional">(optional)</span></label>
      <select id={`${id}-type`} name="business-type" value={type} disabled={busy} onChange={event=>setType(event.target.value as BusinessType|'')}><option value="">Choose one</option>{businessTypes.map(option=><option key={option}>{option}</option>)}</select></div>
    {error&&<div className="auth-alert" role="alert"><p>{error}</p></div>}
    <div className="modal-actions">{onCancel&&<button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>}<button className="primary" disabled={busy}>{busy?'Creating workspace…':submitLabel}</button></div>
  </form>
}
