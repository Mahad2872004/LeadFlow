import { Suspense, lazy, useEffect } from 'react'
const Dashboard=lazy(()=>import('./Dashboard'))
const InquiryPage=lazy(()=>import('./components/InquiryPage'))
const Marketing=lazy(()=>import('./marketing/Marketing'))
export default function Routes(){
 const path=window.location.pathname.replace(/\/+$/,'')||'/'
 const privatePage=path==='/app'||path.startsWith('/app/')||path==='/login'
 useEffect(()=>{
  if(privatePage){document.title='Workspace — LeadFlow';document.querySelector('meta[name="description"]')?.setAttribute('content','Sign in to your private LeadFlow workspace.')}
  if(path==='/inquiry'){document.title='Send an inquiry — LeadFlow';document.querySelector('meta[name="description"]')?.setAttribute('content','Tell us about your project through the LeadFlow inquiry form.')}
  if(privatePage){const robots=document.createElement('meta');robots.name='robots';robots.content='noindex,nofollow';document.head.appendChild(robots);return()=>robots.remove()}
 },[path,privatePage])
 return <Suspense fallback={<p role="status" style={{padding:32,fontFamily:'system-ui'}}>Loading LeadFlow…</p>}>{path==='/inquiry'?<InquiryPage/>:privatePage?<Dashboard/>:<Marketing path={path}/>}</Suspense>
}
