import { useEffect, useState } from 'react'
import type { WorkspaceSummary } from '../lib/backend'
import { accountLabel, apolloLedger, apolloSync, apolloTest, apolloUpdateAccount, operationLabels, remainingOf, statusLabels, type ApolloAccount, type LedgerEntry } from '../lib/apollo'
import { dateLabel } from '../lib/format'
import { Modal } from './Modal'
const creditTypes: [string, string][] = [['lead_credit', 'Email credits'], ['direct_dial_credit', 'Mobile credits'], ['export_credit', 'Export credits']]
const percent = (used: number, total: number) => total ? Math.min(100, Math.round(used / total * 1000) / 10) : 0
const when = (value: string | null) => value ? `${dateLabel(value)}, ${new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'Never'
interface CreditsProps { workspace: WorkspaceSummary; accounts: ApolloAccount[]; selected: string; onSelect: (id: string) => void; onChanged: () => void }
/** Apollo accounts, their credit usage (LeadFlow's ledger and Apollo's own figures), and the credit history. */
export function ApolloCredits({workspace,accounts,selected,onSelect,onChanged}:CreditsProps){
  const manage=workspace.role!=='member'
  const [busy,setBusy]=useState(''),[message,setMessage]=useState<{text:string;error?:boolean}|null>(null),[editing,setEditing]=useState<ApolloAccount|null>(null)
  const [filters,setFilters]=useState<Record<string,string>>({}),[entries,setEntries]=useState<LedgerEntry[]|null>(null),[ledgerError,setLedgerError]=useState(''),[reload,setReload]=useState(0)
  useEffect(()=>{
    let active=true
    apolloLedger(workspace.id,filters).then(list=>{if(active){setEntries(list);setLedgerError('')}}).catch(cause=>{if(active)setLedgerError(cause instanceof Error?cause.message:'The credit history couldn’t be loaded.')})
    return()=>{active=false}
  },[workspace.id,filters,reload])
  async function act(account:ApolloAccount,kind:'test'|'sync'){
    setBusy(`${kind}-${account.id}`);setMessage(null)
    try{
      if(kind==='test'){await apolloTest(workspace.id,account.id);setMessage({text:`${accountLabel(account)} is connected.`})}
      else{await apolloSync(workspace.id,account.id);setMessage({text:`Updated ${accountLabel(account)} with Apollo’s credit figures.`})}
    }catch(cause){setMessage({text:cause instanceof Error?cause.message:'Apollo couldn’t be reached.',error:true})}
    finally{setBusy('');onChanged()}
  }
  const active=accounts.filter(account=>account.configured)
  const total={allowance:active.reduce((sum,a)=>sum+a.monthlyAllowance,0),used:active.reduce((sum,a)=>sum+a.used,0)}
  const accountName=(id:string)=>{const account=accounts.find(item=>item.id===id);return account?accountLabel(account):id}
  return <div className="ap-credits">
    {message&&<div className={message.error?'error-banner dv-inline-error':'dv-summary'} role={message.error?'alert':'status'}>{message.text}</div>}
    <section className="ap-totals" aria-label="All accounts">
      <div><span>Accounts</span><strong>{active.length}</strong></div>
      <div><span>Monthly allowance</span><strong>{total.allowance.toLocaleString()}</strong></div>
      <div><span>Used this cycle</span><strong>{Number(total.used.toFixed(2)).toLocaleString()}</strong></div>
      <div><span>Remaining</span><strong>{Math.max(0,Number((total.allowance-total.used).toFixed(2))).toLocaleString()}</strong></div>
    </section>
    <p className="ap-help ap-note">Each account is used on its own; LeadFlow never switches accounts for you. Totals are for reference. Apollo’s terms don’t allow opening extra self-serve accounts to get around credit limits.</p>
    <div className="ap-account-grid">{accounts.map(account=>{const used=account.used,left=remainingOf(account),pct=percent(used,account.monthlyAllowance)
      return <article key={account.id} className={`panel ap-account${account.id===selected?' current':''}${!account.configured?' missing':''}`} aria-labelledby={`ap-acct-${account.id}`}>
        <header><div><h3 id={`ap-acct-${account.id}`}>{account.nickname||account.id}</h3><small>{account.id}{account.nickname&&account.nickname!==account.id?'':''} · added {dateLabel(account.createdAt)}</small></div>
          <span className={`dv-badge ${!account.configured?'dv-invalid':account.active?'dv-new':'dv-possible'}`}>{!account.configured?'Key removed':account.active?'Active':'Switched off'}</span></header>
        <div className="ap-meter" role="img" aria-label={`${used} of ${account.monthlyAllowance} credits used, ${pct}%`}><i style={{width:`${pct}%`}} className={pct>=90?'high':undefined}/></div>
        <dl className="ap-figures">
          <div><dt>Allowance</dt><dd>{account.monthlyAllowance}</dd></div><div><dt>Used</dt><dd>{Number(used.toFixed(2))}</dd></div><div><dt>Remaining</dt><dd>{Number(left.toFixed(2))}</dd></div><div><dt>Usage</dt><dd>{pct}%</dd></div>
          <div><dt>Email reveals</dt><dd>{Number(account.usedEmail.toFixed(2))}</dd></div><div><dt>Phone reveals</dt><dd>{Number(account.usedPhone.toFixed(2))}</dd></div><div><dt>Company search</dt><dd>{Number(account.usedSearch.toFixed(2))}</dd></div><div><dt>Waiting</dt><dd>{account.pending}</dd></div>
        </dl>
        <p className="ap-help">Cycle {dateLabel(account.cycleStart)} – {dateLabel(account.cycleEnd)} · {account.cycleSource==='apollo'?'billing cycle reported by Apollo':`resets on day ${account.resetDay} (set by you until synced with Apollo)`}. Figures above come from LeadFlow’s ledger of its own requests.</p>
        {account.synced&&Object.keys(account.synced).length>0&&<div className="ap-synced"><strong>Apollo reports</strong> <small>synced {when(account.lastSyncedAt)}</small>
          <ul>{creditTypes.filter(([type])=>account.synced?.[type]).map(([type,label])=>{const stat=account.synced![type];return <li key={type}>{label}: {stat.leftOver??'?'} left of {stat.limit??'?'}{stat.consumed!==null?` (${stat.consumed} used)`:''}</li>})}</ul></div>}
        <p className="ap-help">Connection: {account.lastConnectionError?<span className="field-error">{account.lastConnectionError}</span>:account.lastConnectedAt?`working, last checked ${when(account.lastConnectedAt)}`:'not checked yet'}</p>
        {account.notes&&<p className="ap-notes">{account.notes}</p>}
        <div className="ap-account-actions">
          {account.configured&&account.id!==selected&&<button className="secondary" onClick={()=>onSelect(account.id)}>Use for discovery</button>}
          {account.configured&&account.id===selected&&<span className="soft-tag">Used for discovery</span>}
          {account.configured&&<button className="text-button" disabled={!!busy} onClick={()=>void act(account,'sync')}>{busy===`sync-${account.id}`?'Syncing…':'Sync credits from Apollo'}</button>}
          {account.configured&&manage&&<button className="text-button" disabled={!!busy} onClick={()=>void act(account,'test')}>{busy===`test-${account.id}`?'Testing…':'Test connection'}</button>}
          {manage&&<button className="text-button" onClick={()=>setEditing(account)}>Edit</button>}
        </div>
      </article>})}</div>

    <section className="panel" aria-labelledby="ap-ledger-title">
      <div className="section-heading"><div><h2 id="ap-ledger-title">Credit history</h2><p>Every credit-using request LeadFlow made, newest first (up to 200). Kept across cycles.</p></div><button className="text-button" onClick={()=>{setEntries(null);setReload(value=>value+1)}}>Refresh</button></div>
      <div className="filters dv-filters ap-ledger-filters">
        <select aria-label="Account" value={filters.accountId??''} onChange={event=>setFilters({...filters,accountId:event.target.value})}><option value="">All accounts</option>{accounts.map(account=><option key={account.id} value={account.id}>{accountLabel(account)}</option>)}</select>
        <select aria-label="Operation" value={filters.operation??''} onChange={event=>setFilters({...filters,operation:event.target.value})}><option value="">All operations</option>{Object.entries(operationLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="Status" value={filters.status??''} onChange={event=>setFilters({...filters,status:event.target.value})}><option value="">All statuses</option>{Object.entries(statusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
        <label className="ap-date">From<input type="date" value={filters.from??''} onChange={event=>setFilters({...filters,from:event.target.value})}/></label>
        <label className="ap-date">To<input type="date" value={filters.to??''} onChange={event=>setFilters({...filters,to:event.target.value})}/></label>
      </div>
      {ledgerError?<div className="error-banner dv-inline-error" role="alert">{ledgerError}</div>
        :entries===null?<div className="content-skeleton" role="status"><span className="sr-only">Loading credit history…</span><i className="skeleton skeleton-panel"/></div>
        :entries.length===0?<div className="empty"><h3>No credit use yet</h3><p>Reveals and company searches appear here with the credits Apollo charged.</p></div>
        :<div className="table-scroll"><table className="dv-table ap-ledger"><thead><tr><th>When</th><th>Account</th><th>Operation</th><th>For</th><th>Credits</th><th>Status</th><th>Reference</th></tr></thead>
          <tbody>{entries.map(entry=><tr key={entry.id}>
            <td data-label="When">{when(entry.createdAt)}</td><td data-label="Account">{accountName(entry.accountId)}</td><td data-label="Operation">{operationLabels[entry.operation]}</td>
            <td data-label="For">{entry.subjects.map(subject=>subject.name).join(', ')||'—'}</td>
            <td data-label="Credits">{entry.credits!==null?<>{Number(entry.credits)} <small className="muted">{entry.creditBasis==='reported'?'reported by Apollo':entry.creditBasis==='documented'?'Apollo’s published rate':'estimate'}</small></>:<>up to {Number(entry.estimatedCredits)} <small className="muted">estimate</small></>}</td>
            <td data-label="Status"><span className={`dv-badge ap-status-${entry.status}`}>{statusLabels[entry.status]}</span>{entry.error&&<small className="dv-sub">{entry.error}</small>}</td>
            <td data-label="Reference">{entry.reference??'—'}</td>
          </tr>)}</tbody></table></div>}
    </section>
    {editing&&<AccountEditor account={editing} onCancel={()=>setEditing(null)} onSave={async changes=>{await apolloUpdateAccount(workspace.id,editing.id,changes);setEditing(null);setMessage({text:'Account saved.'});onChanged()}}/>}
  </div>
}
function AccountEditor({account,onCancel,onSave}:{account:ApolloAccount;onCancel:()=>void;onSave:(changes:Partial<ApolloAccount>)=>Promise<void>}){
  const [form,setForm]=useState({nickname:account.nickname,monthlyAllowance:String(account.monthlyAllowance),resetDay:String(account.resetDay),notes:account.notes,active:account.active})
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  return <Modal title={`Edit ${account.id}`} onClose={onCancel}>
    <p className="modal-intro">The API key is set on the server (APOLLO_API_KEYS) and is never shown here. These settings control how LeadFlow tracks this account’s credits.</p>
    <form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('')
      try{await onSave({nickname:form.nickname.trim(),monthlyAllowance:Number(form.monthlyAllowance),resetDay:Number(form.resetDay),notes:form.notes,active:form.active})}
      catch(cause){setError(cause instanceof Error?cause.message:'The account couldn’t be saved.')}finally{setBusy(false)}}}>
      <div className="form-grid">
        <label>Nickname<input maxLength={60} value={form.nickname} onChange={event=>setForm({...form,nickname:event.target.value})}/></label>
        <label>Monthly credit allowance<input type="number" min={0} max={1000000} required value={form.monthlyAllowance} onChange={event=>setForm({...form,monthlyAllowance:event.target.value})}/></label>
        <label>Cycle reset day (until synced)<input type="number" min={1} max={28} required value={form.resetDay} onChange={event=>setForm({...form,resetDay:event.target.value})}/></label>
        <label className="dv-check ap-active"><input type="checkbox" checked={form.active} onChange={event=>setForm({...form,active:event.target.checked})}/>Active (can be used for discovery)</label>
      </div>
      <label>Notes<textarea rows={3} maxLength={1000} value={form.notes} onChange={event=>setForm({...form,notes:event.target.value})}/></label>
      {error&&<p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
    </form>
  </Modal>
}
