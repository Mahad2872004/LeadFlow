import { useCallback, useEffect, useRef, useState } from 'react'
import { dateLabel, initials } from '../lib/format'
import { documentCategoryLabels, formatBytes, isDisplayKind, itemStateLabels, type ItemKind, type ResponseValue } from '../lib/onboardingOptions'
import { portalAcknowledgeScope, portalCall, portalDownload, portalRemoveFile, portalUpload, PortalError, type PortalItem, type PortalScope, type PortalView, type SharedFile } from '../lib/portal'
import { Icon } from './Icon'
import './ClientPortal.css'
const marks={
  lock:<><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2"/></>,
  shield:<><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6Z"/><path d="m8.8 12.2 2.2 2.2 4.2-4.6"/></>,
  unlink:<><path d="M9 17H7A5 5 0 0 1 7 7M15 7h2a5 5 0 0 1 4 8M8 12h4"/><path d="m3 3 18 18"/></>,
  text:<><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.5 7.5 3 3"/></>,
  choice:<><circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><path d="M11 7h9M11 17h9"/></>,
  multi:<><rect x="4" y="5" width="4" height="4" rx="1"/><rect x="4" y="15" width="4" height="4" rx="1"/><path d="M11 7h9M11 17h9"/></>,
  check:<><rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/></>,
  links:<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></>,
  access:<><circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/></>,
  at:<><circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7"/></>,
  phone:<path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>,
  number:<><path d="M9 4 7 20M17 4l-2 16M4 9h16M3.5 15h16"/></>,
  date:<><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></>,
  file:<><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M14 3.5v5h5M12 17v-6M9.5 13.5 12 11l2.5 2.5"/></>,
  download:<><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></>,
  scope:<><path d="M7 3.5h7l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path d="M14 3.5v4h4M8.5 12.5h7M8.5 16h5"/></>,
}
type MarkName=keyof typeof marks
const kindMarks:Record<ItemKind,MarkName>={text:'text',short_text:'text',email:'at',phone:'phone',url:'links',number:'number',date:'date',choice:'choice',multi_choice:'multi',checkbox:'check',links:'links',access:'access',file:'file',heading:'text',info:'text'}
/** Decorative icon, hidden from assistive technology. */
function Mark({name,size=18}:{name:MarkName;size?:number}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{marks[name]}</svg>}
/** File types the upload checks accept; the server checks again, including each file's content. */
const acceptedFiles='.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.mp4,.mov,.webm,.mp3,.psd'
// The link token sits in the URL fragment: browsers don't send fragments to servers or in Referer headers.
const readToken=()=>{const value=window.location.hash.slice(1);return /^lf_[0-9a-f]{64}$/.test(value)?value:''}
type State={status:'loading'}|{status:'invalid';message:string}|{status:'error';message:string}|{status:'ready';view:PortalView}
const opened=(view:PortalView):State=>{document.title=`${view.title} — client onboarding`;return {status:'ready',view}}
const failed=(cause:unknown):State=>cause instanceof PortalError&&cause.status===404?{status:'invalid',message:cause.message}:{status:'error',message:cause instanceof Error?cause.message:'Something went wrong.'}
const open=(token:string)=>portalCall<{onboarding:PortalView}>({action:'open',token}).then(result=>opened(result.onboarding),failed)
const message=(cause:unknown,fallback:string)=>cause instanceof Error?cause.message:fallback
/** The client's onboarding checklist. It shows only this request's client-facing fields; there is nothing to browse. */
export default function ClientPortal(){
  const [token]=useState(readToken)
  const [state,setState]=useState<State>(()=>token?{status:'loading'}:{status:'invalid',message:'This link is incomplete. Open the full link your agency sent you, or ask them for a new one.'})
  const [attempt,setAttempt]=useState(0)
  const load=useCallback(()=>open(token).then(setState),[token])
  useEffect(()=>{
    if(!token)return
    let active=true
    open(token).then(next=>{if(active)setState(next)})
    return()=>{active=false}
  },[token,attempt])
  return <main className="portal-page">
    <div className="portal-shell">
      {state.status==='loading'&&<div className="portal-card portal-center" role="status"><span className="portal-spinner" aria-hidden="true"/>Opening your checklist…</div>}
      {state.status==='invalid'&&<div className="portal-card portal-center" role="alert"><span className="portal-center-icon" aria-hidden="true"><Mark name="unlink" size={26}/></span><h1>This link isn’t working</h1><p>{state.message}</p><p className="portal-small">For your security, onboarding links expire and can be replaced by your agency.</p></div>}
      {state.status==='error'&&<div className="portal-card portal-center" role="alert"><span className="portal-center-icon" aria-hidden="true"><Icon name="reset" size={24}/></span><h1>We couldn’t open your checklist</h1><p>{state.message}</p><button className="portal-primary" onClick={()=>{setState({status:'loading'});setAttempt(value=>value+1)}}>Try again</button></div>}
      {state.status==='ready'&&<Checklist view={state.view} token={token} onReload={load}/>}
    </div>
    <footer className="portal-footer"><span className="portal-footer-note"><Mark name="lock" size={14}/>Private onboarding checklist</span><span className="portal-powered"><span className="portal-lf-mark" aria-hidden="true"><Icon name="arrow" size={11}/></span>Powered by LeadFlow</span></footer>
  </main>
}
function Checklist({view,token,onReload}:{view:PortalView;token:string;onReload:()=>Promise<void>}){
  // Saving remounts the item with its new revision, so its confirmation lives here.
  const [messages,setMessages]=useState<Record<string,string>>({})
  const editable=view.status==='active'
  const shown=view.items.filter(item=>item.state!=='not_required')
  // Headings and instructions only display text: they are never counted.
  const needed=shown.filter(item=>!isDisplayKind(item.kind))
  const required=needed.filter(item=>item.required),accepted=required.filter(item=>item.state==='accepted').length
  const changes=needed.filter(item=>item.state==='changes_requested'),todo=needed.filter(item=>item.state==='not_started'),waiting=needed.filter(item=>item.state==='submitted')
  const next=changes[0]??todo.find(item=>item.required)??todo[0]
  const sections=shown.reduce<[string,PortalItem[]][]>((groups,item)=>{const group=groups.find(([name])=>name===item.section);if(group)group[1].push(item);else groups.push([item.section,[item]]);return groups},[])
  const banner=view.status==='draft'?{tone:'info',title:'Your checklist isn’t open yet',text:`${view.agencyName} is still preparing it. Please check back soon using this same link.`}
    :view.status==='paused'?{tone:'info',title:'This onboarding is paused',text:`${view.agencyName} has paused it for now. You can read what you’ve shared, but changes are turned off until they resume it.`}
    :view.status==='cancelled'?{tone:'info',title:'This onboarding has been closed',text:`${view.agencyName} closed this onboarding, so nothing more is needed here. Contact them if you think this is a mistake.`}
    :view.status==='completed'?{tone:'done',title:'You’re all set',text:`${view.agencyName} confirmed they have everything needed to start${view.confirmedAt?` (${dateLabel(view.confirmedAt)})`:''}. Thank you!`}
    :view.allAccepted?{tone:'done',title:'Everything required has been accepted',text:`${view.agencyName} will confirm the next steps with you.`}:null
  return <>
    <header className="portal-head">
      <div className="portal-brand"><span className="portal-mark" aria-hidden="true">{initials(view.agencyName)}</span><p className="portal-eyebrow">CLIENT ONBOARDING · {view.agencyName.toUpperCase()}</p><span className="portal-secure" aria-hidden="true"><Mark name="lock" size={13}/>Private &amp; secure</span></div>
      <h1>{view.title}</h1>
      <p>Prepared for {view.clientName}. This private page lists what {view.agencyName} needs before work can start. Your progress is saved here, so you can come back any time before {dateLabel(view.linkExpiresAt)}.</p>
    </header>
    {banner&&<div className={`portal-banner portal-${banner.tone}`} role="status"><Icon name={banner.tone==='done'?'check':'clock'} size={20}/><strong>{banner.title}</strong><p>{banner.text}</p></div>}
    {needed.length>0&&<section className="portal-card portal-summary" aria-label="Your progress">
      <div className="portal-summary-top" aria-hidden="true"><span>Your progress</span><b>{required.length?Math.round(100*accepted/required.length):100}%</b></div>
      <div className="portal-progress"><div role="progressbar" aria-label="Required items accepted" aria-valuemin={0} aria-valuemax={required.length} aria-valuenow={accepted} aria-valuetext={`${accepted} of ${required.length} required items accepted`}><i style={{width:`${required.length?Math.round(100*accepted/required.length):100}%`}}/></div><span>{accepted} of {required.length} required items accepted</span></div>
      <ul className="portal-counts"><li><strong>{todo.length}</strong> to do</li><li><strong>{changes.length}</strong> need changes</li><li><strong>{waiting.length}</strong> waiting for review</li><li><strong>{needed.filter(item=>item.state==='accepted').length}</strong> accepted</li></ul>
      {editable&&next&&<p className="portal-next"><span className="portal-next-icon" aria-hidden="true"><Icon name="arrow" size={18}/></span><strong>Next step:</strong> <a href={`#portal-item-${next.id}`}>{next.title}</a>{next.state==='changes_requested'?' needs a change.':''}{view.dueDate?` Please complete the checklist by ${dateLabel(view.dueDate)}.`:''}</p>}
    </section>}
    {view.instructions&&<section className="portal-card portal-note"><h2>A note from {view.agencyName}</h2><p className="portal-text">{view.instructions}</p></section>}
    {needed.length>0&&<p className="portal-safety"><span className="portal-safety-icon" aria-hidden="true"><Mark name="shield" size={20}/></span><strong>Please never share passwords, API keys or recovery codes here.</strong> For account access, use each platform’s own sharing settings; each access item explains how. Links should point to files in your own storage.</p>}
    {sections.map(([section,items])=><section key={section} className="portal-section" aria-label={section}><h2>{section}</h2>
      {items.map(item=>isDisplayKind(item.kind)?<DisplayBlock key={item.id} item={item}/>
        :<PortalItemCard key={`${item.id}-${item.revision}`} item={item} token={token} editable={editable} message={messages[item.id]??''} onReload={onReload}
          onSaved={async text=>{await onReload();setMessages(current=>({...current,[item.id]:text}))}}/>)}</section>)}
    {!!view.sharedFiles?.length&&<SharedFiles agency={view.agencyName} files={view.sharedFiles} token={token}/>}
    {view.scope&&<ScopeCard agency={view.agencyName} scope={view.scope} token={token} onReload={onReload}/>}
  </>
}
/** A heading or instructions from the agency. Nothing to answer. */
function DisplayBlock({item}:{item:PortalItem}){
  if(item.kind==='heading')return <div className="portal-heading"><h3>{item.title}</h3>{item.guidance&&<p className="portal-text">{item.guidance}</p>}</div>
  return <aside className="portal-instructions" aria-label={item.title}><strong>{item.title}</strong>{item.guidance&&<p className="portal-text">{item.guidance}</p>}</aside>
}
const emptyValue=(item:PortalItem):ResponseValue=>{
  switch(item.kind){
    case 'text':case 'short_text':case 'email':case 'phone':case 'url':return {text:''}
    case 'choice':return {choice:'',note:''}
    case 'multi_choice':return {choices:[],note:''}
    case 'checkbox':return {checked:false,note:''}
    case 'number':return {number:null,note:''}
    case 'date':return {date:null,note:''}
    case 'links':return {links:[''],note:''}
    case 'file':return {files:[],note:''}
    default:return {granted:false,note:''}
  }
}
const textInputs:Partial<Record<ItemKind,{type:string;inputMode?:'email'|'tel'|'url'|'text';autoComplete?:string;max:number}>>={
  short_text:{type:'text',max:300},email:{type:'email',inputMode:'email',autoComplete:'email',max:254},phone:{type:'tel',inputMode:'tel',autoComplete:'tel',max:40},url:{type:'url',inputMode:'url',max:500},
}
// Kinds whose answer keeps the client's optional note; the database drops a note on single-value text answers.
const noteKinds:readonly ItemKind[]=['choice','multi_choice','checkbox','number','date','links','access','file']
function PortalItemCard({item,token,editable,message:saved,onSaved,onReload}:{item:PortalItem;token:string;editable:boolean;message:string;onSaved:(message:string)=>Promise<void>;onReload:()=>Promise<void>}){
  const initial={...emptyValue(item),...(item.value??{}),...(item.kind==='links'&&!item.value?.links?.length?{links:['']}:{})}
  const [value,setValue]=useState<ResponseValue>(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflicted,setConflicted]=useState(false)
  const locked=!editable||item.state==='accepted'
  // A file answer lists the files uploaded to this item that passed the checks.
  const uploaded=(item.files??[]).filter(file=>file.status==='available').map(file=>file.id)
  const body=(current:ResponseValue):ResponseValue=>item.kind==='links'?{...current,links:(current.links??[]).map(link=>link.trim()).filter(Boolean)}
    :item.kind==='file'?{files:uploaded,note:current.note??''}:item.kind==='date'?{...current,date:current.date||null}:current
  const filesChanged=item.kind==='file'&&JSON.stringify(uploaded.toSorted())!==JSON.stringify((initial.files??[]).toSorted())
  const dirty=JSON.stringify(value)!==JSON.stringify(initial)||filesChanged
  const id=`portal-item-${item.id}`,config=item.config??{}
  async function save(submit:boolean){
    if(busy)return
    setBusy(true);setError('')
    try{await portalCall({action:'save',token,itemId:item.id,value:body(value),submit,revision:item.revision})}
    catch(cause){setConflicted(cause instanceof PortalError&&cause.status===409&&/updated elsewhere/.test(cause.message));setError(message(cause,'We couldn’t save this. Please try again.'));setBusy(false);return}
    // The card remounts with the saved revision once the checklist reloads.
    await onSaved(submit?'Submitted for review. Your agency will check it.':'Progress saved. You can come back to finish it.')
    setBusy(false)
  }
  const textInput=textInputs[item.kind]
  return <article id={id} className={`portal-item portal-item-${item.state}`} aria-labelledby={`${id}-title`}>
    <div className="portal-item-head"><span className="portal-item-icon" aria-hidden="true">{item.state==='accepted'?<Icon name="check" size={20}/>:<Mark name={kindMarks[item.kind]} size={18}/>}</span><h3 id={`${id}-title`}>{item.title}</h3><span className={`portal-state portal-state-${item.state}`}>{item.state==='submitted'?'Waiting for review':itemStateLabels[item.state]}</span></div>
    <p className="portal-meta">{item.required?'Required':'Optional'}{item.dueDate?` · due ${dateLabel(item.dueDate)}`:''}{item.stage?` · ${item.stage}`:''}</p>
    {item.guidance&&<p className="portal-text">{item.guidance}</p>}
    {item.feedback&&<div className={item.state==='changes_requested'?'portal-feedback':'portal-feedback portal-feedback-ok'}><strong>{item.state==='changes_requested'?'Changes requested:':'Note from your agency:'}</strong> {item.feedback}</div>}
    <form noValidate onSubmit={event=>{event.preventDefault();void save(true)}}><fieldset disabled={locked||busy}>
      {item.kind==='text'&&<label>Your answer<textarea rows={4} maxLength={config.maxLength??4000} placeholder={config.placeholder} value={value.text??''} onChange={event=>setValue({...value,text:event.target.value})}/></label>}
      {textInput&&<label>Your answer<input className="portal-input" type={textInput.type} inputMode={textInput.inputMode} autoComplete={textInput.autoComplete??'off'} maxLength={item.kind==='short_text'?config.maxLength??300:textInput.max}
        placeholder={config.placeholder??(item.kind==='url'?'https://':undefined)} value={value.text??''} onChange={event=>setValue({...value,text:event.target.value})}/></label>}
      {item.kind==='number'&&<label>Your answer<input className="portal-input" type="number" inputMode="decimal" step="any" min={config.min} max={config.max} placeholder={config.placeholder} value={value.number??''}
        onChange={event=>setValue({...value,number:event.target.value===''?null:Number(event.target.value)})}/>{(config.min!==undefined||config.max!==undefined)&&<span className="portal-hint">{config.min!==undefined&&config.max!==undefined?`Between ${config.min} and ${config.max}`:config.min!==undefined?`At least ${config.min}`:`At most ${config.max}`}</span>}</label>}
      {item.kind==='date'&&<label>Date<input className="portal-input" type="date" min="1900-01-01" max="2100-12-31" value={value.date??''} onChange={event=>setValue({...value,date:event.target.value||null})}/></label>}
      {item.kind==='choice'&&<div role="radiogroup" aria-label={item.title} className="portal-choices">{item.options.map(option=><label key={option} className="portal-choice"><input type="radio" name={`${id}-choice`} checked={value.choice===option} onChange={()=>setValue({...value,choice:option})}/>{option}</label>)}</div>}
      {item.kind==='multi_choice'&&<div role="group" aria-label={`${item.title}: choose all that apply`} className="portal-choices">{item.options.map(option=><label key={option} className="portal-choice"><input type="checkbox" checked={(value.choices??[]).includes(option)}
        onChange={event=>setValue({...value,choices:event.target.checked?[...(value.choices??[]),option]:(value.choices??[]).filter(choice=>choice!==option)})}/>{option}</label>)}</div>}
      {item.kind==='checkbox'&&<label className="portal-choice portal-access"><input type="checkbox" checked={!!value.checked} onChange={event=>setValue({...value,checked:event.target.checked})}/>Yes, I confirm</label>}
      {item.kind==='links'&&<div className="portal-links">{(value.links??['']).map((link,index)=><div key={index} className="portal-link-row"><label>Link {index+1}<input type="url" inputMode="url" maxLength={500} placeholder="https://" value={link} onChange={event=>setValue({...value,links:(value.links??[]).map((existing,position)=>position===index?event.target.value:existing)})}/></label>
        {(value.links??[]).length>1&&!locked&&<button type="button" className="portal-text-button" onClick={()=>setValue({...value,links:(value.links??[]).filter((_,position)=>position!==index)})}>Remove</button>}</div>)}
        {!locked&&(value.links??[]).length<10&&<button type="button" className="portal-text-button" onClick={()=>setValue({...value,links:[...(value.links??[]),'']})}>+ Add another link</button>}</div>}
      {item.kind==='access'&&<label className="portal-choice portal-access"><input type="checkbox" checked={!!value.granted} onChange={event=>setValue({...value,granted:event.target.checked})}/>I’ve granted access using the platform’s own sharing settings</label>}
      {item.kind==='file'&&<FileField item={item} token={token} locked={locked} onChanged={onReload}/>}
      {noteKinds.includes(item.kind)&&!(locked&&!value.note)&&<label>{item.kind==='access'?'Which account did you add, or anything we should know? (optional)':'Anything else? (optional)'}<textarea rows={2} maxLength={1000} value={value.note??''} onChange={event=>setValue({...value,note:event.target.value})}/></label>}
      {!locked&&<div className="portal-actions">
        <button type="button" className="portal-secondary" disabled={busy||!dirty} onClick={()=>void save(false)}>Save progress</button>
        <button className="portal-primary" disabled={busy}>{busy?'Saving…':item.state==='changes_requested'||item.state==='submitted'?'Resubmit for review':'Submit for review'}</button>
      </div>}
    </fieldset></form>
    {item.hasDraft&&!dirty&&editable&&item.state!=='accepted'&&<p className="portal-small">You have saved progress on this item that hasn’t been submitted yet.</p>}
    {saved&&!error&&<p className="portal-saved" role="status">{saved}</p>}
    {error&&<p className="portal-error" role="alert">{error}{conflicted&&<> <button type="button" className="portal-text-button" onClick={()=>void onReload()}>Reload the latest version</button></>}</p>}
  </article>
}
/**
 * Uploads for a file field. Each file goes straight to secure storage with a one-time link, then is checked (type, size
 * and content) before the agency can open it. Submitting the item sends the files that passed.
 */
function FileField({item,token,locked,onChanged}:{item:PortalItem;token:string;locked:boolean;onChanged:()=>Promise<void>}){
  const files=item.files??[],limit=item.config?.maxFiles??5
  // Files in an answer waiting for review stay until the agency asks for changes.
  const submitted=item.state==='submitted'?item.value?.files??[]:[]
  const [uploads,setUploads]=useState<{name:string;progress:number}[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState('')
  const input=useRef<HTMLInputElement>(null)
  async function upload(chosen:File[]){
    if(busy||!chosen.length)return
    const room=limit-files.length
    setError('');setDone('')
    if(room<=0){setError(`You can upload up to ${limit} file${limit===1?'':'s'} here. Remove one first.`);return}
    const batch=chosen.slice(0,room),skipped=chosen.length-batch.length
    setBusy(true);setUploads(batch.map(file=>({name:file.name,progress:0})))
    let added=0
    for(const [index,file] of batch.entries()){
      try{await portalUpload(token,item.id,file,fraction=>setUploads(current=>current.map((entry,position)=>position===index?{...entry,progress:fraction}:entry)));added+=1}
      catch(cause){setError(`${file.name}: ${message(cause,'The upload failed. Please try again.')}`);break}
    }
    setUploads([]);setBusy(false);if(input.current)input.current.value=''
    if(added)setDone(`${added} file${added===1?'':'s'} uploaded and checked.${skipped?` ${skipped} not uploaded: the limit here is ${limit}.`:''} Submit the item when you’re ready.`)
    await onChanged()
  }
  async function act(action:()=>Promise<unknown>,fallback:string){
    if(busy)return
    setBusy(true);setError('');setDone('')
    try{await action();await onChanged()}catch(cause){setError(message(cause,fallback))}finally{setBusy(false)}
  }
  return <div className="portal-files">
    {files.length>0&&<ul className="portal-file-list" aria-label="Your uploaded files">{files.map(file=><li key={file.id}>
      <span className="portal-file-icon" aria-hidden="true"><Mark name="file" size={17}/></span><span className="portal-file-name">{file.name}<small>{formatBytes(file.size)}{file.status==='pending'?' · being checked':''}</small></span>
      {file.status==='available'&&<button type="button" className="portal-text-button" disabled={busy} onClick={()=>void act(()=>portalDownload(token,file.id),'The file couldn’t be opened.')}>Download<span className="sr-only"> {file.name}</span></button>}
      {!locked&&!submitted.includes(file.id)&&<button type="button" className="portal-text-button" disabled={busy} onClick={()=>void act(()=>portalRemoveFile(token,file.id),'The file couldn’t be removed.')}>Remove<span className="sr-only"> {file.name}</span></button>}
    </li>)}</ul>}
    {uploads.length>0&&<ul className="portal-upload-list" aria-live="polite">{uploads.map(upload=><li key={upload.name}><span>{upload.name}</span><progress max={1} value={upload.progress} aria-label={`Uploading ${upload.name}`}/></li>)}</ul>}
    {!locked&&files.length<limit&&<label className="portal-file-picker">Choose {limit-files.length===1?'a file':'files'} to upload
      <input ref={input} type="file" accept={acceptedFiles} multiple={limit-files.length>1} disabled={busy} onChange={event=>void upload(Array.from(event.target.files??[]))}/>
      <span className="portal-hint">Up to {limit} file{limit===1?'':'s'} here: PDF, images, Office documents, text, CSV, ZIP, video or audio. Never upload password lists or keys.</span></label>}
    {!locked&&files.length>=limit&&<p className="portal-small">You’ve added the maximum of {limit} file{limit===1?'':'s'} here. Remove one to replace it.</p>}
    {done&&<p className="portal-saved" role="status">{done}</p>}
    {error&&<p className="portal-error" role="alert">{error}</p>}
  </div>
}
function SharedFiles({agency,files,token}:{agency:string;files:SharedFile[];token:string}){
  const [error,setError]=useState(''),[busy,setBusy]=useState('')
  async function download(id:string){
    if(busy)return
    setBusy(id);setError('')
    try{await portalDownload(token,id)}catch(cause){setError(message(cause,'The file couldn’t be opened.'))}finally{setBusy('')}
  }
  return <section className="portal-card portal-shared" aria-labelledby="portal-shared-title">
    <h2 id="portal-shared-title">Files from {agency}</h2>
    <p className="portal-small">Documents {agency} shared with you. Download links work for one minute at a time.</p>
    <ul className="portal-file-list">{files.map(file=><li key={file.id}><span className="portal-file-icon" aria-hidden="true"><Mark name="file" size={17}/></span>
      <span className="portal-file-name">{file.name}<small>{documentCategoryLabels[file.category]??'File'} · {formatBytes(file.size)}{file.description?` · ${file.description}`:''}</small></span>
      <button type="button" className="portal-text-button" disabled={!!busy} onClick={()=>void download(file.id)}><Mark name="download" size={15}/>{busy===file.id?'Opening…':'Download'}<span className="sr-only"> {file.name}</span></button></li>)}</ul>
    {error&&<p className="portal-error" role="alert">{error}</p>}
  </section>
}
/** The scope the agency confirmed and chose to share. Acknowledging it records that the client read it; it isn't a signature. */
function ScopeCard({agency,scope,token,onReload}:{agency:string;scope:PortalScope;token:string;onReload:()=>Promise<void>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  async function acknowledge(){
    if(busy)return
    setBusy(true);setError('')
    try{await portalAcknowledgeScope(token,scope.id);await onReload()}catch(cause){setError(message(cause,'We couldn’t record that. Please try again.'))}finally{setBusy(false)}
  }
  return <section className="portal-card portal-scope" aria-labelledby="portal-scope-title">
    <div className="portal-scope-head"><span className="portal-item-icon" aria-hidden="true"><Mark name="scope" size={18}/></span><div><h2 id="portal-scope-title">Agreed scope</h2><p className="portal-small">Version {scope.version}, confirmed by {agency} on {dateLabel(scope.confirmedAt)}.</p></div></div>
    {scope.services.map(service=><div key={service.name} className="portal-scope-service"><h3>{service.name}</h3>
      {service.agreedScope&&<><h4>What’s included</h4><p className="portal-text">{service.agreedScope}</p></>}
      {service.deliverables&&<><h4>Deliverables</h4><p className="portal-text">{service.deliverables}</p></>}
      {service.exclusions&&<><h4>Not included</h4><p className="portal-text">{service.exclusions}</p></>}</div>)}
    {scope.requirements.length>0&&<><h3>Requirements</h3><ul className="portal-scope-list">{scope.requirements.map((requirement,index)=><li key={`${requirement.title}-${index}`}><strong>{requirement.title}</strong>{requirement.description&&<p className="portal-text">{requirement.description}</p>}</li>)}</ul></>}
    {scope.outstandingQuestions&&<><h3>Open questions</h3><p className="portal-text">{scope.outstandingQuestions}</p></>}
    <div className="portal-scope-ack">
      {scope.acknowledgedAt?<p className="portal-saved" role="status">You acknowledged this scope on {dateLabel(scope.acknowledgedAt)}.</p>
        :<><button type="button" className="portal-primary" disabled={busy} onClick={()=>void acknowledge()}>{busy?'Saving…':'I’ve read this scope'}</button></>}
      <p className="portal-small">This is an acknowledgement that you’ve read the scope, not a signature, contract or legal acceptance. If something looks wrong, contact {agency} before work starts.</p>
    </div>
    {error&&<p className="portal-error" role="alert">{error}</p>}
  </section>
}
