import { useEffect, useState, type CSSProperties } from 'react'
import { Modal } from './Modal'
import { StageBadge } from './SalesBits'
import { archiveStage, categoryLabels, reorderStages, restoreStage, salesPipeline, saveSalesSettings, saveStage, stageColors, colorNames, type Pipeline, type Stage, type StageCategory, errorText } from '../lib/sales'

/**
 * Pipeline settings: stages (name, colour, default probability, order, archive and restore), currencies, lost reasons
 * and the stage new deals start in. Owners and admins change them; members can see them.
 */
export function PipelineSettings({ workspaceId, onChanged, onClose }: { workspaceId: string; onChanged: (message: string) => void; onClose: () => void }) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [archiving, setArchiving] = useState<{ stage: Stage; reassignTo: string } | null>(null)
  const [adding, setAdding] = useState({ name: '', color: stageColors[3], probability: '', category: 'open' as StageCategory })
  useEffect(() => { salesPipeline(workspaceId).then(setPipeline).catch(cause => setError(errorText(cause))) }, [workspaceId])
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('')
    try { await action(); setPipeline(await salesPipeline(workspaceId)); setNotice(message); onChanged(message); return true }
    catch (cause) { setError(errorText(cause)); setPipeline(await salesPipeline(workspaceId).catch(() => pipeline)); return false }
    finally { setBusy(false) }
  }
  if (!pipeline) return <Modal title="Pipeline settings" onClose={onClose}><p className="sp-loading" role="status">{error || 'Loading…'}</p></Modal>
  const can = pipeline.canConfigure, active = pipeline.stages.filter(stage => !stage.archived), archived = pipeline.stages.filter(stage => stage.archived)
  function moveStage(index: number, step: -1 | 1) {
    const ids = active.map(stage => stage.id), target = index + step
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    void act(() => reorderStages(workspaceId, ids), 'Stage order saved.')
  }
  return <Modal title="Pipeline settings" onClose={onClose}>
    <div className="sp-settings">
      {!can && <p className="sp-notice">Only workspace owners and admins can change the pipeline. You can see how it’s set up.</p>}
      {notice && <p className="sp-notice" role="status">{notice}</p>}
      {error && <p className="sp-error" role="alert">{error}</p>}
      <h3>Stages</h3>
      <p className="sp-muted">Deals move left to right through open stages, then close as won or lost. The probability is used for weighted value when a deal has none of its own.</p>
      <ol className="sp-stage-list">{active.map((stage, index) => <StageRow key={`${stage.id}:${stage.name}:${stage.color}:${stage.probability}`} stage={stage} first={index === 0} last={index === active.length - 1} can={can} busy={busy}
        onSave={changes => act(() => saveStage(workspaceId, { id: stage.id, ...changes }), `${changes.name ?? stage.name} saved.`)}
        onMove={step => moveStage(index, step)} onArchive={() => setArchiving({ stage, reassignTo: '' })} />)}</ol>
      {archiving && <div className="sp-confirm"><p>Archive “{archiving.stage.name}”?{archiving.stage.dealCount ? ` Its ${archiving.stage.dealCount} deal${archiving.stage.dealCount === 1 ? '' : 's'} move to the stage you choose, with an entry in each deal’s history.` : ' It has no deals.'} You can restore it later.</p>
        {!!archiving.stage.dealCount && <label className="sp-inline">Move deals to<select value={archiving.reassignTo} onChange={event => setArchiving({ ...archiving, reassignTo: event.target.value })}><option value="">Choose a stage…</option>
          {active.filter(stage => stage.id !== archiving.stage.id && stage.category === archiving.stage.category).map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>}
        <div className="sp-actions"><button className="secondary" onClick={() => setArchiving(null)}>Cancel</button>
          <button className="primary" disabled={busy || (!!archiving.stage.dealCount && !archiving.reassignTo)} onClick={async () => { if (await act(() => archiveStage(workspaceId, archiving.stage.id, archiving.reassignTo || null), `${archiving.stage.name} archived.`)) setArchiving(null) }}>Archive stage</button></div></div>}
      {can && <form className="sp-add-stage" onSubmit={async event => { event.preventDefault(); if (await act(() => saveStage(workspaceId, { name: adding.name, color: adding.color, category: adding.category, probability: adding.probability === '' ? null : Number(adding.probability) }), `${adding.name} added.`)) setAdding({ ...adding, name: '', probability: '' }) }}>
        <label>New stage<input required maxLength={60} value={adding.name} placeholder="e.g. Discovery call" onChange={event => setAdding({ ...adding, name: event.target.value })} /></label>
        <label>Kind<select value={adding.category} onChange={event => setAdding({ ...adding, category: event.target.value as StageCategory })}>{(['open', 'won', 'lost'] as const).map(category => <option key={category} value={category}>{categoryLabels[category]}</option>)}</select></label>
        <label>Probability %<input inputMode="numeric" value={adding.probability} placeholder="Optional" onChange={event => setAdding({ ...adding, probability: event.target.value.replace(/[^\d]/g, '').slice(0, 3) })} /></label>
        <ColorPicker value={adding.color} onChange={color => setAdding({ ...adding, color })} />
        <button className="secondary" disabled={busy}>Add stage</button>
      </form>}
      {archived.length > 0 && <><h4>Archived stages</h4><ul className="sp-archived">{archived.map(stage => <li key={stage.id}><StageBadge stage={stage} />{can && <button className="text-button" disabled={busy} onClick={() => void act(() => restoreStage(workspaceId, stage.id), `${stage.name} restored.`)}>Restore</button>}</li>)}</ul></>}
      <DealSettings pipeline={pipeline} can={can} busy={busy} onSave={settings => act(() => saveSalesSettings(workspaceId, settings), 'Pipeline settings saved.')} />
    </div>
  </Modal>
}

function StageRow({ stage, first, last, can, busy, onSave, onMove, onArchive }: {
  stage: Stage; first: boolean; last: boolean; can: boolean; busy: boolean; onSave: (changes: Partial<Stage>) => Promise<boolean>; onMove: (step: -1 | 1) => void; onArchive: () => void
}) {
  const [name, setName] = useState(stage.name), [probability, setProbability] = useState(stage.probability === null ? '' : String(stage.probability)), [color, setColor] = useState(stage.color)
  const dirty = name.trim() !== stage.name || probability !== (stage.probability === null ? '' : String(stage.probability)) || color !== stage.color
  return <li className={`is-${stage.category}`} style={{ '--sp-stage': color } as CSSProperties}>
    <span className="sp-swatch" aria-hidden="true" />
    {can ? <>
      <input aria-label={`Name of ${stage.name}`} maxLength={60} value={name} onChange={event => setName(event.target.value)} />
      <span className="sp-chip">{categoryLabels[stage.category]}</span>
      <label className="sp-prob"><input aria-label={`Default probability for ${stage.name}`} inputMode="numeric" value={probability} placeholder="—" onChange={event => setProbability(event.target.value.replace(/[^\d]/g, '').slice(0, 3))} />%</label>
      <ColorPicker value={color} onChange={setColor} compact label={`Colour of ${stage.name}`} />
      <span className="sp-muted sp-count">{stage.dealCount ?? 0} deal{stage.dealCount === 1 ? '' : 's'}</span>
      <span className="sp-row-actions">
        {dirty && <button className="primary" disabled={busy || !name.trim()} onClick={() => void onSave({ name: name.trim(), color, probability: probability === '' ? null : Number(probability) })}>Save</button>}
        <button className="icon-button" disabled={busy || first} aria-label={`Move ${stage.name} up`} onClick={() => onMove(-1)}>↑</button>
        <button className="icon-button" disabled={busy || last} aria-label={`Move ${stage.name} down`} onClick={() => onMove(1)}>↓</button>
        <button className="text-button" disabled={busy} onClick={onArchive}>Archive</button>
      </span>
    </> : <><strong>{stage.name}</strong><span className="sp-chip">{categoryLabels[stage.category]}</span><span className="sp-muted">{stage.probability === null ? '' : `${stage.probability}%`}</span><span className="sp-muted sp-count">{stage.dealCount ?? 0} deals</span></>}
  </li>
}

function ColorPicker({ value, onChange, compact = false, label = 'Colour' }: { value: string; onChange: (color: string) => void; compact?: boolean; label?: string }) {
  return <label className={compact ? 'sp-color is-compact' : 'sp-color'}>{!compact && 'Colour'}<select aria-label={label} value={value} onChange={event => onChange(event.target.value)} style={{ '--sp-stage': value } as CSSProperties}>
    {[...new Set([...stageColors, value])].map(color => <option key={color} value={color}>{colorNames[color] ?? color}</option>)}</select></label>
}

function DealSettings({ pipeline, can, busy, onSave }: { pipeline: Pipeline; can: boolean; busy: boolean; onSave: (settings: Parameters<typeof saveSalesSettings>[1]) => Promise<boolean> }) {
  const [currencies, setCurrencies] = useState(pipeline.settings.currencies.join(', ')), [defaultCurrency, setDefaultCurrency] = useState(pipeline.settings.defaultCurrency)
  const [reasons, setReasons] = useState(pipeline.settings.lostReasons.join('\n')), [defaultStage, setDefaultStage] = useState(pipeline.settings.defaultStageId ?? '')
  const codes = currencies.split(/[\s,]+/).map(code => code.trim().toUpperCase()).filter(Boolean)
  return <form className="sp-form sp-deal-settings" onSubmit={event => { event.preventDefault(); void onSave({ currencies: codes, defaultCurrency, lostReasons: reasons.split('\n').map(reason => reason.trim()).filter(Boolean), defaultStageId: defaultStage || undefined }) }}>
    <h3>Deals</h3>
    <div className="sp-row">
      <label>Currencies<input disabled={!can} value={currencies} onChange={event => setCurrencies(event.target.value)} /><small>Three-letter codes, such as USD, GBP, EUR. Totals are kept per currency; nothing is converted.</small></label>
      <label>Default currency<select disabled={!can} value={defaultCurrency} onChange={event => setDefaultCurrency(event.target.value)}>{[...new Set([...codes.filter(code => /^[A-Z]{3}$/.test(code)), defaultCurrency])].map(code => <option key={code}>{code}</option>)}</select></label>
    </div>
    <label>New deals start in<select disabled={!can} value={defaultStage} onChange={event => setDefaultStage(event.target.value)}>{pipeline.stages.filter(stage => !stage.archived && stage.category === 'open').map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
    <label>Lost reasons<textarea disabled={!can} rows={6} value={reasons} onChange={event => setReasons(event.target.value)} /><small>One per line, up to 20. Deals already lost keep their reason.</small></label>
    {can && <div className="sp-actions"><button className="primary" disabled={busy}>Save deal settings</button></div>}
  </form>
}
