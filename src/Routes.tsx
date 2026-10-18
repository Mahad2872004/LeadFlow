import { Suspense, lazy } from 'react'
const Dashboard=lazy(()=>import('./Dashboard'))
const InquiryPage=lazy(()=>import('./components/InquiryPage'))
export default function Routes(){
  const publicInquiry=window.location.pathname.replace(/\/$/,'')==='/inquiry'
  return <Suspense fallback={<p role="status">Loading…</p>}>{publicInquiry?<InquiryPage/>:<Dashboard/>}</Suspense>
}
