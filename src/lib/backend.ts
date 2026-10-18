import { supabase } from './supabase'
import { isData } from './storage'
import type { Data } from './model'
export interface Snapshot { data: Data; revision: number }
export async function loadWorkspace(): Promise<Snapshot> {
  const { data, error } = await supabase!.rpc('load_workspace')
  if (error) throw new Error(error.message)
  if (!data || !isData(data.data) || !Number.isSafeInteger(data.revision)) throw new Error('Invalid workspace response. Please contact your administrator.')
  return data
}
export async function saveWorkspace(data: Data, revision: number, requestId: string): Promise<number> {
  const { data: result, error } = await supabase!.rpc('save_workspace', { payload: data, expected_revision: revision, request_id: requestId })
  if (error) throw new Error(error.message)
  return result as number
}
