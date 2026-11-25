// Shared by the dashboard and the client portal, so this module must not import the Supabase client.
// Keep these lists in step with supabase/migrations/202610250001_client_onboarding.sql and 202611250001_client_management.sql.
export const serviceTypes = ['paid_ads', 'seo', 'social', 'email', 'website', 'automation', 'other'] as const
export type ServiceType = typeof serviceTypes[number]
export const serviceLabels: Record<ServiceType, string> = { paid_ads: 'Paid advertising', seo: 'SEO & digital marketing', social: 'Social media management', email: 'Email marketing', website: 'Website development', automation: 'Automation', other: 'Other' }
/** Field types. M6A had the first four; M10 added the rest. heading and info only display text and never take an answer. */
export const itemKinds = ['text', 'short_text', 'email', 'phone', 'url', 'number', 'date', 'choice', 'multi_choice', 'checkbox', 'links', 'access', 'file', 'heading', 'info'] as const
export type ItemKind = typeof itemKinds[number]
export const kindLabels: Record<ItemKind, string> = {
  text: 'Long answer', short_text: 'Short answer', email: 'Email address', phone: 'Phone number', url: 'Web address', number: 'Number', date: 'Date',
  choice: 'Choose one option', multi_choice: 'Choose several options', checkbox: 'Confirmation checkbox', links: 'Asset links', access: 'Account access',
  file: 'File upload', heading: 'Section heading', info: 'Instructions (no answer)',
}
export const displayKinds: readonly ItemKind[] = ['heading', 'info']
export const isDisplayKind = (kind: ItemKind) => displayKinds.includes(kind)
export const choiceKinds: readonly ItemKind[] = ['choice', 'multi_choice']
export type RequestStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'
export const statusLabels: Record<RequestStatus, string> = { draft: 'Draft', active: 'Open', paused: 'Paused', completed: 'Handed off', cancelled: 'Cancelled' }
export type ItemState = 'not_started' | 'submitted' | 'changes_requested' | 'accepted' | 'not_required'
export const itemStateLabels: Record<ItemState, string> = { not_started: 'Not started', submitted: 'Submitted', changes_requested: 'Changes requested', accepted: 'Accepted', not_required: 'Not required' }
export const readinessStates = ['not_open', 'waiting_on_client', 'awaiting_review', 'agency_steps', 'ready', 'paused', 'handed_off', 'cancelled'] as const
export type ReadinessState = typeof readinessStates[number]
export const readinessLabels: Record<ReadinessState, string> = { not_open: 'Not open yet', waiting_on_client: 'Waiting on client', awaiting_review: 'Needs review', agency_steps: 'Agency steps left', ready: 'Ready for handoff', paused: 'Paused', cancelled: 'Cancelled', handed_off: 'Handed off' }
export const reminderIntervals = [2, 3, 5, 7, 14] as const
export const documentCategories = ['brand', 'logo', 'image', 'video', 'content', 'requirements', 'design_reference', 'technical', 'access_instructions', 'other'] as const
export type DocumentCategory = typeof documentCategories[number]
export const documentCategoryLabels: Record<DocumentCategory, string> = { brand: 'Brand guidelines', logo: 'Logo', image: 'Image', video: 'Video', content: 'Content', requirements: 'Requirements document', design_reference: 'Design reference', technical: 'Technical document', access_instructions: 'Access instructions', other: 'Other' }
/** Settings some field types take; the database keeps only those that apply to the type. */
export interface ItemConfig { placeholder?: string; maxLength?: number; min?: number; max?: number; maxFiles?: number; category?: DocumentCategory }
export interface ItemDefinition {
  id?: string; section: string; title: string; guidance: string; kind: ItemKind; options: string[]; required: boolean; dueDate?: string | null; internalNote?: string
  /** M10: field settings, the onboarding stage (ID) and the form the field came from. */
  config?: ItemConfig; stageId?: string | null; formName?: string | null
}
export interface ResponseValue { text?: string; choice?: string; links?: string[]; granted?: boolean; note?: string; number?: number | null; date?: string | null; choices?: string[]; checked?: boolean; files?: string[] }

export const blankItem = (): ItemDefinition => ({ section: '', title: '', guidance: '', kind: 'text', options: [], required: true, config: {} })
export const cleanOptions = (options: string[]) => options.map(option => option.trim()).filter(Boolean)
export const cleanItem = (item: ItemDefinition): ItemDefinition => ({
  ...item, title: item.title.trim(), section: item.section.trim(), guidance: item.guidance.trim(),
  options: choiceKinds.includes(item.kind) ? cleanOptions(item.options) : [], required: isDisplayKind(item.kind) ? false : item.required,
})
/** Client-side checks mirroring the database rules; the database still validates every write. */
export function itemError(item: ItemDefinition): string | null {
  if (!item.title.trim()) return isDisplayKind(item.kind) ? 'Give every heading or instruction a title.' : 'Give every field a label.'
  if (choiceKinds.includes(item.kind)) {
    const options = cleanOptions(item.options)
    if (options.length < 2 || options.length > 20) return `“${item.title.trim()}” needs 2 to 20 options.`
    if (new Set(options.map(option => option.toLowerCase())).size !== options.length) return `“${item.title.trim()}” has duplicate options.`
  }
  const config = item.config ?? {}
  if (item.kind === 'number' && config.min !== undefined && config.max !== undefined && config.min > config.max) return `“${item.title.trim()}”: the minimum is more than the maximum.`
  if (item.kind === 'file' && config.maxFiles !== undefined && (config.maxFiles < 1 || config.maxFiles > 10)) return `“${item.title.trim()}”: allow 1 to 10 files.`
  return null
}
/** Words that suggest someone is asking for a password or secret; forms must use platform sharing instead. */
export const secretPattern = /\b(password|passcode|passwd|secret|api[ _-]?key|private key|2fa|one[- ]time code|pin code)\b/i
export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 102.4) / 10} KB` : `${Math.round(bytes / 104857.6) / 10} MB`
