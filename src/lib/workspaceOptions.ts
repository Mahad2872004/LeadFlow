// Shared by the UI and the database tests. Keep in step with the workspace_settings check constraint.
export const businessTypes = ['Design studio', 'Development agency', 'Marketing agency', 'Freelancer', 'Consultancy', 'Other'] as const
export type BusinessType = typeof businessTypes[number]
export const workspaceRoles = ['owner', 'admin', 'member'] as const
export type WorkspaceRole = typeof workspaceRoles[number]
export const roleLabels: Record<WorkspaceRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }
export const roleSummaries: Record<WorkspaceRole, string> = {
  owner: 'Full control of this workspace, its details and its integrations.',
  admin: 'Can edit workspace details and the website form, manage leads and revoke integration credentials.',
  member: 'Can view, add and update leads, follow-ups and activity. Removing records and changing workspace settings are for owners and admins.',
}
/** Client-side check mirroring the database rule; the database still validates every write. */
export function workspaceNameError(name: string): string | null {
  const clean = name.trim()
  if (!clean) return 'Enter a workspace name.'
  if (clean.length > 100) return 'Use 100 characters or fewer.'
  if ([...clean].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return 'Remove line breaks and control characters.'
  return null
}
