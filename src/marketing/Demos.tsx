import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Glyph } from './Glyph'

// Hands-on demos for the home page: win a deal, onboard the client, deliver the project. Everything is local state with
// fictional data; nothing is loaded or saved. The rules mirror the app (docs/CLIENT-MANAGEMENT.md, docs/PROJECTS.md).

/** Moves focus to `target()` after the next render when `pending` is set, so keyboard users never lose their place. */
function useFocusAfter() {
  const pending = useRef<(() => HTMLElement | null | undefined) | null>(null)
  useLayoutEffect(() => {
    const find = pending.current
    if (!find) return
    pending.current = null
    find()?.focus({ preventScroll: true })
  })
  return (find: () => HTMLElement | null | undefined) => { pending.current = find }
}

function DemoFrame({ name, status, onReset, children }: { name: string; status: string; onReset: () => void; children: ReactNode }) {
  return (
    <div className="mk-demo-ui">
      <div className="mk-demo-bar">
        <span className="mk-demo-label"><i aria-hidden="true" />Interactive demo · fictional data</span>
        <button type="button" className="mk-demo-reset" onClick={onReset}><Glyph name="replay" size={13} />Reset<span className="mk-sr"> the {name} demo</span></button>
      </div>
      {children}
      <p className="mk-sr" role="status">{status}</p>
    </div>
  )
}

/* ---------- Win: mark the deal won, then convert it into a client ---------- */

type WinStep = 'open' | 'won' | 'review' | 'client'
const carryDefaults = { contact: true, service: true, onboarding: true }

export function WinDemo() {
  const [step, setStep] = useState<WinStep>('open')
  const [carry, setCarry] = useState(carryDefaults)
  const [status, setStatus] = useState('')
  const actions = useRef<HTMLDivElement>(null)
  const client = useRef<HTMLDivElement>(null)
  const focusAfter = useFocusAfter()
  const go = (next: WinStep, message: string) => {
    setStep(next)
    setStatus(message)
    focusAfter(() => (next === 'client' ? client.current : actions.current?.querySelector('button')))
  }
  const reset = () => { setStep('open'); setCarry(carryDefaults); setStatus('The win demo was reset.') }
  const harbor = (
    <div key="harbor" className={`mk-deal is-focus${step === 'open' ? '' : ' is-won'}`}>
      <strong>Harbor Dental</strong><small>Online booking build</small>
      <b>{step === 'open' ? '$4,800 · 70%' : 'Won · $4,800'}</b>
    </div>
  )
  const columns: [string, ReactNode[]][] = [
    ['Interested', [<div key="fieldwork" className="mk-deal"><strong>Fieldwork Co.</strong><small>Consulting sprint</small><b>$2,500 · 40%</b></div>]],
    ['Proposal sent', [<div key="lumen" className="mk-deal"><strong>Lumen Physio</strong><small>Local SEO</small><b>£1,200 / mo · 60%</b></div>, ...(step === 'open' ? [harbor] : [])]],
    ['Won', step === 'open' ? [] : [harbor]],
  ]
  const toggles: [keyof typeof carryDefaults, string, string][] = [
    ['contact', 'Carry over Dr. Avery Stone', 'Primary contact, found on the About page'],
    ['service', 'Confirm the service “Online booking build”', 'From the deal, with its scope and deliverables'],
    ['onboarding', 'Start onboarding with “Website kickoff”', 'Recommended because the service matches'],
  ]
  return (
    <DemoFrame name="win" status={status} onReset={reset}>
      {step !== 'client' ? (
        <div className="mk-mini-board" aria-label="Sales pipeline, fictional deals" role="group">
          {columns.map(([name, cards]) => (
            <div key={name} className={`mk-mini-col${name === 'Won' ? ' is-won' : ''}`}>
              <span className="mk-mini-col-head">{name}<b>{cards.length}</b></span>
              {cards.length ? cards : <span className="mk-mini-empty">No deals yet</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="mk-client-card" ref={client} tabIndex={-1} aria-label="New client: Harbor Dental">
          <div className="mk-client-top">
            <b className="mk-avatar mk-avatar-lg">HD</b>
            <span><strong>Harbor Dental</strong><small>Client · Onboarding</small></span>
            <span className="mk-badge is-green">New client</span>
          </div>
          <dl className="mk-client-facts">
            <div><dt>From</dt><dd>Deal “Online booking build” · won at $4,800</dd></div>
            <div><dt>Primary contact</dt><dd>{carry.contact ? 'Dr. Avery Stone' : 'None carried over'}</dd></div>
            <div><dt>Services</dt><dd>{carry.service ? 'Online booking build · confirmed' : 'None confirmed yet'}</dd></div>
            <div><dt>Onboarding</dt><dd>{carry.onboarding ? 'Website kickoff checklist created' : 'Not started'}</dd></div>
          </dl>
        </div>
      )}
      {(step === 'open' || step === 'won') && (
        <dl className="mk-client-facts mk-deal-facts" aria-label="Harbor Dental deal">
          <div><dt>Stage</dt><dd>{step === 'open' ? 'Proposal sent · 70% probability' : 'Won · closed today'}</dd></div>
          <div><dt>{step === 'open' ? 'Weighted value' : 'Final value'}</dt><dd>{step === 'open' ? '$3,360 of $4,800' : '$4,800'}</dd></div>
          <div><dt>Contact</dt><dd>Dr. Avery Stone · Owner</dd></div>
          <div><dt>From</dt><dd>Report opportunity “Add online booking”</dd></div>
        </dl>
      )}
      {step === 'review' && (
        <fieldset className="mk-review">
          <legend>Convert to client · review</legend>
          {toggles.map(([key, label, note]) => (
            <label key={key} className="mk-check-row">
              <input type="checkbox" checked={carry[key]} onChange={event => setCarry(value => ({ ...value, [key]: event.target.checked }))} />
              <span><strong>{label}</strong><small>{note}</small></span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="mk-demo-actions" ref={actions}>
        {step === 'open' && <button type="button" className="mk-demo-btn" onClick={() => go('won', 'Harbor Dental was marked won at $4,800 and moved to Won.')}><Glyph name="trophy" size={15} />Mark won</button>}
        {step === 'won' && <button type="button" className="mk-demo-btn" onClick={() => go('review', 'Review what carries over to the new client.')}><Glyph name="users" size={15} />Convert to client</button>}
        {step === 'review' && <>
          <button type="button" className="mk-demo-btn" onClick={() => go('client', 'Harbor Dental is now a client.')}><Glyph name="check" size={15} />Create client</button>
          <button type="button" className="mk-demo-btn is-ghost" onClick={() => go('won', 'Back to the pipeline.')}>Back</button>
        </>}
        {step === 'client' && <p className="mk-demo-done"><Glyph name="checkCircle" size={16} />Harbor Dental is now a client. The contacts, service and checklist were created in one step.</p>}
      </div>
    </DemoFrame>
  )
}

/* ---------- Onboard: resolve checklist items and watch readiness ---------- */

const onboardItems = [
  { id: 'assets', label: 'Brand assets', who: 'Client', note: 'File upload · 3 files accepted' },
  { id: 'hours', label: 'Booking hours form', who: 'Client', note: 'Form · submitted and accepted' },
  { id: 'access', label: 'Website hosting access', who: 'Client', note: 'Access · confirmed by your team' },
  { id: 'scope', label: 'Scope confirmed', who: 'Agency', note: 'A dated record, not a contract' },
  { id: 'welcome', label: 'Welcome message sent', who: 'Agency', note: 'You send it yourself, then mark it sent' },
] as const
type OnboardId = typeof onboardItems[number]['id']
const onboardStart: OnboardId[] = ['assets', 'welcome']

export function OnboardDemo() {
  const [done, setDone] = useState<OnboardId[]>(onboardStart)
  const [completed, setCompleted] = useState(false)
  const [status, setStatus] = useState('')
  const result = useRef<HTMLParagraphElement>(null)
  const focusAfter = useFocusAfter()
  const total = onboardItems.length
  const clientLeft = onboardItems.filter(item => item.who === 'Client' && !done.includes(item.id)).length
  const agencyLeft = onboardItems.filter(item => item.who === 'Agency' && !done.includes(item.id)).length
  const ready = clientLeft === 0 && agencyLeft === 0
  const state = completed ? 'Onboarded' : ready ? 'Ready to complete' : clientLeft ? `Waiting on the client · ${clientLeft} ${clientLeft === 1 ? 'item' : 'items'}` : 'Agency steps left'
  const ratio = done.length / total
  const toggle = (id: OnboardId, on: boolean) => {
    const next = on ? [...done, id] : done.filter(item => item !== id)
    setDone(next)
    const label = onboardItems.find(item => item.id === id)?.label
    setStatus(`${label} ${on ? 'resolved' : 'reopened'}. Readiness ${next.length} of ${total}.`)
  }
  const complete = () => { setCompleted(true); setStatus('Onboarding completed. Harbor Dental is onboarded.'); focusAfter(() => result.current) }
  const reset = () => { setDone(onboardStart); setCompleted(false); setStatus('The onboarding demo was reset.') }
  return (
    <DemoFrame name="onboarding" status={status} onReset={reset}>
      <div className="mk-onboard">
        <div className="mk-ring-wrap">
          <svg className="mk-ring" viewBox="0 0 80 80" aria-hidden="true">
            <circle cx="40" cy="40" r="32" className="mk-ring-track" />
            <circle cx="40" cy="40" r="32" className="mk-ring-fill" style={{ strokeDashoffset: `${201.06 * (1 - ratio)}` }} />
          </svg>
          <span className="mk-ring-label"><strong>{done.length} of {total}</strong><small>ready</small></span>
        </div>
        <div className="mk-onboard-head">
          <strong>Harbor Dental · Website kickoff</strong>
          <span className={`mk-badge ${completed || ready ? 'is-green' : 'is-amber'}`}>{state}</span>
          <small>Client link active · the client sees only this checklist</small>
        </div>
      </div>
      <fieldset className="mk-onboard-list" disabled={completed}>
        <legend className="mk-sr">Checklist items</legend>
        {onboardItems.map(item => (
          <label key={item.id} className={`mk-check-row${done.includes(item.id) ? ' is-done' : ''}`}>
            <input type="checkbox" checked={done.includes(item.id)} onChange={event => toggle(item.id, event.target.checked)} />
            <span><strong>{item.label}</strong><small>{item.note}</small></span>
            <i className={`mk-who is-${item.who.toLowerCase()}`}>{item.who}</i>
          </label>
        ))}
      </fieldset>
      <div className="mk-demo-actions">
        {completed
          ? <p className="mk-demo-done" ref={result} tabIndex={-1}><Glyph name="checkCircle" size={16} />Onboarded. A project can now start from the confirmed scope.</p>
          : <button type="button" className="mk-demo-btn" disabled={!ready} onClick={complete}><Glyph name="check" size={15} />Complete onboarding</button>}
        {!completed && !ready && <small className="mk-demo-hint">Resolve every item to complete onboarding.</small>}
      </div>
    </DemoFrame>
  )
}

/* ---------- Deliver: move tasks, watch progress, health and the timeline ---------- */

const columns = ['todo', 'doing', 'done'] as const
type Column = typeof columns[number]
const columnNames: Record<Column, string> = { todo: 'To do', doing: 'In progress', done: 'Done' }
interface DemoTask { id: string; title: string; milestone: string; column: Column; high?: boolean; waitsFor?: string }
const startTasks: DemoTask[] = [
  { id: 'sitemap', title: 'Sitemap and page list', milestone: 'Discovery', column: 'done' },
  { id: 'design', title: 'Homepage design', milestone: 'Design', column: 'doing' },
  { id: 'booking', title: 'Booking page build', milestone: 'Build', column: 'todo', high: true },
  { id: 'content', title: 'Content migration', milestone: 'Build', column: 'todo' },
  { id: 'launch', title: 'Launch checklist', milestone: 'Launch', column: 'todo', waitsFor: 'booking' },
]
const milestones = [['Discovery', 0, 20], ['Design', 14, 42], ['Build', 36, 80], ['Launch', 80, 96]] as const
const TODAY = 46

export function DeliverDemo() {
  const [tasks, setTasks] = useState(startTasks)
  const [overdue, setOverdue] = useState(false)
  const [late, setLate] = useState(false)
  const [status, setStatus] = useState('')
  const board = useRef<HTMLDivElement>(null)
  const focusAfter = useFocusAfter()
  const doneCount = tasks.filter(task => task.column === 'done').length
  const percent = Math.round((doneCount / tasks.length) * 100)
  const booking = tasks.find(task => task.id === 'booking')
  // The same rules as the app: Delayed outranks At risk; an overdue task stops counting once it is completed.
  const reasons: { level: 'delayed' | 'at_risk'; text: string }[] = []
  if (late) reasons.push({ level: 'delayed', text: 'The target completion date has passed' })
  if (overdue && booking?.column !== 'done') reasons.push({ level: 'at_risk', text: 'A high-priority task is overdue: Booking page build' })
  const health = reasons.some(reason => reason.level === 'delayed') ? 'delayed' : reasons.length ? 'at_risk' : 'on_track'
  const healthLabel = { delayed: 'Delayed', at_risk: 'At risk', on_track: 'On track' }[health]
  const healthAfter = (nextTasks: DemoTask[], nextOverdue: boolean, nextLate: boolean) =>
    nextLate ? 'Delayed' : nextOverdue && nextTasks.find(task => task.id === 'booking')?.column !== 'done' ? 'At risk' : 'On track'

  const move = (task: DemoTask, direction: -1 | 1) => {
    const column = columns[columns.indexOf(task.column) + direction]
    const next = tasks.map(item => (item.id === task.id ? { ...item, column } : item))
    setTasks(next)
    const completed = next.filter(item => item.column === 'done').length
    setStatus(`${task.title} moved to ${columnNames[column]}. Progress ${completed} of ${next.length} tasks. Health: ${healthAfter(next, overdue, late)}.`)
    const keep = direction === 1 ? 'next' : 'back'
    focusAfter(() => board.current?.querySelector<HTMLElement>(`[data-move="${task.id}-${keep}"]`) ?? board.current?.querySelector<HTMLElement>(`[data-move^="${task.id}-"]`))
  }
  const flip = (which: 'overdue' | 'late') => {
    const nextOverdue = which === 'overdue' ? !overdue : overdue
    const nextLate = which === 'late' ? !late : late
    setOverdue(nextOverdue)
    setLate(nextLate)
    setStatus(`Health: ${healthAfter(tasks, nextOverdue, nextLate)}.`)
  }
  const reset = () => { setTasks(startTasks); setOverdue(false); setLate(false); setStatus('The delivery demo was reset.') }
  const milestoneDone = (name: string) => {
    const own = tasks.filter(task => task.milestone === name)
    return own.length ? own.filter(task => task.column === 'done').length / own.length : 0
  }
  const timelineLabel = `Timeline: ${milestones.map(([name]) => `${name} ${Math.round(milestoneDone(name) * 100)}% done`).join(', ')}. Today is during Build.`

  return (
    <DemoFrame name="delivery" status={status} onReset={reset}>
      <div className="mk-deliver">
        <div className="mk-task-board" ref={board} role="group" aria-label="Project task board, fictional tasks">
          {columns.map((column, index) => {
            const own = tasks.filter(task => task.column === column)
            return (
              <div key={column} className={`mk-task-col is-${column}`}>
                <span className="mk-mini-col-head">{columnNames[column]}<b>{own.length}</b></span>
                {own.map(task => {
                  const waiting = task.waitsFor && tasks.find(item => item.id === task.waitsFor)?.column !== 'done'
                  const isOverdue = task.high && overdue && task.column !== 'done'
                  return (
                    <div key={task.id} className={`mk-task-card${isOverdue ? ' is-overdue' : ''}`}>
                      <strong>{task.title}</strong>
                      <span className="mk-task-meta">
                        <i>{task.milestone}</i>
                        {task.high && <i className="is-high">High</i>}
                        {isOverdue && <i className="is-overdue">Overdue</i>}
                        {waiting && <i className="is-wait">Waits for Booking page build</i>}
                      </span>
                      <span className="mk-task-move">
                        {index > 0 && <button type="button" data-move={`${task.id}-back`} aria-label={`Move ${task.title} back to ${columnNames[columns[index - 1]]}`} onClick={() => move(task, -1)}><Glyph name="arrowLeft" size={14} /></button>}
                        {index < columns.length - 1 && <button type="button" data-move={`${task.id}-next`} aria-label={`Move ${task.title} to ${columnNames[columns[index + 1]]}`} onClick={() => move(task, 1)}><Glyph name="arrowRight" size={14} /></button>}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="mk-deliver-side">
          <div className="mk-deliver-block">
            <span className="mk-project-progress"><span>Progress <b>{percent}%</b></span><small>{doneCount} of {tasks.length} tasks completed</small></span>
            <div className="mk-bar mk-bar-lg"><span style={{ width: `${percent}%` }} /></div>
            <small className="mk-basis">Counts tasks because this project has no deliverables yet; deliverables and tasks are never mixed.</small>
          </div>
          <div className="mk-deliver-block">
            <span className="mk-project-progress"><span>Health</span><i className={`mk-health is-${health}`}>{healthLabel}</i></span>
            {reasons.length
              ? <ul className="mk-reasons">{reasons.map(reason => <li key={reason.text} className={`is-${reason.level}`}><Glyph name="info" size={14} />{reason.text}</li>)}</ul>
              : <small className="mk-basis">No overdue high-priority tasks, missed dates or blocked work.</small>}
            <div className="mk-switches">
              <button type="button" role="switch" aria-checked={overdue} onClick={() => flip('overdue')}><span className="mk-switch-knob" aria-hidden="true" />Booking page build is overdue</button>
              <button type="button" role="switch" aria-checked={late} onClick={() => flip('late')}><span className="mk-switch-knob" aria-hidden="true" />The target date has passed</button>
            </div>
          </div>
        </div>
        <div className="mk-gantt mk-gantt-live" role="img" aria-label={timelineLabel}>
          {milestones.map(([name, from, to]) => (
            <div key={name} className="mk-gantt-row">
              <span>{name}</span>
              <span className="mk-gantt-track"><i style={{ left: `${from}%`, width: `${to - from}%` }}><em style={{ width: `${milestoneDone(name) * 100}%` }} /></i></span>
            </div>
          ))}
          <span className="mk-gantt-today" style={{ '--today': TODAY / 100 } as CSSProperties}>Today</span>
        </div>
      </div>
    </DemoFrame>
  )
}
