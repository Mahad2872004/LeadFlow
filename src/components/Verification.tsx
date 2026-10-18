import { useEffect, useRef, useState } from 'react'
type Turnstile = { render: (element: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void; reset: (id: string) => void }
declare global { interface Window { turnstile?: Turnstile } }
let loading: Promise<Turnstile> | undefined
function loadTurnstile(): Promise<Turnstile> {
  if(window.turnstile)return Promise.resolve(window.turnstile)
  if(loading)return loading
  loading=new Promise<Turnstile>((resolve,reject)=>{
    const script=document.createElement('script')
    script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true
    script.onload=()=>window.turnstile?resolve(window.turnstile):reject(new Error('Verification failed to load.'))
    script.onerror=()=>{script.remove();reject(new Error('Verification could not load. Check your connection or content blocker.'))}
    document.head.appendChild(script)
  }).catch(error=>{loading=undefined;throw error})
  return loading
}
export function Verification({siteKey,onToken,resetVersion}:{siteKey:string;onToken:(token:string)=>void;resetVersion:number}) {
  const container=useRef<HTMLDivElement>(null)
  const [error,setError]=useState('')
  useEffect(()=>{
    let stopped=false,id:string|undefined,api:Turnstile|undefined
    loadTurnstile().then(service=>{
      if(stopped||!container.current)return
      api=service;id=service.render(container.current,{sitekey:siteKey,action:'inquiry',size:'flexible',callback:(token:string)=>{setError('');onToken(token)},'expired-callback':()=>onToken(''),'error-callback':(code:string)=>{onToken('');const hint=code==='110200'?'This hostname is not authorized for the verification widget. Contact the site administrator.':code==='110100'||code==='110110'?'The verification site key is invalid. Contact the site administrator.':code==='200500'?'The verification frame could not load. Check whether your browser or network blocks challenges.cloudflare.com.':'Unable to complete verification. Try reloading, another browser, or another network.';setError(`${hint} (Cloudflare code: ${code || 'unavailable'})`)}})
    }).catch(cause=>{if(!stopped)setError(cause.message)})
    return()=>{stopped=true;if(id)api?.remove(id)}
  },[siteKey,onToken,resetVersion])
  return <div className="inquiry-verification"><div ref={container}/>{error&&<p role="alert">{error}</p>}</div>
}
