// Shared by the dashboard and the client portal, so this module must not import the Supabase client.
// Keep these lists in step with supabase/migrations/202610250001_client_onboarding.sql.
export const serviceTypes = ['paid_ads', 'seo', 'social', 'email', 'other'] as const
export type ServiceType = typeof serviceTypes[number]
export const serviceLabels: Record<ServiceType, string> = { paid_ads: 'Paid advertising', seo: 'SEO', social: 'Social media management', email: 'Email marketing', other: 'Other' }
export const itemKinds = ['text', 'choice', 'links', 'access'] as const
export type ItemKind = typeof itemKinds[number]
export const kindLabels: Record<ItemKind, string> = { text: 'Written answer', choice: 'Choose an option', links: 'Asset links', access: 'Account access' }
export type RequestStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'
export const statusLabels: Record<RequestStatus, string> = { draft: 'Draft', active: 'Open', paused: 'Paused', completed: 'Handed off', cancelled: 'Cancelled' }
export type ItemState = 'not_started' | 'submitted' | 'changes_requested' | 'accepted' | 'not_required'
export const itemStateLabels: Record<ItemState, string> = { not_started: 'Not started', submitted: 'Submitted', changes_requested: 'Changes requested', accepted: 'Accepted', not_required: 'Not required' }
export const readinessStates = ['not_open', 'waiting_on_client', 'awaiting_review', 'ready', 'paused', 'handed_off', 'cancelled'] as const
export type ReadinessState = typeof readinessStates[number]
export const readinessLabels: Record<ReadinessState, string> = { not_open: 'Not open yet', waiting_on_client: 'Waiting on client', awaiting_review: 'Needs review', ready: 'Ready for handoff', paused: 'Paused', cancelled: 'Cancelled', handed_off: 'Handed off' }
export const reminderIntervals = [2, 3, 5, 7, 14] as const
export interface ItemDefinition { id?: string; section: string; title: string; guidance: string; kind: ItemKind; options: string[]; required: boolean; dueDate?: string | null; internalNote?: string }
export interface ResponseValue { text?: string; choice?: string; links?: string[]; granted?: boolean; note?: string }

export const blankItem = (): ItemDefinition => ({ section: '', title: '', guidance: '', kind: 'text', options: [], required: true })
export const cleanOptions = (options: string[]) => options.map(option => option.trim()).filter(Boolean)
export const cleanItem = (item: ItemDefinition): ItemDefinition => ({ ...item, title: item.title.trim(), section: item.section.trim(), guidance: item.guidance.trim(), options: item.kind === 'choice' ? cleanOptions(item.options) : [] })
/** Client-side checks mirroring the database rules; the database still validates every write. */
export function itemError(item: ItemDefinition): string | null {
  if (!item.title.trim()) return 'Give every item a title.'
  if (item.kind === 'choice') {
    const options = cleanOptions(item.options)
    if (options.length < 2 || options.length > 20) return `“${item.title.trim()}” needs 2 to 20 options.`
    if (new Set(options.map(option => option.toLowerCase())).size !== options.length) return `“${item.title.trim()}” has duplicate options.`
  }
  return null
}
