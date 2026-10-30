import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { asCandidate, businessToRow, countryName, criteriaSummary, defaultCriteria, DiscoveryError, domainOf, duplicateIndex, emptyLocation, filterLabels, importLeads, reasonLabels, runSearch,
  type ContactFilter, type DiscoveredBusiness, type DuplicateMatch, type ImportResult, type LeadOrigin, type ProviderStatus, type SearchCriteria, type SearchLocation, type SearchResult } from '../lib/discovery'
import { dateLabel } from '../lib/format'
import { normalizeWebsite, type Lead } from '../lib/model'
import { Icon } from './Icon'
import { Modal } from './Modal'

/** Mirrors parseCriteria in the Edge function, so most mistakes are explained before a search is spent. */
function checkCriteria(criteria: SearchCriteria, provider: ProviderStatus): string {
  if (criteria.category === 'custom' && !/^[\p{L}\p{N} &'-]{2,60}$/u.test(criteria.keyword.trim())) return 'Describe the niche in 2–60 characters, using letters, numbers, spaces, &, \' or -.'
  for (const [index, location] of criteria.locations.entries()) {
    if (!location.city.trim() && !location.postcode.trim()) return `Enter a city or postcode for location ${index + 1}.`
    if (location.postcode && !/^[A-Za-z0-9 -]{1,12}$/.test(location.postcode.trim())) return `Check the postcode for location ${index + 1}.`
  }
  if (new Set(criteria.locations.map(location => JSON.stringify(location).toLowerCase())).size !== criteria.locations.length) return 'Each location must be different.'
  if (criteria.locations.length > provider.capabilities.maxLocations) return `Search up to ${provider.capabilities.maxLocations} locations at a time.`
  return ''
}
type Run = { status: 'idle' } | { status: 'searching'; criteria: SearchCriteria } | { status: 'error'; error: DiscoveryError; criteria: SearchCriteria } | { status: 'done'; result: SearchResult }
type Sort = 'name' | 'city' | 'updated'
type Pending = { chunks: { id: string; rows: ReturnType<typeof businessToRow>[] }[]; results: ImportResult[] }
interface SearchProps {
  workspace: WorkspaceSummary; providers: ProviderStatus[]; leads: Lead[]; origins: LeadOrigin[]; blocked: boolean
  /** Criteria to start from, e.g. reopened from history. The parent remounts this form to load new ones. */
  initial: { provider: string; criteria: SearchCriteria } | null
  onSearched: () => void
  onImported: (message: string) => Promise<void>
}
/** The search form, its results, business details and importing selected businesses. */
export function DiscoverySearch({workspace,providers,leads,origins,blocked,initial,onSearched,onImported}:SearchProps){
  const configured=providers.filter(provider=>provider.configured)
  const [providerId,setProviderId]=useState(()=>initial?.provider&&configured.some(item=>item.id===initial.provider)?initial.provider:configured[0].id)
  const provider=configured.find(item=>item.id===providerId)??configured[0]
  const {capabilities}=provider
  const [criteria,setCriteria]=useState<SearchCriteria>(()=>initial?.criteria??defaultCriteria(capabilities))
  const [formError,setFormError]=useState('')
  const [run,setRun]=useState<Run>({status:'idle'})
  const set=(next:Partial<SearchCriteria>)=>{setCriteria(current=>({...current,...next}));setFormError('')}
  const setLocation=(index:number,next:Partial<SearchLocation>)=>set({locations:criteria.locations.map((location,position)=>position===index?{...location,...next}:location)})
  async function search(next=criteria){
    const problem=checkCriteria(next,provider)
    if(problem){setFormError(problem);return}
    setRun({status:'searching',criteria:next})
    try{
      const result=await runSearch(workspace.id,provider.id,{...next,keyword:next.category==='custom'?next.keyword.trim():''})
      setRun({status:'done',result})
    }catch(cause){setRun({status:'error',error:cause instanceof DiscoveryError?cause:new DiscoveryError('The search could not be completed.',0),criteria:next})}
    finally{onSearched()}
  }
  function submit(event:FormEvent){event.preventDefault();void search()}
  const searching=run.status==='searching'
  return <>
    <form className="panel dv-form" onSubmit={submit} aria-labelledby="dv-form-title" noValidate>
      <div className="dv-form-head">
        <div><h2 id="dv-form-title">Who are you looking for?</h2><p>Describe your ideal customer. Results come from {provider.label}; nothing is added to LeadFlow until you choose.</p></div>
        {configured.length>1?<label className="dv-provider">Source<select value={provider.id} onChange={event=>{setProviderId(event.target.value);setCriteria(defaultCriteria(configured.find(item=>item.id===event.target.value)!.capabilities))}}>{configured.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          :<span className="soft-tag">Source · {provider.label}</span>}
      </div>
      <fieldset className="dv-section" disabled={searching}>
        <legend><span className="dv-step">1</span> Business type</legend>
        <div className="dv-row">
          <label>Industry or niche<select value={criteria.category} onChange={event=>set({category:event.target.value})}>{capabilities.categories.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}{capabilities.customKeyword&&<option value="custom">Custom niche…</option>}</select></label>
          {criteria.category==='custom'&&<label>Custom niche<input value={criteria.keyword} maxLength={60} placeholder="e.g. yoga studio" aria-describedby="dv-keyword-help" onChange={event=>set({keyword:event.target.value})}/><small id="dv-keyword-help" className="field-help">Matched against business names.</small></label>}
        </div>
      </fieldset>
      <fieldset className="dv-section" disabled={searching}>
        <legend><span className="dv-step">2</span> Locations</legend>
        <ol className="dv-locations">
          {criteria.locations.map((location,index)=><li key={index} className="dv-location">
            <label>Country<select value={location.country} onChange={event=>setLocation(index,{country:event.target.value})}>{capabilities.countries.map(code=><option key={code} value={code}>{countryName(code)}</option>)}</select></label>
            <label>City or town<input value={location.city} maxLength={80} autoComplete="off" onChange={event=>setLocation(index,{city:event.target.value})}/></label>
            <label>{location.country==='US'?'State':location.country==='AU'?'State or territory':'County or region'} <span className="muted">(optional)</span><input value={location.region} maxLength={80} autoComplete="off" onChange={event=>setLocation(index,{region:event.target.value})}/></label>
            <label>{location.country==='US'?'ZIP code':'Postcode'} <span className="muted">(optional)</span><input value={location.postcode} maxLength={12} autoComplete="off" onChange={event=>setLocation(index,{postcode:event.target.value})}/></label>
            {criteria.locations.length>1&&<button type="button" className="icon-button dv-remove" aria-label={`Remove location ${index+1}`} onClick={()=>set({locations:criteria.locations.filter((_,position)=>position!==index)})}>✕</button>}
          </li>)}
        </ol>
        <div className="dv-location-foot">
          {criteria.locations.length<capabilities.maxLocations&&<button type="button" className="text-button" onClick={()=>set({locations:[...criteria.locations,{...emptyLocation,country:criteria.locations.at(-1)?.country??'US'}]})}><Icon name="plus" size={14}/> Add another location</button>}
          <small className="field-help">A postcode searches around that point; a city searches inside its boundary where one is mapped.</small>
        </div>
      </fieldset>
      <fieldset className="dv-section" disabled={searching}>
        <legend><span className="dv-step">3</span> Refine <span className="muted">(optional)</span></legend>
        <div className="dv-row dv-refine">
          {capabilities.filters.length>0&&<div className="dv-checks" role="group" aria-label="Contact details">{capabilities.filters.map(filter=><label key={filter} className="dv-check"><input type="checkbox" checked={criteria.require.includes(filter)} onChange={event=>set({require:event.target.checked?[...criteria.require,filter]:criteria.require.filter(item=>item!==filter)})}/>{filterLabels[filter]}</label>)}</div>}
          <label>Radius<select value={criteria.radiusKm} onChange={event=>set({radiusKm:Number(event.target.value)})}>{[1,3,5,10,25,50].map(km=><option key={km} value={km}>{km} km</option>)}</select></label>
          <label>Results per location<select value={criteria.limit} onChange={event=>set({limit:Number(event.target.value)})}>{[25,50,100].filter(value=>value<=capabilities.maxResultsPerLocation).map(value=><option key={value} value={value}>Up to {value}</option>)}</select></label>
        </div>
      </fieldset>
      {formError&&<p className="field-error dv-form-error" role="alert">{formError}</p>}
      <div className="dv-form-foot">
        <details className="dv-notes"><summary>About this source</summary><ul>{capabilities.notes.map(note=><li key={note}>{note}</li>)}</ul></details>
        <button className="primary" disabled={searching}><Icon name="search" size={16}/> {searching?'Searching…':'Find businesses'}</button>
      </div>
    </form>
    <div aria-live="polite">
      {run.status==='searching'&&<section className="panel dv-progress" role="status"><span className="dv-spinner" aria-hidden="true"/><div><strong>Searching {provider.label}…</strong><p>Looking for {criteriaSummary(run.criteria,provider)}. Large areas can take up to a minute.</p></div><i className="dv-progress-bar" aria-hidden="true"/></section>}
      {run.status==='error'&&<section className="panel dv-problem" role="alert">
        <div><strong>{run.error.status===429?'Too many searches right now':run.error.status===422?'We couldn’t run that search':'The search didn’t finish'}</strong><p>{run.error.message}{run.error.retryAfter?` Try again in about ${run.error.retryAfter} seconds.`:''}</p></div>
        {run.error.status!==422&&run.error.status!==403&&<button className="secondary" onClick={()=>void search(run.criteria)}>Try again</button>}
      </section>}
    </div>
    {run.status==='done'&&<Results key={run.result.searchId} workspace={workspace} result={run.result} provider={provider} leads={leads} origins={origins} blocked={blocked} onImported={onImported}/>}
  </>
}

const rowsPerPage=25
const contactLinks=(business:DiscoveredBusiness)=>[business.website&&'website',business.phone&&'phone',business.email&&'email'].filter(Boolean) as ContactFilter[]
function DuplicateBadge({match}:{match:DuplicateMatch|null}){
  if(!match)return <span className="dv-badge dv-new">New</span>
  return <span className={`dv-badge ${match.blocking?'dv-existing':'dv-possible'}`} title={reasonLabels[match.reason]}>{match.blocking?'In LeadFlow':'Possible duplicate'}</span>
}
function Results({workspace,result,provider,leads,origins,blocked,onImported}:{workspace:WorkspaceSummary;result:SearchResult;provider:ProviderStatus;leads:Lead[];origins:LeadOrigin[];blocked:boolean;onImported:(message:string)=>Promise<void>}){
  const [selected,setSelected]=useState<Set<string>>(new Set()),[excluded,setExcluded]=useState<Set<string>>(new Set())
  const [query,setQuery]=useState(''),[contact,setContact]=useState<ContactFilter|'any'>('any'),[sort,setSort]=useState<Sort>('name'),[hideExisting,setHideExisting]=useState(false),[showExcluded,setShowExcluded]=useState(false)
  const [page,setPage]=useState(1),[detail,setDetail]=useState<DiscoveredBusiness|null>(null)
  const [review,setReview]=useState<{clear:DiscoveredBusiness[];possible:DiscoveredBusiness[];allowed:Set<string>}|null>(null)
  const [pending,setPending]=useState<Pending|null>(null),[importing,setImporting]=useState(false),[importError,setImportError]=useState(''),[summary,setSummary]=useState<{imported:number;skipped:ImportResult['skipped']}|null>(null)
  const matches=useMemo(()=>{const index=duplicateIndex(leads,origins);return new Map(result.results.map(business=>[business.id,index.find(asCandidate(business))]))},[leads,origins,result.results])
  const visible=result.results.filter(business=>excluded.has(business.id)===showExcluded
    &&(!hideExisting||!matches.get(business.id))
    &&(contact==='any'||!!business[contact])
    &&`${business.name} ${business.category} ${business.address} ${business.city} ${business.postcode} ${domainOf(business.website)}`.toLowerCase().includes(query.trim().toLowerCase()))
    .toSorted((a,b)=>sort==='city'?`${a.city}${a.name}`.localeCompare(`${b.city}${b.name}`):sort==='updated'?(b.sourceUpdatedAt??'').localeCompare(a.sourceUpdatedAt??''):a.name.localeCompare(b.name))
  const shown=visible.slice(0,page*rowsPerPage)
  const selectable=(business:DiscoveredBusiness)=>!matches.get(business.id)?.blocking&&!excluded.has(business.id)
  const chosen=result.results.filter(business=>selected.has(business.id)&&selectable(business))
  const allShownSelected=shown.filter(selectable).length>0&&shown.filter(selectable).every(business=>selected.has(business.id))
  const toggle=(id:string,on:boolean)=>setSelected(current=>{const next=new Set(current);if(on)next.add(id);else next.delete(id);return next})
  const exclude=(business:DiscoveredBusiness,on:boolean)=>{setExcluded(current=>{const next=new Set(current);if(on)next.add(business.id);else next.delete(business.id);return next});if(on)toggle(business.id,false)}
  function startImport(businesses:DiscoveredBusiness[]){
    setSummary(null);setImportError('')
    const possible=businesses.filter(business=>matches.get(business.id)),clear=businesses.filter(business=>!matches.get(business.id))
    if(possible.length)setReview({clear,possible,allowed:new Set()})
    else void submitImport(clear,new Set())
  }
  async function submitImport(businesses:DiscoveredBusiness[],allowed:Set<string>,retry?:Pending){
    setReview(null)
    // The database accepts up to 250 rows per request; each request keeps its ID so a retry cannot import twice.
    const work:Pending=retry??{results:[],chunks:Array.from({length:Math.ceil(businesses.length/250)},(_,index)=>({id:crypto.randomUUID(),rows:businesses.slice(index*250,index*250+250).map(business=>businessToRow(business,result.fetchedAt,allowed.has(business.id)))}))}
    if(!work.chunks.length)return
    setImporting(true);setImportError('');setPending(work)
    try{
      for(const chunk of work.chunks.slice(work.results.length)){
        const outcome=await importLeads(workspace.id,chunk.id,{method:'discovery',provider:result.provider,searchId:result.searchId,rows:chunk.rows})
        work.results.push(outcome);setPending({...work})
      }
      const imported=work.results.reduce((total,item)=>total+item.imported.length,0),skipped=work.results.flatMap(item=>item.skipped)
      setPending(null);setSelected(new Set());setSummary({imported,skipped})
      await onImported(imported?`${imported} ${imported===1?'business was':'businesses were'} added to your leads.`:'No new leads were added.')
    }catch(cause){setImportError(`${cause instanceof Error?cause.message:'The import could not be confirmed.'} Retrying is safe: anything already imported won’t be added twice.`)}
    finally{setImporting(false)}
  }
  const updated=(business:DiscoveredBusiness)=>business.sourceUpdatedAt?`Updated ${dateLabel(business.sourceUpdatedAt)}`:'Update date unknown'
  return <section className="panel dv-results" aria-labelledby="dv-results-title">
    <div className="section-heading dv-results-head">
      <div><h2 id="dv-results-title">{result.results.length} {result.results.length===1?'business':'businesses'} found <span className="number-tag">{provider.label}</span></h2>
        <p>{criteriaSummary(result.criteria,provider)} · Fetched {new Date(result.fetchedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})} · <a href={result.attribution.url} target="_blank" rel="noopener noreferrer">{result.attribution.text}</a></p></div>
    </div>
    {result.warnings.length>0&&<ul className="dv-warnings">{result.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul>}
    {summary&&<div className="dv-summary" role="status"><strong>{summary.imported?`Added ${summary.imported} to Leads.`:'Nothing new was added.'}</strong>{summary.skipped.length>0&&<> {summary.skipped.length} skipped to protect existing leads:<ul>{summary.skipped.map(item=><li key={item.key}>{result.results.find(business=>business.id===item.key)?.name??item.key} — {reasonLabels[item.reason]}</li>)}</ul></>}</div>}
    {importError&&pending&&<div className="error-banner dv-inline-error" role="alert">{importError} <button className="secondary" disabled={importing||blocked} onClick={()=>void submitImport([],new Set(),pending)}>Retry import</button></div>}
    {result.results.length===0?<div className="empty"><h3>No matching businesses</h3><p>Try a nearby city, a wider radius, a different niche, or fewer contact filters. Coverage varies by area.</p></div>:<>
      <div className="filters dv-filters">
        <label className="search"><Icon name="search" size={18}/><input aria-label="Filter results" placeholder="Filter by name, area or website…" value={query} onChange={event=>{setQuery(event.target.value);setPage(1)}}/></label>
        <select aria-label="Contact details" value={contact} onChange={event=>{setContact(event.target.value as ContactFilter|'any');setPage(1)}}><option value="any">Any contact details</option>{(['website','phone','email'] as const).filter(field=>provider.capabilities.fields.includes(field)).map(field=><option key={field} value={field}>{filterLabels[field]}</option>)}</select>
        <select aria-label="Sort results" value={sort} onChange={event=>setSort(event.target.value as Sort)}><option value="name">Name A–Z</option><option value="city">City</option><option value="updated">Recently updated</option></select>
        <label className="dv-check dv-inline"><input type="checkbox" checked={hideExisting} onChange={event=>{setHideExisting(event.target.checked);setPage(1)}}/>Hide possible matches</label>
        {(excluded.size>0||showExcluded)&&<button className="text-button" onClick={()=>{setShowExcluded(value=>!value);setPage(1)}}>{showExcluded?'Back to results':`Excluded (${excluded.size})`}</button>}
        <span className="results" role="status">{visible.length} shown</span>
      </div>
      <div className="table-scroll"><table className="dv-table">
        <thead><tr><th className="dv-select"><input type="checkbox" aria-label="Select all shown businesses" checked={allShownSelected} disabled={showExcluded} onChange={event=>setSelected(current=>{const next=new Set(current);for(const business of shown.filter(selectable)){if(event.target.checked)next.add(business.id);else next.delete(business.id)}return next})}/></th><th>Business</th><th>Contact</th><th>Location</th><th>Data</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{shown.map(business=>{const match=matches.get(business.id)??null;const website=normalizeWebsite(business.website);return <tr key={business.id} className={selected.has(business.id)?'dv-selected':undefined}>
          <td className="dv-select"><input type="checkbox" aria-label={`Select ${business.name}`} checked={selected.has(business.id)} disabled={!selectable(business)} onChange={event=>toggle(business.id,event.target.checked)}/></td>
          <td data-label="Business"><button className="dv-name" onClick={()=>setDetail(business)}><strong>{business.name}</strong><small>{business.category}</small></button></td>
          <td data-label="Contact"><div className="dv-contacts">{website&&<a href={website} target="_blank" rel="noopener noreferrer nofollow">{domainOf(website)}</a>}{business.phone&&<span>{business.phone}</span>}{business.email&&<span>{business.email}</span>}{!contactLinks(business).length&&<span className="muted">No public contact details</span>}</div></td>
          <td data-label="Location">{[business.address,business.city,business.postcode].filter(Boolean).join(', ')||<span className="muted">{business.matchedLocation}</span>}</td>
          <td data-label="Data"><DuplicateBadge match={match}/><small className="dv-fresh">{updated(business)}</small></td>
          <td className="dv-actions"><button className="text-button" onClick={()=>setDetail(business)}>Details</button><button className="text-button" onClick={()=>exclude(business,!excluded.has(business.id))}>{excluded.has(business.id)?'Restore':'Exclude'}</button></td>
        </tr>})}</tbody>
      </table>{visible.length===0&&<div className="empty"><h3>Nothing matches these filters</h3><p>Clear the filter or show excluded businesses.</p></div>}</div>
      {shown.length<visible.length&&<div className="dv-more"><button className="secondary" onClick={()=>setPage(value=>value+1)}>Show {Math.min(rowsPerPage,visible.length-shown.length)} more</button></div>}
      <div className={`dv-actionbar${chosen.length?' visible':''}`} aria-hidden={!chosen.length}>
        <span><strong>{chosen.length}</strong> selected</span>
        <button className="text-button" tabIndex={chosen.length?0:-1} onClick={()=>setSelected(new Set())}>Clear</button>
        <button className="primary" tabIndex={chosen.length?0:-1} disabled={!chosen.length||importing||blocked} onClick={()=>startImport(chosen)}>{importing?`Adding${pending?` ${Math.min(pending.results.length*250,chosen.length)}/${chosen.length}`:''}…`:`Add ${chosen.length} to LeadFlow`}</button>
      </div>
      {blocked&&chosen.length>0&&<p className="muted dv-blocked">Finish or discard the unsaved change above before importing.</p>}
    </>}
    {detail&&!review&&<Modal title={detail.name} onClose={()=>setDetail(null)}>
      <BusinessDetail business={detail} match={matches.get(detail.id)??null} attribution={result.attribution} fields={provider.capabilities.fields}/>
      <div className="modal-actions"><button className="secondary" onClick={()=>{exclude(detail,!excluded.has(detail.id));setDetail(null)}}>{excluded.has(detail.id)?'Restore to results':'Exclude from results'}</button>
        <button className="primary" disabled={!selectable(detail)||importing||blocked} onClick={()=>{const business=detail;setDetail(null);startImport([business])}}>{matches.get(detail.id)?.blocking?'Already in LeadFlow':'Add to LeadFlow'}</button></div>
    </Modal>}
    {review&&<Modal title="Review possible duplicates" onClose={()=>setReview(null)}>
      <p className="modal-intro">These businesses look like leads you already have. Existing leads are never changed. Tick a business to add it as a separate lead anyway.</p>
      <ul className="dv-review">{review.possible.map(business=>{const match=matches.get(business.id)!;return <li key={business.id}><label className="dv-check"><input type="checkbox" checked={review.allowed.has(business.id)} onChange={event=>setReview(current=>{if(!current)return current;const allowed=new Set(current.allowed);if(event.target.checked)allowed.add(business.id);else allowed.delete(business.id);return {...current,allowed}})}/><span><strong>{business.name}</strong><small>{reasonLabels[match.reason]}{match.lead?`: ${match.lead.name}${match.lead.company&&match.lead.company!==match.lead.name?` · ${match.lead.company}`:''}`:''}</small></span></label></li>})}</ul>
      <div className="modal-actions"><button className="secondary" onClick={()=>setReview(null)}>Cancel</button><button className="primary" disabled={!review.clear.length&&!review.allowed.size} onClick={()=>void submitImport([...review.clear,...review.possible.filter(business=>review.allowed.has(business.id))],review.allowed)}>Add {review.clear.length+review.allowed.size} to LeadFlow</button></div>
    </Modal>}
  </section>
}

function CopyButton({value,label}:{value:string;label:string}){
  const [state,setState]=useState<'idle'|'copied'|'failed'>('idle')
  return <button type="button" className="text-button dv-copy" aria-label={`Copy ${label}`} onClick={async()=>{try{await navigator.clipboard.writeText(value);setState('copied')}catch{setState('failed')}window.setTimeout(()=>setState('idle'),1800)}}>{state==='copied'?'Copied':state==='failed'?'Copy failed':'Copy'}</button>
}
function BusinessDetail({business,match,attribution,fields}:{business:DiscoveredBusiness;match:DuplicateMatch|null;attribution:SearchResult['attribution'];fields:string[]}){
  const website=normalizeWebsite(business.website)
  const address=[business.address,business.city,business.region,business.postcode,countryName(business.country)].filter(Boolean).join(', ')
  const rows:[string,string,ReactNode][]=[
    ['category','Category',business.category],
    ['website','Website',website?<><a href={website} target="_blank" rel="noopener noreferrer nofollow">{website}</a><CopyButton value={website} label="website"/></>:''],
    ['phone','Phone',business.phone?<><a href={`tel:${business.phone.replace(/[^+\d]/g,'')}`}>{business.phone}</a><CopyButton value={business.phone} label="phone number"/></>:''],
    ['email','Email',business.email?<><a href={`mailto:${business.email}`}>{business.email}</a><CopyButton value={business.email} label="email address"/></>:''],
    ['address','Address',address?<>{address}<CopyButton value={address} label="address"/></>:''],
  ]
  return <div className="dv-detail">
    {match&&<p className={`dv-match ${match.blocking?'dv-existing':'dv-possible'}`}>{reasonLabels[match.reason]}{match.lead?`: ${match.lead.name}`:''}.</p>}
    <dl>{rows.filter(([field])=>fields.includes(field)).map(([field,label,value])=><div key={field}><dt>{label}</dt><dd>{value||<span className="muted">Not provided by this source</span>}</dd></div>)}
      <div><dt>Data freshness</dt><dd>{business.sourceUpdatedAt?`Source record last updated ${dateLabel(business.sourceUpdatedAt)}`:'The source doesn’t say when this record was last updated'}</dd></div>
      <div><dt>Source</dt><dd>{business.sourceUrl?<a href={business.sourceUrl} target="_blank" rel="noopener noreferrer">View the source record</a>:business.provider} · <a href={attribution.url} target="_blank" rel="noopener noreferrer">{attribution.text}</a></dd></div>
    </dl>
    <p className="muted dv-verify">Check details with the business before contacting them; directory data can be incomplete or out of date.</p>
  </div>
}
