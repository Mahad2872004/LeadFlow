import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon, type IconName } from './Icon'

export interface Command { id: string; group: 'Go to' | 'Actions' | 'Leads' | 'Clients'; label: string; hint?: string; icon: IconName; run: () => void }

/** ⌘K / Ctrl+K menu: jump to a page, run an action, or open a lead. Mounted only while open. */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  useEffect(() => {
    const element = dialog.current
    if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement
    element?.showModal()
    input.current?.focus()
    return () => { element?.close(); if (opener.current?.isConnected) opener.current.focus() }
  }, [])

  const text = query.trim().toLowerCase()
  const matches = text
    ? commands.filter(command => `${command.label} ${command.hint ?? ''}`.toLowerCase().includes(text))
    : commands
  const leads = matches.filter(command => command.group === 'Leads').slice(0, text ? 8 : 5)
  // Clients (M10) appear only when searching, so the empty menu stays short.
  const clients = text ? matches.filter(command => command.group === 'Clients').slice(0, 5) : []
  const results = [...matches.filter(command => command.group !== 'Leads' && command.group !== 'Clients'), ...leads, ...clients]
  const current = Math.min(active, Math.max(0, results.length - 1))
  const run = (command?: Command) => { if (!command) return; onClose(); command.run() }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length) setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length)
    } else if (event.key === 'Enter') { event.preventDefault(); run(results[current]) }
  }
  useEffect(() => { document.getElementById(`${id}-option-${current}`)?.scrollIntoView({ block: 'nearest' }) }, [current, id])

  let index = -1
  return <dialog ref={dialog} className="command-palette" aria-label="Command menu"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }}>
    <div className="command-input">
      <Icon name="search" size={18}/>
      <input ref={input} value={query} placeholder="Jump to a page, run an action, or find a lead…" aria-label="Search pages, actions and leads"
        role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={results.length ? `${id}-option-${current}` : undefined}
        onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={onKeyDown}/>
      <kbd>Esc</kbd>
    </div>
    <div className="command-list" id={`${id}-list`} role="listbox" aria-label="Results">
      {results.length === 0 && <p className="command-empty">No matches for “{query.trim()}”.</p>}
      {(['Go to', 'Actions', 'Leads', 'Clients'] as const).map(group => {
        const items = results.filter(command => command.group === group)
        if (!items.length) return null
        return <div key={group} role="group" aria-label={group} className="command-group">
          <span className="command-group-label" aria-hidden="true">{group}</span>
          {items.map(command => {
            index++
            const position = index
            return <div key={command.id} id={`${id}-option-${position}`} role="option" aria-selected={position === current}
              className={`command-option${position === current ? ' is-active' : ''}`}
              onMouseMove={() => { if (position !== current) setActive(position) }} onClick={() => run(command)}>
              <span className="command-icon"><Icon name={command.icon} size={16}/></span>
              <span className="command-label">{command.label}{command.hint && <small>{command.hint}</small>}</span>
              {position === current && <span className="command-enter" aria-hidden="true">↵</span>}
            </div>
          })}
        </div>
      })}
    </div>
    <div className="command-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>esc</kbd> to close</span></div>
  </dialog>
}
