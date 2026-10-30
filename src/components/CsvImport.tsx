import { useRef, useState } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { guessMapping, importFields, maxCsvBytes, maxCsvRows, parseCsv, prepareRows, toCsv, type ColumnMapping, type ImportField, type PreparedRow } from '../lib/csv'
import { duplicateIndex, importLeads, reasonLabels, type DuplicateMatch, type ImportResult, type ImportRow, type LeadOrigin } from '../lib/discovery'
import type { Lead } from '../lib/model'
import { Icon } from './Icon'

type Parsed = { name: string; headers: string[]; records: string[][] }
type Reviewed = PreparedRow & { match: DuplicateMatch | null }
type Status = 'ready' | 'review' | 'existing' | 'invalid'
const statusOf = (row: Reviewed): Status => !row.row ? 'invalid' : !row.match ? 'ready' : row.match.blocking ? 'existing' : 'review'
const statusLabels: Record<Status, string> = { ready: 'Ready', review: 'Possible duplicate', existing: 'Already in LeadFlow', invalid: 'Needs fixing' }
const template = toCsv([['Business name', 'Contact name', 'Email', 'Phone', 'Website', 'Industry', 'Address', 'City', 'State or region', 'Postcode', 'Country', 'Notes'],
  ['Example Dental', 'Jordan Lee', 'hello@dental.example', '+1 512 555 0100', 'https://dental.example', 'Dental clinics', '12 Main St', 'Austin', 'TX', '78701', 'US', 'Fictional example row']])
/** Lets the user save a generated CSV. Only files LeadFlow built from the user's own data are offered. */
function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
interface CsvProps { workspace: WorkspaceSummary; leads: Lead[]; origins: LeadOrigin[]; blocked: boolean; onImported: (message: string) => Promise<void> }
/** Upload → map columns → review every row → import in idempotent batches → summary with a file of rows not imported. */
export function CsvImport({workspace,leads,origins,blocked,onImported}:CsvProps){
  const input=useRef<HTMLInputElement>(null)
  const [parsed,setParsed]=useState<Parsed|null>(null),[mapping,setMapping]=useState<ColumnMapping|null>(null),[step,setStep]=useState<'upload'|'map'|'review'|'done'>('upload')
  const [fileError,setFileError]=useState(''),[dragging,setDragging]=useState(false),[includeReview,setIncludeReview]=useState(false),[show,setShow]=useState<Status|'all'>('all')
  const [batches,setBatches]=useState<{id:string;rows:ImportRow[]}[]|null>(null),[results,setResults]=useState<ImportResult[]>([]),[importing,setImporting]=useState(false),[importError,setImportError]=useState('')
  // Fixed when the user opens the review, so the summary still describes these rows after the leads reload.
  const [reviewed,setReviewed]=useState<Reviewed[]>([])
  function review(){
    // Rows are checked against existing leads and against earlier rows of the same file, as the database will.
    const index=duplicateIndex(leads,origins)
    setReviewed(prepareRows(parsed!.records,mapping!).map(prepared=>{
      if(!prepared.row)return {...prepared,match:null}
      const match=index.find(prepared.row)
      if(!match)index.remember(prepared.row)
      return {...prepared,match}
    }))
    setShow('all');setStep('review')
  }
  const counts=reviewed.reduce((total,row)=>({...total,[statusOf(row)]:total[statusOf(row)]+1}),{ready:0,review:0,existing:0,invalid:0} as Record<Status,number>)
  const toImport=reviewed.filter(row=>statusOf(row)==='ready'||(includeReview&&statusOf(row)==='review'))

  async function read(file:File){
    setFileError('')
    if(!/\.csv$/i.test(file.name)&&file.type!=='text/csv'){setFileError('Choose a .csv file. In Excel or Google Sheets, use File → Download → CSV.');return}
    if(file.size>maxCsvBytes){setFileError('This file is larger than 2 MB. Split it into smaller files.');return}
    try{
      const records=parseCsv(await file.text())
      if(records.length<2){setFileError('The file needs a header row and at least one lead.');return}
      if(records.length-1>maxCsvRows){setFileError(`This file has ${records.length-1} rows. Import up to ${maxCsvRows.toLocaleString()} at a time.`);return}
      const [headers,...rows]=records
      setParsed({name:file.name,headers:headers.map((header,index)=>header.trim()||`Column ${index+1}`),records:rows})
      setMapping(guessMapping(headers));setStep('map')
    }catch(cause){setFileError(cause instanceof Error?cause.message:'This file could not be read.')}
  }
  async function runImport(retry=false){
    const work=retry&&batches?batches:Array.from({length:Math.ceil(toImport.length/250)},(_,index)=>({id:crypto.randomUUID(),rows:toImport.slice(index*250,index*250+250).map(row=>({...row.row!,allowDuplicate:statusOf(row)==='review'}))}))
    const done=retry?results:[]
    setBatches(work);setResults(done);setImporting(true);setImportError('')
    try{
      // Each batch keeps its ID, so retrying after a lost response returns the stored result instead of importing again.
      for(const batch of work.slice(done.length)){done.push(await importLeads(workspace.id,batch.id,{method:'csv',rows:batch.rows}));setResults([...done])}
      setStep('done');setBatches(null)
      const imported=done.reduce((total,result)=>total+result.imported.length,0)
      await onImported(imported?`${imported} ${imported===1?'lead was':'leads were'} imported from ${parsed!.name}.`:'No new leads were imported.')
    }catch(cause){setImportError(`${cause instanceof Error?cause.message:'The import could not be confirmed.'} ${done.length} of ${work.length} batches finished. Retrying is safe: rows already imported won’t be added twice.`)}
    finally{setImporting(false)}
  }
  function reset(){setParsed(null);setReviewed([]);setMapping(null);setStep('upload');setResults([]);setBatches(null);setImportError('');setIncludeReview(false);setShow('all');if(input.current)input.current.value=''}
  const steps=['Upload','Match columns','Review','Done'],current=['upload','map','review','done'].indexOf(step)
  const serverSkipped=results.flatMap(result=>result.skipped)
  const notImported=step==='done'?[...reviewed.filter(row=>!toImport.includes(row)).map(row=>[row,row.errors.join(' ')||(row.match?reasonLabels[row.match.reason]:'')] as const),
    ...serverSkipped.map(item=>[reviewed.find(row=>row.row?.key===item.key)!,reasonLabels[item.reason]] as const).filter(([row])=>row)]:[]
  return <section className="panel dv-csv" aria-labelledby="dv-csv-title">
    <div className="section-heading"><div><h2 id="dv-csv-title">Import leads from a CSV file</h2><p>Bring in a list from a spreadsheet, another CRM or an event. You’ll check every row before anything is added.</p></div>
      <button className="text-button" onClick={()=>download('leadflow-import-template.csv',template)}>Download a template</button></div>
    <ol className="dv-steps" aria-label="Import progress">{steps.map((label,index)=><li key={label} className={index<current?'done':index===current?'current':''} aria-current={index===current?'step':undefined}><span>{index<current?'✓':index+1}</span>{label}</li>)}</ol>

    {step==='upload'&&<div className="dv-csv-body">
      <label className={`dv-drop${dragging?' dragging':''}`} onDragOver={event=>{event.preventDefault();setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);const file=event.dataTransfer.files[0];if(file)void read(file)}}>
        <Icon name="clipboard" size={26}/><strong>Choose a CSV file</strong><span>or drag it here · up to {maxCsvRows.toLocaleString()} rows, 2 MB</span>
        <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" onChange={event=>{const file=event.target.files?.[0];if(file)void read(file)}}/>
      </label>
      {fileError&&<p className="field-error" role="alert">{fileError}</p>}
      <p className="muted dv-csv-hint">Each row needs a business or contact name. Email, phone, website, address and notes are optional. Only import contacts you’re allowed to use for business outreach.</p>
    </div>}

    {step==='map'&&parsed&&mapping&&<div className="dv-csv-body">
      <p className="dv-file"><strong>{parsed.name}</strong> · {parsed.records.length} rows · {parsed.headers.length} columns <button className="text-button" onClick={reset}>Choose another file</button></p>
      <div className="table-scroll"><table className="dv-map"><thead><tr><th>LeadFlow field</th><th>Column in your file</th><th>First value</th></tr></thead>
        <tbody>{importFields.map(field=><tr key={field.key}><td>{field.label}{(field.key==='businessName'||field.key==='contactName')&&<small className="muted"> · one of these is required</small>}</td>
          <td><select aria-label={`Column for ${field.label}`} value={mapping[field.key]} onChange={event=>setMapping({...mapping,[field.key]:Number(event.target.value)} as Record<ImportField,number>)}><option value={-1}>Don’t import</option>{parsed.headers.map((header,index)=><option key={index} value={index} disabled={Object.entries(mapping).some(([key,value])=>key!==field.key&&value===index)}>{header}</option>)}</select></td>
          <td className="muted">{mapping[field.key]>=0?parsed.records[0]?.[mapping[field.key]]||'—':''}</td></tr>)}</tbody></table></div>
      {mapping.businessName<0&&mapping.contactName<0&&<p className="field-error" role="alert">Match a column to Business name or Contact name to continue.</p>}
      <div className="modal-actions"><button className="secondary" onClick={reset}>Back</button><button className="primary" disabled={mapping.businessName<0&&mapping.contactName<0} onClick={review}>Review rows</button></div>
    </div>}

    {step==='review'&&<div className="dv-csv-body">
      <div className="dv-counts" role="group" aria-label="Rows by status">{(['all','ready','review','existing','invalid'] as const).map(status=><button key={status} className={`dv-count dv-count-${status}${show===status?' active':''}`} aria-pressed={show===status} onClick={()=>setShow(status)}><strong>{status==='all'?reviewed.length:counts[status]}</strong>{status==='all'?'All rows':statusLabels[status]}</button>)}</div>
      {counts.review>0&&<label className="dv-check dv-include"><input type="checkbox" checked={includeReview} onChange={event=>setIncludeReview(event.target.checked)}/>Also import the {counts.review} possible {counts.review===1?'duplicate':'duplicates'} as separate leads</label>}
      <div className="table-scroll dv-preview"><table><thead><tr><th>Row</th><th>Name</th><th>Email / website</th><th>Status</th></tr></thead>
        <tbody>{reviewed.filter(row=>show==='all'||statusOf(row)===show).slice(0,200).map(row=>{const status=statusOf(row);return <tr key={row.line}><td className="muted">{row.line}</td><td>{row.row?.businessName||row.row?.contactName||row.values[mapping!.businessName]||row.values[mapping!.contactName]||'—'}{row.row?.businessName&&row.row.contactName&&<small className="dv-sub">{row.row.contactName}</small>}</td>
          <td>{row.row?row.row.email||row.row.website||<span className="muted">—</span>:''}</td>
          <td><span className={`dv-badge dv-${status==='ready'?'new':status==='review'?'possible':status==='existing'?'existing':'invalid'}`}>{statusLabels[status]}</span>{(row.errors.length>0||row.match)&&<small className="dv-sub">{row.errors.join(' ')||`${reasonLabels[row.match!.reason]}${row.match!.inBatch?' earlier in this file':row.match!.lead?`: ${row.match!.lead.name}`:''}`}</small>}</td></tr>})}</tbody></table></div>
      {reviewed.filter(row=>show==='all'||statusOf(row)===show).length>200&&<p className="muted">Showing the first 200 rows of this view. Every row is still imported or reported.</p>}
      {importError&&<div className="error-banner dv-inline-error" role="alert">{importError} <button className="secondary" disabled={importing||blocked} onClick={()=>void runImport(true)}>Retry import</button></div>}
      {blocked&&<p className="muted">Finish or discard the unsaved change above before importing.</p>}
      <div className="modal-actions"><button className="secondary" disabled={importing} onClick={()=>setStep('map')}>Back</button><button className="primary" disabled={!toImport.length||importing||blocked||!!importError} onClick={()=>void runImport()}>{importing?`Importing… ${Math.min(results.length*250,toImport.length)}/${toImport.length}`:`Import ${toImport.length} ${toImport.length===1?'lead':'leads'}`}</button></div>
    </div>}

    {step==='done'&&<div className="dv-csv-body">
      <div className="dv-summary" role="status"><strong>{results.reduce((total,result)=>total+result.imported.length,0)} leads imported from {parsed?.name}.</strong> {notImported.length?`${notImported.length} rows weren’t imported.`:'Every row was imported.'}</div>
      {notImported.length>0&&<><ul className="dv-skipped">{notImported.slice(0,8).map(([row,reason])=><li key={row.line}><span className="muted">Row {row.line}</span> {row.row?.businessName||row.row?.contactName||'Unnamed row'} — {reason}</li>)}</ul>
        {notImported.length>8&&<p className="muted">…and {notImported.length-8} more in the file below.</p>}</>}
      <div className="modal-actions dv-done-actions">{notImported.length>0&&parsed&&<button className="secondary" onClick={()=>download(parsed.name.replace(/\.csv$/i,'')+'-not-imported.csv',toCsv([[...parsed.headers,'LeadFlow issue'],...notImported.map(([row,reason])=>[...row.values,reason])]))}>Download rows not imported</button>}<button className="primary" onClick={reset}>Import another file</button></div>
    </div>}
  </section>
}
