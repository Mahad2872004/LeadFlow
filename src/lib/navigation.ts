import { useSyncExternalStore } from 'react'
// LeadFlow has no router library: private routes switch with the History API, marketing pages use plain links.
const changeEvent = 'leadflow:navigate'
function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  window.addEventListener(changeEvent, onChange)
  return () => { window.removeEventListener('popstate', onChange); window.removeEventListener(changeEvent, onChange) }
}
export function navigate(to: string, { replace = false } = {}) {
  if (to === window.location.pathname + window.location.search) return
  if (replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.dispatchEvent(new Event(changeEvent))
}
export const usePathname = () => useSyncExternalStore(subscribe, () => window.location.pathname)
/** Post-sign-in destinations are limited to the app itself, so a crafted link cannot send users elsewhere. */
export function safeNext(value: string | null): string {
  return value && /^\/app(?:[/?#]|$)/.test(value) ? value : '/app'
}
