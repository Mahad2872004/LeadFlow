import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { accountLabel, apolloExport, apolloLeft, apolloReveal, apolloSave, apolloSearch, ApolloRequestError, contactsFor, contactsForMany, createLeadList, organizationRow, personRow, remainingOf, saveSearch,
  type ApolloAccount, type Contact, type FilterValues, type LeadList, type Organization, type Person, type ResultPage, type SearchKind } from '../lib/apollo'
import { compactFilters } from '../lib/apolloFilters'
import { organizationsExport, peopleExport, peopleFromExport } from '../lib/apolloExport'
import { downloadCsv, maxCsvBytes, parseCsv, toCsv } from '../lib/csv'
import { domainOf, type LeadOrigin } from '../lib/discovery'
import { dateLabel } from '../lib/format'
import type { Lead } from '../lib/model'
import { ApolloFilters } from './ApolloFilters'
import { Icon } from './Icon'
import { Modal } from './Modal'

type Item = Person | Organization
type Column = { id: string; label: string; sort?: (item: Item) => string; render: (item: Item) => ReactNode }
type Problem = { message: string; retry?: () => void }
type Row = { label: string; value: ReactNode }
interface SearchProps {
  kind: SearchKind; workspace: WorkspaceSummary; account: ApolloAccount; phoneReveal: boolean; leads: Lead[]; origins: LeadOrigin[]; lists: LeadList[]; blocked: boolean
  /** Filters to start from (a saved or past search). The parent remounts this component to load others. */
  initial: FilterValues | null
  onChanged: () => void
  onImported: (message: string) => Promise<void>
  onListsChanged: () => void
}
const storageKey = (kind: SearchKind) => `leadflow.apollo.columns.${kind}`
const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size))
/** People or company search with Apollo: filters, results, reveals and saving to leads. */
export function ApolloSearch({kind,workspace,account,phoneReveal,leads,origins,lists,blocked,initial,onChanged,onImported,onListsChanged}:SearchProps){
  const [filters,setFilters]=useState<FilterValues>(initial??{})
  const [applied,setApplied]=useState<{filters:FilterValues;searchId:string}|null>(null)
  const [result,setResult]=useState<ResultPage<Item>|null>(null),[loading,setLoading]=useState(false),[problem,setProblem]=useState<Problem|null>(null)
  const [perPage,setPerPage]=useState(25),[confirm,setConfirm]=useState<{page:number;filters:FilterValues;searchId:string|null;refresh:boolean}|null>(null),[hideSaved,setHideSaved]=useState(false)
  const lastKey=`leadflow.apollo.last.${workspace.id}.${kind}`
  const fileInput=useRef<HTMLInputElement>(null)
  const [selected,setSelected]=useState<Set<string>>(new Set()),[contacts,setContacts]=useState<Map<string,Contact>>(new Map())
  const [query,setQuery]=useState(''),[sort,setSort]=useState<{column:string;dir:1|-1}|null>(null),[detail,setDetail]=useState<Item|null>(null)
  const [modal,setModal]=useState<'reveal'|'save'|'saveSearch'|'columns'|null>(null),[notice,setNotice]=useState('')
  const [hidden,setHidden]=useState<Set<string>>(()=>{try{return new Set(JSON.parse(localStorage.getItem(storageKey(kind))??'[]'))}catch{return new Set()}})
  const [phonesWaiting,setPhonesWaiting]=useState<{ids:string[];since:number}|null>(null)
  const people=kind==='people'
  // Reveal and save batches keep their IDs until they succeed, so retrying never charges or saves twice.
  const pendingReveal=useRef<{batches:{operationId:string;people:{id:string;name:string}[];done:boolean}[];phone:boolean}|null>(null)
  const pendingSave=useRef<{batches:{requestId:string;rows:ReturnType<typeof personRow>[];done:boolean}[];listId:string|null}|null>(null)

  const saved=useMemo(()=>new Set(origins.filter(origin=>origin.provider===(people?'apollo_people':'apollo_organizations')).map(origin=>origin.providerRef??'')),[origins,people])
  const leadDomains=useMemo(()=>new Set(leads.map(lead=>domainOf(lead.website??'')).filter(Boolean)),[leads])
  const inLeadFlow=(item:Item)=>saved.has(people?`person:${item.id}`:`org:${item.id}`)||(!people&&leadDomains.has(domainOf((item as Organization).websiteUrl||(item as Organization).primaryDomain)))

  // Revealed details already in this workspace, for the people on this page.
  useEffect(()=>{
    if(!people||!result)return
    let active=true
    contactsFor(workspace.id,result.items.map(item=>item.id)).then(found=>{if(active)setContacts(current=>{const next=new Map(current);for(const contact of found)next.set(contact.id,contact);return next})}).catch(()=>{})
    return()=>{active=false}
  },[people,result,workspace.id])
  // Phone numbers arrive from Apollo minutes later; check every 15 seconds for up to 10 minutes.
  useEffect(()=>{
    if(!phonesWaiting)return
    const timer=window.setInterval(async()=>{
      try{
        const found=await contactsFor(workspace.id,phonesWaiting.ids)
        setContacts(current=>{const next=new Map(current);for(const contact of found)next.set(contact.id,contact);return next})
        const open=phonesWaiting.ids.filter(id=>!found.find(contact=>contact.id===id)?.phoneRevealedAt)
        if(!open.length){setPhonesWaiting(null);setNotice('Phone lookups finished.');onChanged()}
        else if(Date.now()-phonesWaiting.since>600000){setPhonesWaiting(null);setNotice('Apollo is still working on some phone numbers. They’ll appear here and in Credits & accounts when they arrive.')}
      }catch{/* Try again on the next tick. */}
    },15000)
    return()=>window.clearInterval(timer)
  },[phonesWaiting,workspace.id,onChanged])

  // Saved pages come back free. Only when Apollo has to be asked does company search stop for the 1-credit confirmation.
  async function run(page:number,useFilters:FilterValues,searchId:string|null,{confirmed=false,refresh=false}={}){
    setConfirm(null);setLoading(true);setProblem(null);setNotice('')
    try{
      const next=await apolloSearch(workspace.id,{kind,accountId:account.id,filters:useFilters,page,perPage,...(searchId?{searchId}:{}),...(refresh?{refresh:true}:{}),...(!people&&confirmed?{operationId:crypto.randomUUID(),confirmCredits:true}:{})})
      setResult(next as ResultPage<Item>);setSelected(new Set());setQuery('');setSort(null)
      setApplied(current=>({filters:useFilters,searchId:searchId??current?.searchId??''}))
      try{localStorage.setItem(lastKey,JSON.stringify({filters:useFilters,page,perPage}))}catch{/* optional */}
      if(!next.saved)onChanged()
    }catch(cause){
      const error=cause instanceof ApolloRequestError?cause:new ApolloRequestError('The search didn’t finish.',0)
      if(error.code==='confirm_credits'){setConfirm({page,filters:useFilters,searchId,refresh});return}
      setProblem({message:`${error.message}${error.retryAfter?` Try again in about ${error.retryAfter} seconds.`:''}`,retry:error.status===422||error.status===402?undefined:()=>void run(page,useFilters,searchId,{confirmed:!people,refresh})})
      if(!people)onChanged()
    }finally{setLoading(false)}
  }
  // Coming back to this tab shows the last results again, from saved pages only: this never calls Apollo.
  const restored=useRef(false)
  useEffect(()=>{
    if(restored.current||initial)return
    restored.current=true
    let last:{filters:FilterValues;page:number;perPage:number}|null=null
    try{last=JSON.parse(localStorage.getItem(lastKey)??'null')}catch{/* optional */}
    if(!last?.filters)return
    const saved=last
    setFilters(saved.filters);setPerPage(saved.perPage)
    apolloSearch(workspace.id,{kind,accountId:account.id,filters:saved.filters,page:saved.page,perPage:saved.perPage,savedOnly:true}).then(next=>{
      if(!next.missing){setResult(next as ResultPage<Item>);setApplied({filters:saved.filters,searchId:''})}
    }).catch(()=>{/* Nothing saved to show. */})
  },[initial,lastKey,workspace.id,kind,account.id])
  function startSearch(){const clean=compactFilters(filters);if(!Object.keys(clean).length){setProblem({message:'Choose at least one filter.'});return}void run(1,clean,crypto.randomUUID())}
  const goTo=(page:number)=>applied&&void run(page,applied.filters,null)
  // Everything Apollo found in this workspace (saved result pages) with every revealed email and phone, as CSV.
  async function exportAll(){
    setLoading(true);setProblem(null);setNotice('')
    try{
      const found=await apolloExport(workspace.id,kind)
      const rows=people?peopleExport(found.items as Person[],found.contacts,id=>saved.has(`person:${id}`)):organizationsExport(found.items as Organization[],org=>inLeadFlow(org))
      if(rows.length<2){setNotice(`Nothing to export yet. Search for ${people?'people':'companies'} first.`);return}
      downloadCsv(`apollo-${people?'people':'companies'}-${new Date().toISOString().slice(0,10)}.csv`,toCsv(rows))
      const revealed=people?found.contacts.filter(contact=>contact.email||contact.phones.length).length:0
      setNotice(`Exported ${rows.length-1} ${people?'people':'companies'}${people?`, ${revealed} with revealed contact details`:''}.${found.items.length>=found.limit?` Only the newest ${found.limit.toLocaleString()} are included.`:''}`)
    }catch(cause){setProblem({message:cause instanceof Error?cause.message:'The export couldn’t be prepared.'})}
    finally{setLoading(false)}
  }
  // A LeadFlow export opened again: its people load with their current reveal status, without searching or using credits.
  async function openExport(file:File){
    setLoading(true);setProblem(null);setNotice('')
    try{
      if(file.size>maxCsvBytes*5)throw new Error('This file is larger than 10 MB.')
      const items=peopleFromExport(parseCsv(await file.text())).slice(0,5000)
      if(!items.length)throw new Error('No Apollo person IDs were found in this file.')
      const found=await contactsForMany(workspace.id,items.map(item=>item.id))
      setContacts(current=>{const next=new Map(current);for(const contact of found)next.set(contact.id,contact);return next})
      setResult({kind,accountId:account.id,searchId:null,fetchedAt:new Date().toISOString(),filters:{},items,page:1,perPage:items.length,total:items.length,totalPages:1,fromFile:file.name})
      setApplied(null);setSelected(new Set());setQuery('');setSort(null)
      const open=items.filter(item=>!found.some(contact=>contact.id===item.id&&contact.emailRevealedAt)).length
      setNotice(`Loaded ${items.length} ${items.length===1?'person':'people'} from ${file.name}. ${open} not revealed yet.`)
    }catch(cause){setProblem({message:cause instanceof Error?cause.message:'This file couldn’t be read.'})}
    finally{setLoading(false);if(fileInput.current)fileInput.current.value=''}
  }
  const alreadyRevealed=(id:string,phone:boolean)=>{const contact=contacts.get(id);return !!contact?.emailRevealedAt&&(!phone||!!contact.phoneRequestedAt)}

  async function reveal(phone:boolean,retry=false){
    if(!retry){
      const chosen=((result?.items??[]).filter(item=>selected.has(item.id)) as Person[]).filter(person=>!alreadyRevealed(person.id,phone))
      if(!chosen.length){setModal(null);setNotice('Everyone selected is already revealed. No credits used.');setSelected(new Set());return}
      pendingReveal.current={phone,batches:chunk(chosen.map(person=>({id:person.id,name:person.name})),10).map(batch=>({operationId:crypto.randomUUID(),people:batch,done:false}))}
    }
    const work=pendingReveal.current!
    setModal(null);setLoading(true);setProblem(null)
    let matched=0,credits=0
    try{
      for(const batch of work.batches.filter(item=>!item.done)){
        const outcome=await apolloReveal(workspace.id,{accountId:account.id,operationId:batch.operationId,people:batch.people,phone:work.phone})
        const known=new Set(outcome.alreadyRevealed??[])
        batch.done=true;matched+=outcome.contacts.filter(contact=>!known.has(contact.id)).length;credits+=outcome.credits??0
        const stamp=new Date().toISOString()
        // The response has the details; the reveal times are known here, and a phone lookup is now under way.
        setContacts(current=>{const next=new Map(current);for(const contact of outcome.contacts){const before=current.get(contact.id);next.set(contact.id,{...before,...contact,phones:contact.phones.length?contact.phones:before?.phones??[],
          emailRevealedAt:contact.emailRevealedAt??stamp,phoneRequestedAt:contact.phoneRequestedAt??(outcome.phonePending?stamp:before?.phoneRequestedAt??null),phoneRevealedAt:contact.phoneRevealedAt??(outcome.phonePending?null:before?.phoneRevealedAt??null)})}return next})
        if(outcome.phonePending)setPhonesWaiting(current=>({ids:[...new Set([...(current?.ids??[]),...outcome.contacts.filter(contact=>!known.has(contact.id)).map(contact=>contact.id)])],since:current?.since??Date.now()}))
      }
      const total=work.batches.reduce((sum,batch)=>sum+batch.people.length,0)
      setNotice(`Revealed ${matched} of ${total}${credits?` · ${credits} credit${credits===1?'':'s'} used`:''}.${work.phone&&matched?' Phone numbers usually arrive within a few minutes.':''}`)
      pendingReveal.current=null;setSelected(new Set())
    }catch(cause){
      const error=cause instanceof ApolloRequestError?cause:new ApolloRequestError('The reveal didn’t finish.',0)
      setProblem({message:`${error.message}${error.status===402?'':' Retrying is safe: finished batches aren’t sent again and nothing is charged twice.'}`,retry:error.status===402?undefined:()=>void reveal(work.phone,true)})
    }finally{setLoading(false);onChanged()}
  }

  async function save(listChoice:{listId:string|null;newName:string},retry=false){
    if(!retry){
      const now=new Date().toISOString()
      const chosen=(result?.items??[]).filter(item=>selected.has(item.id)&&!inLeadFlow(item))
      const rows=chosen.map(item=>people?personRow(item as Person,contacts.get(item.id),now):organizationRow(item as Organization,now))
      pendingSave.current={listId:listChoice.listId,batches:chunk(rows,250).map(batch=>({requestId:crypto.randomUUID(),rows:batch,done:false}))}
    }
    const work=pendingSave.current!
    setModal(null);setLoading(true);setProblem(null)
    try{
      if(!retry&&listChoice.newName.trim()){work.listId=await createLeadList(workspace.id,listChoice.newName.trim());onListsChanged()}
      let imported=0,skipped=0,listed=0
      for(const batch of work.batches.filter(item=>!item.done)){
        const outcome=await apolloSave(workspace.id,{accountId:account.id,kind,requestId:batch.requestId,searchId:applied?.searchId??null,listId:work.listId,rows:batch.rows})
        batch.done=true;imported+=outcome.imported.length;skipped+=outcome.skipped.length;listed+=outcome.listed
      }
      pendingSave.current=null;setSelected(new Set())
      const list=lists.find(item=>item.id===work.listId)?.name??listChoice.newName.trim()
      setNotice(`${imported} saved to Leads${listed&&list?` and added to “${list}”`:''}.${skipped?` ${skipped} skipped to protect existing leads.`:''}`)
      if(work.listId)onListsChanged()
      await onImported(`${imported} ${imported===1?'lead was':'leads were'} saved from Apollo.`)
    }catch(cause){
      setProblem({message:`${cause instanceof Error?cause.message:'Saving didn’t finish.'} Retrying is safe: nothing is saved twice.`,retry:()=>void save(listChoice,true)})
    }finally{setLoading(false)}
  }

  const contactOf=(item:Item)=>people?contacts.get(item.id):undefined
  const emailCell=(person:Person)=>{const contact=contactOf(person);return contact?.email?<a href={`mailto:${contact.email}`}>{contact.email}</a>:contact?.emailRevealedAt?<span className="muted">No email found</span>:person.hasEmail?<span className="ap-lock">Available · locked</span>:<span className="muted">Not available</span>}
  const phoneCell=(person:Person)=>{const contact=contactOf(person);const number=contact?.phones[0]?.number
    return number?<a href={`tel:${number}`}>{number}</a>:contact?.phoneRequestedAt&&!contact.phoneRevealedAt?<span className="ap-pending">Looking up…</span>:contact?.phoneRevealedAt?<span className="muted">No number found</span>
      :person.directPhone==='yes'?<span className="ap-lock">Direct phone · locked</span>:person.directPhone==='maybe'?<span className="ap-lock">Maybe · locked</span>:<span className="muted">Not available</span>}
  const columns:Column[]=people?[
    {id:'name',label:'Name',sort:item=>contactOf(item)?.name||(item as Person).name,render:item=><button className="dv-name" onClick={()=>setDetail(item)}><strong>{contactOf(item)?.name||(item as Person).name}</strong><small>{(item as Person).title||'No title listed'}</small></button>},
    {id:'company',label:'Company',sort:item=>(item as Person).organizationName,render:item=>(item as Person).organizationName||<span className="muted">—</span>},
    {id:'website',label:'Website',render:item=>{const domain=contactOf(item)?.organizationDomain;return domain?<a href={`https://${domain}`} target="_blank" rel="noopener noreferrer nofollow">{domain}</a>:<span className="muted">{contactOf(item)?.emailRevealedAt?'Not provided':'After reveal'}</span>}},
    {id:'email',label:'Email',render:item=>emailCell(item as Person)},
    {id:'phone',label:'Phone',render:item=>phoneCell(item as Person)},
    {id:'location',label:'Location',render:item=>{const contact=contactOf(item);const place=[contact?.city,contact?.state,contact?.country].filter(Boolean).join(', ');return place||((item as Person).hasCity||(item as Person).hasCountry?<span className="ap-lock">On record · locked</span>:<span className="muted">—</span>)}},
    {id:'linkedin',label:'LinkedIn',render:item=>{const url=contactOf(item)?.linkedinUrl;return url?<a href={url} target="_blank" rel="noopener noreferrer nofollow">Profile</a>:<span className="muted">{contactOf(item)?.emailRevealedAt?'Not provided':'After reveal'}</span>}},
    {id:'refreshed',label:'Apollo updated',sort:item=>(item as Person).lastRefreshedAt??'',render:item=>(item as Person).lastRefreshedAt?dateLabel((item as Person).lastRefreshedAt!):<span className="muted">—</span>},
    {id:'status',label:'LeadFlow',render:item=>inLeadFlow(item)?<span className="dv-badge dv-existing">In LeadFlow</span>:<span className="dv-badge dv-new">New</span>},
  ]:[
    {id:'name',label:'Company',sort:item=>item.name,render:item=><button className="dv-name" onClick={()=>setDetail(item)}><strong>{item.name}</strong><small>{(item as Organization).primaryDomain||'No domain listed'}</small></button>},
    {id:'website',label:'Website',render:item=>{const url=(item as Organization).websiteUrl;return /^https?:\/\//.test(url)?<a href={url} target="_blank" rel="noopener noreferrer nofollow">{domainOf(url)||url}</a>:<span className="muted">—</span>}},
    {id:'phone',label:'Phone',render:item=>(item as Organization).phone||<span className="muted">—</span>},
    {id:'linkedin',label:'LinkedIn',render:item=>{const url=(item as Organization).linkedinUrl;return url?<a href={url} target="_blank" rel="noopener noreferrer nofollow">Company page</a>:<span className="muted">—</span>}},
    {id:'founded',label:'Founded',sort:item=>String((item as Organization).foundedYear??''),render:item=>(item as Organization).foundedYear??<span className="muted">—</span>},
    {id:'codes',label:'NAICS / SIC',render:item=>[...(item as Organization).naicsCodes,...(item as Organization).sicCodes].slice(0,4).join(', ')||<span className="muted">—</span>},
    {id:'status',label:'LeadFlow',render:item=>inLeadFlow(item)?<span className="dv-badge dv-existing">In LeadFlow</span>:<span className="dv-badge dv-new">New</span>},
  ]
  const shownColumns=columns.filter(column=>!hidden.has(column.id)||column.id==='name')
  const items=(result?.items??[]).filter(item=>!hideSaved||!inLeadFlow(item)).filter(item=>{const text=`${item.name} ${people?`${(item as Person).title} ${(item as Person).organizationName} ${contactOf(item)?.name??''} ${contactOf(item)?.email??''}`:(item as Organization).primaryDomain}`.toLowerCase();return text.includes(query.trim().toLowerCase())})
  const sortColumn=columns.find(column=>column.id===sort?.column)
  const visible=sortColumn?.sort?items.toSorted((a,b)=>sortColumn.sort!(a).localeCompare(sortColumn.sort!(b))*sort!.dir):items
  const chosen=(result?.items??[]).filter(item=>selected.has(item.id))
  const revealable=people?(chosen as Person[]):[]
  const savable=chosen.filter(item=>!inLeadFlow(item))
  const allSelected=visible.length>0&&visible.every(item=>selected.has(item.id))
  const remaining=remainingOf(account)
  const toggleColumn=(id:string)=>setHidden(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);try{localStorage.setItem(storageKey(kind),JSON.stringify([...next]))}catch{/* optional */}return next})

  return <div className="ap-layout">
    <aside className="panel ap-sidebar" aria-label={`${people?'People':'Company'} filters`}>
      <ApolloFilters kind={kind} filters={filters} onChange={setFilters}/>
      <div className="ap-sidebar-foot">
        <label className="ap-perpage">Results per page<select value={perPage} onChange={event=>setPerPage(Number(event.target.value))}>{[10,25,50,100].map(value=><option key={value}>{value}</option>)}</select></label>
        <button className="primary" disabled={loading} onClick={startSearch}><Icon name="search" size={16}/> {loading?'Working…':people?'Search people':'Search companies'}</button>
        <button className="text-button" disabled={!Object.keys(compactFilters(filters)).length} onClick={()=>setModal('saveSearch')}>Save these filters</button>
        {!people&&<p className="ap-help">Company search uses 1 Apollo credit per page of results. You’ll confirm each page.</p>}
      </div>
    </aside>
    <section className="panel ap-results" aria-labelledby={`ap-results-${kind}`} aria-busy={loading}>
      <div className="section-heading"><div><h2 id={`ap-results-${kind}`}>{result?`${result.total.toLocaleString()} ${people?(result.total===1?'person':'people'):(result.total===1?'company':'companies')} found`:people?'Find people':'Find companies'}</h2>
        <p>{result?`From Apollo · account ${accountLabel(account)} · fetched ${new Date(result.fetchedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}${result.total>50000?' · Apollo shows the first 50,000':''}`
          :people?'People search is free. Names, emails and phone numbers stay hidden until you reveal them, which uses credits.':'Search companies by industry, size, location, technology and funding.'}</p></div>
        <div className="ap-head-actions">
          {result&&<button className="text-button" onClick={()=>setModal('columns')}>Columns</button>}
          <button className="text-button" disabled={loading} onClick={()=>void exportAll()}>Export all found (CSV)</button>
          {people&&<><button className="text-button" disabled={loading} onClick={()=>fileInput.current?.click()}>Open an export</button>
            <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Open a LeadFlow Apollo export" tabIndex={-1} onChange={event=>{const file=event.target.files?.[0];if(file)void openExport(file)}}/></>}
        </div>
      </div>
      <div aria-live="polite">
        {result?.fromFile&&<div className="ap-saved-note" role="status"><span>Showing {result.items.length} {result.items.length===1?'person':'people'} from {result.fromFile}. No search was run and no credits were used.</span></div>}
        {result?.saved&&<div className="ap-saved-note" role="status"><span>Saved results from {dateLabel(result.fetchedAt)}, {new Date(result.fetchedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}. No credits used.</span><button className="text-button" disabled={loading} onClick={()=>applied&&void run(result.page,applied.filters,null,{refresh:true})}>Refresh from Apollo{people?'':' (1 credit)'}</button></div>}
        {notice&&<div className="dv-summary" role="status">{notice}</div>}
        {problem&&<div className="error-banner dv-inline-error" role="alert">{problem.message}{problem.retry&&<button className="secondary" disabled={loading||blocked} onClick={problem.retry}>Try again</button>}</div>}
        {phonesWaiting&&<p className="ap-waiting" role="status"><span className="dv-spinner" aria-hidden="true"/> Waiting for Apollo to deliver {phonesWaiting.ids.length} phone {phonesWaiting.ids.length===1?'lookup':'lookups'}…</p>}
      </div>
      {loading&&!result&&<div className="content-skeleton" role="status"><span className="sr-only">Searching Apollo…</span><i className="skeleton skeleton-panel"/></div>}
      {!result&&!loading&&<div className="empty ap-empty"><h3>Choose filters, then search</h3><p>{people?'Try a job title such as “owner”, a seniority, and a location.':'Try an industry, a company size and a location.'} Save filter sets you use often.</p></div>}
      {result&&result.items.length===0&&<div className="empty"><h3>No matches</h3><p>Remove a filter or widen the location.</p></div>}
      {result&&result.items.length>0&&<>
        <div className="filters dv-filters">
          <label className="search"><Icon name="search" size={18}/><input aria-label="Search within these results" placeholder="Search within this page…" value={query} onChange={event=>setQuery(event.target.value)}/></label>
          {people&&<button className="text-button" onClick={()=>setSelected(new Set(visible.filter(item=>!alreadyRevealed(item.id,false)).map(item=>item.id)))}>Select not yet revealed</button>}
          <label className="dv-check dv-inline"><input type="checkbox" checked={hideSaved} onChange={event=>setHideSaved(event.target.checked)}/>Hide {people?'people':'companies'} already in LeadFlow</label>
          <span className="results" role="status">{visible.length} on this page</span>
        </div>
        <div className="table-scroll"><table className="dv-table ap-table">
          <thead><tr><th className="dv-select"><input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={event=>setSelected(current=>{const next=new Set(current);for(const item of visible){if(event.target.checked)next.add(item.id);else next.delete(item.id)}return next})}/></th>
            {shownColumns.map(column=><th key={column.id} aria-sort={sort?.column===column.id?(sort.dir===1?'ascending':'descending'):undefined}>{column.sort?<button className="ap-sort" onClick={()=>setSort(current=>current?.column===column.id?{column:column.id,dir:current.dir===1?-1:1}:{column:column.id,dir:1})}>{column.label}{sort?.column===column.id?(sort.dir===1?' ↑':' ↓'):''}</button>:column.label}</th>)}</tr></thead>
          <tbody>{visible.map(item=><tr key={item.id} className={selected.has(item.id)?'dv-selected':undefined}>
            <td className="dv-select"><input type="checkbox" aria-label={`Select ${contactOf(item)?.name||item.name}`} checked={selected.has(item.id)} onChange={event=>setSelected(current=>{const next=new Set(current);if(event.target.checked)next.add(item.id);else next.delete(item.id);return next})}/></td>
            {shownColumns.map(column=><td key={column.id} data-label={column.label}>{column.render(item)}</td>)}
          </tr>)}</tbody>
        </table></div>
        <nav className="ap-pager" aria-label="Result pages">
          <button className="secondary" disabled={loading||result.page<=1} onClick={()=>goTo(result.page-1)}>Previous</button>
          <span>Page {result.page} of {Math.max(result.totalPages,1).toLocaleString()}</span>
          <button className="secondary" disabled={loading||result.page>=result.totalPages} onClick={()=>goTo(result.page+1)}>Next</button>
        </nav>
        <div className={`dv-actionbar${chosen.length?' visible':''}`} aria-hidden={!chosen.length}>
          <span><strong>{chosen.length}</strong> selected</span>
          <button className="text-button" tabIndex={chosen.length?0:-1} onClick={()=>setSelected(new Set())}>Clear</button>
          {people&&<button className="secondary ap-bar-secondary" tabIndex={chosen.length?0:-1} disabled={!revealable.length||loading||blocked} onClick={()=>setModal('reveal')}>Reveal contact details</button>}
          <button className="primary" tabIndex={chosen.length?0:-1} disabled={!savable.length||loading||blocked} onClick={()=>setModal('save')}>Save {savable.length} to Leads</button>
        </div>
      </>}
    </section>

    {confirm&&<Modal title="Use 1 credit for this page?" onClose={()=>setConfirm(null)}>
      <p className="modal-intro">Apollo charges 1 credit for each page of company results, up to {perPage} companies. LeadFlow records it in the credit history.</p>
      <CreditLine account={account} needed={1}/>
      <div className="modal-actions"><button className="secondary" onClick={()=>setConfirm(null)}>Cancel</button><button className="primary" disabled={remaining<1} onClick={()=>void run(confirm.page,confirm.filters,confirm.searchId,{confirmed:true,refresh:confirm.refresh})}>Use 1 credit and search</button></div>
    </Modal>}
    {modal==='reveal'&&<RevealDialog emailCount={revealable.filter(person=>!alreadyRevealed(person.id,false)).length} phoneCount={revealable.filter(person=>!alreadyRevealed(person.id,true)).length} account={account} phoneReveal={phoneReveal} onCancel={()=>setModal(null)} onConfirm={phone=>void reveal(phone)}/>}
    {modal==='save'&&<SaveDialog count={savable.length} skipped={chosen.length-savable.length} lists={lists} people={people} revealed={savable.filter(item=>contacts.get(item.id)?.email).length} onCancel={()=>setModal(null)} onConfirm={choice=>void save(choice)}/>}
    {modal==='saveSearch'&&<SaveSearchDialog onCancel={()=>setModal(null)} onSave={async name=>{await saveSearch(workspace.id,crypto.randomUUID(),name,kind,{kind,filters:compactFilters(filters),accountId:account.id});setModal(null);setNotice(`Saved “${name}”. Find it under Saved & recent.`);onChanged()}}/>}
    {modal==='columns'&&<Modal title="Columns" onClose={()=>setModal(null)}>
      <p className="modal-intro">Choose what the table shows. Your choice is remembered on this device.</p>
      <ul className="ap-column-list">{columns.map(column=><li key={column.id}><label className="dv-check"><input type="checkbox" disabled={column.id==='name'} checked={!hidden.has(column.id)||column.id==='name'} onChange={()=>toggleColumn(column.id)}/>{column.label}</label></li>)}</ul>
      <div className="modal-actions"><button className="primary" onClick={()=>setModal(null)}>Done</button></div>
    </Modal>}
    {detail&&!modal&&<Modal title={contactOf(detail)?.name||detail.name} onClose={()=>setDetail(null)}>
      {people?<PersonDetail person={detail as Person} contact={contactOf(detail)}/>:<OrganizationDetail org={detail as Organization}/>}
      <div className="modal-actions">
        {people&&<button className="secondary" disabled={loading||blocked} onClick={()=>{setSelected(new Set([detail.id]));setDetail(null);setModal('reveal')}}>Reveal contact details</button>}
        <button className="primary" disabled={inLeadFlow(detail)||loading||blocked} onClick={()=>{setSelected(new Set([detail.id]));setDetail(null);setModal('save')}}>{inLeadFlow(detail)?'Already in LeadFlow':'Save to Leads'}</button>
      </div>
    </Modal>}
  </div>
}
function CreditLine({account,needed}:{account:ApolloAccount;needed:number}){
  const remaining=remainingOf(account),apollo=apolloLeft(account,'lead_credit')
  return <p className={`ap-credit-line${needed>remaining?' ap-short':''}`}><strong>{accountLabel(account)}:</strong> {remaining} of {account.monthlyAllowance} credits left this cycle in LeadFlow’s ledger
    {apollo!==null&&<> · Apollo reported {apollo} email credits left{account.lastSyncedAt?` (synced ${dateLabel(account.lastSyncedAt)})`:''}</>}.{needed>remaining&&' Not enough credits for this.'}</p>
}
function RevealDialog({emailCount,phoneCount,account,phoneReveal,onCancel,onConfirm}:{emailCount:number;phoneCount:number;account:ApolloAccount;phoneReveal:boolean;onCancel:()=>void;onConfirm:(phone:boolean)=>void}){
  const [phone,setPhone]=useState(false)
  // People already revealed are skipped; a phone lookup re-runs the match (1 credit) for those still without one.
  const count=phone?phoneCount:emailCount
  const most=count+(phone?count*8:0)
  return <Modal title={`Reveal ${count} ${count===1?'person':'people'}?`} onClose={onCancel}>
    <p className="modal-intro">Apollo charges only when it finds data: 1 credit for each person it matches (name, work email and profile), and up to 8 more for each mobile number it finds. Apollo’s own figures are recorded when it reports them.</p>
    <label className="dv-check ap-phone-option"><input type="checkbox" checked={phone} disabled={!phoneReveal} onChange={event=>setPhone(event.target.checked)}/>Also look up mobile numbers{!phoneReveal&&' (needs an HTTPS deployment)'}</label>
    {phone&&<p className="ap-help">Numbers arrive from Apollo within a few minutes. Plans with separate mobile credits draw on those instead.</p>}
    <dl className="ap-cost"><div><dt>Email and profile</dt><dd>up to {count} credit{count===1?'':'s'}</dd></div>{phone&&<div><dt>Mobile numbers</dt><dd>up to {count*8} credits</dd></div>}<div><dt>At most</dt><dd><strong>{most} credits</strong></dd></div></dl>
    <CreditLine account={account} needed={most}/>
    <div className="modal-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={most>remainingOf(account)} onClick={()=>onConfirm(phone)}>Reveal for up to {most} credits</button></div>
  </Modal>
}
function SaveDialog({count,skipped,lists,people,revealed,onCancel,onConfirm}:{count:number;skipped:number;lists:LeadList[];people:boolean;revealed:number;onCancel:()=>void;onConfirm:(choice:{listId:string|null;newName:string})=>void}){
  const [choice,setChoice]=useState(''),[name,setName]=useState('')
  return <Modal title={`Save ${count} to Leads`} onClose={onCancel}>
    <p className="modal-intro">{people&&revealed<count?`${count-revealed} of these haven’t been revealed, so they’re saved with the masked name and no email. Revealing later fills those in on the saved lead. `:''}Each lead records that it came from Apollo and which account found it.{skipped?` ${skipped} already in LeadFlow will be skipped.`:''}</p>
    <form onSubmit={event=>{event.preventDefault();onConfirm({listId:choice&&choice!=='new'?choice:null,newName:choice==='new'?name:''})}}>
      <label>Add to a list (optional)<select value={choice} onChange={event=>setChoice(event.target.value)}><option value="">No list</option>{lists.map(list=><option key={list.id} value={list.id}>{list.name} ({list.leadIds.length})</option>)}<option value="new">New list…</option></select></label>
      {choice==='new'&&<label>List name<input required maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></label>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary">Save {count}</button></div>
    </form>
  </Modal>
}
function SaveSearchDialog({onCancel,onSave}:{onCancel:()=>void;onSave:(name:string)=>Promise<void>}){
  const [name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  return <Modal title="Save these filters" onClose={onCancel}>
    <form onSubmit={async event=>{event.preventDefault();setBusy(true);try{await onSave(name.trim())}catch(cause){setError(cause instanceof Error?cause.message:'The search couldn’t be saved.')}finally{setBusy(false)}}}>
      <label>Name<input required maxLength={80} value={name} placeholder="e.g. Austin dental owners" onChange={event=>setName(event.target.value)}/></label>
      {error&&<p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy||!name.trim()}>Save</button></div>
    </form>
  </Modal>
}
function PersonDetail({person,contact}:{person:Person;contact?:Contact}){
  const rows:Row[]=[{label:'Title',value:person.title||contact?.title},{label:'Company',value:contact?.organizationName||person.organizationName},{label:'Company domain',value:contact?.organizationDomain},
    {label:'Email',value:contact?.email?<><a href={`mailto:${contact.email}`}>{contact.email}</a>{contact.emailStatus&&<span className="muted"> · {contact.emailStatus}</span>}</>:person.hasEmail?'Available · reveal to see it':'Apollo has no email'},
    {label:'Phone',value:contact?.phones.length?contact.phones.map(phone=><span key={phone.number} className="ap-phone"><a href={`tel:${phone.number}`}>{phone.number}</a>{phone.type&&<span className="muted"> · {phone.type.replace(/_/g,' ')}</span>}</span>)
      :contact?.phoneRequestedAt&&!contact.phoneRevealedAt?'Being looked up by Apollo':person.directPhone==='yes'?'Direct phone available · reveal with phone lookup':person.directPhone==='maybe'?'Apollo may have a direct phone':'Not available'},
    {label:'Location',value:[contact?.city,contact?.state,contact?.country].filter(Boolean).join(', ')||(person.hasCountry?'On record · reveal to see it':'')},
    {label:'LinkedIn',value:contact?.linkedinUrl?<a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer nofollow">{contact.linkedinUrl}</a>:''},
    {label:'Company data on record',value:[person.organization.hasIndustry&&'industry',person.organization.hasEmployeeCount&&'employee count',person.organization.hasRevenue&&'revenue',person.organization.hasPhone&&'phone'].filter(Boolean).join(', ')},
    {label:'Apollo record updated',value:person.lastRefreshedAt?dateLabel(person.lastRefreshedAt):''},
    {label:'Revealed',value:contact?.emailRevealedAt?`Email ${dateLabel(contact.emailRevealedAt)}${contact.phoneRevealedAt?`, phone ${dateLabel(contact.phoneRevealedAt)}`:''}${contact.accountId?` · account ${contact.accountId}`:''}`:'Not yet'}]
  return <dl className="dv-detail ap-detail">{rows.filter(row=>row.value).map(row=><div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
}
function OrganizationDetail({org}:{org:Organization}){
  const link=(url:string,label:string)=>/^https?:\/\//.test(url)?<a href={url} target="_blank" rel="noopener noreferrer nofollow">{label}</a>:''
  const rows:Row[]=[{label:'Website',value:link(org.websiteUrl,org.websiteUrl)},{label:'Domain',value:org.primaryDomain},{label:'Phone',value:org.phone?<a href={`tel:${org.phone}`}>{org.phone}</a>:''},{label:'LinkedIn',value:link(org.linkedinUrl,'Company page')},
    {label:'Twitter',value:link(org.twitterUrl,'Profile')},{label:'Facebook',value:link(org.facebookUrl,'Page')},{label:'Founded',value:org.foundedYear},{label:'Stock symbol',value:org.publiclyTradedSymbol},{label:'Languages',value:org.languages.join(', ')},
    {label:'NAICS codes',value:org.naicsCodes.join(', ')},{label:'SIC codes',value:org.sicCodes.join(', ')}]
  return <><dl className="dv-detail ap-detail">{rows.filter(row=>row.value).map(row=><div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    <p className="muted dv-verify">Apollo’s company search doesn’t include industry, employee count, location or a description; its paid company enrichment does, and isn’t used here.</p></>
}
