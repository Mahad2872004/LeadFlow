// Gemini (Google AI Studio key) through the Gemini REST API's generateContent method, with JSON output constrained by
// responseJsonSchema. No SDK: one request, so the Edge Function stays dependency-free here, and tests pass a fake fetch.
// The key goes in the x-goog-api-key header, never in the URL, so it can't end up in request logs.
import { ProviderError, type AiClient } from './providers.ts'

export const defaultGeminiModel = 'gemini-3.6-flash'
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models'
const blocked = ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'IMAGE_SAFETY']

/** Returns null when GEMINI_API_KEY (or GOOGLE_API_KEY) isn't set: the report then has rule-based findings only. ANALYSIS_AI_MODEL picks the Gemini model. */
export function geminiClient(env: (name: string) => string | undefined, fetcher: typeof fetch = fetch): AiClient | null {
  const apiKey = (env('GEMINI_API_KEY') || env('GOOGLE_API_KEY') || '').trim()
  if (!apiKey) return null
  const model = /^gemini-[a-z0-9.-]{2,60}$/.test(env('ANALYSIS_AI_MODEL') ?? '') ? env('ANALYSIS_AI_MODEL')! : defaultGeminiModel
  return async ({ system, user, schema, maxTokens }) => {
    let response: Response
    try {
      response = await fetcher(`${endpoint}/${model}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(110_000),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: maxTokens },
        }),
      })
    } catch (error) {
      throw new ProviderError((error as Error).name === 'TimeoutError' ? 'timeout' : 'unavailable', (error as Error).name === 'TimeoutError' ? 'The AI service took too long to answer.' : 'The AI service couldn’t be reached.')
    }
    const body = await response.json().catch(() => null) as Record<string, any> | null
    if (!response.ok) {
      const message = String(body?.error?.message ?? ''), status = String(body?.error?.status ?? '')
      // Google answers an invalid key with 400 INVALID_ARGUMENT ("API key not valid") as well as 401/403.
      if (response.status === 401 || response.status === 403 || /api key/i.test(message) || status === 'PERMISSION_DENIED' || status === 'UNAUTHENTICATED') throw new ProviderError('auth', 'The Gemini API key was rejected.')
      if (response.status === 429) throw new ProviderError('rate_limited', 'Gemini is rate-limiting requests or the key’s quota is used up. Try again later.')
      if (response.status === 404) throw new ProviderError('invalid', `Gemini doesn’t know the model “${model}”. Check ANALYSIS_AI_MODEL.`)
      if (response.status === 400) throw new ProviderError('invalid', 'Gemini didn’t accept the request.')
      throw new ProviderError('unavailable', 'The AI service is unavailable right now.')
    }
    if (body?.promptFeedback?.blockReason) throw new ProviderError('failed', 'The AI model declined to analyze this content.')
    const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : null
    if (!candidate) throw new ProviderError('failed', 'The AI service returned no answer.')
    if (candidate.finishReason === 'MAX_TOKENS') throw new ProviderError('failed', 'The AI output was cut off before it finished.')
    if (blocked.includes(candidate.finishReason)) throw new ProviderError('failed', 'The AI model declined to analyze this content.')
    // Thought summaries (thought: true) aren't part of the answer.
    const text = (Array.isArray(candidate.content?.parts) ? candidate.content.parts : []).filter((part: Record<string, unknown>) => !part.thought && typeof part.text === 'string').map((part: { text: string }) => part.text).join('')
    let output: unknown
    try { output = JSON.parse(text) } catch { throw new ProviderError('invalid', 'The AI returned output that isn’t valid JSON.') }
    const usage = body?.usageMetadata ?? {}, count = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0
    // Thinking tokens are billed as output tokens.
    return { output, provider: 'gemini', inputTokens: count(usage.promptTokenCount), outputTokens: count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount), model: String(body?.modelVersion || model) }
  }
}
