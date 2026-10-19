import { createContext, useContext } from 'react'
import type { Page } from '../components/Sidebar'
import type { WorkspaceSummary } from './backend'
export interface AuthUser { id: string; email: string }
export interface AuthValue { user: AuthUser; signOut: () => Promise<string | null> }
export const AuthContext = createContext<AuthValue | null>(null)
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthGate.')
  return value
}
export interface WorkspaceValue {
  workspaces: WorkspaceSummary[]
  active: WorkspaceSummary
  /** True while the open workspace has a save in flight or an unsaved failed attempt. */
  locked: boolean
  setLocked: (locked: boolean) => void
  switchTo: (workspaceId: string) => void
  /** Reloads the list and opens a workspace that was just created. */
  opened: (workspaceId: string, name: string) => Promise<void>
  refresh: () => Promise<void>
  openPage: (page: Page) => void
}
export const WorkspaceContext = createContext<WorkspaceValue | null>(null)
export function useWorkspaces() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspaces must be used inside WorkspaceShell.')
  return value
}
