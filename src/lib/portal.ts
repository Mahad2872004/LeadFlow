import type { ItemKind, ItemState, RequestStatus, ResponseValue } from './onboardingOptions'
// Client portal. The browser sends the link token to the client-portal Edge Function, which hashes it; the
// database finds the single request it belongs to. Nothing in the request chooses a workspace.
export interface PortalItem { id: string; section: string; title: string; guidance: string; kind: ItemKind; options: string[]; required: boolean; dueDate: string | null; state: ItemState; value: ResponseValue | null; hasDraft: boolean; submittedAt: string | null; revision: number; feedback: string | null }
export interface PortalView { agencyName: string; title: string; clientName: string; status: RequestStatus; linkExpiresAt: string; instructions: string; dueDate: string | null; allAccepted: boolean; confirmedAt: string | null; items: PortalItem[] }
export class PortalError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status } }
export async function portalCall<T>(body: Record<string, unknown>): Promise<T> {
  const endpoint = import.meta.env.VITE_SUPABASE_URL
  if (!endpoint) throw new PortalError('Onboarding isn’t available right now. Please try again later.', 503)
  let response: Response
  try { response = await fetch(`${endpoint}/functions/v1/client-portal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000) }) }
  catch { throw new PortalError('We couldn’t reach your checklist. Check your connection and try again; nothing you saved has been lost.', 0) }
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.ok !== true) throw new PortalError(typeof result.error === 'string' ? result.error : 'Something went wrong. Please try again.', response.status)
  return result as T
}
