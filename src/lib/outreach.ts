import { supabase } from './supabase'
import { failure, RequestError } from './backend'
import { assessContact, contactRoles, normalizePhone, type ContactRole, type EmailStatus, type PhoneStatus, type ChannelType } from '../../supabase/functions/_shared/outreach/contacts.ts'
import { angleDefinitions, channelLimits, diffWords, followUpDates, outreachAngles, outreachChannels, outreachLengths, outreachObjectives, outreachTones, recommendOutreach,
  type DraftStatus, type OutreachAngle, type OutreachChannel, type OutreachLength, type OutreachObjective, type OutreachTone } from '../../supabase/functions/_shared/outreach/compose.ts'
export { angleDefinitions, assessContact, channelLimits, contactRoles, diffWords, followUpDates, normalizePhone, outreachAngles, outreachChannels, outreachLengths, outreachObjectives, outreachTones, recommendOutreach }
export type { ChannelType, ContactRole, DraftStatus, EmailStatus, OutreachAngle, OutreachChannel, OutreachLength, OutreachObjective, OutreachTone, PhoneStatus }

export interface ContactSourceRecord { source: string; how: string; field: string; value: string; sourceUrl: string | null; evidenceId: string | null; analysisId: string | null; observedAt: string }
export interface Suggestion { field: string; value: string; source: string; sourceUrl: string | null; observedAt: string }
export interface LeadContact {
  id: string; leadId: string; kind: 'person' | 'business'; label: string; fullName: string; jobTitle: string; role: ContactRole; email: string; emailStatus: EmailStatus
  emailCheck: { method: string; outcome: string; mx: string[]; detail: string; checkedAt: string } | null; emailCheckedAt: string | null; phone: string; phoneE164: string; phoneStatus: PhoneStatus
  whatsapp: string; linkedinUrl: string; profileUrl: string; provider: string | null; providerRef: string | null; notes: string; isPrimary: boolean; isPreferred: boolean; confirmed: boolean
  confirmedAt: string | null; editedFields: string[]; suggestions: Suggestion[]; origin: 'discovered' | 'manual' | 'apollo'; createdBy: string | null; createdAt: string; updatedAt: string; lastSeenAt: string
  sources: ContactSourceRecord[]
}
export interface LeadChannel { id: string; channel: ChannelType; label: string; value: string; source: string; sourceUrl: string | null; evidenceId: string | null; analysisId: string | null; observedAt: string }
export type JobStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
export interface ContactJob { id: string; leadId: string; mode: 'full' | 'verify'; status: JobStatus; step: string | null; providers: Record<string, { status: string; detail?: string }>; progress: Record<string, number>; failure: string | null; createdBy: string | null; createdAt: string; completedAt: string | null }
export interface LeadContacts { contacts: LeadContact[]; channels: LeadChannel[]; job: ContactJob | null }
export interface Claim { statement: string; findingIds: string[]; evidenceIds: string[]; sourceUrls: string[]; serviceId: string | null }
export interface Draft {
  id: string; leadId: string; contactId: string | null; contactName: string; analysisId: string | null; opportunityId: string | null; opportunityTitle: string; serviceId: string | null
  channel: OutreachChannel; angle: OutreachAngle; sequenceStep: number; parentId: string | null; status: DraftStatus; subject: string; body: string; claims: Claim[]; grounding: 'evidence' | 'general'
  warnings: string[]; version: number; origin: 'generated' | 'regenerated' | 'edited' | 'duplicated' | 'restored'; notes: string; provider: string | null; model: string | null
  createdBy: string | null; createdAt: string; updatedAt: string; statusChangedAt: string | null; sentAt: string | null; repliedAt: string | null
}
export interface DraftVersion { version: number; origin: Draft['origin']; subject: string; body: string; claims: Claim[]; grounding: 'evidence' | 'general'; angle: OutreachAngle; provider: string | null; model: string | null; inputTokens: number | null; outputTokens: number | null; settings: Record<string, unknown>; createdBy: string | null; createdAt: string }
export interface Preferences {
  agencyName: string; agencyDescription: string; agencyWebsite: string; senderName: string; senderRole: string; contactDetails: string; tone: OutreachTone; length: OutreachLength
  objective: OutreachObjective; preferredCta: string; avoidPhrases: string; customInstructions: string; caseStudyLinks: string[]; followupIntervals: number[]
}
export interface PreferenceSettings { workspace: Partial<Preferences> | null; mine: Partial<Preferences> | null; effective: Preferences; canEditWorkspace: boolean }
export interface OutreachConfig {
  providers: { ai: { configured: boolean; provider: 'gemini' | null; model: string | null }; website: { configured: boolean }; dns: { configured: boolean }; apollo: { enabled: boolean } }
  limits: { monthlySearches: number; maxConcurrent: number; recentHours: number; monthlyGenerations: number; maxPages: number }
  channelLimits: Record<OutreachChannel, { subject: number; body: number }>
}
export interface OutreachUsage {
  since: string; contactSearches: number; generations: number
  usage: { provider: string; operation: string; unit: string; quantity: number; credits: number | null; failed: number }[]
  recent: { provider: string; operation: string; quantity: number; unit: string; credits: number | null; remaining: number | null; status: string; detail: string | null; at: string }[]
}

/** A failed request with the HTTP status and the server's code (recent, limit, edited, stale, unsupported_claim, too_long, not_configured…). */
export class OutreachRequestError extends Error {
  status: number; code: string
  constructor(message: string, status: number, code = '') { super(message); this.status = status; this.code = code }
}
const endpoint = () => { const url = import.meta.env.VITE_SUPABASE_URL; return url ? `${new URL(url).origin}/functions/v1/outreach` : '' }
// The browser sends its session token; the function checks membership with it. Provider keys never reach the browser.
async function invoke<T>(workspaceId: string, body: Record<string, unknown>, timeoutMs = 120000): Promise<T> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token, url = endpoint()
  if (!token || !url) throw new OutreachRequestError('Your session has expired. Sign in again.', 401)
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' },
      body: JSON.stringify({ workspaceId, ...body }), signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    throw new OutreachRequestError((cause as Error).name === 'TimeoutError' ? 'This is taking longer than expected. Retrying is safe: it won’t create a duplicate.' : 'We couldn’t reach LeadFlow. Check your connection and try again.', 0)
  }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new OutreachRequestError(typeof result.error === 'string' ? result.error : 'Outreach isn’t available right now.', response.status, typeof result.code === 'string' ? result.code : '')
  return result as T
}
export const outreachConfig = (workspaceId: string) => invoke<OutreachConfig>(workspaceId, { action: 'config' }, 20000)
/** Starts contact discovery for a lead (or returns the search already running) and runs its first step. */
export const discoverContacts = (workspaceId: string, request: { leadId: string; requestId: string; force?: boolean }) =>
  invoke<LeadContacts & { id: string; existing: boolean }>(workspaceId, { action: 'discover', ...request })
/** Checks the given contacts' email domains and phone formats again. */
export const verifyContacts = (workspaceId: string, request: { leadId: string; requestId: string; contactIds: string[] }) =>
  invoke<LeadContacts & { id: string; existing: boolean }>(workspaceId, { action: 'verify', ...request })
export const advanceContactSearch = (workspaceId: string, leadId: string, jobId: string) => invoke<LeadContacts>(workspaceId, { action: 'advance', leadId, jobId })
export interface GenerateRequest {
  leadId: string; requestId: string; channel: OutreachChannel; angle: OutreachAngle; opportunityId: string | null; contactId: string | null; sequenceStep: number; parentId: string | null
  instructions: string; draftId?: string; expectedVersion?: number; replaceEdited?: boolean
}
// Up to two AI attempts of 55 s each, plus saving.
export const generateDraft = (workspaceId: string, request: GenerateRequest) => invoke<{ draft: Draft; existing: boolean }>(workspaceId, { action: 'generate', ...request }, 150000).then(result => result.draft)

async function call<T>(name: string, args: Record<string, unknown>, check: (value: unknown) => boolean = () => true): Promise<T> {
  const { data, error } = await supabase!.rpc(name, args)
  if (error) throw failure(error)
  if (!check(data)) throw new RequestError('Unexpected response. Please contact your administrator.')
  return data as T
}
const isObject = (value: unknown) => typeof value === 'object' && value !== null
export const leadContacts = (workspaceId: string, leadId: string) => call<LeadContacts>('lead_contacts_for', { target_workspace: workspaceId, target_lead: leadId }, isObject)
export const saveContact = (workspaceId: string, leadId: string, contact: Partial<LeadContact>) => call<LeadContact>('save_lead_contact', { target_workspace: workspaceId, target_lead: leadId, contact }, isObject)
export const setContactFlags = (workspaceId: string, contactId: string, flags: { primary?: boolean; preferred?: boolean; confirmed?: boolean }) =>
  call<LeadContact>('set_lead_contact_flags', { target_workspace: workspaceId, contact_id: contactId, flags }, isObject)
export const resolveSuggestion = (workspaceId: string, contactId: string, suggestion: Suggestion, accept: boolean) =>
  call<LeadContact>('resolve_contact_suggestion', { target_workspace: workspaceId, contact_id: contactId, suggestion_field: suggestion.field, suggestion_value: suggestion.value, accept }, isObject)
export const deleteContact = (workspaceId: string, contactId: string) => call<void>('delete_lead_contact', { target_workspace: workspaceId, contact_id: contactId })
export const deleteLeadContactData = (workspaceId: string, leadId: string) => call<number>('delete_lead_contact_data', { target_workspace: workspaceId, target_lead: leadId })
export const addApolloPeople = (workspaceId: string, leadId: string, personIds: string[]) =>
  call<{ added: number; updated: number; notFound: string[] }>('add_apollo_people_as_contacts', { target_workspace: workspaceId, target_lead: leadId, person_ids: personIds }, isObject)
export const cancelContactSearch = (workspaceId: string, jobId: string) => call<void>('cancel_contact_discovery', { target_workspace: workspaceId, job_id: jobId })
export const outreachPreferences = (workspaceId: string) => call<PreferenceSettings>('outreach_preferences_for', { target_workspace: workspaceId }, isObject)
export const saveOutreachPreferences = (workspaceId: string, scope: 'workspace' | 'user', preferences: Partial<Preferences>) =>
  call<PreferenceSettings>('save_outreach_preferences', { target_workspace: workspaceId, scope, preferences }, isObject)
export const draftsFor = (workspaceId: string, leadId: string) => call<Draft[]>('outreach_drafts_for', { target_workspace: workspaceId, target_lead: leadId }, Array.isArray)
export const draftVersions = (workspaceId: string, draftId: string) => call<DraftVersion[]>('outreach_draft_versions', { target_workspace: workspaceId, draft_id: draftId }, Array.isArray)
export const saveDraft = (workspaceId: string, draftId: string, expectedVersion: number, changes: { subject?: string; body?: string; notes?: string }) =>
  call<Draft>('save_outreach_draft', { target_workspace: workspaceId, draft_id: draftId, expected_version: expectedVersion, new_subject: changes.subject ?? null, new_body: changes.body ?? null, new_notes: changes.notes ?? null }, isObject)
export const restoreVersion = (workspaceId: string, draftId: string, version: number, expectedVersion: number) =>
  call<Draft>('restore_outreach_draft_version', { target_workspace: workspaceId, draft_id: draftId, restore_version: version, expected_version: expectedVersion }, isObject)
export const setDraftStatus = (workspaceId: string, draftId: string, status: DraftStatus) => call<Draft>('set_outreach_draft_status', { target_workspace: workspaceId, draft_id: draftId, new_status: status }, isObject)
export const duplicateDraft = (workspaceId: string, draftId: string, requestId: string) => call<Draft>('duplicate_outreach_draft', { target_workspace: workspaceId, draft_id: draftId, request_id: requestId }, isObject)
export const deleteDraft = (workspaceId: string, draftId: string) => call<void>('delete_outreach_draft', { target_workspace: workspaceId, draft_id: draftId })
export const outreachUsage = (workspaceId: string) => call<OutreachUsage>('outreach_usage_for', { target_workspace: workspaceId }, isObject)

// ---------- Labels ----------
export const roleLabels: Record<ContactRole, string> = {
  owner: 'Owner', founder: 'Founder', ceo: 'CEO', managing_director: 'Managing director', marketing: 'Marketing', operations: 'Operations', business_development: 'Business development',
  sales: 'Sales', decision_maker: 'Decision-maker', general: 'General contact', support: 'Support', other: 'Other',
}
export const emailStatusLabels: Record<EmailStatus, string> = { verified: 'Verified', likely_valid: 'Likely valid', unverified: 'Unverified', invalid: 'Invalid', risky: 'Risky', unknown: 'Not checked' }
export const emailStatusHelp: Record<EmailStatus, string> = {
  verified: 'A provider (Apollo) reported this address as verified.', likely_valid: 'Published by the business on its own website, and its domain accepts email. The mailbox itself can’t be confirmed without sending a message.',
  unverified: 'The domain accepts email, but nothing confirms this mailbox exists.', invalid: 'The address or its domain can’t receive email.', risky: 'A provider marked this address as risky, for example a catch-all domain.',
  unknown: 'Not checked yet, or the check couldn’t run.',
}
export const phoneStatusLabels: Record<PhoneStatus, string> = { valid_format: 'Valid format', invalid_format: 'Invalid format', unverified: 'Not checked', provider_verified: 'Verified by provider' }
export const channelLabels: Record<OutreachChannel, string> = { email: 'Email', whatsapp: 'WhatsApp', linkedin_connection: 'LinkedIn note', linkedin_message: 'LinkedIn message' }
export const channelHelp: Record<OutreachChannel, string> = {
  email: 'A short email with a subject line.', whatsapp: 'A brief, conversational message. Only for numbers the business publishes for WhatsApp, or that you know use it.',
  linkedin_connection: 'An invitation note of up to 200 characters (LinkedIn’s limit). LeadFlow never sends invitations.', linkedin_message: 'A message for after the person accepts your invitation.',
}
export const draftStatusLabels: Record<DraftStatus, string> = { draft: 'Draft', ready: 'Ready to send', sent: 'Sent manually', replied: 'Replied', follow_up: 'Follow-up required', archived: 'Archived' }
export const originLabels: Record<Draft['origin'], string> = { generated: 'Generated', regenerated: 'Regenerated', edited: 'Edited by you', duplicated: 'Duplicated', restored: 'Restored' }
export const sourceLabels: Record<string, string> = { website: 'Business website', apollo: 'Apollo', apollo_search: 'Apollo search', manual: 'Your team', lead_record: 'Lead record' }
export const howLabels: Record<string, string> = { mailto: 'email link', tel: 'phone link', whatsapp_link: 'WhatsApp link', text: 'page text', team_listing: 'listed with job title', name_match: 'address matches the person’s name',
  provider: 'revealed', provider_search: 'search result', manual: 'entered by hand', lead_record: 'lead details' }
export const channelTypeLabels: Record<ChannelType, string> = { contact_page: 'Contact page', contact_form: 'Contact form', booking_page: 'Booking page', social: 'Social profile', linkedin_company: 'LinkedIn company page', address: 'Address', whatsapp: 'WhatsApp link' }
export const toneLabels: Record<OutreachTone, string> = { professional: 'Professional', friendly: 'Friendly', consultative: 'Consultative', direct: 'Direct', conversational: 'Conversational' }
export const lengthLabels: Record<OutreachLength, string> = { short: 'Short', standard: 'Standard', detailed: 'Detailed' }
export const objectiveLabels: Record<OutreachObjective, string> = { discovery_call: 'Book a discovery call', free_audit: 'Offer a free review', case_study: 'Share a case study', proposal_permission: 'Ask to send a proposal', conversation: 'Start a conversation' }
/** The name to show for a contact: a person's name, or what the business line is for. */
export const contactName = (contact: Pick<LeadContact, 'kind' | 'fullName' | 'label' | 'email' | 'phone'>) => contact.kind === 'person' ? contact.fullName : contact.label || contact.email || contact.phone || 'Business contact'
/** mailto: and WhatsApp click-to-chat links. Opening one never sends anything by itself. */
export const mailtoLink = (email: string, subject: string, body: string) => `mailto:${encodeURIComponent(email)}?${new URLSearchParams({ subject, body }).toString().replace(/\+/g, '%20')}`
export const whatsappLink = (e164: string, text: string) => `https://wa.me/${e164.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`
