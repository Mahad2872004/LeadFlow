import { useRef, useState } from 'react'
import { inquiryServices, normalizeInquiry, type Inquiry } from '../../supabase/functions/_shared/inquiry'
import { Verification } from './Verification'
import './InquiryPage.css'
const empty:Inquiry={name:'',email:'',phone:'',company:'',service:'',message:''}
const receiptKey='leadflow.inquiry.receipt.v1'
export default function InquiryPage(){
  const [form,setForm]=useState(()=>new URLSearchParams(window.location.search).get('topic')==='leadflow-access'?{...empty,service:'Consulting',message:'I would like to request access to LeadFlow. My workflow is: '}:empty),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reference,setReference]=useState(''),[verificationVersion,setVerificationVersion]=useState(0)
  const lock=useRef(false),receipt=useRef<{hash:string;id:string}|null>(null)
  const endpoint=import.meta.env.VITE_SUPABASE_URL,siteKey=import.meta.env.VITE_TURNSTILE_SITE_KEY
  // A workspace's own form link carries its public key; without one, the deployment-wide form is used.
  const [formKey]=useState(()=>new URLSearchParams(window.location.search).get('form'))
  const validLink=!formKey||/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(formKey)
  const connected=!!endpoint?.trim()&&!!siteKey?.trim(),configured=connected&&validLink
  async function submit(event:React.SubmitEvent<HTMLFormElement>){
    event.preventDefault();if(lock.current)return
    let inquiry:Inquiry
    try{inquiry=normalizeInquiry(form)}catch(cause){setError((cause as Error).message);return}
    if(!token){setError('Please complete the verification before sending.');return}
    const honeypot=new FormData(event.currentTarget).get('website')??''
    lock.current=true;setBusy(true);setError('')
    try{
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(formKey?{form:formKey,inquiry}:inquiry)))),x=>x.toString(16).padStart(2,'0')).join('')
      if(!receipt.current){try{receipt.current=JSON.parse(sessionStorage.getItem(receiptKey)??'null')}catch{/* In-memory retry still works when storage is unavailable. */}}
      if(receipt.current?.hash!==hash||!receipt.current?.id)receipt.current={hash,id:crypto.randomUUID()}
      try{sessionStorage.setItem(receiptKey,JSON.stringify(receipt.current))}catch{/* No contact details are stored in browser storage. */}
      const response=await fetch(`${endpoint}/functions/v1/submit-inquiry`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:receipt.current.id,inquiry,token,website:honeypot,...(formKey?{form:formKey}:{})}),signal:AbortSignal.timeout(45000)})
      const result=await response.json()
      if(!response.ok||result.ok!==true)throw new Error(typeof result.error==='string'?result.error:'We could not confirm your inquiry. Please try again.')
      setReference(receipt.current.id)
    }catch(cause){setError(cause instanceof Error&&cause.name!=='TypeError'&&cause.name!=='TimeoutError'?cause.message:'We could not confirm your inquiry. Check your connection and retry with the same details; this will not create a second inquiry.')}
    finally{lock.current=false;setBusy(false);setToken('');setVerificationVersion(v=>v+1)}
  }
  return <main className="inquiry-page"><div className="inquiry-layout"><section className="inquiry-intro"><a className="inquiry-brand" href="/inquiry" aria-label="LeadFlow inquiries"><span>↗</span> LeadFlow</a><p className="inquiry-eyebrow">LET’S MAKE SOMETHING GREAT</p><h1>A good project starts with a conversation.</h1><p className="inquiry-description">Tell us what you have in mind. Share your goals, your ideas, or the challenge you’re ready to solve.</p><div className="inquiry-note"><span aria-hidden="true">✦</span><div><strong>A thoughtful first step.</strong><p>Your inquiry goes directly to our team, so we can pick up the conversation with context.</p></div></div><p className="inquiry-small">No mailing lists. Just a conversation about your project.</p></section><section className="inquiry-card" aria-label="Project inquiry">
    {reference?<div className="inquiry-success" role="status"><span className="inquiry-check" aria-hidden="true">✓</span><p className="inquiry-eyebrow">INQUIRY RECEIVED</p><h2>Thanks for reaching out.</h2><p>Your inquiry has been saved for our team to review.</p><p className="inquiry-reference">Reference: {reference}</p><button type="button" onClick={()=>{setReference('');setForm(empty);receipt.current=null;try{sessionStorage.removeItem(receiptKey)}catch{/* optional storage */}}}>Start another inquiry</button></div>:<><div className="inquiry-card-heading"><h2>Tell us about your project</h2><p>Fields marked * are required.</p></div>{!validLink?<p className="inquiry-error" role="alert">This form link is incomplete. Check the link with the business you are contacting.</p>:!connected&&<p className="inquiry-error" role="alert">This inquiry form is not connected yet. Please check back soon.</p>}<form onSubmit={submit}><fieldset disabled={busy||!configured}><div className="inquiry-grid">{(['name','email','phone','company'] as const).map(field=><label key={field}>{field==='name'?'Your name *':field==='email'?'Email address *':field==='phone'?'Phone (optional)':'Company (optional)'}<input name={field} type={field==='email'?'email':field==='phone'?'tel':'text'} autoComplete={field==='name'?'name':field==='email'?'email':field==='phone'?'tel':'organization'} required={field==='name'||field==='email'} maxLength={field==='phone'?25:150} value={form[field]} onChange={event=>setForm({...form,[field]:event.target.value})} placeholder={field==='name'?'Alex Morgan':field==='email'?'alex@company.com':field==='phone'?'+1 555 000 0000':'Your company'}/></label>)}</div><label>What can we help with? *<select name="service" required value={form.service} onChange={event=>setForm({...form,service:event.target.value})}><option value="">Choose a service</option>{inquiryServices.map(service=><option key={service}>{service}</option>)}</select></label><label>Tell us a little more *<textarea name="message" required rows={5} maxLength={2000} value={form.message} onChange={event=>setForm({...form,message:event.target.value})} placeholder="What are you looking to create or improve?"/></label><div className="inquiry-honeypot" aria-hidden="true"><label>Leave this field empty<input name="website" tabIndex={-1} autoComplete="off"/></label></div>{configured&&<><Verification siteKey={siteKey} onToken={setToken} resetVersion={verificationVersion}/><button className="inquiry-reverify" type="button" onClick={()=>{setToken('');setVerificationVersion(v=>v+1)}}>Reload verification</button></>}<p className="inquiry-privacy">We’ll use these details to respond to your inquiry. Please don’t include passwords or sensitive information.</p><button className="inquiry-submit" disabled={!token||!configured||busy} type="submit">{busy?'Sending your inquiry…':'Send inquiry'} <span aria-hidden="true">↗</span></button></fieldset>{error&&<p className="inquiry-error" role="alert">{error}</p>}{busy&&<p role="status" className="inquiry-small">Saving your inquiry securely…</p>}</form></>}
  </section></div><footer className="inquiry-footer">Good conversations. Better projects.<span>Powered by LeadFlow</span></footer></main>
}
