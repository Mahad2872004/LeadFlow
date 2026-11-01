import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { accountLabel, apolloStatus, leadLists, remainingOf, type ApolloStatus, type FilterValues, type LeadList, type SearchKind } from '../lib/apollo'
import type { LeadOrigin } from '../lib/discovery'
import type { Lead } from '../lib/model'
import { ApolloCredits } from './ApolloCredits'
import { ApolloSaved } from './ApolloSaved'
import { ApolloSearch } from './ApolloSearch'
import './Apollo.css'
type View = 'people' | 'organizations' | 'saved' | 'credits'
interface WorkspaceProps { workspace: WorkspaceSummary; leads: Lead[]; origins: LeadOrigin[]; blocked: boolean; onImported: (message: string) => Promise<void> }
const accountKey = (workspaceId: string) => `leadflow.apollo.account.${workspaceId}`
/** Apollo lead generation: people and company search, saved and recent searches, and credits & accounts. */
export function ApolloWorkspace({workspace,leads,origins,blocked,onImported}:WorkspaceProps){
  const [status,setStatus]=useState<{state:'loading'}|{state:'error';message:string}|{state:'ready';value:ApolloStatus}>({state:'loading'}),[attempt,setAttempt]=useState(0)
  const [view,setView]=useState<View>('people'),[lists,setLists]=useState<LeadList[]>([]),[listsVersion,setListsVersion]=useState(0),[refreshKey,setRefreshKey]=useState(0)
  const [accountId,setAccountId]=useState(()=>{try{return localStorage.getItem(accountKey(workspace.id))??''}catch{return ''}})
  // Filters handed over from a saved or recent search; the key remounts the search form with them.
  const [loaded,setLoaded]=useState<{key:number;kind:SearchKind;filters:FilterValues}|null>(null)
  useEffect(()=>{
    let active=true
    apolloStatus(workspace.id).then(value=>{if(active)setStatus({state:'ready',value})}).catch(cause=>{if(active)setStatus({state:'error',message:cause instanceof Error?cause.message:'Apollo isn’t available right now.'})})
    return()=>{active=false}
  },[workspace.id,attempt])
  useEffect(()=>{
    let active=true
    leadLists(workspace.id).then(items=>{if(active)setLists(items)}).catch(()=>{/* Saving still works without a list. */})
    return()=>{active=false}
  },[workspace.id,listsVersion,leads])
  // Credit figures change after searches and reveals; refresh them quietly.
  const changed=useCallback(()=>{setAttempt(value=>value+1);setRefreshKey(value=>value+1)},[])
  const select=(id:string)=>{setAccountId(id);try{localStorage.setItem(accountKey(workspace.id),id)}catch{/* optional */}}
  if(status.state==='loading')return <div className="content-skeleton" role="status"><span className="sr-only">Loading Apollo…</span><i className="skeleton skeleton-panel"/></div>
  if(status.state==='error')return <div className="error-banner load-error" role="alert"><p><strong>We couldn’t load Apollo.</strong> {status.message}</p><button className="secondary" onClick={()=>{setStatus({state:'loading'});setAttempt(value=>value+1)}}>Try again</button></div>
  const {value}=status
  if(!value.enabled)return <NotEnabled reason={value.reason} canManage={value.role!=='member'} workspaceId={workspace.id}/>
  const usable=value.accounts.filter(account=>account.configured)
  const account=usable.find(item=>item.id===accountId&&item.active)??usable.find(item=>item.active)??usable[0]
  const views:[View,string][]=[['people','Find people'],['organizations','Find companies'],['saved','Saved & recent'],['credits','Credits & accounts']]
  return <div className="ap">
    <div className="ap-bar">
      <div className="dv-tabs" role="tablist" aria-label="Apollo views">{views.map(([id,label])=><button key={id} role="tab" aria-selected={view===id} className={view===id?'active':''} onClick={()=>setView(id)}>{label}</button>)}</div>
      <div className="ap-account-picker">
        <label>Apollo account<select value={account?.id??''} onChange={event=>select(event.target.value)}>{usable.map(item=><option key={item.id} value={item.id} disabled={!item.active}>{accountLabel(item)}{item.active?'':' (off)'}</option>)}</select></label>
        {account&&<span className={`ap-remaining${remainingOf(account)<5?' low':''}`} title="Credits left this cycle in LeadFlow’s ledger">{Number(remainingOf(account).toFixed(2))} / {account.monthlyAllowance} credits left</span>}
      </div>
    </div>
    {!account?<div className="error-banner">No Apollo account is switched on. Switch one on in Credits & accounts.</div>:<>
      {(view==='people'||view==='organizations')&&!account.active&&<div className="error-banner">{accountLabel(account)} is switched off. Choose another account or switch it on.</div>}
      {view==='people'&&<ApolloSearch key={`people-${loaded?.kind==='people'?loaded.key:0}`} kind="people" workspace={workspace} account={account} phoneReveal={value.phoneReveal} leads={leads} origins={origins} lists={lists} blocked={blocked}
        initial={loaded?.kind==='people'?loaded.filters:null} onChanged={changed} onImported={onImported} onListsChanged={()=>setListsVersion(version=>version+1)}/>}
      {view==='organizations'&&<ApolloSearch key={`org-${loaded?.kind==='organizations'?loaded.key:0}`} kind="organizations" workspace={workspace} account={account} phoneReveal={value.phoneReveal} leads={leads} origins={origins} lists={lists} blocked={blocked}
        initial={loaded?.kind==='organizations'?loaded.filters:null} onChanged={changed} onImported={onImported} onListsChanged={()=>setListsVersion(version=>version+1)}/>}
    </>}
    {view==='saved'&&<ApolloSaved workspace={workspace} refreshKey={refreshKey} onUse={(kind,filters,useAccount)=>{if(useAccount&&usable.some(item=>item.id===useAccount&&item.active))select(useAccount);setLoaded({key:Date.now(),kind,filters});setView(kind)}}/>}
    {view==='credits'&&<ApolloCredits workspace={workspace} accounts={value.accounts} selected={account?.id??''} onSelect={id=>{select(id);setView('people')}} onChanged={changed}/>}
  </div>
}
function NotEnabled({reason,canManage,workspaceId}:{reason:ApolloStatus['reason'];canManage:boolean;workspaceId:string}){
  return <section className="panel dv-setup" aria-labelledby="ap-setup-title"><div className="dv-setup-copy">
    <p className="eyebrow">APOLLO NOT CONNECTED</p>
    <h2 id="ap-setup-title">{reason==='no_accounts'?'No Apollo API key has been added yet':reason==='keys_unreadable'?'The Apollo API key couldn’t be read':'Apollo isn’t switched on for this workspace'}</h2>
    <p>Apollo search and contact reveals run on the server with your own Apollo API key. Until it’s connected, you can still import a CSV file or add businesses yourself.</p>
    {canManage&&<p className="dv-setup-detail">{reason==='keys_unreadable'?<>The <code>APOLLO_API_KEYS</code> secret is set, but no key could be read from it. Set it to <code>primary:YOUR_KEY</code> on one line, with no spaces inside the key, and reload this page.</>:reason==='no_accounts'?<>Set the <code>APOLLO_API_KEYS</code> secret for the <code>apollo</code> function, for example <code>primary:YOUR_KEY</code>, and add this workspace to <code>APOLLO_WORKSPACE_IDS</code>.</>
      :<>Add this workspace’s ID to the <code>APOLLO_WORKSPACE_IDS</code> secret: <code>{workspaceId}</code></>} See the Apollo setup guide (docs/APOLLO.md).</p>}
  </div></section>
}
