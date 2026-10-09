import type { SessionListRow } from '@herald-os/client'
import { atom } from 'nanostores'
import { rest } from '../lib/rest.ts'
import { gatewayRequest, isGatewayOpen } from './gateway.ts'

export interface HistoryRow extends SessionListRow { last_active?: number; archived?: boolean; pinned?: boolean; snippet?: string }
interface HistoryState { rows: HistoryRow[]; query: string; includeArchived: boolean; total: number; offset: number; hasMore: boolean; truncated: boolean; loading: boolean; error: string | null }
const initial = (): HistoryState => ({ rows: [], query: '', includeArchived: false, total: 0, offset: 0, hasMore: false, truncated: false, loading: false, error: null })
export const $history = atom<HistoryState>(initial())
/** Cache for command/mission consumers; the visible page lives in $history. */
export const $sessions = atom<HistoryRow[]>([])
export const $sessionsLoading = atom(false)
export const $historyOpen = atom(true)
export const $chatResultsOpen = atom(false)
export const $runtimeIds = atom<Record<string, string>>({})
const PAGE_SIZE = 50
const EXCLUDED = 'kanban,tool,oneshot,cron'
let generation = 0

export function rememberRuntimeId(storedId: string, runtimeId: string): void {
  $runtimeIds.set({ ...$runtimeIds.get(), [storedId]: runtimeId })
}
const unique = (rows: HistoryRow[]) => [...new Map(rows.map(row => [row.id, row])).values()]

async function load(append = false): Promise<void> {
  const current = $history.get()
  const request = ++generation
  const offset = append ? current.offset : 0
  $history.set({ ...current, loading: true, error: null })
  $sessionsLoading.set(true)
  try {
    if (!isGatewayOpen()) throw new Error('Hermes está desconectado. Reintenta cuando vuelva la conexión.')
    let incoming: HistoryRow[]
    let total: number
    if (current.query) {
      const response = await rest.get<{ results: (HistoryRow & { session_id?: string })[] }>('/api/sessions/search', { q: current.query, limit: 100, exclude_sources: EXCLUDED })
      incoming = response.results.map(row => ({ ...row, id: row.id || row.session_id || '' })).filter(row => row.id)
      total = incoming.length
    } else {
      const response = await rest.get<{ sessions: HistoryRow[]; total: number; storage?: Record<string, unknown> }>('/api/sessions', {
        limit: PAGE_SIZE, offset, order: 'recent', archived: current.includeArchived ? 'include' : 'exclude', exclude_sources: EXCLUDED
      })
      if (response.storage && Object.values(response.storage).some(value => String(value).includes('corrupt'))) throw new Error('El almacenamiento del historial necesita revisión. Las conversaciones no se han eliminado.')
      incoming = response.sessions
      total = response.total
    }
    if (request !== generation) return
    const rows = unique([...(append ? current.rows : []), ...incoming])
    $sessions.set(unique([...incoming, ...$sessions.get().filter(row => !incoming.some(r => r.id === row.id))]))
    $history.set({ ...current, rows, total, offset: offset + PAGE_SIZE, hasMore: !current.query && offset + PAGE_SIZE < total, truncated: Boolean(current.query) && total >= 100, loading: false, error: null })
  } catch (error) {
    if (request === generation) $history.set({ ...$history.get(), loading: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (request === generation) $sessionsLoading.set(false)
  }
}
export function refreshSessions(): Promise<void> { return load() }
export function loadMoreSessions(): Promise<void> {
  return $history.get().hasMore && !$history.get().loading ? load(true) : Promise.resolve()
}
export function searchSessions(query: string, includeArchived = $history.get().includeArchived): Promise<void> {
  const next = query.trim()
  const changed = next !== $history.get().query || includeArchived !== $history.get().includeArchived
  $history.set({ ...$history.get(), query: next, includeArchived, ...(changed ? { rows: [], total: 0, offset: 0, hasMore: false } : {}) })
  return load()
}
export function updateSessionTitle(storedId: string, title: string): void {
  const update = (row: HistoryRow) => row.id === storedId ? { ...row, title } : row
  $sessions.set($sessions.get().map(update))
  $history.set({ ...$history.get(), rows: $history.get().rows.map(update) })
}
export async function deleteSession(storedId: string): Promise<void> {
  await gatewayRequest('session.delete', { session_id: storedId })
  generation++ // A pre-delete response must not resurrect this row.
  $sessions.set($sessions.get().filter(row => row.id !== storedId))
  $history.set({ ...$history.get(), rows: $history.get().rows.filter(row => row.id !== storedId), total: Math.max(0, $history.get().total - 1), loading: false })
  $sessionsLoading.set(false)
  const ids = { ...$runtimeIds.get() }; delete ids[storedId]; $runtimeIds.set(ids)
  await refreshSessions()
}
export function resetSessionHistory(): void {
  generation++
  $history.set(initial()); $sessions.set([]); $runtimeIds.set({}); $sessionsLoading.set(false)
}
