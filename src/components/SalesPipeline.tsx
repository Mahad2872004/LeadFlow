import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Icon } from './Icon'
import { CloseDealDialog, StageBadge, Totals } from './SalesBits'
import { localDate } from '../lib/dates'
import type { WorkspaceSummary } from '../lib/backend'
import { dealsFor, isConflict, money, moveDeal, pipelineBoard, priorityLabels, reopenDeal, salesPipeline, weighted, type BoardColumn, type Deal, type DealFilters, type DealPage, type Pipeline, type Priority, errorText, shortDate } from '../lib/sales'

type View = 'board' | 'list'
type Pending = { deal: Deal; kind: 'won' | 'lost' } | { deal: Deal; kind: 'reopen'; stageId: string }
const pageSize = 25

/**
 * The sales pipeline: deals by stage on a board (drag a card, or use its Move menu) or in a sortable, paged list.
 * Moves are saved one at a time with the deal's version, shown at once, and undone if the save fails.
 * Won and lost need their details, and reopening needs confirmation, so those open a dialog instead.
 */
export function SalesPipeline({ workspace, version, onOpenDeal, onCreateDeal, onSettings, onNotice }: {
  workspace: WorkspaceSummary; version: number; onOpenDeal: (dealId: string) => void; onCreateDeal: () => void; onSettings: () => void; onNotice: (message: string) => void
}) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null), [columns, setColumns] = useState<BoardColumn[] | null>(null)
  const [view, setView] = useState<View>(() => { try { return localStorage.getItem('leadflow.pipeline.view') === 'list' ? 'list' : 'board' } catch { return 'board' } })
  const [search, setSearch] = useState(''), [ownerId, setOwnerId] = useState(''), [priority, setPriority] = useState<Priority | ''>('')
  // Loading problems clear on the next successful load; a failed action stays explained until the next action.
  const [loadError, setLoadError] = useState(''), [error, setError] = useState(''), [moving, setMoving] = useState<Set<string>>(new Set()), [pending, setPending] = useState<Pending | null>(null)
  const [reload, setReload] = useState(0)
  const query = useDebounced(search.trim(), 250)
  useEffect(() => {
    let active = true
    Promise.all([salesPipeline(workspace.id), pipelineBoard(workspace.id, { ownerId, priority, search: query })])
      .then(([config, board]) => { if (active) { setPipeline(config); setColumns(board); setLoadError('') } })
      .catch(cause => { if (active) { setLoadError(errorText(cause)); setColumns(current => current ?? []) } })
    return () => { active = false }
  }, [workspace.id, ownerId, priority, query, version, reload])
  function chooseView(next: View) { setView(next); try { localStorage.setItem('leadflow.pipeline.view', next) } catch { /* A convenience only. */ } }

  const open = useMemo(() => (columns ?? []).filter(column => column.category === 'open'), [columns])
  const summary = useMemo(() => {
    const totals = new Map<string, { currency: string; value: number; weighted: number }>()
    for (const column of open) for (const total of column.totals) {
      const entry = totals.get(total.currency) ?? { currency: total.currency, value: 0, weighted: 0 }
      entry.value += Number(total.value); entry.weighted += Number(total.weighted); totals.set(total.currency, entry)
    }
    const list = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))
    return { count: open.reduce((sum, column) => sum + Number(column.count), 0), value: list.map(item => ({ currency: item.currency, value: item.value })), weighted: list.map(item => ({ currency: item.currency, value: item.weighted })) }
  }, [open])
  const today = localDate()
  const horizon = localDate(new Date(new Date(`${today}T12:00:00`).getTime() + 14 * 86_400_000))
  const closingSoon = open.flatMap(column => column.deals).filter(deal => deal.expectedCloseDate && deal.expectedCloseDate <= horizon).length
  const won = (columns ?? []).filter(column => column.category === 'won'), wonCount = won.reduce((sum, column) => sum + Number(column.count), 0)

  /** Moves a card to another open stage: shown at once, saved, and put back if the save fails. */
  async function move(deal: Deal, stageId: string) {
    if (!columns || !pipeline || deal.stageId === stageId || moving.has(deal.id)) return
    const target = columns.find(column => column.id === stageId)
    if (!target) return
    if (deal.outcome !== 'open') {
      if (target.category === 'open') setPending({ deal, kind: 'reopen', stageId })
      else setError(`${deal.title} is already ${deal.outcome}. Reopen it in an open stage before changing the outcome.`)
      return
    }
    if (target.category !== 'open') { setPending({ deal, kind: target.category }); return }
    const before = columns
    setColumns(relocate(columns, deal, stageId)); setMoving(set => new Set(set).add(deal.id)); setError('')
    try {
      const saved = await moveDeal(workspace.id, deal.id, stageId, deal.version, crypto.randomUUID())
      setColumns(current => current && replaceDeal(current, saved))
      onNotice(`${deal.title} moved to ${target.name}.`)
    } catch (cause) {
      setColumns(before)
      setError(isConflict(cause) ? `${deal.title} changed in another window, so it wasn’t moved. The board has been refreshed.` : `${deal.title} couldn’t be moved: ${errorText(cause)}`)
      if (isConflict(cause)) setReload(value => value + 1)
    } finally { setMoving(set => { const next = new Set(set); next.delete(deal.id); return next }) }
  }
  async function confirmReopen(deal: Deal, stageId: string) {
    try { const saved = await reopenDeal(workspace.id, deal.id, stageId, deal.version, crypto.randomUUID()); setPending(null); setReload(value => value + 1); onNotice(`${saved.title} reopened in ${saved.stage.name}.`) }
    catch (cause) { setPending(null); setError(errorText(cause)) }
  }

  if (!pipeline || !columns) return <section className="panel sp-panel" aria-busy="true"><div className="sp-loading" role="status">{loadError ? <p className="sp-error" role="alert">{loadError}</p> : 'Loading your pipeline…'}</div></section>
  const members = pipeline.members
  return <>
    <section className="sp-summary" aria-label="Pipeline summary">
      <div><span>Open deals</span><strong>{summary.count}</strong><small>{closingSoon ? `${closingSoon} expected to close in the next 14 days` : 'None expected to close in the next 14 days'}</small></div>
      <div><span>Open pipeline</span><strong><Totals totals={summary.value} empty="No values yet" compact /></strong><small>Deals with a value, per currency</small></div>
      <div><span>Weighted pipeline</span><strong><Totals totals={summary.weighted} empty="—" compact /></strong><small>Value × probability (the deal’s, or its stage’s)</small></div>
      <div><span>Won · last 90 days</span><strong><Totals totals={mergeTotals(won)} empty="None yet" compact /></strong><small>{wonCount} deal{wonCount === 1 ? '' : 's'} · see Sales analytics for any period</small></div>
    </section>
    <section className="panel sp-panel">
      <div className="section-heading sp-heading">
        <div><h2>Deals <span className="number-tag">{summary.count} open</span></h2><p>Drag a card to another stage, or use its Move menu. Won and lost ask for details first.</p></div>
        <div className="sp-heading-actions">
          <div className="view-toggle" role="group" aria-label="Pipeline view"><button aria-pressed={view === 'board'} onClick={() => chooseView('board')}><Icon name="columns" size={15} />Board</button><button aria-pressed={view === 'list'} onClick={() => chooseView('list')}><Icon name="list" size={15} />List</button></div>
          <button className="secondary" onClick={onSettings}><Icon name="gear" size={16} /> {pipeline.canConfigure ? 'Pipeline settings' : 'Stages'}</button>
          <button className="primary" onClick={onCreateDeal}><Icon name="plus" size={16} /> New deal</button>
        </div>
      </div>
      <div className="filters">
        <label className="search"><Icon name="search" size={18} /><input aria-label="Search deals" placeholder="Search deals, companies or contacts…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <select aria-label="Filter by owner" value={ownerId} onChange={event => setOwnerId(event.target.value)}><option value="">All owners</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
        <select aria-label="Filter by priority" value={priority} onChange={event => setPriority(event.target.value as Priority | '')}><option value="">Any priority</option>{(['high', 'medium', 'low'] as const).map(item => <option key={item} value={item}>{priorityLabels[item]} priority</option>)}</select>
        {(search || ownerId || priority) && <button className="text-button" onClick={() => { setSearch(''); setOwnerId(''); setPriority('') }}>Clear filters</button>}
      </div>
      {(error || loadError) && <p className="sp-error sp-inset" role="alert">{error || loadError}</p>}
      {view === 'board'
        ? <Board columns={columns} pipeline={pipeline} moving={moving} today={today} onMove={move} onOpen={onOpenDeal} empty={!columns.some(column => Number(column.count) > 0) && !search && !ownerId && !priority} onCreate={onCreateDeal} />
        : <DealList workspaceId={workspace.id} pipeline={pipeline} search={query} ownerId={ownerId} priority={priority} version={version + reload} today={today} onOpen={onOpenDeal} />}
    </section>
    {pending && pending.kind !== 'reopen' && <CloseDealDialog workspaceId={workspace.id} deal={pending.deal} pipeline={pipeline} outcome={pending.kind}
      onCancel={() => setPending(null)} onDone={deal => { setPending(null); setReload(value => value + 1); onNotice(`${deal.title} marked as ${deal.outcome}.`) }} />}
    {pending && pending.kind === 'reopen' && <ReopenConfirm deal={pending.deal} stage={pipeline.stages.find(stage => stage.id === pending.stageId)?.name ?? 'that stage'} onCancel={() => setPending(null)} onConfirm={() => void confirmReopen(pending.deal, pending.stageId)} />}
  </>
}

function ReopenConfirm({ deal, stage, onCancel, onConfirm }: { deal: Deal; stage: string; onCancel: () => void; onConfirm: () => void }) {
  const [busy, setBusy] = useState(false)
  return <div className="sp-floating-confirm" role="alertdialog" aria-labelledby="sp-reopen-title">
    <p id="sp-reopen-title"><strong>Reopen “{deal.title}” in {stage}?</strong> It was marked {deal.outcome}. Its close details stay in the timeline.</p>
    <div className="sp-actions"><button className="secondary" onClick={onCancel}>Keep it {deal.outcome}</button><button className="primary" disabled={busy} onClick={() => { setBusy(true); onConfirm() }}>Reopen deal</button></div>
  </div>
}

function Board({ columns, pipeline, moving, today, onMove, onOpen, empty, onCreate }: {
  columns: BoardColumn[]; pipeline: Pipeline; moving: Set<string>; today: string; onMove: (deal: Deal, stageId: string) => void; onOpen: (id: string) => void; empty: boolean; onCreate: () => void
}) {
  const [dragging, setDragging] = useState<Deal | null>(null), [over, setOver] = useState<string | null>(null)
  if (empty) return <div className="empty sp-empty"><h3>No deals yet</h3><p>Create a deal from a lead, from an opportunity in a business report, or from an outreach conversation, and track it here until it’s won or lost.</p><button className="primary" onClick={onCreate}><Icon name="plus" size={16} /> Create your first deal</button></div>
  const active = pipeline.stages.filter(stage => !stage.archived)
  return <div className="sp-board" style={{ '--sp-columns': columns.length } as CSSProperties}>{columns.map(column => {
    const accepts = dragging && dragging.stageId !== column.id
    return <section key={column.id} className={`sp-column is-${column.category}${over === column.id && accepts ? ' is-over' : ''}`} aria-label={`${column.name}: ${column.count} deals`}
      onDragOver={event => { if (accepts) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(column.id) } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(current => current === column.id ? null : current) }}
      onDrop={event => { event.preventDefault(); setOver(null); if (dragging) onMove(dragging, column.id); setDragging(null) }}>
      <header className="sp-column-head" style={{ '--sp-stage': column.color } as CSSProperties}>
        <div><i aria-hidden="true" /><h3>{column.name}</h3><span className="number-tag">{column.count}</span></div>
        <p>{column.category === 'open' ? <><Totals totals={column.totals} empty="No value yet" compact />{column.probability !== null && <span className="sp-muted"> · {column.probability}%</span>}</> : <span className="sp-muted">Last 90 days · <Totals totals={column.totals} empty="—" compact /></span>}</p>
      </header>
      <div className="sp-column-list">
        {column.deals.map(deal => <DealCard key={deal.id} deal={deal} stages={active} today={today} busy={moving.has(deal.id)} onOpen={() => onOpen(deal.id)} onMove={stageId => onMove(deal, stageId)}
          onDragStart={() => setDragging(deal)} onDragEnd={() => { setDragging(null); setOver(null) }} />)}
        {!column.deals.length && <p className="sp-column-empty">{column.category === 'open' ? 'Drop a deal here' : column.category === 'won' ? 'Won deals appear here' : 'Lost deals appear here'}</p>}
        {column.count > column.deals.length && <p className="sp-column-more">Showing the {column.deals.length} most recently active of {column.count}. Use the list view to see all.</p>}
      </div>
    </section>
  })}</div>
}

function DealCard({ deal, stages, today, busy, onOpen, onMove, onDragStart, onDragEnd }: {
  deal: Deal; stages: Pipeline['stages']; today: string; busy: boolean; onOpen: () => void; onMove: (stageId: string) => void; onDragStart: () => void; onDragEnd: () => void
}) {
  const overdueTask = deal.nextTask && deal.nextTask.due < today, closeOverdue = deal.outcome === 'open' && deal.expectedCloseDate && deal.expectedCloseDate < today
  const value = deal.outcome === 'won' && deal.wonValue !== null ? deal.wonValue : deal.value
  return <article className={`sp-card priority-${deal.priority}${busy ? ' is-busy' : ''}`} draggable={!busy} aria-busy={busy}
    onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', deal.id); onDragStart() }} onDragEnd={onDragEnd}>
    <button className="sp-card-open" onClick={onOpen} aria-label={`Open deal ${deal.title}`}>
      <strong>{deal.title}</strong>
      <span>{deal.lead ? deal.lead.company || deal.lead.name : 'Lead removed'}{deal.contact ? ` · ${deal.contact.name}` : ''}</span>
    </button>
    <p className="sp-card-value">{value === null ? <b className="sp-muted">No value yet</b> : <b>{money(value, deal.currency)}</b>}{deal.outcome === 'open' && deal.effectiveProbability !== null && deal.value !== null && <span title="Weighted value">{deal.effectiveProbability}% · {money(weighted(deal), deal.currency)}</span>}</p>
    <p className="sp-card-meta">
      {deal.priority === 'high' && <span className="sp-chip is-high">High priority</span>}
      {deal.outcome === 'lost' && deal.lostReason && <span className="sp-chip">{deal.lostReason}</span>}
      {deal.expectedCloseDate && deal.outcome === 'open' && <span className={`sp-chip${closeOverdue ? ' is-late' : ''}`}>Close {shortDate(deal.expectedCloseDate)}</span>}
      {deal.nextTask && <span className={`sp-chip${overdueTask ? ' is-late' : ''}`} title={deal.nextTask.notes}><Icon name="calendar" size={12} /> {shortDate(deal.nextTask.due)}</span>}
      {deal.nextMeeting && <span className="sp-chip"><Icon name="clock" size={12} /> {shortDate(deal.nextMeeting.startsAt)}</span>}
      {deal.ownerName && <span className="sp-chip" title={`Owner: ${deal.ownerName}`}>{deal.ownerName.split(/[\s@]/)[0]}</span>}
    </p>
    <label className="sp-card-move"><span className="sr-only">Move {deal.title} to</span>
      <select value={deal.stageId} disabled={busy} onChange={event => onMove(event.target.value)}>
        {stages.map(stage => <option key={stage.id} value={stage.id}>{stage.id === deal.stageId ? `In ${stage.name}` : stage.category === 'open' ? `Move to ${stage.name}` : `Mark as ${stage.name}…`}</option>)}
      </select></label>
  </article>
}

function DealList({ workspaceId, pipeline, search, ownerId, priority, version, today, onOpen }: {
  workspaceId: string; pipeline: Pipeline; search: string; ownerId: string; priority: Priority | ''; version: number; today: string; onOpen: (id: string) => void
}) {
  const [outcome, setOutcome] = useState<DealFilters['outcome']>('open'), [stageId, setStageId] = useState('')
  const [sort, setSort] = useState<NonNullable<DealFilters['sort']>>('activity'), [direction, setDirection] = useState<'asc' | 'desc'>('desc'), [offset, setOffset] = useState(0)
  const [page, setPage] = useState<DealPage | null>(null), [error, setError] = useState('')
  const filterKey = `${search}|${ownerId}|${priority}|${outcome}|${stageId}|${sort}|${direction}`
  const [lastKey, setLastKey] = useState(filterKey)
  if (lastKey !== filterKey) { setLastKey(filterKey); setOffset(0) }
  useEffect(() => {
    let active = true
    dealsFor(workspaceId, { search, ownerId, priority, outcome, stageId, sort, direction, limit: pageSize, offset })
      .then(result => { if (active) { setPage(result); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspaceId, search, ownerId, priority, outcome, stageId, sort, direction, offset, version])
  const header = (key: NonNullable<DealFilters['sort']>, label: string) => <th aria-sort={sort === key ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
    <button className="sp-sort" onClick={() => { if (sort === key) setDirection(direction === 'asc' ? 'desc' : 'asc'); else { setSort(key); setDirection(key === 'close' ? 'asc' : 'desc') } }}>{label}{sort === key && <span aria-hidden="true">{direction === 'asc' ? ' ↑' : ' ↓'}</span>}</button></th>
  return <div className="sp-list">
    <div className="filters sp-list-filters">
      <select aria-label="Filter by outcome" value={outcome} onChange={event => setOutcome(event.target.value as DealFilters['outcome'])}><option value="open">Open deals</option><option value="won">Won</option><option value="lost">Lost</option><option value="all">All deals</option></select>
      <select aria-label="Filter by stage" value={stageId} onChange={event => setStageId(event.target.value)}><option value="">All stages</option>{pipeline.stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}{stage.archived ? ' (archived)' : ''}</option>)}</select>
      {page && <span className="results" role="status">{page.total} deal{page.total === 1 ? '' : 's'}</span>}
    </div>
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {!page ? <p className="sp-loading" role="status">Loading deals…</p> : !page.items.length ? <div className="empty"><h3>No deals match</h3><p>Try another stage, outcome or search.</p></div> : <>
      <div className="sp-table-wrap"><table className="sp-table">
        <thead><tr>{header('activity', 'Deal')}<th>Stage</th>{header('value', 'Value')}<th>Weighted</th>{header('close', 'Expected close')}<th>Owner</th><th>Next follow-up</th>{header('updated', 'Updated')}</tr></thead>
        <tbody>{page.items.map(deal => <tr key={deal.id}>
          <td><button className="sp-link" onClick={() => onOpen(deal.id)}><strong>{deal.title}</strong></button><small>{deal.lead ? deal.lead.company || deal.lead.name : 'Lead removed'}{deal.contact ? ` · ${deal.contact.name}` : ''}</small></td>
          <td><StageBadge stage={deal.stage} /></td>
          <td className="sp-num">{money(deal.outcome === 'won' && deal.wonValue !== null ? deal.wonValue : deal.value, deal.currency)}</td>
          <td className="sp-num">{deal.outcome === 'open' ? <>{money(weighted(deal), deal.currency)}{deal.effectiveProbability !== null && <small>{deal.effectiveProbability}%</small>}</> : <span className="sp-muted">—</span>}</td>
          <td className={deal.outcome === 'open' && deal.expectedCloseDate && deal.expectedCloseDate < today ? 'is-late' : ''}>{deal.outcome === 'open' ? shortDate(deal.expectedCloseDate) : <small>Closed {shortDate(deal.actualCloseDate)}</small>}</td>
          <td>{deal.ownerName ?? <span className="sp-muted">Unassigned</span>}</td>
          <td>{deal.nextTask ? <span className={deal.nextTask.due < today ? 'is-late' : ''} title={deal.nextTask.notes}>{shortDate(deal.nextTask.due)}</span> : <span className="sp-muted">None</span>}</td>
          <td><small>{shortDate(deal.updatedAt)}</small></td>
        </tr>)}</tbody>
      </table></div>
      {page.total > pageSize && <div className="sp-pager"><span>{page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} of {page.total}</span>
        <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</button>
        <button className="secondary" disabled={offset + pageSize >= page.total} onClick={() => setOffset(offset + pageSize)}>Next</button></div>}
    </>}
  </div>
}

function relocate(columns: BoardColumn[], deal: Deal, stageId: string): BoardColumn[] {
  const target = columns.find(column => column.id === stageId)!
  const moved: Deal = { ...deal, stageId, stage: { ...deal.stage, name: target.name, color: target.color, category: target.category } }
  return columns.map(column => column.id === deal.stageId ? { ...column, count: column.count - 1, deals: column.deals.filter(item => item.id !== deal.id), totals: adjust(column.totals, deal, -1, column.probability) }
    : column.id === stageId ? { ...column, count: column.count + 1, deals: [moved, ...column.deals], totals: adjust(column.totals, moved, 1, column.probability) } : column)
}
function adjust(totals: BoardColumn['totals'], deal: Deal, sign: 1 | -1, stageProbability: number | null): BoardColumn['totals'] {
  if (deal.value === null) return totals
  const probability = deal.probability ?? stageProbability ?? 0, value = Number(deal.value)
  const existing = totals.find(total => total.currency === deal.currency) ?? { currency: deal.currency, value: 0, weighted: 0, count: 0 }
  const next = { ...existing, value: Number(existing.value) + sign * value, weighted: Number(existing.weighted) + sign * value * probability / 100, count: Number(existing.count) + sign }
  return [...totals.filter(total => total.currency !== deal.currency), ...(next.count > 0 ? [next] : [])].sort((a, b) => a.currency.localeCompare(b.currency))
}
function replaceDeal(columns: BoardColumn[], deal: Deal) { return columns.map(column => ({ ...column, deals: column.deals.map(item => item.id === deal.id ? deal : item) })) }
function mergeTotals(columns: BoardColumn[]) {
  const map = new Map<string, number>()
  for (const column of columns) for (const total of column.totals) map.set(total.currency, (map.get(total.currency) ?? 0) + Number(total.value))
  return [...map].map(([currency, value]) => ({ currency, value })).sort((a, b) => a.currency.localeCompare(b.currency))
}
function useDebounced<T>(value: T, delay: number) {
  const [current, setCurrent] = useState(value), timer = useRef<number | undefined>(undefined)
  useEffect(() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setCurrent(value), delay); return () => window.clearTimeout(timer.current) }, [value, delay])
  return current
}
