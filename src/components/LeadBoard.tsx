import { statuses, type Lead, type Status } from '../lib/model'
import { dateLabel } from '../lib/format'

interface LeadBoardProps { leads: Lead[]; onSelect: (id: string) => void; onStatus: (lead: Lead, status: Status) => void }
const initialsOf = (name: string) => name.split(' ').map(part => part[0]).slice(0, 2).join('')

/** The pipeline as columns by status. An alternative to the lead table; only one of them is shown at a time. */
export function LeadBoard({ leads, onSelect, onStatus }: LeadBoardProps) {
  return <div className="lead-board">{statuses.map(status => {
    const items = leads.filter(lead => lead.status === status)
    return <section key={status} className={`board-column is-${status.toLowerCase()}`} aria-label={`${status} column`}>
      <div className="board-head"><span className={'legend-dot ' + status.toLowerCase()} aria-hidden="true"/><h3>{status}</h3><span className="number-tag">{items.length}</span></div>
      <div className="board-list">{items.length ? items.map(lead => <article className="board-card" key={lead.id}>
        <button className="board-open" onClick={() => onSelect(lead.id)} aria-label={`View ${lead.name}`}>
          <span className={'avatar tone-' + (lead.name.length % 4)} aria-hidden="true">{initialsOf(lead.name)}</span>
          <span className="board-who"><strong>{lead.name}</strong><small>{lead.company && lead.company !== lead.name ? lead.company : lead.email || lead.city || lead.service}</small></span>
        </button>
        <p className="board-meta"><span>{lead.service}</span><span>{dateLabel(lead.createdAt)}</span></p>
        <select aria-label={`Status for ${lead.name}`} className={'status ' + lead.status.toLowerCase()} value={lead.status} onChange={event => onStatus(lead, event.target.value as Status)}>{statuses.map(option => <option key={option}>{option}</option>)}</select>
      </article>) : <p className="board-empty">No {status.toLowerCase()} leads</p>}</div>
    </section>
  })}</div>
}
