import type { PGlite } from '@electric-sql/pglite'
import { createDiscoveryHandler } from '../../supabase/functions/discover-leads/handler.ts'
import type { Runtime } from '../../supabase/functions/_shared/runtime.ts'
/**
 * The discover-leads Edge handler wired to embedded PostgreSQL. RPCs with the service key run as service_role;
 * RPCs with a user's token run as that user, as PostgREST would. Nominatim and Overpass are simulated: no request
 * leaves the machine.
 */
export const nominatimUrl = 'https://geocoder.test/'
export const overpassUrl = 'https://directory.test/api/interpreter'
export interface OsmElement { type: 'node' | 'way' | 'relation'; id: number; timestamp?: string; tags: Record<string, string> }
export interface DiscoveryState {
  /** Answers by city or postcode (lower case). Missing places geocode to nothing. */
  places: Record<string, { osm_type: string; osm_id: number; lat: string; lon: string }>
  elements: OsmElement[]
  /** Statuses to answer the next directory calls with, before answering normally. */
  directoryFailures: number[]
  directoryRemark: string
  geocoderCalls: string[]
  directoryQueries: string[]
  /** Every outgoing request's headers, to check what is sent upstream. */
  upstreamHeaders: Headers[]
}
export function createDiscoveryHarness(db: PGlite, overrides: Record<string, string | undefined> = {}) {
  const config: Record<string, string | undefined> = { SUPABASE_URL: 'http://127.0.0.1:54329', SUPABASE_SERVICE_ROLE_KEY: 'test-server-key', SUPABASE_ANON_KEY: 'test-public-key',
    DISCOVERY_ALLOWED_ORIGINS: 'http://127.0.0.1:5175,http://127.0.0.1:4175', OSM_NOMINATIM_URL: nominatimUrl, OSM_OVERPASS_URL: overpassUrl,
    OSM_USER_AGENT: 'LeadFlow-tests/1.0 (ops@example.com)', ...overrides }
  const state: DiscoveryState = { places: {}, elements: [], directoryFailures: [], directoryRemark: '', geocoderCalls: [], directoryQueries: [], upstreamHeaders: [] }
  const runtime: Runtime = { env: name => config[name], fetch: async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers)
    if (url.href.startsWith(nominatimUrl)) {
      state.upstreamHeaders.push(headers); state.geocoderCalls.push(url.search)
      const key = (url.searchParams.get('postalcode') ?? url.searchParams.get('city') ?? '').toLowerCase()
      return Response.json(state.places[key] ? [state.places[key]] : [])
    }
    if (url.href === overpassUrl) {
      state.upstreamHeaders.push(headers)
      const query = new URLSearchParams(String(init?.body)).get('data') ?? ''
      state.directoryQueries.push(query)
      const failure = state.directoryFailures.shift()
      if (failure) return new Response('busy', { status: failure })
      const limit = Number(query.match(/qt (\d+);$/)?.[1] ?? 1000)
      return Response.json({ elements: state.elements.slice(0, limit), ...(state.directoryRemark ? { remark: state.directoryRemark } : {}) })
    }
    const name = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1]
    if (!name || url.origin !== config.SUPABASE_URL) throw new Error(`Unexpected test URL ${url.href}`)
    const token = headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
    let role = 'service_role', sub = ''
    if (token !== config.SUPABASE_SERVICE_ROLE_KEY) {
      try { const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); sub = claims.sub; role = 'authenticated' } catch { return Response.json({ code: 'PGRST301', message: 'Invalid JWT' }, { status: 401 }) }
      if (typeof sub !== 'string') return Response.json({ code: 'PGRST301', message: 'Invalid JWT' }, { status: 401 })
    }
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>, keys = Object.keys(args)
    const values = keys.map(key => typeof args[key] === 'object' && args[key] !== null ? JSON.stringify(args[key]) : args[key])
    try {
      const result = await db.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)", [sub, JSON.stringify(sub ? { sub, role } : { role })])
        await tx.exec(`set local role ${role}`)
        return (await tx.query<{ result: unknown }>(`select public.${name}(${keys.map((key, index) => `"${key}" => $${index + 1}`).join(', ')}) as result`, values)).rows[0]?.result
      })
      return name === 'finish_discovery_search' || name === 'remember_discovery_place' ? new Response(null, { status: 204 }) : Response.json(result ?? null)
    } catch (error) {
      const { code, message } = error as { code?: string; message: string }
      return Response.json({ code, message }, { status: code === '42501' ? 403 : 400 })
    }
  } }
  return { config, state, runtime, handler: createDiscoveryHandler(runtime, undefined, async () => {}) }
}
export const discoveryRequest = (body: Record<string, unknown>, token: string | null, origin = 'http://127.0.0.1:5175') =>
  new Request('https://functions.test/discover-leads', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
/** A small fictional Austin directory: two dentists with contact details, one without, and one with unusable values. */
export function austinDirectory(): OsmElement[] {
  return [
    { type: 'node', id: 101, timestamp: '2026-09-01T10:00:00Z', tags: { amenity: 'dentist', name: 'Bluebonnet Dental', website: 'bluebonnet-dental.example', phone: '+1 512-555-0101', email: 'hello@bluebonnet-dental.example', 'addr:housenumber': '12', 'addr:street': 'Congress Ave', 'addr:city': 'Austin', 'addr:state': 'TX', 'addr:postcode': '78701' } },
    { type: 'way', id: 202, timestamp: '2025-03-15T08:30:00Z', tags: { healthcare: 'dentist', amenity: 'dentist', name: 'Lone Star Smiles', 'contact:website': 'https://www.lonestarsmiles.example/', 'contact:phone': '(512) 555-0102', 'addr:city': 'Austin' } },
    { type: 'node', id: 303, tags: { amenity: 'dentist', name: 'Barton Creek Family Dentistry', 'addr:city': 'Austin', 'addr:postcode': '78704' } },
    { type: 'node', id: 404, tags: { amenity: 'dentist', name: 'Unreliable Data Dental', website: 'javascript:alert(1)', phone: 'call us', email: 'not-an-email' } },
    { type: 'node', id: 505, tags: { amenity: 'dentist' } },
  ]
}
