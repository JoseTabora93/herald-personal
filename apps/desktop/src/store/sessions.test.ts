import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ get: vi.fn(), rpc: vi.fn(), online: vi.fn(() => true) }))
vi.mock('../lib/rest.ts', () => ({ rest: { get: io.get } }))
vi.mock('./gateway.ts', () => ({ gatewayRequest: io.rpc, isGatewayOpen: io.online }))
import * as sessions from './sessions.ts'

const row = (id: string) => ({ id, title: id, source: 'web', message_count: 2 })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

beforeEach(() => { vi.clearAllMocks(); sessions.resetSessionHistory(); io.online.mockReturnValue(true) })

describe('saved conversation history', () => {
  it('pages beyond 60 conversations and retains other interactive sources', async () => {
    io.get.mockResolvedValueOnce({ sessions: Array.from({ length: 50 }, (_, i) => row(`s${i}`)), total: 73 })
      .mockResolvedValueOnce({ sessions: Array.from({ length: 23 }, (_, i) => row(`s${i + 50}`)), total: 73 })
    await sessions.refreshSessions()
    expect(sessions.$history.get().hasMore).toBe(true)
    await sessions.loadMoreSessions()
    expect(sessions.$history.get().rows).toHaveLength(73)
    expect(io.get.mock.calls[1][1]).toMatchObject({ offset: 50, order: 'recent', exclude_sources: 'kanban,tool,oneshot,cron' })
    expect(sessions.$history.get().hasMore).toBe(false)
  })
  it('uses server search for old message content and normalizes search IDs', async () => {
    io.get.mockResolvedValueOnce({ results: [{ session_id: 'old', title: 'Contrato', source: 'desktop', snippet: 'entrega pendiente' }] })
    await sessions.searchSessions('entrega')
    expect(io.get).toHaveBeenCalledWith('/api/sessions/search', expect.objectContaining({ q: 'entrega' }))
    expect(sessions.$history.get().rows[0]).toMatchObject({ id: 'old', title: 'Contrato' })
  })
  it('ignores a slow older search after a newer selection', async () => {
    const old = deferred<unknown>()
    io.get.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ results: [row('new')] })
    const pending = sessions.searchSessions('old')
    await sessions.searchSessions('new')
    old.resolve({ results: [row('old')] })
    await pending
    expect(sessions.$history.get().rows.map(r => r.id)).toEqual(['new'])
  })
  it('preserves cached rows and exposes a backend failure instead of showing an empty inbox', async () => {
    io.get.mockResolvedValueOnce({ sessions: [row('saved')], total: 1 })
    await sessions.refreshSessions()
    io.get.mockRejectedValueOnce(new Error('Servidor no disponible'))
    await sessions.refreshSessions()
    expect(sessions.$history.get().error).toContain('Servidor no disponible')
    expect(sessions.$history.get().rows[0].id).toBe('saved')
    expect(sessions.$sessionsLoading.get()).toBe(false)
  })
  it('deduplicates pinned rows without losing the page offset', async () => {
    io.get.mockResolvedValueOnce({ sessions: [row('pinned'), ...Array.from({ length: 50 }, (_, i) => row(`s${i}`))], total: 101 })
      .mockResolvedValueOnce({ sessions: [row('pinned'), row('older')], total: 101 })
    await sessions.refreshSessions(); await sessions.loadMoreSessions()
    expect(sessions.$history.get().rows.filter(r => r.id === 'pinned')).toHaveLength(1)
    expect(sessions.$history.get().offset).toBe(100)
  })
  it('does not remove a conversation when deletion fails', async () => {
    io.get.mockResolvedValueOnce({ sessions: [row('saved')], total: 1 })
    await sessions.refreshSessions()
    io.rpc.mockRejectedValueOnce(new Error('No eliminado'))
    await expect(sessions.deleteSession('saved')).rejects.toThrow('No eliminado')
    expect(sessions.$history.get().rows).toHaveLength(1)
  })
  it('treats unavailable storage as an error, not a successful empty list', async () => {
    io.get.mockResolvedValueOnce({ sessions: [], total: 0, storage: { state: 'corrupt' } })
    await sessions.refreshSessions()
    expect(sessions.$history.get().error).toBeTruthy()
  })
})

it('exposes offline history as unavailable and retries successfully', async () => {
  io.online.mockReturnValueOnce(false)
  await sessions.refreshSessions(); expect(sessions.$history.get().error).toContain('desconectado')
  io.get.mockResolvedValueOnce({ sessions: [row('a')], total: 1 })
  await sessions.refreshSessions(); expect(sessions.$history.get().error).toBeNull()
  sessions.rememberRuntimeId('a', 'runtime-a'); expect(sessions.$runtimeIds.get().a).toBe('runtime-a')
})
it('requests archived sessions explicitly, updates renamed rows, and removes acknowledged deletions', async () => {
  io.get.mockResolvedValueOnce({ sessions: [row('a')], total: 1 }).mockResolvedValueOnce({ sessions: [], total: 0 })
  await sessions.searchSessions('', true)
  expect(io.get).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ archived: 'include' }))
  sessions.updateSessionTitle('a', 'Guardado'); expect(sessions.$history.get().rows[0].title).toBe('Guardado')
  io.rpc.mockResolvedValueOnce({ deleted: true }); await sessions.deleteSession('a')
  expect(sessions.$history.get().rows).toEqual([])
  expect(sessions.$sessions.get()).toEqual([])
  await sessions.loadMoreSessions(); expect(io.get).toHaveBeenCalledTimes(2)
})
it('shows when search results reach the backend cap', async () => {
  io.get.mockResolvedValueOnce({ results: Array.from({ length: 100 }, (_, i) => row(`r${i}`)) })
  await sessions.searchSessions('común')
  expect(sessions.$history.get()).toMatchObject({ truncated: true, hasMore: false })
})
