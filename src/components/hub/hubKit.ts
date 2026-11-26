import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { dateLabel } from '../../lib/format'
import type { ClientRole, ReviewStatus } from '../../lib/hub'

// The client portal's shared state and helpers (no components here, so fast refresh keeps working).

export interface HubSession {
  accessId: string; userId: string; userEmail: string; name: string; email: string; role: ClientRole; clientName: string; agencyName: string
  accounts: { accessId: string; clientName: string; agencyName: string }[]
  unread: number; refreshUnread: () => void; setAccess: (accessId: string) => void; signOut: () => Promise<void>
  /** Reloads the person's client spaces (after a name change, for example). */
  reloadAccounts: () => void
}
export const HubContext = createContext<HubSession | null>(null)
export function useHub() {
  const value = useContext(HubContext)
  if (!value) throw new Error('useHub outside the client portal')
  return value
}

export const errorText = (cause: unknown) => cause instanceof Error && cause.message ? cause.message : 'Something went wrong. Try again.'
export const isUuid = (value: string | undefined) => !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/** Loads data for a key. Reloading keeps the last data on screen; a new key shows loading. */
export function useLoad<T>(key: string, load: () => Promise<T>) {
  const [result, setResult] = useState<{ key: string; data?: T; error?: string } | null>(null)
  const [version, setVersion] = useState(0)
  const loader = useRef(load)
  useEffect(() => { loader.current = load })
  useEffect(() => {
    let active = true
    loader.current().then(
      data => { if (active) setResult({ key, data }) },
      (cause: unknown) => { if (active) setResult(previous => previous?.key === key && previous.data !== undefined ? { ...previous, error: errorText(cause) } : { key, error: errorText(cause) }) })
    return () => { active = false }
  }, [key, version])
  const mine = result?.key === key ? result : null
  const reload = useCallback(() => setVersion(value => value + 1), [])
  const replace = useCallback((data: T) => setResult({ key, data }), [key])
  return { data: mine?.data, error: mine && mine.data === undefined ? mine.error : undefined, loading: !mine, reload, replace }
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand'
export const reviewTone = (status: ReviewStatus): Tone =>
  status === 'awaiting_review' || status === 'resubmitted' ? 'info' : status === 'changes_requested' ? 'warning' : status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : 'neutral'
export const projectTone = (status: string): Tone => status === 'in_progress' ? 'info' : status === 'completed' ? 'success' : status === 'on_hold' ? 'warning' : 'neutral'
export const feedbackTone = (status: string): Tone => status === 'addressed' ? 'success' : status === 'clarification_requested' ? 'warning' : status === 'acknowledged' ? 'info' : 'neutral'

/** "just now", "5 min ago", "3 h ago", "yesterday", then the date. */
export function timeAgo(iso: string) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  if (seconds < 172800) return 'yesterday'
  return dateLabel(iso)
}
/** "Due today", "Due in 3 days", "2 days overdue". */
export function dueText(date: string | null) {
  if (!date) return 'No due date'
  const today = new Date(); today.setHours(12, 0, 0, 0)
  const due = new Date(`${date}T12:00:00`)
  const days = Math.round((due.getTime() - today.getTime()) / 86400000)
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days > 1) return `Due in ${days} days`
  return `${-days} day${days === -1 ? '' : 's'} overdue`
}
export const firstName = (name: string, email: string) => (name.trim().split(/\s+/)[0] || email.split('@')[0] || 'there')

export const roleLabel: Record<ClientRole, string> = { admin: 'Client admin', member: 'Client member', reviewer: 'Client reviewer' }

const accessKey = 'leadflow.portal.access'
export const rememberAccess = (accessId: string) => { try { localStorage.setItem(accessKey, accessId) } catch { /* storage unavailable */ } }
export const rememberedAccess = () => { try { return localStorage.getItem(accessKey) } catch { return null } }
export const passwordProblem = (password: string, confirm: string) => password.length < 8 ? 'Use at least 8 characters.' : password !== confirm ? 'The passwords don’t match.' : ''
export const projectTabs = ['overview', 'timeline', 'deliverables', 'messages', 'files', 'updates'] as const
export type ProjectTab = typeof projectTabs[number]
