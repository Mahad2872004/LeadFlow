import { Suspense, lazy, useEffect } from 'react'
import { usePathname } from './lib/navigation'
import { signupOpen } from './marketing/access'
const Dashboard=lazy(()=>import('./Dashboard'))
const InquiryPage=lazy(()=>import('./components/InquiryPage'))
const ClientPortal=lazy(()=>import('./components/ClientPortal'))
const Marketing=lazy(()=>import('./marketing/Marketing'))
const authMeta:Record<string,[string,string]>={'/login':['Sign in — LeadFlow','Sign in to your LeadFlow workspace.'],'/signup':signupOpen?['Create your account — LeadFlow','Create a LeadFlow account and set up your first workspace.']:['Request access — LeadFlow','Accounts are administrator-provisioned. Request access or sign in to an existing workspace.']}
export default function Routes(){
 const path=usePathname().replace(/\/+$/,'')||'/'
 const appPage=path==='/app'||path.startsWith('/app/')
 const privatePage=appPage||path==='/login'||path==='/signup'
 const portalPage=path==='/client-portal'
 useEffect(()=>{
  if(privatePage){const [title,description]=authMeta[path]??['Workspace — LeadFlow','Sign in to your private LeadFlow workspace.'];document.title=title;document.querySelector('meta[name="description"]')?.setAttribute('content',description)}
  if(path==='/inquiry'){document.title='Send an inquiry — LeadFlow';document.querySelector('meta[name="description"]')?.setAttribute('content','Tell us about your project through the LeadFlow inquiry form.')}
  if(appPage||path==='/login'){const robots=document.createElement('meta');robots.name='robots';robots.content='noindex,nofollow';document.head.appendChild(robots);return()=>robots.remove()}
 },[path,privatePage,appPage])
 // Client links carry a private token: keep the page out of search engines and never send it as a referrer.
 useEffect(()=>{
  if(!portalPage)return
  document.title='Client onboarding — LeadFlow';document.querySelector('meta[name="description"]')?.setAttribute('content','Your private onboarding checklist.')
  const tags=[['robots','noindex,nofollow'],['referrer','no-referrer']].map(([name,content])=>{const meta=document.createElement('meta');meta.name=name;meta.content=content;document.head.appendChild(meta);return meta})
  return()=>tags.forEach(meta=>meta.remove())
 },[portalPage])
 return <Suspense fallback={<p role="status" style={{padding:32,fontFamily:'system-ui'}}>Loading LeadFlow…</p>}>{path==='/inquiry'?<InquiryPage/>:portalPage?<ClientPortal/>:privatePage?<Dashboard/>:<Marketing path={path}/>}</Suspense>
}
