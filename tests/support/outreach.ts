import type { PGlite } from '@electric-sql/pglite'
import { createAnalysisHarness, type AnalysisState } from './analysis.ts'
import { createOutreachHandler } from '../../supabase/functions/outreach/handler.ts'
import type { AiRequest, AiResponse } from '../../supabase/functions/_shared/analysis/providers.ts'
/**
 * The outreach handler on the business-analysis harness (embedded PostgreSQL, simulated websites and DNS), with its own
 * simulated AI for drafts. No request leaves the machine and nothing is billed.
 */
/** failures are thrown first, one per call; then error (if set) on every call; then outputs. */
export interface DraftAiState { outputs: unknown[]; error?: Error; failures: Error[]; requests: AiRequest[] }
export function createOutreachHarness(db: PGlite, overrides: Record<string, string | undefined> = {}) {
  const base = createAnalysisHarness(db, overrides)
  const drafts: DraftAiState = { outputs: [], failures: [], requests: [] }
  const ai = async (request: AiRequest): Promise<AiResponse> => {
    drafts.requests.push(request)
    const failure = drafts.failures.shift()
    if (failure) throw failure
    if (drafts.error) throw drafts.error
    return { output: drafts.outputs.length > 1 ? drafts.outputs.shift() : drafts.outputs[0], provider: 'gemini', inputTokens: 3200, outputTokens: 420, model: 'gemini-3.6-flash' }
  }
  const withAi = !!(base.config.GEMINI_API_KEY || base.config.GOOGLE_API_KEY)
  return { ...base, drafts, outreach: createOutreachHandler(base.runtime, { ai: withAi ? ai : null, model: withAi ? 'gemini-3.6-flash' : null }) }
}
export const outreachRequest = (body: Record<string, unknown>, token: string | null, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/outreach', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

/**
 * A fictional marketing studio with a team page. Includes what must NOT become a contact: an obfuscated address, an
 * address on another domain in the text, a no-reply link, a page robots.txt disallows, and navigation text.
 */
export function studioSite(state: AnalysisState, origin = 'https://brightpath.example') {
  const host = new URL(origin).hostname
  state.dns[host] = ['93.184.216.40']
  state.mx[host] = ['10 mx1.mailhost.example.', '20 mx2.mailhost.example.']
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><header><nav><a href="/">Home</a><a href="/about/">About Us</a>
    <a href="/team/">Our Team</a><a href="/contact/">Contact</a><a href="/private/staff-list/">Staff list</a></nav></header>${body}
    <footer><a href="https://www.linkedin.com/company/brightpath-studio/">LinkedIn</a><a href="https://www.instagram.com/brightpathstudio">Instagram</a>
    <a href="https://wa.me/15125550123">Chat on WhatsApp</a><a href="mailto:no-reply@brightpath.example">Updates</a></footer></body></html>`
  state.sites[`${origin}/`] = { status: 200, body: page('Brightpath Studio | Brand and web design', '<h1>Brand and web design for local businesses</h1><p>Call <a href="tel:+1 (512) 555-0199">(512) 555-0199</a>.</p>') }
  state.sites[`${origin}/team/`] = { status: 200, body: page('Our team', `<h1>Meet the team</h1>
    <div class="person"><h3>Jane Doe</h3><p>Founder &amp; CEO</p><a href="https://www.linkedin.com/in/janedoe-example/">Jane Doe</a></div>
    <div class="person"><h3>Marcus Lee</h3><p>Head of Marketing</p></div>
    <div class="person"><h3>Our Clients</h3><p>Director of happiness, and more</p></div>
    <p>Press enquiries: press@brightpath.example. For sales, write to sales [at] brightpath [dot] example.</p>
    <p>Website by designer@webcraft.example</p>`) }
  state.sites[`${origin}/about/`] = { status: 200, body: page('About Brightpath', '<h1>About us</h1><p>Founded in 2015 by a designer who loves local business. Write to <a href="mailto:jane@brightpath.example">Jane</a>.</p>') }
  state.sites[`${origin}/contact/`] = { status: 200, body: page('Contact Brightpath', `<h1>Contact</h1><form><input name="name"><input type="email" name="email"><textarea name="message"></textarea></form>
    <a href="mailto:Info@Brightpath.example?subject=Hello">info@brightpath.example</a><address>200 Congress Ave, Austin, TX 78701</address>`) }
  state.sites[`${origin}/private/staff-list/`] = { status: 200, body: page('Staff', '<h3>Hidden Person</h3><p>Operations Manager</p>') }
  state.sites[`${origin}/robots.txt`] = { status: 200, body: 'User-agent: *\nDisallow: /private/\n', headers: { 'content-type': 'text/plain' } }
}

/** A well-formed draft the simulated AI returns. `refs` are the finding references it cites. */
export const draftOutput = (body: string, refs: string[] = ['F1'], subject = 'A quick note about your website') => ({
  subject, body, evidenceSufficient: refs.length > 0, angleSummary: 'Leads with the observed issue.',
  claims: refs.length ? [{ statement: 'Something observed on the website', findingRefs: refs, serviceRef: 'S1' }] : [],
})
