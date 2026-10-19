import { Suspense, lazy, useEffect } from 'react'
import { usePathname } from './lib/navigation'
import { signupOpen } from './marketing/access'
const Dashboard=lazy(()=>import('./Dashboard'))
const InquiryPage=lazy(()=>import('./components/InquiryPage'))
const Marketing=lazy(()=>import('./marketing/Marketing'))
const authMeta:Record<string,[string,string]>={'/login':['Sign in — LeadFlow','Sign in to your LeadFlow workspace.'],'/signup':signupOpen?['Create your account — LeadFlow','Create a LeadFlow account and set up your first workspace.']:['Request access — LeadFlow','Accounts are administrator-provisioned. Request access or sign in to an existing workspace.']}
export default function Routes(){
 const path=usePathname().replace(/\/+$/,'')||'/'
 const appPage=path==='/app'||path.startsWith('/app/')
 const privatePage=appPage||path==='/login'||path==='/signup'
 useEffect(()=>{
  if(privatePage){const [title,description]=authMeta[path]??['Workspace — LeadFlow','Sign in to your private LeadFlow workspace.'];document.title=title;document.querySelector('meta[name="description"]')?.setAttribute('content',description)}
  if(path==='/inquiry'){document.title='Send an inquiry — LeadFlow';document.querySelector('meta[name="description"]')?.setAttribute('content','Tell us about your project through the LeadFlow inquiry form.')}
  if(appPage||path==='/login'){const robots=document.createElement('meta');robots.name='robots';robots.content='noindex,nofollow';document.head.appendChild(robots);return()=>robots.remove()}
 },[path,privatePage,appPage])
 return <Suspense fallback={<p role="status" style={{padding:32,fontFamily:'system-ui'}}>Loading LeadFlow…</p>}>{path==='/inquiry'?<InquiryPage/>:privatePage?<Dashboard/>:<Marketing path={path}/>}</Suspense>
}
