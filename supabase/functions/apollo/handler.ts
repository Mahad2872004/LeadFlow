import { boundedJson } from '../_shared/request.ts'
import { rpc, rpcAs, RpcError, type Runtime } from '../_shared/runtime.ts'
import { ApolloError, configuredAccounts, unreadableKeys, creditUsage, revealPeople, searchKindProvider, searchOrganizations, searchPeople, testConnection, type ApolloAccountKey } from '../_shared/apollo/client.ts'
import { FilterError, parseFilters, type SearchKind } from '../_shared/apollo/filters.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const personId = /^[A-Za-z0-9]{1,40}$/
/** Apollo's documented cost of a mobile number found by people enrichment, used to reserve credits until Apollo reports the actual figure. */
export const phoneCreditEstimate = 8
/** Filters as stable text: keys and list values sorted, so the same search always has the same saved-page key. */
const canonical = (filters: Record<string, unknown>) => JSON.stringify(Object.keys(filters).sort().map(key => [key, Array.isArray(filters[key]) ? [...filters[key] as string[]].sort() : filters[key]]))
const sha256Hex = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('')
/** The signed-in user's ID from a token the database has already accepted (apollo_member_role ran with it). */
const subjectOf = (token: string) => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string } catch { return null } }
interface Ledger { id: string; status: string; existing: boolean; credits: number | null; estimated_credits: number; reference: string | null; error: string | null }

/**
 * Apollo.io for signed-in members of workspaces the operator has enabled (APOLLO_WORKSPACE_IDS). Each action first checks
 * membership with the caller's own token; Apollo keys stay in this function. Credit-consuming calls (company search pages,
 * reveals) reserve credits in a locked ledger first, and the operation ID makes retries return the stored outcome instead
 * of calling Apollo again. Logs carry the action, account label, outcome and HTTP status only, never keys or contact data.
 */
export function createApolloHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (runtime.env('DISCOVERY_ALLOWED_ORIGINS') || runtime.env('PORTAL_ALLOWED_ORIGINS') || runtime.env('INQUIRY_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    if (!origin || !allowed.includes(origin)) return respond(403, { error: 'This website cannot use Apollo.' })
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { error: 'Use POST.' })
    if (!runtime.env('SUPABASE_URL') || !runtime.env('SUPABASE_SERVICE_ROLE_KEY') || !(runtime.env('SUPABASE_ANON_KEY') || runtime.env('SUPABASE_PUBLISHABLE_KEY')))
      return respond(503, { error: 'Apollo isn’t available right now. Please try again later.' })
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/)?.[1]
    if (!token) return respond(401, { error: 'Sign in to use Apollo.' })
    let body: Record<string, unknown>
    try { body = await boundedJson(request, 400000) } catch { return respond(400, { error: 'Send a request of less than 400 KB.' }) }
    if (typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return respond(400, { error: 'Reload the page and try again.' })
    const workspaceId = body.workspaceId.toLowerCase(), action = String(body.action ?? '')

    let role: string
    try { role = await rpcAs<string>(runtime, token, 'apollo_member_role', { target_workspace: workspaceId }) } catch (error) {
      if (error instanceof RpcError && error.code === '401') return respond(401, { error: 'Your session has expired. Sign in again.' })
      if (error instanceof RpcError && error.code === '42501') return respond(403, { error: 'You don’t have access to this workspace.' })
      return respond(503, { error: 'We couldn’t check your access. Try again in a minute.' })
    }
    const enabledFor = (runtime.env('APOLLO_WORKSPACE_IDS') ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
    const enabled = enabledFor.includes('*') || enabledFor.includes(workspaceId)
    const accounts = configuredAccounts(runtime.env)
    const webhookBase = (runtime.env('APOLLO_WEBHOOK_BASE_URL') || runtime.env('SUPABASE_URL') || '').replace(/\/+$/, '')
    // Apollo delivers phone numbers only to an HTTPS webhook.
    const phoneReveal = /^https:\/\//.test(webhookBase)
    const log = (detail: string) => console.log(`apollo ${action} ${detail}`)

    if (action === 'status') {
      const reason = !accounts.length ? (unreadableKeys(runtime.env) ? 'keys_unreadable' : 'no_accounts') : !enabled ? 'workspace_not_enabled' : null
      let list: unknown[] = []
      try { list = await rpc<unknown[]>(runtime, 'apollo_accounts_status', { configured: accounts.map(account => account.id) }) } catch { return respond(503, { error: 'Apollo account settings couldn’t be loaded.' }) }
      return respond(200, { enabled: !reason, reason, role, phoneReveal, accounts: enabled ? list : [] })
    }
    if (!accounts.length || !enabled) return respond(403, { error: 'Apollo isn’t enabled for this workspace.', code: 'not_enabled' })
    const account = accounts.find(item => item.id === body.accountId)
    const needAccount = () => account ? null : respond(422, { error: 'Choose an Apollo account.' })
    const manage = role === 'owner' || role === 'admin'
    const apolloFailure = (error: unknown, ledgerNote = '') => {
      if (error instanceof ApolloError) {
        log(`${account?.id ?? '-'} failed ${error.kind} ${error.status}${ledgerNote}`)
        const status = error.kind === 'rate_limited' ? 429 : error.kind === 'invalid' ? 422 : error.kind === 'unauthorized' || error.kind === 'forbidden' || error.kind === 'plan' ? 502 : 503
        return respond(status, { error: error.message, code: `apollo_${error.kind}`, retryAfter: error.retryAfter })
      }
      log(`${account?.id ?? '-'} failed internal${ledgerNote}`)
      return respond(503, { error: 'The request to Apollo couldn’t be completed. Try again in a minute.' })
    }
    // A shared per-minute budget per Apollo account, below Apollo's free-plan limit of 50 a minute.
    const paced = async (acct: ApolloAccountKey) => { try { return await rpc<boolean>(runtime, 'inquiry_rate_limit', { bucket_key: `apollo-${acct.id}` }) } catch { return false } }

    if (action === 'update_account') {
      if (needAccount()) return needAccount()!
      if (!manage) return respond(403, { error: 'Only workspace owners and admins can change Apollo accounts.' })
      const changes = body.changes as Record<string, unknown> | undefined
      if (!changes || typeof changes !== 'object') return respond(400, { error: 'Nothing to change.' })
      const picked: Record<string, unknown> = {}
      for (const key of ['nickname', 'active', 'monthlyAllowance', 'resetDay', 'notes']) if (changes[key] !== undefined) picked[key] = changes[key]
      try { return respond(200, { account: await rpc(runtime, 'apollo_update_account', { account_id: account!.id, changes: picked }) }) } catch (error) {
        if (error instanceof RpcError && error.code === '22023') return respond(422, { error: error.detail })
        return respond(503, { error: 'The account couldn’t be saved. Try again.' })
      }
    }
    if (action === 'test_connection' || action === 'sync_credits') {
      if (needAccount()) return needAccount()!
      if (action === 'test_connection' && !manage) return respond(403, { error: 'Only workspace owners and admins can test Apollo accounts.' })
      if (!await paced(account!)) return respond(429, { error: 'Too many Apollo requests this minute. Try again shortly.', retryAfter: 60 })
      try {
        if (action === 'test_connection') {
          await testConnection(runtime.fetch, account!)
          await rpc(runtime, 'apollo_record_connection', { account_id: account!.id, ok: true, failure: null })
          log(`${account!.id} ok`)
          return respond(200, { ok: true })
        }
        const usage = await creditUsage(runtime.fetch, account!)
        const synced = await rpc(runtime, 'apollo_record_sync', { account_id: account!.id, stats: usage.stats, cycle_start: usage.cycleStart, cycle_end: usage.cycleEnd })
        log(`${account!.id} ok`)
        return respond(200, { account: synced })
      } catch (error) {
        if (error instanceof ApolloError) await rpc(runtime, 'apollo_record_connection', { account_id: account!.id, ok: false, failure: error.message }).catch(() => {})
        return apolloFailure(error)
      }
    }
    if (action === 'ledger') {
      const raw = (body.filters ?? {}) as Record<string, unknown>, filters: Record<string, string> = {}
      if (typeof raw.accountId === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(raw.accountId)) filters.accountId = raw.accountId
      if (typeof raw.operation === 'string' && ['email_reveal', 'phone_reveal', 'organization_search'].includes(raw.operation)) filters.operation = raw.operation
      if (typeof raw.status === 'string' && ['pending', 'succeeded', 'no_match', 'failed', 'unknown'].includes(raw.status)) filters.status = raw.status
      for (const key of ['from', 'to']) if (typeof raw[key] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw[key] as string)) filters[key] = raw[key] as string
      try { return respond(200, { entries: await rpc(runtime, 'apollo_ledger_for', { target_workspace: workspaceId, filters }) }) } catch { return respond(503, { error: 'The credit history couldn’t be loaded.' }) }
    }

    if (action === 'search') {
      if (needAccount()) return needAccount()!
      const kind: SearchKind | null = body.kind === 'people' || body.kind === 'organizations' ? body.kind : null
      if (!kind) return respond(400, { error: 'Choose people or companies.' })
      const page = Number(body.page ?? 1), perPage = Number(body.perPage ?? 25)
      if (!Number.isInteger(page) || page < 1 || page > 500 || ![10, 25, 50, 100].includes(perPage) || page * perPage > 50000) return respond(422, { error: 'Apollo shows up to 50,000 results (500 pages of 100).' })
      let filters
      try { filters = parseFilters(kind, body.filters) } catch (error) { if (error instanceof FilterError) return respond(422, { error: error.message }); throw error }
      // Saved pages: a repeated search, or a page already fetched, is answered from the database for free unless the user
      // asks to refresh. savedOnly never calls Apollo; it restores the last results when a user comes back to the page.
      const signature = await sha256Hex(`${kind}|${page}|${perPage}|${canonical(filters)}`)
      if (body.refresh !== true) {
        const saved = await rpc<{ result: Record<string, unknown>; fetchedAt: string; accountId: string | null } | null>(runtime, 'apollo_saved_result', { target_workspace: workspaceId, page_signature: signature }).catch(() => null)
        if (saved?.result) { log(`${account!.id} ${kind} saved page`); return respond(200, { kind, accountId: saved.accountId ?? account!.id, searchId: null, fetchedAt: saved.fetchedAt, filters, ...saved.result, page, perPage, saved: true }) }
      }
      if (body.savedOnly === true) return respond(200, { kind, missing: true })
      // Organization Search costs 1 credit per page, so it needs an operation ID and the user's confirmation. Asked before
      // anything is recorded, so the confirmed request can reuse the same search ID.
      const confirmed = body.confirmCredits === true && typeof body.operationId === 'string' && uuid.test(body.operationId)
      if (kind === 'organizations' && !confirmed) return respond(428, { error: 'Company search uses 1 Apollo credit per page. Confirm to continue.', code: 'confirm_credits' })
      // A new search (page 1 with a search ID) is recorded in history; that also applies the workspace search quotas.
      const searchId = typeof body.searchId === 'string' && uuid.test(body.searchId) ? body.searchId.toLowerCase() : null
      if (searchId) {
        try { await rpcAs(runtime, token, 'start_discovery_search', { target_workspace: workspaceId, search_id: searchId, provider: searchKindProvider(kind), criteria: { filters, account: account!.id } }) } catch (error) {
          if (error instanceof RpcError && error.code === 'P0429') return respond(429, { error: error.detail || 'Search limit reached. Wait a few minutes.', retryAfter: 60 })
          if (error instanceof RpcError && error.code === '23505') return respond(409, { error: 'This search was already started. Start a new search.' })
          return respond(503, { error: 'We couldn’t start the search. Try again.' })
        }
      }
      const finish = (outcome: 'completed' | 'failed', count: number | null, failure: string | null) => searchId
        ? rpc(runtime, 'finish_discovery_search', { search_id: searchId, outcome, result_count: count === null ? null : Math.min(count, 1000), truncated: (count ?? 0) > 1000, failure }).catch(() => {})
        : Promise.resolve()
      if (!await paced(account!)) { await finish('failed', null, 'rate_limited'); return respond(429, { error: 'Too many Apollo requests this minute. Try again shortly.', retryAfter: 60 }) }
      let ledger: Ledger | null = null
      if (kind === 'organizations') {
        try {
          ledger = await rpc<Ledger>(runtime, 'apollo_reserve', { account_id: account!.id, target_workspace: workspaceId, operation_id: body.operationId, operation: 'organization_search', estimate: 1,
            subjects: [{ id: `page-${page}`, name: `Company search, page ${page}` }], actor: subjectOf(token), webhook_token_hash: null })
        } catch (error) {
          await finish('failed', null, 'credits')
          if (error instanceof RpcError && ['P0402', '55000'].includes(error.code)) return respond(402, { error: error.detail, code: 'credits' })
          return respond(503, { error: 'Credits couldn’t be reserved. Try again.' })
        }
        if (ledger.existing) return respond(409, { error: 'This page was already requested. Search again to load it.', code: 'duplicate_operation' })
      }
      try {
        const result = kind === 'people' ? await searchPeople(runtime.fetch, account!, filters, page, perPage) : await searchOrganizations(runtime.fetch, account!, filters, page, perPage)
        if (ledger) await rpc(runtime, 'apollo_settle', { ledger_id: ledger.id, outcome: 'succeeded', credits: 1, basis: 'documented', reference: null, failure: null })
        await finish('completed', result.total, null)
        log(`${account!.id} ${kind} ok`)
        await rpc(runtime, 'apollo_save_result', { target_workspace: workspaceId, page_signature: signature, kind, filters, page, per_page: perPage, account_id: account!.id,
          result: { items: result.items, total: result.total, totalPages: result.totalPages } }).catch(() => { /* The results are still returned; only reuse is lost. */ })
        return respond(200, { kind, accountId: account!.id, searchId, fetchedAt: new Date().toISOString(), filters, ...result, saved: false })
      } catch (error) {
        if (ledger) {
          const charged = error instanceof ApolloError && error.charged
          await rpc(runtime, 'apollo_settle', { ledger_id: ledger.id, outcome: charged ? 'unknown' : 'failed', credits: charged ? null : 0, basis: charged ? 'estimated' : 'documented',
            reference: null, failure: error instanceof ApolloError ? error.message : 'Internal error' }).catch(() => {})
        }
        await finish('failed', null, error instanceof ApolloError ? error.kind : 'internal')
        return apolloFailure(error)
      }
    }

    if (action === 'reveal') {
      if (needAccount()) return needAccount()!
      if (typeof body.operationId !== 'string' || !uuid.test(body.operationId)) return respond(400, { error: 'Reload the page and try again.' })
      const people = Array.isArray(body.people) ? body.people as { id?: unknown; name?: unknown }[] : []
      if (people.length < 1 || people.length > 10 || !people.every(item => typeof item?.id === 'string' && personId.test(item.id) && typeof item.name === 'string' && item.name.length <= 150))
        return respond(422, { error: 'Reveal between 1 and 10 people at a time.' })
      const subjects = [...new Map(people.map(item => [item.id as string, { id: item.id as string, name: (item.name as string).trim() }])).values()]
      const wantPhone = body.phone === true
      // People already revealed in this workspace (and, for phone lookups, already looked up) are never sent to Apollo again.
      let known: { id: string; emailRevealedAt?: string | null; phoneRequestedAt?: string | null }[] = []
      try { known = await rpcAs(runtime, token, 'apollo_contacts_for', { target_workspace: workspaceId, person_ids: subjects.map(subject => subject.id) }) } catch { return respond(503, { error: 'We couldn’t check who is already revealed. Try again.' }) }
      const requested = subjects.map(subject => subject.id)
      const done = known.filter(contact => contact.emailRevealedAt && (!wantPhone || contact.phoneRequestedAt))
      const alreadyRevealed = done.map(contact => contact.id)
      if (alreadyRevealed.length === subjects.length) return respond(200, { contacts: done, unmatched: [], credits: 0, creditBasis: 'documented', phonePending: false, alreadyRevealed })
      subjects.splice(0, subjects.length, ...subjects.filter(subject => !alreadyRevealed.includes(subject.id)))
      if (wantPhone && !phoneReveal) return respond(422, { error: 'Phone reveals need an HTTPS webhook address, which this deployment doesn’t have.' })
      const operationId = body.operationId.toLowerCase(), actor = subjectOf(token)
      let email: Ledger, phone: Ledger | null = null, webhookToken = ''
      try {
        email = await rpc<Ledger>(runtime, 'apollo_reserve', { account_id: account!.id, target_workspace: workspaceId, operation_id: operationId, operation: 'email_reveal', estimate: subjects.length, subjects, actor, webhook_token_hash: null })
        if (email.existing) {
          // A retry: report what happened instead of calling Apollo again.
          const contacts = await rpcAs(runtime, token, 'apollo_contacts_for', { target_workspace: workspaceId, person_ids: requested })
          return respond(email.status === 'pending' ? 409 : 200, { replayed: true, status: email.status, contacts, error: email.status === 'pending' ? 'This reveal is still being processed.' : email.error })
        }
        if (wantPhone) {
          webhookToken = `lf_${Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('')}`
          phone = await rpc<Ledger>(runtime, 'apollo_reserve', { account_id: account!.id, target_workspace: workspaceId, operation_id: operationId, operation: 'phone_reveal',
            estimate: subjects.length * phoneCreditEstimate, subjects, actor, webhook_token_hash: await sha256Hex(webhookToken) })
        }
      } catch (error) {
        if (error instanceof RpcError && ['P0402', '55000'].includes(error.code)) {
          // The email part may have been reserved before the phone part was refused; release it.
          if (wantPhone) await rpc<Ledger>(runtime, 'apollo_reserve', { account_id: account!.id, target_workspace: workspaceId, operation_id: operationId, operation: 'email_reveal', estimate: 0, subjects, actor, webhook_token_hash: null })
            .then(entry => rpc(runtime, 'apollo_settle', { ledger_id: entry.id, outcome: 'failed', credits: 0, basis: 'documented', reference: null, failure: 'Not enough credits for the phone lookup.' })).catch(() => {})
          return respond(402, { error: error.detail, code: 'credits' })
        }
        return respond(503, { error: 'Credits couldn’t be reserved. Try again.' })
      }
      if (!await paced(account!)) {
        for (const entry of [email, phone]) if (entry) await rpc(runtime, 'apollo_settle', { ledger_id: entry.id, outcome: 'failed', credits: 0, basis: 'documented', reference: null, failure: 'Paced by LeadFlow; nothing was sent.' }).catch(() => {})
        return respond(429, { error: 'Too many Apollo requests this minute. Try again shortly.', retryAfter: 60 })
      }
      try {
        const webhookUrl = phone ? `${webhookBase}/functions/v1/apollo-webhook?token=${webhookToken}` : null
        const result = await revealPeople(runtime.fetch, account!, subjects.map(subject => subject.id), webhookUrl)
        await rpc(runtime, 'apollo_store_contacts', { target_workspace: workspaceId, account_id: account!.id, contacts: result.contacts, phone_requested: !!phone })
        const matched = result.contacts.length
        // Apollo reports credits_consumed for bulk enrichment; when absent, the documented 1 credit per matched person applies.
        await rpc(runtime, 'apollo_settle', { ledger_id: email.id, outcome: matched ? 'succeeded' : 'no_match', credits: result.creditsConsumed ?? matched,
          basis: result.creditsConsumed === null ? 'documented' : 'reported', reference: result.requestId, failure: null })
        if (phone) {
          if (!matched) await rpc(runtime, 'apollo_settle', { ledger_id: phone.id, outcome: 'no_match', credits: 0, basis: 'documented', reference: result.requestId, failure: null })
          // Otherwise the entry stays pending until Apollo calls the webhook with the numbers and the credits used.
          else await rpc(runtime, 'apollo_settle', { ledger_id: phone.id, outcome: 'pending', credits: null, basis: 'estimated', reference: result.requestId, failure: null })
        }
        log(`${account!.id} ok matched ${matched}/${subjects.length}${phone ? ' phone pending' : ''}`)
        return respond(200, { contacts: [...result.contacts, ...done], alreadyRevealed, unmatched: result.unmatched, credits: result.creditsConsumed ?? matched, creditBasis: result.creditsConsumed === null ? 'documented' : 'reported',
          phonePending: !!phone && matched > 0 })
      } catch (error) {
        const charged = error instanceof ApolloError && error.charged
        for (const entry of [email, phone]) if (entry) await rpc(runtime, 'apollo_settle', { ledger_id: entry.id, outcome: charged ? 'unknown' : 'failed', credits: charged ? null : 0,
          basis: charged ? 'estimated' : 'documented', reference: null, failure: error instanceof ApolloError ? error.message : 'Internal error' }).catch(() => {})
        return apolloFailure(error, charged ? ' outcome unknown' : '')
      }
    }

    if (action === 'export') {
      const kind: SearchKind | null = body.kind === 'people' || body.kind === 'organizations' ? body.kind : null
      if (!kind) return respond(400, { error: 'Choose people or companies.' })
      try {
        const found = await rpc<{ items: unknown[]; contacts: unknown[] }>(runtime, 'apollo_export', { target_workspace: workspaceId, kind, max_items: 20000 })
        log(`${kind} ${found.items.length} items`)
        return respond(200, { kind, ...found, limit: 20000 })
      } catch { return respond(503, { error: 'The export couldn’t be prepared. Try again.' }) }
    }
    if (action === 'save') {
      if (needAccount()) return needAccount()!
      const kind: SearchKind | null = body.kind === 'people' || body.kind === 'organizations' ? body.kind : null
      if (!kind || !Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 250) return respond(422, { error: 'Save between 1 and 250 results at a time.' })
      const listId = typeof body.listId === 'string' && uuid.test(body.listId) ? body.listId : null
      const prefix = kind === 'people' ? 'person:' : 'org:'
      if (!body.rows.every(row => row && typeof row === 'object' && typeof (row as Record<string, unknown>).providerRef === 'string' && ((row as Record<string, unknown>).providerRef as string).startsWith(prefix)))
        return respond(422, { error: 'Reload the results and try again.' })
      if (typeof body.requestId !== 'string' || !uuid.test(body.requestId)) return respond(400, { error: 'Reload the page and try again.' })
      try {
        // import_leads runs as the user, so membership and the duplicate rules apply exactly as for any import.
        const result = await rpcAs<{ imported: { key: string; leadId: string }[]; skipped: unknown[]; revision: number }>(runtime, token, 'import_leads', { target_workspace: workspaceId, request_id: body.requestId,
          payload: { method: 'discovery', provider: searchKindProvider(kind), ...(typeof body.searchId === 'string' && uuid.test(body.searchId) ? { searchId: body.searchId.toLowerCase() } : {}), rows: body.rows } })
        const leadIds = result.imported.map(item => item.leadId)
        const listed = leadIds.length ? await rpc<number>(runtime, 'apollo_mark_imported', { target_workspace: workspaceId, account_id: account!.id, lead_ids: leadIds, list_id: listId }) : 0
        return respond(200, { ...result, listed })
      } catch (error) {
        if (error instanceof RpcError && ['22023', '23505', 'P0002'].includes(error.code)) return respond(422, { error: error.detail || 'These results couldn’t be saved.' })
        if (error instanceof RpcError && error.code === '42501') return respond(403, { error: 'You don’t have access to this workspace.' })
        return respond(503, { error: 'The leads couldn’t be saved. Retrying is safe: nothing is saved twice.' })
      }
    }
    return respond(400, { error: 'Unknown action.' })
  }
}
