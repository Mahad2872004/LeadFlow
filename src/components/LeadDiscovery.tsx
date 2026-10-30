import { useEffect, useState } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { criteriaSummary, discoveryHistory, searchEnabled, discoveryStatus, failureLabels, filterLabels, leadOrigins, type HistoryItem, type LeadOrigin, type ProviderStatus, type SearchCriteria } from '../lib/discovery'
import { dateLabel } from '../lib/format'
import type { Lead } from '../lib/model'
import { CsvImport } from './CsvImport'
import { DiscoverySearch } from './DiscoverySearch'
import { Icon } from './Icon'
import './Discovery.css'

type Tab = 'find' | 'csv' | 'history'
type Status = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; providers: ProviderStatus[] }
interface DiscoveryProps {
  workspace: WorkspaceSummary; leads: Lead[]
  /** True while the dashboard has a save in flight or an unsaved failed attempt; imports wait for it. */
  blocked: boolean
  /** Reloads the workspace after an import and shows the message. */
  onImported: (message: string) => Promise<void>
  onAddLead: () => void
}
/** Lead discovery: find businesses through a configured provider, import a CSV file, and review past searches. */
export function LeadDiscovery({workspace,leads,blocked,onImported,onAddLead}:DiscoveryProps){
  // While business search is "coming soon", the page opens on CSV import; manual entry is always available.
  const [tab,setTab]=useState<Tab>(searchEnabled?'find':'csv')
  const [status,setStatus]=useState<Status>({state:'loading'}),[attempt,setAttempt]=useState(0)
  const [origins,setOrigins]=useState<LeadOrigin[]>([]),[history,setHistory]=useState<HistoryItem[]|null>(null),[historyError,setHistoryError]=useState('')
  const [reopened,setReopened]=useState<{key:number;provider:string;criteria:SearchCriteria}|null>(null)
  useEffect(()=>{
    if(!searchEnabled)return
    let active=true
    discoveryStatus().then(providers=>{if(active)setStatus({state:'ready',providers})}).catch(cause=>{if(active)setStatus({state:'error',message:cause instanceof Error?cause.message:'Lead discovery is not available right now.'})})
    return()=>{active=false}
  },[attempt])
  // Provenance is reloaded whenever the leads change, so duplicate badges include what was just imported.
  useEffect(()=>{
    let active=true
    leadOrigins(workspace.id).then(items=>{if(active)setOrigins(items)}).catch(()=>{/* Duplicate checks still use the leads; the database enforces the rest. */})
    return()=>{active=false}
  },[workspace.id,leads])
  // Loaded when the tab opens, and again after a search or on Refresh (both clear it to null first).
  const [historyAttempt,setHistoryAttempt]=useState(0)
  useEffect(()=>{
    if(tab!=='history')return
    let active=true
    discoveryHistory(workspace.id).then(items=>{if(active){setHistory(items);setHistoryError('')}}).catch(cause=>{if(active)setHistoryError(cause instanceof Error?cause.message:'Search history could not be loaded.')})
    return()=>{active=false}
  },[tab,workspace.id,historyAttempt])
  const loadHistory=()=>{setHistory(null);setHistoryError('');setHistoryAttempt(value=>value+1)}
  const providers=status.state==='ready'?status.providers:[]
  const configured=providers.filter(provider=>provider.configured)
  const providerFor=(id:string)=>providers.find(provider=>provider.id===id)
  const tabs:[Tab,string][]=searchEnabled?[['find','Find businesses'],['csv','Import CSV'],['history','Search history']]:[['csv','Import CSV'],['find','Find businesses']]
  return <div className="dv">
    <div className="dv-toolbar">
      <div className="dv-tabs" role="tablist" aria-label="Lead discovery views">{tabs.map(([id,label])=><button key={id} role="tab" id={`dv-tab-${id}`} aria-selected={tab===id} aria-controls={`dv-panel-${id}`} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}{!searchEnabled&&id==='find'&&<span className="dv-soon">Coming soon</span>}</button>)}</div>
      <button className="secondary" onClick={onAddLead}><Icon name="plus" size={15}/> Add a business manually</button>
    </div>
    <div role="tabpanel" id={`dv-panel-${tab}`} aria-labelledby={`dv-tab-${tab}`}>
      {tab==='find'&&!searchEnabled&&<ComingSoon onCsv={()=>setTab('csv')} onAddLead={onAddLead}/>}
      {tab==='find'&&searchEnabled&&(status.state==='loading'?<div className="content-skeleton" role="status"><span className="sr-only">Loading lead discovery…</span><i className="skeleton skeleton-panel"/></div>
        :status.state==='error'?<div className="error-banner load-error" role="alert"><p><strong>We couldn’t load lead discovery.</strong> {status.message}</p><button className="secondary" onClick={()=>{setStatus({state:'loading'});setAttempt(value=>value+1)}}>Try again</button></div>
        :configured.length===0?<NotConfigured providers={providers} canManage={workspace.role!=='member'} onCsv={()=>setTab('csv')} onAddLead={onAddLead}/>
        :<DiscoverySearch key={reopened?.key??0} workspace={workspace} providers={providers} leads={leads} origins={origins} blocked={blocked} initial={reopened} onSearched={()=>setHistory(null)} onImported={onImported}/>)}
      {tab==='csv'&&<CsvImport workspace={workspace} leads={leads} origins={origins} blocked={blocked} onImported={onImported}/>}
      {tab==='history'&&<section className="panel" aria-labelledby="dv-history-title">
        <div className="section-heading"><div><h2 id="dv-history-title">Recent searches</h2><p>The last 25 searches in {workspace.name}. Criteria and counts only; results aren’t stored.</p></div><button className="text-button" onClick={loadHistory}>Refresh</button></div>
        {historyError?<div className="error-banner dv-inline-error" role="alert">{historyError} <button className="secondary" onClick={loadHistory}>Try again</button></div>
          :history===null?<div className="content-skeleton" role="status"><span className="sr-only">Loading search history…</span><i className="skeleton skeleton-panel"/></div>
          :history.length===0?<div className="empty"><h3>No searches yet</h3><p>Searches you and your teammates run appear here, so you can repeat them later.</p><button className="secondary" onClick={()=>setTab('find')}>Find businesses</button></div>
          :<ul className="dv-history">{history.map(item=><li key={item.id}>
            <div className="dv-history-main"><strong>{criteriaSummary(item.criteria,providerFor(item.provider))}</strong>
              <small>{dateLabel(item.createdAt)}, {new Date(item.createdAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})} · {providerFor(item.provider)?.label??item.provider} · {item.mine?'You':'A teammate'}{item.criteria.require?.length?` · ${item.criteria.require.map(filter=>filterLabels[filter].toLowerCase()).join(', ')}`:''}</small></div>
            <span className={`dv-badge dv-run-${item.status}`}>{item.status==='completed'?`${item.resultCount} ${item.resultCount===1?'result':'results'}${item.truncated?'+':''}`:item.status==='failed'?failureLabels[item.failure??'internal']??'Failed':item.status==='running'?'Running':'Interrupted'}</span>
            <button className="secondary" disabled={!providerFor(item.provider)?.configured} onClick={()=>{setReopened({key:Date.now(),provider:item.provider,criteria:item.criteria});setTab('find')}}>Use these criteria</button>
          </li>)}</ul>}
      </section>}
    </div>
  </div>
}
function ComingSoon({onCsv,onAddLead}:{onCsv:()=>void;onAddLead:()=>void}){
  return <section className="panel dv-setup" aria-labelledby="dv-soon-title">
    <div className="dv-setup-copy">
      <p className="eyebrow">COMING SOON</p>
      <h2 id="dv-soon-title">Find businesses by industry and location</h2>
      <p>Soon you’ll be able to search for businesses that match your ideal client, such as dental clinics in Austin, check whether they’re already in LeadFlow, and add the right ones in one step.</p>
      <p>Until then, import a list from a spreadsheet or add businesses yourself. Duplicate checks work the same way.</p>
      <div className="welcome-actions"><button className="primary" onClick={onCsv}>Import a CSV file</button><button className="secondary" onClick={onAddLead}>Add a business manually</button></div>
    </div>
  </section>
}
function NotConfigured({providers,canManage,onCsv,onAddLead}:{providers:ProviderStatus[];canManage:boolean;onCsv:()=>void;onAddLead:()=>void}){
  return <section className="panel dv-setup" aria-labelledby="dv-setup-title">
    <div className="dv-setup-copy">
      <p className="eyebrow">NOT SWITCHED ON YET</p>
      <h2 id="dv-setup-title">Business search hasn’t been set up for this LeadFlow deployment</h2>
      <p>Searching for businesses uses an external directory, which an administrator connects on the server. Until then, you can still build your list: add businesses yourself or import a CSV file.</p>
      {canManage&&providers.map(provider=><p key={provider.id} className="dv-setup-detail"><strong>{provider.label}:</strong> needs {provider.missing.join(', ')}. See the lead discovery setup guide (docs/LEAD-DISCOVERY.md).</p>)}
      <div className="welcome-actions"><button className="primary" onClick={onCsv}>Import a CSV file</button><button className="secondary" onClick={onAddLead}>Add a business manually</button></div>
    </div>
  </section>
}
