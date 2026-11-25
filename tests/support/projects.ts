import type { PGlite } from '@electric-sql/pglite'
import { createClientsHarness } from './clients.ts'
import { createProjectAssistantHandler } from '../../supabase/functions/project-assistant/handler.ts'
import type { AiClient } from '../../supabase/functions/_shared/analysis/providers.ts'
type AiRequest = Parameters<AiClient>[0]
/**
 * The project-assistant Edge handler (plus client-files and client-portal from the clients harness) wired to embedded
 * PostgreSQL, with a simulated AI model: tests set what it answers and read what it was asked. Nothing leaves the process.
 */
export function createProjectsHarness(db: PGlite, overrides: Record<string, string> = {}) {
  const base = createClientsHarness(db, overrides)
  const ai = { calls: [] as AiRequest[], answer: (_request: AiRequest): unknown => ({}), failure: null as Error | null }
  const model: AiClient = async request => {
    ai.calls.push(request)
    if (ai.failure) throw ai.failure
    return { output: ai.answer(request), provider: 'gemini', inputTokens: 1200, outputTokens: 300, model: 'gemini-test' }
  }
  return { ...base, ai, assistant: createProjectAssistantHandler(base.runtime, { ai: model, model: 'gemini-test' }), unconfigured: createProjectAssistantHandler(base.runtime, { ai: null, model: null }) }
}
export const assistantRequest = (body: Record<string, unknown>, token: string | null, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/project-assistant', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
