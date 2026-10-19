// Set VITE_PUBLIC_SIGNUP=true in the frontend build once Supabase Auth allows new sign-ups, so the
// marketing copy invites visitors to create an account instead of requesting access. /signup itself
// always follows the live Auth settings, so a mismatch is never broken, only out of date.
export const signupOpen = import.meta.env?.VITE_PUBLIC_SIGNUP === 'true'
