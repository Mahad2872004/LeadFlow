// Turns provider values into what a LeadFlow lead accepts. A value that does not fit is dropped, never
// repaired into something the business did not publish. Limits match the leads table.
/** Some sources hold several values separated by semicolons; the first is the primary one. */
const first = (value: string | undefined) => (value ?? '').split(';')[0].trim()
export function cleanText(value: string | undefined, max: number): string {
  const result = [...(value ?? '')].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').replace(/\s+/g, ' ').trim()
  return result.length <= max ? result : ''
}
/** An http(s) URL without credentials, at most 300 characters. A bare domain is read as https. */
export function cleanWebsite(value: string | undefined): string {
  let candidate = first(value)
  if (!candidate) return ''
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(candidate)) return ''
    candidate = `https://${candidate}`
  }
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return ''
    return url.href.length <= 300 ? url.href : ''
  } catch { return '' }
}
export function cleanPhone(value: string | undefined): string {
  const phone = first(value)
  return /^[+\d\s().-]{7,25}$/.test(phone) && phone.replace(/\D/g, '').length >= 7 ? phone : ''
}
/** Only addresses a business published for contact, e.g. OpenStreetMap's email tag. */
export function cleanEmail(value: string | undefined): string {
  const email = first(value).replace(/^mailto:/i, '').toLowerCase()
  return email.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}
