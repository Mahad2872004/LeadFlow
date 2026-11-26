// M13: signing keys for workflow webhooks. Nothing secret is stored in the database: each endpoint's key is derived from the
// server secret EMAIL_HASH_SECRET (already required by inbound-lead), the endpoint ID and its secret version. Rotating
// increases the version, so the old key stops working at once.
//
// A sender signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the key, and sends:
//   X-LeadFlow-Webhook: <endpoint id>
//   X-LeadFlow-Timestamp: <Unix seconds>
//   X-LeadFlow-Signature: v1=<hex digest>
const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('')

async function hmac(key: string, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', imported, encoder.encode(message)))
}

/** The endpoint's signing key, shown once when it is created or rotated. */
export async function webhookSecret(serverSecret: string, webhookId: string, version: number): Promise<string> {
  return 'whsec_' + await hmac(serverSecret, `automation-webhook:${webhookId.toLowerCase()}:${version}`)
}

/** The signature a sender computes. */
export const signWebhook = (secret: string, timestamp: string, body: string) => hmac(secret, `${timestamp}.${body}`)

/** Compares two hex strings in constant time for equal lengths. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

/** The raw body (needed byte for byte for the signature), refused above maxBytes. */
export async function boundedText(request: Request, maxBytes = 16384): Promise<string> {
  const reader = request.body?.getReader(); if (!reader) throw new Error('Missing body')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      length += value.length
      if (length > maxBytes) { await reader.cancel(); throw new Error('Too large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(bytes)
}
