import { supabase } from './supabase'
// Captured before supabase-js processes the URL: a failed or expired email link reports its error in the hash.
const hash = new URLSearchParams(window.location.hash.slice(1))
const linkError = hash.get('error_description') || hash.get('error')
if (linkError) window.history.replaceState(null, '', window.location.pathname + window.location.search)
/** A one-time message from an email confirmation link that failed, if the page was opened from one. */
export const emailLinkError = linkError
  ? hash.get('error_code') === 'otp_expired' ? 'That confirmation link has expired or was already used. Sign in, or create your account again to get a new link.' : linkError.replace(/\+/g, ' ')
  : ''

export interface AuthSettings { signupEnabled: boolean; confirmEmail: boolean }
/** Public Auth settings, so sign-up follows the project's configuration. Null when they cannot be read. */
export async function loadAuthSettings(): Promise<AuthSettings | null> {
  try {
    const url = import.meta.env.VITE_SUPABASE_URL, key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
    const response = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key }, signal: AbortSignal.timeout(10000) })
    if (!response.ok) return null
    const settings = await response.json()
    return { signupEnabled: settings.disable_signup !== true, confirmEmail: settings.mailer_autoconfirm !== true }
  } catch { return null }
}

export const emailRedirect = () => `${window.location.origin}/app`
export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

/** Plain-language messages for Supabase Auth errors. */
export function authErrorMessage(error: unknown): string {
  const { code, name, message, reasons } = (error ?? {}) as { code?: string; name?: string; message?: string; reasons?: string[] }
  switch (code) {
    case 'invalid_credentials': return 'The email or password is incorrect.'
    case 'email_not_confirmed': return 'Confirm your email address first. Check your inbox for the link, or send a new one.'
    case 'signup_disabled': return 'New accounts aren’t open yet. Request access instead.'
    case 'user_already_exists': case 'email_exists': return 'An account with this email already exists. Sign in instead.'
    case 'weak_password': return `Choose a stronger password${reasons?.includes('pwned') ? ': this one has appeared in a data breach' : reasons?.includes('characters') ? ' with a mix of letters, numbers and symbols' : ''}.`
    case 'over_email_send_rate_limit': case 'over_request_rate_limit': return 'Too many attempts. Wait a minute, then try again.'
    case 'email_address_invalid': case 'validation_failed': return 'Enter a valid email address.'
    case 'email_address_not_authorized': return 'Email can’t be sent to this address yet. Contact your LeadFlow administrator.'
  }
  if (name === 'AuthRetryableFetchError' || name === 'TypeError') return 'We couldn’t reach LeadFlow. Check your connection and try again.'
  return message || 'Something went wrong. Please try again.'
}

export async function resendConfirmation(email: string) {
  const { error } = await supabase!.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: emailRedirect() } })
  if (error) throw error
}
