export async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('Use JSON')
  const reader = request.body?.getReader(); if (!reader) throw new Error('Missing body')
  const chunks: Uint8Array[] = []; let length = 0
  try { while (true) { const {done,value} = await reader.read(); if(done) break; length += value.length; if(length > 16384) { await reader.cancel(); throw new Error('Too large') }; chunks.push(value) } }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(length); let offset = 0
  for(const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid body')
  return parsed as Record<string,unknown>
}
