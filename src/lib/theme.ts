import { useSyncExternalStore } from 'react'

/** Light, dark, or follow the operating system. Stored per browser. */
export type ThemePreference = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const key = 'leadflow.theme'
const changeEvent = 'leadflow:theme'
const media = () => typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

/** Everything is themed except the inquiry form, which businesses embed in their own websites and so stays light. */
export const isThemedPath = (path: string) => (path.replace(/\/+$/, '') || '/') !== '/inquiry'

export function readPreference(): ThemePreference {
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : 'system' } catch { return 'system' }
}
export const resolveTheme = (preference: ThemePreference): Theme => preference === 'system' ? (media()?.matches ? 'dark' : 'light') : preference

export function setPreference(preference: ThemePreference) {
  try { if (preference === 'system') localStorage.removeItem(key); else localStorage.setItem(key, preference) } catch { /* Storage can be unavailable; the choice still applies to this page. */ }
  applyTheme(preference)
  window.dispatchEvent(new Event(changeEvent))
}
export function applyTheme(preference = readPreference()) {
  document.documentElement.dataset.theme = resolveTheme(preference)
}

/** Applies the theme while mounted and follows system changes. Returns a cleanup that removes it again. */
export function watchTheme() {
  applyTheme()
  const query = media()
  const onSystem = () => { if (readPreference() === 'system') applyTheme('system') }
  query?.addEventListener('change', onSystem)
  return () => { query?.removeEventListener('change', onSystem); delete document.documentElement.dataset.theme }
}

function subscribe(onChange: () => void) {
  const query = media()
  window.addEventListener(changeEvent, onChange)
  window.addEventListener('storage', onChange)
  query?.addEventListener('change', onChange)
  return () => { window.removeEventListener(changeEvent, onChange); window.removeEventListener('storage', onChange); query?.removeEventListener('change', onChange) }
}
const snapshot = () => `${readPreference()}:${resolveTheme(readPreference())}`

/** The stored preference and the theme it resolves to right now. */
export function useTheme(): { preference: ThemePreference; theme: Theme } {
  const [preference, theme] = useSyncExternalStore(subscribe, snapshot, () => 'system:light').split(':') as [ThemePreference, Theme]
  return { preference, theme }
}
