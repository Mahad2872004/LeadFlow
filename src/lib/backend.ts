import { supabase } from './supabase'
import { isData } from './storage'
import type { Data } from './model'
import { businessTypes, workspaceRoles, type BusinessType, type WorkspaceRole } from './workspaceOptions'
export type { WorkspaceRole } from './workspaceOptions'
export interface Snapshot { data: Data; revision: number }
export interface WorkspaceSummary { id: string; name: string; ownerId: string; role: WorkspaceRole; revision: number; createdAt: string; businessType: BusinessType | null; timezone: string }
export interface WorkspaceMember { userId: string; role: WorkspaceRole; displayName: string; email: string; joinedAt: string }
/** An error with the database's code, e.g. 42501 when the caller may not access the workspace. */
export class RequestError extends Error { code: string; constructor(message: string, code = '') { super(message); this.code = code } }
// Database messages are written for people; only transport failures need rewording.
function failure(error: { message: string; code?: string }) {
  return new RequestError(/failed to fetch|networkerror|load failed|fetch failed/i.test(error.message) ? 'We couldn’t reach LeadFlow. Check your connection and try again.' : error.message, error.code)
}
export const accessDenied = (cause: unknown) => cause instanceof RequestError && cause.code === '42501'
// A workspace ID only selects a workspace: the database checks the caller's membership on every call.
// Without one, the RPCs use the caller's personal workspace, as M2 did.
export async function loadWorkspace(workspaceId?: string): Promise<Snapshot> {
  const { data, error } = workspaceId ? await supabase!.rpc('load_workspace_for', { target_workspace: workspaceId }) : await supabase!.rpc('load_workspace')
  if (error) throw failure(error)
  if (!data || !isData(data.data) || !Number.isSafeInteger(data.revision)) throw new Error('Invalid workspace response. Please contact your administrator.')
  return data
}
export async function saveWorkspace(data: Data, revision: number, requestId: string, workspaceId?: string): Promise<number> {
  const args = { payload: data, expected_revision: revision, request_id: requestId }
  const { data: result, error } = workspaceId ? await supabase!.rpc('save_workspace_for', { target_workspace: workspaceId, ...args }) : await supabase!.rpc('save_workspace', args)
  if (error) throw failure(error)
  return result as number
}
const known = (list: readonly unknown[], value: unknown) => list.includes(value)
function isWorkspaceRow(value: unknown): value is { id: string; name: string; owner_id: string; role: WorkspaceRole; revision: number; created_at: string; business_type: BusinessType | null; timezone: string } {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return ['id', 'name', 'owner_id', 'created_at', 'timezone'].every(key => typeof row[key] === 'string') && known(workspaceRoles, row.role)
    && Number.isSafeInteger(row.revision) && (row.business_type === null || known(businessTypes, row.business_type))
}
/** Workspaces the signed-in user belongs to, oldest first, with the user's role in each. */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const { data, error } = await supabase!.rpc('list_workspaces')
  if (error) throw failure(error)
  if (!Array.isArray(data) || !data.every(isWorkspaceRow)) throw new Error('Invalid workspace list response. Please contact your administrator.')
  return data.map(row => ({ id: row.id, name: row.name, ownerId: row.owner_id, role: row.role, revision: row.revision, createdAt: row.created_at, businessType: row.business_type, timezone: row.timezone }))
}
/** Retrying with the same request ID returns the workspace the first attempt created. */
export async function createWorkspace(name: string, businessType: BusinessType | null, requestId: string): Promise<string> {
  const { data, error } = await supabase!.rpc('create_workspace', { workspace_name: name, business_type: businessType, request_id: requestId })
  if (error) throw failure(error)
  if (typeof data !== 'string') throw new Error('Invalid workspace response. Please contact your administrator.')
  return data
}
/** Omitted fields stay unchanged; a null business type clears it. Owners and admins only. */
export async function updateWorkspace(workspaceId: string, changes: { name?: string; timezone?: string; businessType?: BusinessType | null }) {
  const { error } = await supabase!.rpc('update_workspace', {
    target_workspace: workspaceId, workspace_name: changes.name ?? null, workspace_timezone: changes.timezone ?? null,
    workspace_business_type: changes.businessType === undefined ? null : changes.businessType ?? '',
  })
  if (error) throw failure(error)
}
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const { data, error } = await supabase!.rpc('list_workspace_members', { target_workspace: workspaceId })
  if (error) throw failure(error)
  if (!Array.isArray(data)) throw new Error('Invalid member list response. Please contact your administrator.')
  return data.filter(row => known(workspaceRoles, row?.role) && typeof row.user_id === 'string')
    .map(row => ({ userId: row.user_id, role: row.role, displayName: typeof row.display_name === 'string' ? row.display_name : '', email: typeof row.email === 'string' ? row.email : '', joinedAt: String(row.joined_at) }))
}
