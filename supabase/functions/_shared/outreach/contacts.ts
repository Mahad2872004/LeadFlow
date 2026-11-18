// Contact intelligence: turning what a business publishes into contacts LeadFlow can show with their source, status and
// confidence. Shared by the outreach Edge Function (extraction during discovery) and the browser (normalizing manual
// entries, explaining confidence), so both apply exactly the same rules.
// * Only explicit contact points are extracted: mailto/tel/WhatsApp links, addresses written as text on the business's own
//   pages, and people whose name and job title appear together on the site. Nothing is guessed: no email patterns are
//   generated, obfuscated addresses ("info [at] …") are not decoded, and a person is never invented from a role alone.
// * Statuses are only what a method can support: syntax and mail-server checks never make an email "verified"; a valid
//   phone format never means the number uses WhatsApp.
// * Confidence is explainable: a few fixed rules, each giving the reason shown to the user. No AI-produced scores.
import { findPhoneNumbersInText, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min'
import { pageKind, parseHtml, socialProfiles, type Page } from '../analysis/html.ts'

export const contactRoles = ['owner', 'founder', 'ceo', 'managing_director', 'marketing', 'operations', 'business_development', 'sales', 'decision_maker', 'general', 'support', 'other'] as const
export type ContactRole = typeof contactRoles[number]
export const emailStatuses = ['verified', 'likely_valid', 'unverified', 'invalid', 'risky', 'unknown'] as const
export type EmailStatus = typeof emailStatuses[number]
export const phoneStatuses = ['valid_format', 'invalid_format', 'unverified', 'provider_verified'] as const
export type PhoneStatus = typeof phoneStatuses[number]
export const channelTypes = ['contact_page', 'contact_form', 'booking_page', 'social', 'linkedin_company', 'address', 'whatsapp'] as const
export type ChannelType = typeof channelTypes[number]
/** Where a contact detail came from. `how` says how it was found within that source. */
export type ContactSource = 'website' | 'apollo' | 'apollo_search' | 'manual' | 'lead_record'
export type FoundHow = 'mailto' | 'tel' | 'whatsapp_link' | 'text' | 'team_listing' | 'name_match' | 'provider' | 'provider_search' | 'manual' | 'lead_record'

export interface ContactCandidate {
  kind: 'person' | 'business'; label: string; fullName: string; jobTitle: string; role: ContactRole
  email: string; emailStatus?: EmailStatus; phone: string; phoneE164: string; phoneStatus: PhoneStatus; whatsapp: string; linkedinUrl: string; profileUrl: string
  source: ContactSource; how: FoundHow; providerRef: string; sourceUrl: string; evidenceId: string | null; analysisId: string | null; observedAt: string
}
export interface ChannelCandidate { channel: ChannelType; label: string; value: string; source: ContactSource; sourceUrl: string; evidenceId: string | null; analysisId: string | null; observedAt: string }

// ---------- Normalization ----------
const freeMail = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|yandex|zoho|fastmail|hey|btinternet|bigpond|optusnet|comcast|verizon|att|sbcglobal)\.[a-z.]+$/
// Addresses nobody reads, or that exist for other purposes; collecting them adds nothing and keeps data we don't need.
const unwantedLocal = /^(no-?reply|do-?not-?reply|donotreply|privacy|gdpr|dpo|abuse|postmaster|hostmaster|unsubscribe|mailer-daemon|bounce[s]?)$/
const looksLikeAsset = /\.(png|jpe?g|gif|webp|svg|css|js)$/i
const placeholderDomain = /^(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.com|yoursite\.com|company\.com|sentry\.io|wixpress\.com)$/
export interface NormalizedEmail { email: string; valid: boolean; reason: string; freeMail: boolean; roleLabel: string; role: ContactRole | null }
/** Lowercases and checks an address. `valid` is syntax only: it says nothing about whether the mailbox exists. */
export function normalizeEmail(raw: string): NormalizedEmail {
  const email = raw.trim().replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase()
  const fail = (reason: string): NormalizedEmail => ({ email, valid: false, reason, freeMail: false, roleLabel: '', role: null })
  if (!email) return fail('empty')
  if (email.length > 150 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/.test(email)) return fail('syntax')
  const [local, domain] = email.split('@')
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return fail('syntax')
  if (looksLikeAsset.test(email) || placeholderDomain.test(domain)) return fail('placeholder')
  const role = roleForMailbox(local)
  return { email, valid: true, reason: '', freeMail: freeMail.test(domain), roleLabel: role?.label ?? '', role: role?.role ?? null }
}
const mailboxRoles: [RegExp, string, ContactRole][] = [
  [/^(info|hello|hi|contact|enquir(y|ies)|inquir(y|ies)|office|admin|mail|team|general|reception|frontdesk|front\.desk)$/, 'General inquiries', 'general'],
  [/^(book(ing|ings)?|appointments?|reservations?|schedul(e|ing))$/, 'Bookings', 'general'],
  [/^(sales|quotes?|orders?|business|new\.?business)$/, 'Sales', 'sales'],
  [/^(support|help|care|service|customer\.?service|customerservice)$/, 'Support', 'support'],
  [/^(marketing|press|media|pr)$/, 'Marketing', 'marketing'],
  [/^(careers|jobs|hr|recruit(ing|ment)?|billing|accounts|invoices?|finance)$/, 'Other department', 'other'],
]
function roleForMailbox(local: string) {
  const match = mailboxRoles.find(([pattern]) => pattern.test(local))
  return match ? { label: match[1], role: match[2] } : unwantedLocal.test(local) ? { label: 'Unmonitored', role: 'other' as ContactRole } : null
}
export const isUnwantedMailbox = (email: string) => unwantedLocal.test(email.split('@')[0] ?? '')
export const domainOf = (value: string) => { try { return new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' } }
/** The registrable part well enough to compare a mailbox with a website (mail.example.co.uk vs www.example.co.uk). */
export function sameOrganizationDomain(emailDomain: string, website: string) {
  const site = domainOf(website), mail = emailDomain.toLowerCase().replace(/^www\./, '')
  if (!site || !mail) return false
  return mail === site || mail.endsWith(`.${site}`) || site.endsWith(`.${mail}`)
}

export interface NormalizedPhone { original: string; e164: string; status: PhoneStatus; national: string; country: string }
/**
 * Parses a phone number with the lead's country as context. "valid_format" means the number is well formed for its
 * country (libphonenumber's metadata), not that it's in service. Without a country and without a leading +, the number
 * can't be evaluated and stays "unverified".
 */
export function normalizePhone(raw: string, defaultCountry = ''): NormalizedPhone {
  const original = raw.trim().slice(0, 40)
  const country = /^[A-Z]{2}$/.test(defaultCountry.toUpperCase()) ? defaultCountry.toUpperCase() as CountryCode : undefined
  const digits = original.replace(/\D/g, '')
  if (digits.length < 6 || digits.length > 17) return { original, e164: '', status: 'invalid_format', national: '', country: '' }
  if (!country && !original.trim().startsWith('+') && !original.trim().startsWith('00')) return { original, e164: '', status: 'unverified', national: '', country: '' }
  const parsed = parsePhoneNumberFromString(original.replace(/^00/, '+'), country)
  if (!parsed) return { original, e164: '', status: 'invalid_format', national: '', country: '' }
  return parsed.isValid() ? { original, e164: parsed.number, status: 'valid_format', national: parsed.formatInternational(), country: parsed.country ?? '' }
    : { original, e164: '', status: 'invalid_format', national: '', country: '' }
}
/** The number in a WhatsApp click-to-chat link (wa.me/…, api.whatsapp.com/send?phone=…), in E.164; empty otherwise. */
export function whatsappFromUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { return '' }
  const host = url.hostname.toLowerCase()
  const digits = host === 'wa.me' ? url.pathname.replace(/^\/(message\/)?/, '').split('/')[0] : /(^|\.)whatsapp\.com$/.test(host) ? url.searchParams.get('phone') ?? '' : ''
  if (!/^\+?\d{7,15}$/.test(digits)) return ''
  const parsed = parsePhoneNumberFromString(`+${digits.replace(/^\+/, '')}`)
  return parsed?.isValid() ? parsed.number : ''
}
/** A public profile URL without tracking parameters or fragments; empty when it isn't an http(s) URL. */
export function normalizeProfileUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return ''
    url.hash = ''; url.search = ''
    return url.href.replace(/\/$/, '').slice(0, 300)
  } catch { return '' }
}

// ---------- Roles and names ----------
const roleRules: [RegExp, ContactRole][] = [
  [/\b(co-?founder|founder|founding partner)\b/i, 'founder'], [/\b(owner|proprietor|practice owner)\b/i, 'owner'],
  [/\b(ceo|chief executive|president)\b/i, 'ceo'], [/\b(managing director|general manager|\bmd\b)\b/i, 'managing_director'],
  [/\b(cmo|chief marketing|marketing|brand|growth|digital|communications)\b/i, 'marketing'], [/\b(coo|chief operating|operations|office manager|practice manager)\b/i, 'operations'],
  [/\b(business development|partnerships?)\b/i, 'business_development'], [/\b(sales|account executive|account manager)\b/i, 'sales'],
  [/\b(director|principal|partner|head of|vice president|vp|chief [a-z]+ officer|cto|cfo)\b/i, 'decision_maker'],
]
/** The role a job title implies, for sorting and matching outreach to the right person. */
export const roleFor = (title: string): ContactRole => roleRules.find(([pattern]) => pattern.test(title))?.[1] ?? 'other'
// A short line that is a job title: a recognized title phrase, few words, no sentence.
const titlePhrase = /\b(co-?founder|founder|owner|proprietor|ceo|cfo|coo|cto|cmo|chief [a-z]+ officer|president|vice president|managing director|general manager|director(?: of [a-z &]+)?|[a-z]+ director|head of [a-z &]+|(?:marketing|operations|office|practice|sales|business development|account|project|clinic|studio|store|restaurant) manager|principal|managing partner|partner|lead [a-z]+|(?:marketing|sales|design|growth|operations|project|team|creative|technical|engineering|product|brand) lead)\b/i
export const isJobTitle = (text: string) => text.length >= 3 && text.length <= 70 && text.split(/\s+/).length <= 9 && titlePhrase.test(text) && !/[.!?]\s|\b(we|our|you|your|is|are|was|has|have|will|can)\b/i.test(text)
const honorific = /^(dr|mr|mrs|ms|miss|mx|prof)\.?\s+/i
const notName = /\b(our|the|team|about|contact|services?|home|us|meet|book|call|get|welcome|menu|privacy|policy|terms|copyright|rights|reserved|llc|inc|ltd|limited|pty|gmbh|clinic|dental|studio|agency|company|group|solutions|media|marketing|consulting|street|road|avenue|suite|floor|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|read|more|learn|view|click|here|google|facebook|instagram|linkedin|twitter|youtube|and)\b/i
/** Two to four capitalized words, optionally after Dr./Mr./Ms. Rejects headings, company names and navigation text. */
export function looksLikeName(text: string): boolean {
  const name = text.trim().replace(honorific, '')
  // A job title ("Practice Manager") is never a name.
  if (name.length < 4 || name.length > 50 || /\d|@|https?:|[|/\\:;!?()[\]{}<>]/.test(name) || notName.test(name) || titlePhrase.test(name)) return false
  const words = name.split(/\s+/)
  return words.length >= 2 && words.length <= 4 && words.every(word => /^\p{Lu}[\p{L}'’.-]*$/u.test(word) && word.length <= 20 && !/^\p{Lu}+$/u.test(word.replace(/[.'’-]/g, '')) || /^\p{Lu}\.$/u.test(word))
}
/** Lowercase name without titles or punctuation, for matching the same person across sources. */
export const nameKey = (name: string) => name.trim().replace(honorific, '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s'-]/g, '').replace(/\s+/g, ' ').trim()

/** Whether a mailbox is clearly this person's: jane@, jane.doe@, jdoe@ or janedoe@ for "Jane Doe". */
export function emailMatchesName(email: string, name: string) {
  const local = (email.split('@')[0] ?? '').replace(/[._-]/g, ' ').trim(), parts = nameKey(name).split(' '), first = parts[0] ?? '', last = parts.length > 1 ? parts.at(-1)! : ''
  return !!first && !!last && [first, `${first} ${last}`, `${first[0]}${last}`, `${first}${last}`].includes(local)
}
/** Text between tags, in document order: the boundaries keep a name and the job title beneath it apart. */
function textBlocks(html: string): string[] {
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
  return body.split(/<[^>]+>/).map(part => part.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#0?39;|&apos;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[,|–—-]\s*/, '').trim()).filter(Boolean).slice(0, 4000)
}
export interface FoundPerson { name: string; title: string; role: ContactRole }
/**
 * People named with a job title on a page: "Jane Doe" followed by "Founder & CEO" (or the reverse), or both in one short
 * line ("Jane Doe, Founder", "Founder: Jane Doe"). A name without a title, or a title without a name, is not a person.
 */
export function extractPeople(html: string): FoundPerson[] {
  const blocks = textBlocks(html), found = new Map<string, FoundPerson>()
  const add = (name: string, title: string) => {
    const clean = name.trim().replace(/[,–—-]+$/, '').trim(), job = title.trim().replace(/^[,:–—-]+/, '').trim().slice(0, 120)
    if (!looksLikeName(clean) || !isJobTitle(job) || found.has(nameKey(clean))) return
    found.set(nameKey(clean), { name: clean.slice(0, 150), title: job, role: roleFor(job) })
  }
  blocks.forEach((block, index) => {
    const next = blocks[index + 1] ?? ''
    if (looksLikeName(block) && isJobTitle(next)) add(block, next)
    else if (isJobTitle(block) && looksLikeName(next) && !isJobTitle(blocks[index + 2] ?? '')) add(next, block)
    if (block.length <= 90) {
      const inline = block.match(/^((?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?[\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){1,3})\s*(?:,|–|—|-|\|)\s*(.+)$/u)
      if (inline) add(inline[1], inline[2])
      const titled = block.match(/^(.{3,60}?)\s*(?::|–|—|-)\s*((?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?[\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){1,3})$/u)
      if (titled) add(titled[2], titled[1])
    }
  })
  return [...found.values()].slice(0, 20)
}

// ---------- Extraction from a page ----------
const emailInText = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g
function addressFrom(html: string): string {
  const tag = html.match(/<address\b[^>]*>([\s\S]*?)<\/address>/i)?.[1]
  const text = tag ? tag.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim() : ''
  if (text && text.length <= 200 && /\d/.test(text)) return text
  const field = (name: string) => html.match(new RegExp(`"${name}"\\s*:\\s*"([^"]{1,120})"`))?.[1] ?? ''
  const parts = [field('streetAddress'), field('addressLocality'), field('addressRegion'), field('postalCode')].filter(Boolean)
  return parts.length >= 2 ? parts.join(', ').slice(0, 200) : ''
}
export interface PageContext { website: string; country: string; source: ContactSource; evidenceId: string | null; analysisId: string | null; observedAt: string }
const blankCandidate = (context: PageContext, sourceUrl: string): Omit<ContactCandidate, 'kind' | 'label' | 'how'> => ({
  fullName: '', jobTitle: '', role: 'general', email: '', phone: '', phoneE164: '', phoneStatus: 'unverified', whatsapp: '', linkedinUrl: '', profileUrl: '',
  source: context.source, providerRef: '', sourceUrl, evidenceId: context.evidenceId, analysisId: context.analysisId, observedAt: context.observedAt })
/**
 * Contacts and channels on one page. `page` is the parsed page (from M7 evidence or a fresh fetch); `html`, when the page
 * was fetched as HTML, adds people, addresses and plain-text addresses. Email addresses in plain text are only taken from
 * the business's own domain: elsewhere they are too often a designer's credit, a partner or a template leftover.
 */
export function extractFromPage(page: Page, html: string | null, context: PageContext): { contacts: ContactCandidate[]; channels: ChannelCandidate[] } {
  const contacts: ContactCandidate[] = [], channels: ChannelCandidate[] = []
  const channel = (type: ChannelType, label: string, value: string) => channels.push({ channel: type, label, value: value.slice(0, 300), source: context.source, sourceUrl: page.url, evidenceId: context.evidenceId, analysisId: context.analysisId, observedAt: context.observedAt })
  const people = html ? extractPeople(html) : []
  const personFor = (email: string) => people.find(person => emailMatchesName(email, person.name))
  const attached = new Set<string>()
  const emails = [...page.mailto.map(value => ({ value, how: 'mailto' as const })),
    ...(html ? [...new Set(textBlocks(html).join(' ').match(emailInText) ?? [])] : []).filter(value => sameOrganizationDomain(value.split('@')[1] ?? '', context.website)).map(value => ({ value, how: 'text' as const }))]
  const seenEmail = new Set<string>()
  for (const { value, how } of emails) {
    const normalized = normalizeEmail(value)
    if (!normalized.valid || seenEmail.has(normalized.email) || isUnwantedMailbox(normalized.email)) continue
    seenEmail.add(normalized.email)
    const person = personFor(normalized.email)
    if (person && !normalized.role) { attached.add(nameKey(person.name)); contacts.push({ ...blankCandidate(context, page.url), kind: 'person', label: '', fullName: person.name, jobTitle: person.title, role: person.role, email: normalized.email, how: 'name_match' }); continue }
    contacts.push({ ...blankCandidate(context, page.url), kind: 'business', label: normalized.roleLabel || 'Email', role: normalized.role ?? 'other', email: normalized.email, how })
  }
  const phones = [...page.tel.map(value => ({ value, how: 'tel' as const })),
    ...(html && !page.tel.length ? findPhoneNumbersInText(textBlocks(html).join(' \n '), (/^[A-Z]{2}$/.test(context.country) ? context.country : undefined) as CountryCode | undefined).slice(0, 3)
      .filter(found => found.number.isValid()).map(found => ({ value: found.number.number, how: 'text' as const })) : [])]
  const seenPhone = new Set<string>()
  phones.forEach(({ value, how }, index) => {
    const normalized = normalizePhone(value, context.country)
    const key = normalized.e164 || normalized.original
    if (seenPhone.has(key) || normalized.status === 'invalid_format') return
    seenPhone.add(key)
    contacts.push({ ...blankCandidate(context, page.url), kind: 'business', label: index === 0 ? 'Main phone' : 'Phone', role: 'general', phone: normalized.national || normalized.original, phoneE164: normalized.e164, phoneStatus: normalized.status, how })
  })
  for (const link of page.externalLinks) {
    const whatsapp = whatsappFromUrl(link.url)
    if (whatsapp && !contacts.some(contact => contact.whatsapp === whatsapp)) {
      contacts.push({ ...blankCandidate(context, page.url), kind: 'business', label: 'WhatsApp', role: 'general', phone: whatsapp, phoneE164: whatsapp, phoneStatus: 'valid_format', whatsapp, how: 'whatsapp_link' })
      channel('whatsapp', 'WhatsApp chat link', link.url)
    }
    const profile = normalizeProfileUrl(link.url)
    if (/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/company\//i.test(profile)) channel('linkedin_company', 'LinkedIn company page', profile)
    // A personal LinkedIn profile is only kept when the link names a person listed on the same page.
    if (/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(profile)) {
      const person = people.find(item => nameKey(item.name) === nameKey(link.text))
      if (person) { attached.add(nameKey(person.name)); contacts.push({ ...blankCandidate(context, page.url), kind: 'person', label: '', fullName: person.name, jobTitle: person.title, role: person.role, linkedinUrl: profile, profileUrl: profile, how: 'team_listing' }) }
    }
  }
  for (const profile of socialProfiles([page])) if (profile.network !== 'LinkedIn' || !/\/in\//.test(profile.url)) channel(profile.network === 'LinkedIn' ? 'linkedin_company' : 'social', profile.network, normalizeProfileUrl(profile.url) || profile.url)
  for (const person of people) if (!attached.has(nameKey(person.name))) contacts.push({ ...blankCandidate(context, page.url), kind: 'person', label: '', fullName: person.name, jobTitle: person.title, role: person.role, how: 'team_listing' })
  const kind = page.kind === 'other' ? pageKind(page.url, page.title) : page.kind
  if (kind === 'contact') channel('contact_page', 'Contact page', page.url)
  if (kind === 'booking') channel('booking_page', 'Booking page', page.url)
  if (page.forms > 0 && (page.formFields.includes('email') || page.formFields.includes('message'))) channel('contact_form', `Form on ${kind === 'home' ? 'the homepage' : `the ${kind} page`}`, page.url)
  const address = html ? addressFrom(html) : ''
  if (address) channel('address', 'Address', address)
  return { contacts, channels }
}
/** Parses fetched HTML and extracts from it. */
export const extractFromHtml = (html: string, url: string, context: PageContext) => extractFromPage(parseHtml(html, url, 200), html, context)

// ---------- Email verification results ----------
export interface MailDomainCheck { domain: string; outcome: 'mx' | 'a_only' | 'null_mx' | 'no_domain' | 'no_mail_host' | 'dns_unavailable'; mx: string[] }
/**
 * The status an email can honestly have from what LeadFlow checked. A mail server proves the domain accepts mail, not
 * that this mailbox exists: such addresses stay "unverified", or "likely valid" when the business publishes the address
 * on its own website under its own domain. Provider results (Apollo "verified") are kept unless the domain can't take mail.
 */
export function emailStatusFrom(email: string, check: MailDomainCheck | null, publishedOnOwnSite: boolean, providerStatus: EmailStatus | null): { status: EmailStatus; detail: string } {
  const normalized = normalizeEmail(email)
  if (!normalized.valid) return { status: 'invalid', detail: 'The address isn’t a valid email address.' }
  if (check?.outcome === 'no_domain') return { status: 'invalid', detail: `The domain ${check.domain} doesn’t exist.` }
  if (check?.outcome === 'null_mx' || check?.outcome === 'no_mail_host') return { status: 'invalid', detail: `The domain ${check.domain} doesn’t accept email.` }
  if (providerStatus && providerStatus !== 'unknown') return { status: providerStatus, detail: 'Status reported by the provider.' }
  if (!check || check.outcome === 'dns_unavailable') return { status: 'unknown', detail: 'The mail server couldn’t be checked.' }
  if (publishedOnOwnSite) return { status: 'likely_valid', detail: `Published on the business’s own website, and ${check.domain} has ${check.outcome === 'mx' ? 'a mail server' : 'a host that can take mail'}. The mailbox itself can’t be confirmed without sending a message.` }
  return { status: 'unverified', detail: `${check.domain} accepts email, but that doesn’t confirm this mailbox exists.` }
}
/** Apollo's email_status values in LeadFlow's terms. Unknown values stay "unknown". */
export function apolloEmailStatus(value: string): EmailStatus {
  const status = value.trim().toLowerCase()
  if (status === 'verified') return 'verified'
  if (status === 'likely to engage') return 'likely_valid'
  if (['unverified', 'guessed', 'extrapolated', 'user_managed'].includes(status)) return 'unverified'
  if (['invalid', 'bounced'].includes(status)) return 'invalid'
  if (['accept_all', 'catch_all', 'risky'].includes(status)) return 'risky'
  return 'unknown'
}

// ---------- Confidence ----------
export type Level = 'high' | 'medium' | 'low'
export interface ContactSourceRecord { source: ContactSource | string; how: FoundHow | string; field: string; value: string; sourceUrl: string | null; observedAt: string }
export interface AssessableContact {
  kind: 'person' | 'business'; email: string; emailStatus: EmailStatus; phoneE164: string; phoneStatus: PhoneStatus; fullName: string; confirmed: boolean; sources: ContactSourceRecord[]
}
export interface Confidence { level: Level; reasons: string[]; limitations: string[] }
const daysBetween = (from: string, to: number) => (to - Date.parse(from)) / 86_400_000
/**
 * Confidence from fixed rules: how direct the source is, whether the details belong to this business, verification,
 * agreement between sources and freshness. Every point comes with the sentence that explains it.
 */
export function assessContact(contact: AssessableContact, website: string, now = Date.now()): Confidence {
  const reasons: string[] = [], limitations: string[] = []
  let points = 0
  const sources = contact.sources ?? [], has = (test: (source: ContactSourceRecord) => boolean) => sources.some(test)
  if (has(s => s.source === 'website' && ['mailto', 'tel', 'whatsapp_link'].includes(s.how))) { points += 2; reasons.push('Published as a contact link on the business’s own website') }
  else if (has(s => s.source === 'website' && ['team_listing', 'name_match'].includes(s.how))) { points += 2; reasons.push('Named with a job title on the business’s own website') }
  else if (has(s => s.source === 'apollo')) { points += 2; reasons.push('Revealed from Apollo’s database') }
  else if (has(s => s.source === 'manual')) { points += 2; reasons.push('Entered by your team') }
  else if (has(s => s.source === 'website')) { points += 1; reasons.push('Found in the text of the business’s website') }
  else if (has(s => s.source === 'lead_record')) { points += 1; reasons.push('From the lead record') }
  else if (has(s => s.source === 'apollo_search')) limitations.push('From an Apollo search result; the name is partly hidden until revealed')
  if (contact.email) {
    const domain = contact.email.split('@')[1] ?? ''
    if (sameOrganizationDomain(domain, website)) { points += 1; reasons.push('Email domain matches the business website') }
    else if (freeMail.test(domain)) limitations.push('Free email provider: it can’t be confirmed that the address belongs to the business')
    else if (website) limitations.push('Email domain differs from the business website')
    if (contact.emailStatus === 'verified') { points += 2; reasons.push('Email verified by the provider') }
    else if (contact.emailStatus === 'likely_valid') { points += 1; reasons.push('Email likely valid: published by the business and its domain accepts mail') }
    else if (contact.emailStatus === 'risky') { points -= 1; limitations.push('The provider marked this email as risky') }
    else if (contact.emailStatus === 'unknown') limitations.push('Email not checked yet')
  }
  if (contact.phoneStatus === 'invalid_format') { points -= 1; limitations.push('The phone number isn’t valid for its country') }
  else if (contact.phoneE164 && contact.phoneStatus === 'unverified') limitations.push('Phone number not checked against a country’s numbering plan')
  const independent = new Set(sources.filter(s => s.field === (contact.email ? 'email' : contact.phoneE164 ? 'phone' : 'name')).map(s => s.source))
  if (independent.size >= 2) { points += 1; reasons.push(`The same detail came from ${independent.size} independent sources`) }
  const newest = sources.map(s => s.observedAt).filter(Boolean).sort().at(-1)
  if (newest) {
    const age = daysBetween(newest, now)
    if (age > 365) { points -= 1; limitations.push('Last seen more than a year ago') }
    else if (age > 180) limitations.push('Last seen more than six months ago')
  }
  if (contact.kind === 'person' && !contact.email && !contact.phoneE164 && contact.fullName) limitations.push('No direct email or phone for this person')
  if (contact.emailStatus === 'invalid') return { level: 'low', reasons, limitations: ['The email address failed verification', ...limitations] }
  if (contact.confirmed) return { level: 'high', reasons: ['Confirmed by your team', ...reasons], limitations }
  return { level: points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low', reasons, limitations }
}
