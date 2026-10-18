export const inquiryServices = ['Website design', 'Web development', 'Brand identity', 'Consulting', 'Other'] as const
export interface Inquiry { name: string; email: string; phone: string; company: string; service: string; message: string }
const hasControl = (value: string) => [...value].some(char => char.charCodeAt(0) < 32)
export function normalizeInquiry(value: unknown): Inquiry {
  if (!value || typeof value !== 'object') throw new Error('Please complete the inquiry form.')
  const record = value as Record<string, unknown>
  const text = (key: string, optional = false) => {
    const value = record[key] ?? (optional ? '' : null)
    if (typeof value !== 'string') throw new Error(`Please enter a valid ${key}.`)
    return value.trim()
  }
  const result = { name: text('name'), email: text('email').toLowerCase(), phone: text('phone', true), company: text('company', true), service: text('service'), message: text('message') }
  if (!result.name || result.name.length > 150 || hasControl(result.name)) throw new Error('Enter a name of up to 150 characters.')
  if (hasControl(result.email) || result.email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new Error('Enter a valid email address.')
  if (result.phone && (!/^[+\d\s().-]{7,25}$/.test(result.phone) || result.phone.replace(/\D/g, '').length < 7)) throw new Error('Enter a valid phone number or leave it blank.')
  if (result.company.length > 150 || hasControl(result.company)) throw new Error('Enter a company name of up to 150 characters.')
  if (!inquiryServices.some(service => service === result.service)) throw new Error('Choose a service interest.')
  if (!result.message || result.message.length > 2000 || result.message.includes('\0')) throw new Error('Enter a message of 1–2,000 characters.')
  return result
}
