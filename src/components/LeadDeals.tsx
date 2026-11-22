import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { StageBadge } from './SalesBits'
import { dealsFor, money, moveDeal, salesPipeline, suggestedStageKey, type Deal, type Stage, errorText, shortDate, suggestStage } from '../lib/sales'

/** A lead's deals, in the lead drawer. */
export function LeadDeals({ workspaceId, leadId, version, onOpenDeal, onCreate }: { workspaceId: string; leadId: string; version: number; onOpenDeal: (dealId: string) => void; onCreate: () => void }) {
  const [deals, setDeals] = useState<Deal[] | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    dealsFor(workspaceId, { leadId, outcome: 'all', sort: 'created', direction: 'desc', limit: 20 }).then(page => { if (active) setDeals(page.items) }).catch(cause => { if (active) { setDeals([]); setError(errorText(cause)) } })
    return () => { active = false }
  }, [workspaceId, leadId, version])
  return <div className="sp-lead-deals">
    <div className="sp-block-head"><h3>Deals</h3><button className="text-button" onClick={onCreate}><Icon name="plus" size={14} /> New deal</button></div>
    {error ? <p className="sp-muted">{error}</p> : !deals ? <p className="sp-muted" role="status">Loading deals…</p> : !deals.length ? <p className="sp-muted">No deals with this lead yet.</p>
      : <ul>{deals.map(deal => <li key={deal.id}><button className="sp-link" onClick={() => onOpenDeal(deal.id)}>{deal.title}</button><StageBadge stage={deal.stage} />
        <span className="sp-muted">{money(deal.outcome === 'won' && deal.wonValue !== null ? deal.wonValue : deal.value, deal.currency)}{deal.outcome === 'open' && deal.expectedCloseDate ? ` · close ${shortDate(deal.expectedCloseDate)}` : ''}</span></li>)}</ul>}
  </div>
}

/**
 * Shown after a person marks an outreach draft sent or replied: the lead's open deals that are behind the matching stage,
 * with a button to move each one. Nothing moves unless they click it. With no open deal, it offers to create one.
 */
export function StageSuggestion({ workspaceId, leadId, event, onCreateDeal, onMoved, onDismiss }: {
  workspaceId: string; leadId: string; event: { status: 'sent' | 'replied'; draftId: string }; onCreateDeal: (draftId: string) => void; onMoved: (message: string) => void; onDismiss: () => void
}) {
  const [items, setItems] = useState<{ deal: Deal; stage: Stage }[] | null>(null), [noDeals, setNoDeals] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    Promise.all([salesPipeline(workspaceId), dealsFor(workspaceId, { leadId, outcome: 'open', limit: 20 })]).then(([pipeline, page]) => {
      if (!active) return
      setNoDeals(!page.items.length)
      setItems(page.items.flatMap(deal => { const stage = suggestStage(pipeline.stages, deal, suggestedStageKey[event.status]); return stage ? [{ deal, stage }] : [] }))
    }).catch(() => { if (active) setItems([]) })
    return () => { active = false }
  }, [workspaceId, leadId, event.status, event.draftId])
  if (!items || (!items.length && !noDeals)) return null
  return <section className="sp-suggest sp-suggest-lead" aria-label="Suggested next step" aria-live="polite">
    {noDeals ? <><p><strong>Track this conversation as a deal?</strong> This lead has no open deal yet. A deal keeps the value, stage, follow-ups and meetings together.</p>
      <div className="sp-actions"><button className="secondary" onClick={onDismiss}>Not now</button><button className="primary" onClick={() => onCreateDeal(event.draftId)}>Create deal</button></div></>
      : <><p><strong>{event.status === 'sent' ? 'Outreach sent.' : 'Reply recorded.'}</strong> Move {items.length === 1 ? 'this deal' : 'these deals'} forward? Nothing changes unless you choose.</p>
        <ul>{items.map(({ deal, stage }) => <li key={deal.id}><span>{deal.title} <span className="sp-muted">· in {deal.stage.name}</span></span>
          <button className="secondary" disabled={busy} onClick={async () => {
            setBusy(true); setError('')
            try { await moveDeal(workspaceId, deal.id, stage.id, deal.version, crypto.randomUUID()); setItems(current => current?.filter(item => item.deal.id !== deal.id) ?? null); onMoved(`${deal.title} moved to ${stage.name}.`) }
            catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
          }}>Move to {stage.name}</button></li>)}</ul>
        {error && <p className="sp-error" role="alert">{error}</p>}
        <div className="sp-actions"><button className="text-button" onClick={onDismiss}>Not now</button></div></>}
  </section>
}
