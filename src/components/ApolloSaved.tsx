import { useEffect, useState } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { deleteSearch, filtersFor, savedSearches, type FilterValues, type SavedSearch, type SearchKind } from '../lib/apollo'
import { describeValue } from '../lib/apolloFilters'
import { discoveryHistory, failureLabels, type HistoryItem } from '../lib/discovery'
import { dateLabel } from '../lib/format'
const kindOf = (provider: string): SearchKind | null => provider === 'apollo_people' ? 'people' : provider === 'apollo_organizations' ? 'organizations' : null
/** "Job titles: owner · Seniority: Founder" */
function summarize(kind: SearchKind, filters: FilterValues) {
  return filtersFor(kind).filter(definition => filters[definition.key] !== undefined).map(definition => `${definition.label}: ${describeValue(definition, filters[definition.key])}`).join(' · ') || 'No filters'
}
interface SavedProps { workspace: WorkspaceSummary; refreshKey: number; onUse: (kind: SearchKind, filters: FilterValues, accountId?: string) => void }
/** Saved filter sets and recent Apollo searches in this workspace, each of which can be run again. */
export function ApolloSaved({workspace,refreshKey,onUse}:SavedProps){
  const [saved,setSaved]=useState<SavedSearch[]|null>(null),[history,setHistory]=useState<HistoryItem[]|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
  useEffect(()=>{
    let active=true
    Promise.all([savedSearches(workspace.id),discoveryHistory(workspace.id)]).then(([items,recent])=>{if(active){setSaved(items);setHistory(recent.filter(item=>kindOf(item.provider)));setError('')}})
      .catch(cause=>{if(active)setError(cause instanceof Error?cause.message:'Searches couldn’t be loaded.')})
    return()=>{active=false}
  },[workspace.id,refreshKey,attempt])
  if(error)return <div className="error-banner dv-inline-error" role="alert">{error} <button className="secondary" onClick={()=>setAttempt(value=>value+1)}>Try again</button></div>
  if(!saved||!history)return <div className="content-skeleton" role="status"><span className="sr-only">Loading searches…</span><i className="skeleton skeleton-panel"/></div>
  return <div className="ap-saved">
    <section className="panel" aria-labelledby="ap-saved-title">
      <div className="section-heading"><div><h2 id="ap-saved-title">Saved searches <span className="number-tag">{saved.length}</span></h2><p>Filter sets saved in {workspace.name}. Running one loads its filters; you choose when to search.</p></div></div>
      {saved.length===0?<div className="empty"><h3>No saved searches yet</h3><p>Set filters in Find people or Find companies, then choose “Save these filters”.</p></div>
        :<ul className="dv-history">{saved.map(item=>{const kind=item.criteria.kind;return <li key={item.id}>
          <div className="dv-history-main"><strong>{item.name}</strong><small>{kind==='people'?'People':'Companies'} · {summarize(kind,item.criteria.filters)} · saved {dateLabel(item.updatedAt)}{item.mine?'':' by a teammate'}</small></div>
          <button className="text-button" onClick={async()=>{try{await deleteSearch(workspace.id,item.id);setAttempt(value=>value+1)}catch(cause){setError(cause instanceof Error?cause.message:'It couldn’t be deleted.')}}}>Delete</button>
          <button className="secondary" onClick={()=>onUse(kind,item.criteria.filters,item.criteria.accountId)}>Use filters</button>
        </li>})}</ul>}
    </section>
    <section className="panel" aria-labelledby="ap-recent-title">
      <div className="section-heading"><div><h2 id="ap-recent-title">Recent searches</h2><p>The latest Apollo searches in this workspace, with their result counts. Results themselves aren’t stored.</p></div></div>
      {history.length===0?<div className="empty"><h3>No searches yet</h3></div>
        :<ul className="dv-history">{history.map(item=>{const kind=kindOf(item.provider)!,criteria=item.criteria as unknown as {filters?:FilterValues;account?:string};return <li key={item.id}>
          <div className="dv-history-main"><strong>{summarize(kind,criteria.filters??{})}</strong><small>{kind==='people'?'People':'Companies'} · {dateLabel(item.createdAt)}, {new Date(item.createdAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})} · account {criteria.account??'?'} · {item.mine?'You':'A teammate'}</small></div>
          <span className={`dv-badge dv-run-${item.status}`}>{item.status==='completed'?`${(item.resultCount??0).toLocaleString()}${item.truncated?'+':''} results`:item.status==='failed'?failureLabels[item.failure??'internal']??item.failure??'Failed':item.status==='running'?'Running':'Interrupted'}</span>
          <button className="secondary" onClick={()=>onUse(kind,criteria.filters??{},criteria.account)}>Use filters</button>
        </li>})}</ul>}
    </section>
  </div>
}
