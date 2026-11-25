import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { prefersReducedMotion } from '../hooks/useMotion'

// A number per message list, so each new message (even a repeated one) gets a fresh toast.
const listIds = new WeakMap<string[], number>()
let lastId = 0
function idOf(events: string[]) {
  let id = listIds.get(events)
  if (id === undefined) { id = ++lastId; listIds.set(events, id) }
  return id
}

/**
 * The newest workspace message. It closes by itself after a few seconds, or with its close
 * button. Pointing at it or focusing it holds it open. The notification center keeps the
 * full history, so closing a toast loses nothing.
 */
export function Toast({ events, duration = 7000 }: { events: string[]; duration?: number }) {
  // `events` is replaced on every new message, so remembering which list was closed is enough.
  const [closed, setClosed] = useState<string[] | null>(null)
  const [held, setHeld] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const message = events[0]
  const open = Boolean(message) && closed !== events
  const dismiss = useCallback(() => {
    const finish = () => { setClosed(events); setHeld(false) }
    const element = box.current
    if (!element || prefersReducedMotion() || typeof element.animate !== 'function') { finish(); return }
    // Fold the space away rather than letting the page jump up.
    const height = element.getBoundingClientRect().height
    element.animate(
      [{ height: `${height}px`, opacity: 1 }, { height: '0px', opacity: 0, marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' }],
      { duration: 220, easing: 'ease-in', fill: 'forwards' },
    ).onfinish = finish
  }, [events])
  useEffect(() => {
    if (!open || held) return
    const timer = window.setTimeout(dismiss, duration)
    return () => window.clearTimeout(timer)
  }, [open, held, dismiss, duration])
  if (!open) return null
  return <div key={idOf(events)} ref={box} className={`toast${held ? ' is-held' : ''}`} role="status"
    onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
    onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false) }}>
    <span className="toast-check" aria-hidden="true">✓</span>
    <span className="toast-text">{message}</span>
    <button type="button" className="toast-close" aria-label="Dismiss message" onClick={dismiss}><Icon name="close" size={14} /></button>
    {!held && <i className="toast-timer" style={{ animationDuration: `${duration}ms` }} aria-hidden="true" />}
  </div>
}
