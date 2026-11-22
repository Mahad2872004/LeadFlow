import { useRef, useState, type CSSProperties } from 'react'
import { Modal } from './Modal'
import { localDate } from '../lib/dates'
import { closeDeal, errorText, isConflict, money, type Deal, type Pipeline, type StageCategory } from '../lib/sales'

/** Shared pieces of the sales pipeline (M9): stage badges, per-currency totals, the won/lost dialog. Styles in Sales.css. */

export function StageBadge({ stage }: { stage: { name: string; color: string; category: StageCategory; archived?: boolean } }) {
  return <span className={`sp-stage is-${stage.category}`} style={{ '--sp-stage': stage.color } as CSSProperties}><i aria-hidden="true" />{stage.name}{stage.archived ? ' (archived)' : ''}</span>
}

/** Amounts per currency, never added across currencies. */
export function Totals({ totals, empty = '—', compact = false }: { totals: { currency: string; value: number | null }[]; empty?: string; compact?: boolean }) {
  return totals.length ? <span className="sp-totals">{totals.map(total => <span key={total.currency}>{money(total.value, total.currency, compact)}</span>)}</span> : <span className="sp-muted">{empty}</span>
}
/**
 * Closes a deal as won or lost, explicitly. Won asks for the final value and close date; lost for a reason from the
 * workspace's list. The deal, its history and its links are kept, and it can be reopened later.
 */
export function CloseDealDialog({ workspaceId, deal, pipeline, outcome, onDone, onCancel }: {
  workspaceId: string; deal: Deal; pipeline: Pipeline; outcome: 'won' | 'lost'; onDone: (deal: Deal) => void; onCancel: () => void
}) {
  const stages = pipeline.stages.filter(stage => stage.category === outcome && !stage.archived)
  const [stageId, setStageId] = useState(stages[0]?.id ?? '')
  const [wonValue, setWonValue] = useState(deal.value === null ? '' : String(deal.value))
  const [closeDate, setCloseDate] = useState(localDate())
  const [reason, setReason] = useState(''), [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const updated = await closeDeal(workspaceId, deal.id, outcome, { stageId, closeDate, notes, ...(outcome === 'won' ? { wonValue } : { reason }) }, deal.version, requestId.current)
      onDone(updated)
    } catch (cause) {
      setError(isConflict(cause) ? 'This deal changed in another window. Close this dialog, reload the deal and try again.' : errorText(cause))
      if (!(cause instanceof Error && /reach LeadFlow/.test(cause.message))) requestId.current = crypto.randomUUID()
    } finally { setBusy(false) }
  }
  return <Modal title={outcome === 'won' ? `Mark “${deal.title}” as won` : `Mark “${deal.title}” as lost`} onClose={onCancel}>
    <form className="sp-form" onSubmit={submit}>
      <p className="sp-intro">{outcome === 'won'
        ? 'Record the final value and when it closed. Everything about the deal stays, and you can hand it off to client work afterwards. Nothing is created automatically.'
        : 'Record why it was lost. The deal stays in your history and reports, and you can reopen it later.'}</p>
      {stages.length > 1 && <label>Stage<select value={stageId} onChange={event => setStageId(event.target.value)}>{stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>}
      {outcome === 'won' ? <div className="sp-row">
        <label>Final value ({deal.currency})<input inputMode="decimal" value={wonValue} onChange={event => setWonValue(event.target.value)} placeholder={deal.value === null ? 'Not set' : String(deal.value)} />
          <small>{deal.value === null ? 'The deal has no value yet. Leave empty if unknown.' : `Deal value: ${money(deal.value, deal.currency)}`}</small></label>
        <label>Close date<input type="date" required value={closeDate} onChange={event => setCloseDate(event.target.value)} /></label>
      </div> : <div className="sp-row">
        <label>Reason *<select required value={reason} onChange={event => setReason(event.target.value)}><option value="">Choose a reason…</option>{pipeline.settings.lostReasons.map(item => <option key={item}>{item}</option>)}</select></label>
        <label>Close date<input type="date" required value={closeDate} onChange={event => setCloseDate(event.target.value)} /></label>
      </div>}
      <label>Notes<textarea rows={3} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} placeholder={outcome === 'won' ? 'Scope agreed, start date, anything the delivery team should know…' : 'What happened, and anything worth trying next time…'} /></label>
      {error && <p className="sp-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy || (outcome === 'lost' && !reason) || !stageId}>{busy ? 'Saving…' : outcome === 'won' ? 'Mark as won' : 'Mark as lost'}</button></div>
    </form>
  </Modal>
}
