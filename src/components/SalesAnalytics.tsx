import { useEffect, useState, type CSSProperties } from 'react'
import { Totals } from './SalesBits'
import { localDate } from '../lib/dates'
import type { WorkspaceSummary } from '../lib/backend'
import { fewClosed, money, periodLabels, periodRange, salesAnalytics, sourceLabels, type Analytics, type PeriodKey, errorText, relativeDays, shortDate } from '../lib/sales'

/**
 * Sales analytics from the workspace's own deals. Definitions are shown next to each figure. Won, lost and win rate count
 * deals closed in the period; the open pipeline is as of today. Amounts are grouped by currency and never converted.
 */
export function SalesAnalytics({ workspace, version, onOpenDeal, onOpenPipeline }: { workspace: WorkspaceSummary; version: number; onOpenDeal: (dealId: string) => void; onOpenPipeline: () => void }) {
  const [period, setPeriod] = useState<PeriodKey>('30d')
  const [custom, setCustom] = useState(() => periodRange('30d'))
  const range = period === 'custom' ? custom : periodRange(period)
  const [report, setReport] = useState<Analytics | null>(null), [error, setError] = useState('')
  const valid = !!range.from && !!range.to && range.from <= range.to
  useEffect(() => {
    if (!valid) return
    let active = true
    salesAnalytics(workspace.id, range.from, range.to).then(result => { if (active) { setReport(result); setError('') } }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, range.from, range.to, valid, version])
  const today = localDate()
  const noDeals = report && !report.totalDeals
  return <>
    <section className="panel sp-panel">
      <div className="section-heading sp-heading"><div><h2>Period</h2><p>Won, lost, win rate and new deals use this period. The open pipeline is always as of today.</p></div>
        <div className="sp-period">
          <select aria-label="Period" value={period} onChange={event => setPeriod(event.target.value as PeriodKey)}>{(Object.keys(periodLabels) as PeriodKey[]).map(key => <option key={key} value={key}>{periodLabels[key]}</option>)}</select>
          {period === 'custom' && <><label className="sp-inline">From<input type="date" value={custom.from} max={custom.to || undefined} onChange={event => setCustom(current => ({ ...current, from: event.target.value }))} /></label>
            <label className="sp-inline">To<input type="date" value={custom.to} min={custom.from || undefined} onChange={event => setCustom(current => ({ ...current, to: event.target.value }))} /></label></>}
          <span className="sp-muted">{shortDate(range.from)} – {shortDate(range.to)}</span>
        </div></div>
      {!valid && <p className="sp-error sp-inset" role="alert">Choose a start date on or before the end date.</p>}
      {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    </section>
    {!report ? <section className="panel sp-panel"><p className="sp-loading" role="status">Loading analytics…</p></section>
      : noDeals ? <section className="panel sp-panel"><div className="empty"><h3>No deals to analyse yet</h3><p>Analytics are calculated from your deals only. Create deals from leads or report opportunities, and move them through the pipeline.</p><button className="primary" onClick={onOpenPipeline}>Open the pipeline</button></div></section>
      : <>
      <section className="sp-summary" aria-label="Key figures">
        <div><span>Open pipeline</span><strong><Totals totals={report.open.byCurrency} empty="No values yet" compact /></strong><small>{report.open.count} open deal{report.open.count === 1 ? '' : 's'}{report.open.withoutValue ? `, ${report.open.withoutValue} without a value` : ''}</small></div>
        <div><span>Weighted pipeline</span><strong><Totals totals={report.open.byCurrency.map(item => ({ currency: item.currency, value: item.weighted }))} compact /></strong><small>Value × probability; stage default when a deal has none</small></div>
        <div><span>Won in period</span><strong><Totals totals={report.won.byCurrency} empty={report.won.count ? 'No values' : 'None'} compact /></strong><small>{report.won.count} deal{report.won.count === 1 ? '' : 's'} closed won</small></div>
        <div><span>Win rate</span><strong>{report.winRate === null ? '—' : `${report.winRate}%`}</strong><small>{report.closedCount ? `${report.won.count} won of ${report.closedCount} closed (won + lost)` : 'No deals closed in this period'}</small></div>
      </section>
      {report.closedCount > 0 && report.closedCount < fewClosed && <p className="sp-caution" role="note">Only {report.closedCount} deal{report.closedCount === 1 ? '' : 's'} closed in this period, so the win rate and averages can swing a lot with each new result.</p>}
      <div className="sp-analytics-grid">
        <section className="panel sp-panel"><div className="section-heading"><div><h2>Open deals by stage</h2><p>As of today · count and value per currency</p></div></div>
          <Bars rows={report.stages.map(stage => ({ key: stage.stageId, label: stage.name, count: stage.count, color: stage.color, extra: stage.byCurrency.length ? <Totals totals={stage.byCurrency} compact /> : undefined }))} empty="No open deals." /></section>
        <section className="panel sp-panel"><div className="section-heading"><div><h2>Results in period</h2><p>Deals closed between {shortDate(report.from)} and {shortDate(report.to)}</p></div></div>
          <dl className="sp-dl sp-results">
            <div><dt>Won</dt><dd>{report.won.count} · <Totals totals={report.won.byCurrency} empty="no values" /></dd></div>
            <div><dt>Lost</dt><dd>{report.lost.count} · <Totals totals={report.lost.byCurrency} empty="no values" /></dd></div>
            <div><dt>Average won deal</dt><dd>{report.won.byCurrency.length ? report.won.byCurrency.map(item => money(item.average, item.currency)).join(' · ') : '—'}</dd></div>
            <div><dt>Average sales cycle</dt><dd>{report.won.averageCycleDays === null ? '—' : `${report.won.averageCycleDays} days`}<small>From creation to close, won deals</small></dd></div>
            <div><dt>New deals created</dt><dd>{report.createdCount}</dd></div>
            <div><dt>Overdue follow-ups</dt><dd>{report.overdueTasks}<small>Open, linked to deals, due before today</small></dd></div>
          </dl></section>
        <section className="panel sp-panel"><div className="section-heading"><div><h2>Why deals were lost</h2><p>Deals lost in the period</p></div></div>
          <Bars rows={report.lost.reasons.map(item => ({ key: item.reason, label: item.reason, count: item.count }))} empty="No deals were lost in this period." /></section>
        <section className="panel sp-panel"><div className="section-heading"><div><h2>Where new deals came from</h2><p>Deals created in the period</p></div></div>
          <Bars rows={report.bySource.map(item => ({ key: item.source, label: sourceLabels[item.source] ?? item.source, count: item.count }))} empty="No deals were created in this period." /></section>
        <section className="panel sp-panel"><div className="section-heading"><div><h2>By service</h2><p>Deals created in the period, and how many of them are won</p></div></div>
          <Bars rows={report.byService.map(item => ({ key: item.service, label: item.service, count: item.count, extra: <span className="sp-muted">{item.won} won</span> }))} empty="No deals were created in this period." /></section>
        <section className="panel sp-panel"><div className="section-heading"><div><h2>Closing soon</h2><p>Open deals expected to close in the next 30 days, or overdue · {report.upcomingMeetings} meeting{report.upcomingMeetings === 1 ? '' : 's'} in the next 7 days</p></div></div>
          {!report.upcomingCloses.length ? <p className="sp-muted sp-inset">No open deals have an expected close date in the next 30 days.</p>
            : <ul className="sp-closing">{report.upcomingCloses.map(item => <li key={item.id}><button className="sp-link" onClick={() => onOpenDeal(item.id)}>{item.title}</button>
              <span className={item.overdue ? 'is-late' : 'sp-muted'}>{shortDate(item.expectedCloseDate)} · {relativeDays(item.expectedCloseDate, today)}</span><span>{money(item.value, item.currency)}</span></li>)}</ul>}</section>
      </div>
      <p className="sp-footnote">Figures come from this workspace’s deals; archived deals are left out. Amounts in different currencies are shown separately and never converted or added together.</p>
    </>}
  </>
}

function Bars({ rows, empty }: { rows: { key: string; label: string; count: number; color?: string; extra?: React.ReactNode }[]; empty: string }) {
  const max = Math.max(1, ...rows.map(row => row.count))
  if (!rows.some(row => row.count > 0)) return <p className="sp-muted sp-inset">{empty}</p>
  return <ul className="sp-bars">{rows.map(row => <li key={row.key}>
    <span className="sp-bar-label">{row.label}</span>
    <span className="sp-bar-track" aria-hidden="true"><i style={{ width: `${(row.count / max) * 100}%`, ...(row.color ? { '--sp-stage': row.color } : {}) } as CSSProperties} /></span>
    <span className="sp-bar-value">{row.count}{row.extra && <> · {row.extra}</>}</span>
  </li>)}</ul>
}
