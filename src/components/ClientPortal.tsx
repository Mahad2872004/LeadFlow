import { useCallback, useEffect, useState } from 'react'
import { dateLabel, initials } from '../lib/format'
import { itemStateLabels, type ResponseValue } from '../lib/onboardingOptions'
import { portalCall, PortalError, type PortalItem, type PortalView } from '../lib/portal'
import { Icon } from './Icon'
import './ClientPortal.css'
const marks={
  lock:<><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2"/></>,
  shield:<><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6Z"/><path d="m8.8 12.2 2.2 2.2 4.2-4.6"/></>,
  unlink:<><path d="M9 17H7A5 5 0 0 1 7 7M15 7h2a5 5 0 0 1 4 8M8 12h4"/><path d="m3 3 18 18"/></>,
  text:<><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.5 7.5 3 3"/></>,
  choice:<><circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><path d="M11 7h9M11 17h9"/></>,
  links:<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></>,
  access:<><circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/></>,
}
/** Decorative icon, hidden from assistive technology. */
function Mark({name,size=18}:{name:keyof typeof marks;size?:number}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{marks[name]}</svg>}
// The link token sits in the URL fragment: browsers don't send fragments to servers or in Referer headers.
const readToken=()=>{const value=window.location.hash.slice(1);return /^lf_[0-9a-f]{64}$/.test(value)?value:''}
type State={status:'loading'}|{status:'invalid';message:string}|{status:'error';message:string}|{status:'ready';view:PortalView}
const opened=(view:PortalView):State=>{document.title=`${view.title} — client onboarding`;return {status:'ready',view}}
const failed=(cause:unknown):State=>cause instanceof PortalError&&cause.status===404?{status:'invalid',message:cause.message}:{status:'error',message:cause instanceof Error?cause.message:'Something went wrong.'}
const open=(token:string)=>portalCall<{onboarding:PortalView}>({action:'open',token}).then(result=>opened(result.onboarding),failed)
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
  const needed=view.items.filter(item=>item.state!=='not_required')
  const required=needed.filter(item=>item.required),accepted=required.filter(item=>item.state==='accepted').length
  const changes=needed.filter(item=>item.state==='changes_requested'),todo=needed.filter(item=>item.state==='not_started'),waiting=needed.filter(item=>item.state==='submitted')
  const next=changes[0]??todo.find(item=>item.required)??todo[0]
  const sections=needed.reduce<[string,PortalItem[]][]>((groups,item)=>{const group=groups.find(([name])=>name===item.section);if(group)group[1].push(item);else groups.push([item.section,[item]]);return groups},[])
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
      {items.map(item=><PortalItemCard key={`${item.id}-${item.revision}`} item={item} token={token} editable={editable} message={messages[item.id]??''} onReload={onReload}
        onSaved={async message=>{await onReload();setMessages(current=>({...current,[item.id]:message}))}}/>)}</section>)}
  </>
}
const emptyValue=(item:PortalItem):ResponseValue=>item.kind==='text'?{text:''}:item.kind==='choice'?{choice:'',note:''}:item.kind==='links'?{links:[''],note:''}:{granted:false,note:''}
function PortalItemCard({item,token,editable,message,onSaved,onReload}:{item:PortalItem;token:string;editable:boolean;message:string;onSaved:(message:string)=>Promise<void>;onReload:()=>Promise<void>}){
  const initial=item.value?{...emptyValue(item),...item.value,...(item.kind==='links'&&!item.value.links?.length?{links:['']}:{})}:emptyValue(item)
  const [value,setValue]=useState<ResponseValue>(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflicted,setConflicted]=useState(false)
  const locked=!editable||item.state==='accepted'
  const dirty=JSON.stringify(value)!==JSON.stringify(initial)
  const id=`portal-item-${item.id}`
  async function save(submit:boolean){
    if(busy)return
    const body=item.kind==='links'?{...value,links:(value.links??[]).map(link=>link.trim()).filter(Boolean)}:value
    setBusy(true);setError('')
    try{await portalCall({action:'save',token,itemId:item.id,value:body,submit,revision:item.revision})}
    catch(cause){setConflicted(cause instanceof PortalError&&cause.status===409&&/updated elsewhere/.test(cause.message));setError(cause instanceof Error?cause.message:'We couldn’t save this. Please try again.');setBusy(false);return}
    // The card remounts with the saved revision once the checklist reloads.
    await onSaved(submit?'Submitted for review. Your agency will check it.':'Progress saved. You can come back to finish it.')
    setBusy(false)
  }
  return <article id={id} className={`portal-item portal-item-${item.state}`} aria-labelledby={`${id}-title`}>
    <div className="portal-item-head"><span className="portal-item-icon" aria-hidden="true">{item.state==='accepted'?<Icon name="check" size={20}/>:<Mark name={item.kind} size={18}/>}</span><h3 id={`${id}-title`}>{item.title}</h3><span className={`portal-state portal-state-${item.state}`}>{item.state==='submitted'?'Waiting for review':itemStateLabels[item.state]}</span></div>
    <p className="portal-meta">{item.required?'Required':'Optional'}{item.dueDate?` · due ${dateLabel(item.dueDate)}`:''}</p>
    {item.guidance&&<p className="portal-text">{item.guidance}</p>}
    {item.feedback&&<div className={item.state==='changes_requested'?'portal-feedback':'portal-feedback portal-feedback-ok'}><strong>{item.state==='changes_requested'?'Changes requested:':'Note from your agency:'}</strong> {item.feedback}</div>}
    <form noValidate onSubmit={event=>{event.preventDefault();void save(true)}}><fieldset disabled={locked||busy}>
      {item.kind==='text'&&<label>Your answer<textarea rows={4} maxLength={4000} value={value.text??''} onChange={event=>setValue({...value,text:event.target.value})}/></label>}
      {item.kind==='choice'&&<div role="radiogroup" aria-label={item.title} className="portal-choices">{item.options.map(option=><label key={option} className="portal-choice"><input type="radio" name={`${id}-choice`} checked={value.choice===option} onChange={()=>setValue({...value,choice:option})}/>{option}</label>)}</div>}
      {item.kind==='links'&&<div className="portal-links">{(value.links??['']).map((link,index)=><div key={index} className="portal-link-row"><label>Link {index+1}<input type="url" inputMode="url" maxLength={500} placeholder="https://" value={link} onChange={event=>setValue({...value,links:(value.links??[]).map((existing,position)=>position===index?event.target.value:existing)})}/></label>
        {(value.links??[]).length>1&&!locked&&<button type="button" className="portal-text-button" onClick={()=>setValue({...value,links:(value.links??[]).filter((_,position)=>position!==index)})}>Remove</button>}</div>)}
        {!locked&&(value.links??[]).length<10&&<button type="button" className="portal-text-button" onClick={()=>setValue({...value,links:[...(value.links??[]),'']})}>+ Add another link</button>}</div>}
      {item.kind==='access'&&<label className="portal-choice portal-access"><input type="checkbox" checked={!!value.granted} onChange={event=>setValue({...value,granted:event.target.checked})}/>I’ve granted access using the platform’s own sharing settings</label>}
      {item.kind!=='text'&&!(locked&&!value.note)&&<label>{item.kind==='access'?'Which account did you add, or anything we should know? (optional)':'Anything else? (optional)'}<textarea rows={2} maxLength={1000} value={value.note??''} onChange={event=>setValue({...value,note:event.target.value})}/></label>}
      {!locked&&<div className="portal-actions">
        <button type="button" className="portal-secondary" disabled={busy||!dirty} onClick={()=>void save(false)}>Save progress</button>
        <button className="portal-primary" disabled={busy}>{busy?'Saving…':item.state==='changes_requested'||item.state==='submitted'?'Resubmit for review':'Submit for review'}</button>
      </div>}
    </fieldset></form>
    {item.hasDraft&&!dirty&&editable&&item.state!=='accepted'&&<p className="portal-small">You have saved progress on this item that hasn’t been submitted yet.</p>}
    {message&&!error&&<p className="portal-saved" role="status">{message}</p>}
    {error&&<p className="portal-error" role="alert">{error}{conflicted&&<> <button type="button" className="portal-text-button" onClick={()=>void onReload()}>Reload the latest version</button></>}</p>}
  </article>
}
