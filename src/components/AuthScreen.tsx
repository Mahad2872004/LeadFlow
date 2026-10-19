import { useEffect, useId, useRef, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import { supabase } from '../lib/supabase'
import { authErrorMessage, emailRedirect, isEmail, loadAuthSettings, resendConfirmation, type AuthSettings } from '../lib/auth'
import { AppLink } from './AppLink'
import { Icon } from './Icon'
import './Workspace.css'
type Errors = Partial<Record<'email' | 'password' | 'confirm', string>>
export function Field({label,error,hint,...input}:{label:string;error?:string;hint?:string}&InputHTMLAttributes<HTMLInputElement>){
  const id=useId(),described=[hint&&`${id}-hint`,error&&`${id}-error`].filter(Boolean).join(' ')
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} aria-invalid={error?true:undefined} aria-describedby={described||undefined} {...input}/>{hint&&<small id={`${id}-hint`}>{hint}</small>}{error&&<p id={`${id}-error`} className="field-error">{error}</p>}</div>
}
const focusFirstInvalid=(form:HTMLFormElement|null,errors:Errors)=>{const field=(['email','password','confirm'] as const).find(key=>errors[key]);if(field)form?.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus()}
export function AuthScreen({mode,notice}:{mode:'sign-in'|'sign-up';notice:string}){
  // Keep ?next=… when moving between sign-in and sign-up.
  const search=window.location.search
  return <main className="auth-page">
    <section className="auth-story" aria-label="About LeadFlow">
      <a className="auth-brand" href="/"><span className="brand-mark"><Icon name="arrow" size={22}/></span>LeadFlow<span className="brand-dot">.</span></a>
      <div><p className="eyebrow">GOOD CONVERSATIONS DESERVE A FOLLOW-UP</p><h2>Every inquiry, organized. Every next step, in sight.</h2>
        <ul>{['Capture website inquiries in one place','Plan follow-ups and see what’s due','Keep a separate workspace for each business'].map(item=><li key={item}><Icon name="check" size={18}/>{item}</li>)}</ul></div>
      <small>Workspace data is private to its members and protected in the database.</small>
    </section>
    <section className="auth-main">
      <a href="/" className="text-button auth-back">← Back to LeadFlow</a>
      <div className="auth-card">{mode==='sign-in'?<SignIn notice={notice} search={search}/>:<SignUp search={search}/>}</div>
    </section>
  </main>
}
function SignIn({notice,search}:{notice:string;search:string}){
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[errors,setErrors]=useState<Errors>({})
  const [error,setError]=useState(notice),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[resend,setResend]=useState<'idle'|'sending'|'sent'>('idle')
  const form=useRef<HTMLFormElement>(null)
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    const problems:Errors={email:isEmail(email)?undefined:'Enter a valid email address.',password:password?undefined:'Enter your password.'}
    setErrors(problems);if(problems.email||problems.password){focusFirstInvalid(form.current,problems);return}
    setBusy(true);setError('');setCode('');setResend('idle')
    try{const {error}=await supabase!.auth.signInWithPassword({email:email.trim(),password});if(error){setError(authErrorMessage(error));setCode(error.code??'')}}
    catch(cause){setError(authErrorMessage(cause))}
    finally{setBusy(false)}
  }
  async function sendConfirmation(){
    setResend('sending')
    try{await resendConfirmation(email);setResend('sent')}catch(cause){setResend('idle');setError(authErrorMessage(cause));setCode('')}
  }
  return <>
    <h1>Sign in to LeadFlow</h1><p className="auth-lead">Welcome back. Pick up where your pipeline left off.</p>
    <form ref={form} noValidate onSubmit={submit}>
      <Field label="Email" type="email" name="email" data-field="email" autoComplete="username" value={email} onChange={event=>setEmail(event.target.value)} error={errors.email} disabled={busy}/>
      <Field label="Password" type="password" name="password" data-field="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} error={errors.password} disabled={busy}/>
      {error&&<div className="auth-alert" role="alert"><p>{error}</p>{code==='email_not_confirmed'&&resend!=='sent'&&<button type="button" className="text-button" disabled={resend==='sending'} onClick={sendConfirmation}>{resend==='sending'?'Sending…':'Send a new confirmation link'}</button>}</div>}
      {resend==='sent'&&<p className="auth-success" role="status">We sent a new confirmation link to {email.trim()}.</p>}
      <button className="primary auth-submit" disabled={busy}>{busy?'Signing in…':'Sign in'}</button>
    </form>
    <p className="auth-switch">New to LeadFlow? <AppLink href={`/signup${search}`}>Create an account</AppLink></p>
  </>
}
function SignUp({search}:{search:string}){
  // undefined while loading; null when the settings could not be read, in which case the form is shown
  // and the server's answer decides.
  const [settings,setSettings]=useState<AuthSettings|null|undefined>(undefined),[closed,setClosed]=useState(false),[sentTo,setSentTo]=useState('')
  useEffect(()=>{let active=true;loadAuthSettings().then(result=>{if(!active)return;setSettings(result);if(result&&!result.signupEnabled)setClosed(true)});return()=>{active=false}},[])
  if(settings===undefined)return <div className="auth-skeleton" role="status"><span className="sr-only">Checking sign-up availability…</span><i/><i/><i/><i/></div>
  if(closed)return <SignupClosed search={search}/>
  if(sentTo)return <CheckEmail email={sentTo} onBack={()=>setSentTo('')}/>
  return <SignUpForm confirmEmail={settings?.confirmEmail??true} onClosed={()=>setClosed(true)} onSent={setSentTo} search={search}/>
}
function SignUpForm({confirmEmail,onClosed,onSent,search}:{confirmEmail:boolean;onClosed:()=>void;onSent:(email:string)=>void;search:string}){
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[errors,setErrors]=useState<Errors>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const form=useRef<HTMLFormElement>(null)
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    const problems:Errors={email:isEmail(email)?undefined:'Enter a valid email address.',password:password.length>=8?undefined:'Use at least 8 characters.',confirm:confirm===password?undefined:'The passwords don’t match.'}
    setErrors(problems);if(Object.values(problems).some(Boolean)){focusFirstInvalid(form.current,problems);return}
    setBusy(true);setError('')
    try{
      const {data,error}=await supabase!.auth.signUp({email:email.trim(),password,options:{emailRedirectTo:emailRedirect()}})
      if(error){if(error.code==='signup_disabled')onClosed();else setError(authErrorMessage(error));return}
      // With a session, AuthGate continues to workspace setup; otherwise the address must be confirmed first.
      if(!data.session)onSent(email.trim())
    }catch(cause){setError(authErrorMessage(cause))}
    finally{setBusy(false)}
  }
  return <>
    <h1>Create your LeadFlow account</h1><p className="auth-lead">Set up a workspace for your business in a minute.{confirmEmail?' We’ll email you a link to confirm your address.':''}</p>
    <form ref={form} noValidate onSubmit={submit}>
      <Field label="Email" type="email" name="email" data-field="email" autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)} error={errors.email} disabled={busy}/>
      <Field label="Password" type="password" name="new-password" data-field="password" autoComplete="new-password" hint="At least 8 characters." value={password} onChange={event=>setPassword(event.target.value)} error={errors.password} disabled={busy}/>
      <Field label="Confirm password" type="password" name="confirm-password" data-field="confirm" autoComplete="new-password" value={confirm} onChange={event=>setConfirm(event.target.value)} error={errors.confirm} disabled={busy}/>
      {error&&<div className="auth-alert" role="alert"><p>{error}</p></div>}
      <button className="primary auth-submit" disabled={busy}>{busy?'Creating your account…':'Create account'}</button>
    </form>
    <p className="auth-switch">Already have an account? <AppLink href={`/login${search}`}>Sign in</AppLink></p>
  </>
}
function CheckEmail({email,onBack}:{email:string;onBack:()=>void}){
  // Supabase rate-limits confirmation emails, so a resend is offered after a short wait. Measuring
  // against a deadline keeps the countdown right even when a background tab throttles timers.
  const [until,setUntil]=useState(()=>Date.now()+60000),[now,setNow]=useState(()=>Date.now()),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('')
  const cooldown=Math.max(0,Math.ceil((until-now)/1000)),waiting=cooldown>0
  useEffect(()=>{if(!waiting)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[waiting])
  async function resend(){
    setBusy(true);setError('');setStatus('')
    try{await resendConfirmation(email);setStatus('We sent another confirmation email.');const sent=Date.now();setUntil(sent+60000);setNow(sent)}catch(cause){setError(authErrorMessage(cause))}finally{setBusy(false)}
  }
  return <div className="auth-sent">
    <span className="auth-icon" aria-hidden="true"><Icon name="check" size={26}/></span>
    <h1>Check your email</h1>
    <p className="auth-lead">We sent a confirmation link to <strong>{email}</strong>. Open it to finish creating your account, then set up your first workspace.</p>
    <ul className="auth-tips"><li>The link signs you in on the device where you open it.</li><li>Can’t find it? Check your spam or promotions folder.</li></ul>
    <button className="secondary" disabled={busy||cooldown>0} onClick={resend}>{busy?'Sending…':cooldown>0?`Resend email in ${cooldown}s`:'Resend email'}</button>
    {status&&<p className="auth-success" role="status">{status}</p>}{error&&<div className="auth-alert" role="alert"><p>{error}</p></div>}
    <p className="auth-switch"><button className="text-button" onClick={onBack}>Use a different email</button><span aria-hidden="true"> · </span><AppLink href="/login">Back to sign in</AppLink></p>
  </div>
}
function SignupClosed({search}:{search:string}){
  return <div>
    <p className="eyebrow">ACCOUNTS BY INVITATION</p>
    <h1>New accounts aren’t open yet</h1>
    <p className="auth-lead">LeadFlow accounts are currently set up by an administrator. Tell us about your workflow to request access.</p>
    <div className="auth-actions"><a className="primary" href="/inquiry?topic=leadflow-access">Send an access inquiry</a><AppLink className="secondary" href={`/login${search}`}>I already have an account</AppLink></div>
    <ol className="auth-steps"><li>Describe how you would use LeadFlow in the inquiry form.</li><li>Your request is saved and may notify the operator.</li><li>An administrator creates your account separately.</li></ol>
    <p className="auth-fine">No account is created automatically. Access, response times, pricing, and availability are not guaranteed. No payment is collected.</p>
  </div>
}
