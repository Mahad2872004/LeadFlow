import { statuses, type Lead, type Status } from '../lib/model'
import { Icon } from './Icon'
import { dateLabel } from '../lib/format'
interface LeadTableProps {leads:Lead[];onSelect:(id:string)=>void;onStatus:(lead:Lead,status:Status)=>void;onAdd:()=>void}
export function LeadTable({leads,onSelect,onStatus,onAdd}:LeadTableProps) {
  return <div className="table-scroll"><table className="lead-table"><thead><tr><th>Lead / company</th><th>Service interest</th><th>Source</th><th>Status</th><th>Added</th><th><span className="sr-only">Details</span></th></tr></thead>
    <tbody>{leads.map(lead=><tr key={lead.id}>
      <td><button className="person" onClick={()=>onSelect(lead.id)}><span className={'avatar tone-'+(lead.name.length%4)}>{lead.name.split(' ').map(name=>name[0]).slice(0,2).join('')}</span><span><strong>{lead.name}</strong><small>{lead.company&&lead.company!==lead.name?lead.company:lead.email||[lead.industry,lead.city].filter(Boolean).join(' · ')||lead.company}</small></span></button></td>
      <td data-label="Service">{lead.service}</td><td data-label="Source"><span className="source-dot"/>{lead.source}</td>
      <td data-label="Status"><select aria-label={`Status for ${lead.name}`} className={'status '+lead.status.toLowerCase()} value={lead.status} onChange={event=>onStatus(lead,event.target.value as Status)}>{statuses.map(status=><option key={status}>{status}</option>)}</select></td>
      <td data-label="Added" className="muted">{dateLabel(lead.createdAt)}</td><td><button className="icon-button" aria-label={`View ${lead.name}`} onClick={()=>onSelect(lead.id)}><Icon name="arrow" size={18}/></button></td>
    </tr>)}</tbody>
  </table>{leads.length===0&&<div className="empty"><h3>No leads found</h3><p>Try a different search, or capture your first lead.</p><button className="secondary" onClick={onAdd}>Add lead</button></div>}</div>
}
