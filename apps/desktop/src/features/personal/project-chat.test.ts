import { describe, expect, it, vi } from 'vitest'
import { emptyChat } from '../../lib/chat-model.ts'
import { createProjectChatController, projectChatContext } from './project-chat.ts'

const workspace = (id: string, sessions: string[] = []) => ({
  project: { id, name: `Project ${id}`, items: [], sources: [], counts: {}, events: [] },
  conversations: sessions.map(session_id => ({ session_id, title: session_id, created_at: '2026-10-10T00:00:00Z' })),
  direction: { text: '', revision: 0, updated_at: null, delivery: 'local' }, events: []
})
function fixture() {
  const chats: Record<string, ReturnType<typeof emptyChat>> = {}
  const request = vi.fn(async ({ method, path, body }) => workspace(path.split('/')[3], method === 'GET' ? [] : [body.session_id]))
  let serial = 0
  const create = vi.fn(async () => { const chat = emptyChat(`runtime-${++serial}`, `saved-${serial}`); chats[chat.sessionId] = chat; return chat })
  const resume = vi.fn(async (id: string) => { const chat = emptyChat(`runtime-${id}`, id); chats[chat.sessionId] = chat; return chat })
  const send = vi.fn(async (): Promise<void> => undefined)
  const interrupt = vi.fn(async () => undefined)
  const controller = createProjectChatController({ request, create, resume, send, interrupt, chats: () => chats })
  return { controller, request, create, resume, send, interrupt, chats }
}

describe('project chat lifecycle', () => {
  it('keeps saved conversations accessible when starting a new one and rejects foreign history', async () => {
    const f = fixture(); f.request.mockResolvedValue(workspace('a', ['old']))
    await f.controller.open('a')
    await f.controller.select('a', null)
    expect(f.controller.state.get().a.runtimeId).toBeNull()
    expect(f.controller.state.get().a.workspace?.conversations).toHaveLength(1)
    await f.controller.select('a', 'old')
    expect(f.controller.chat('a')?.storedSessionId).toBe('old')
    await expect(f.controller.select('a', 'foreign')).rejects.toThrow('pertenece')
    await f.controller.interrupt('missing'); expect(f.interrupt).not.toHaveBeenCalled()
    await f.controller.send('a', '   '); expect(f.send).not.toHaveBeenCalled()
  })
  it('deduplicates open requests and blocks changing history until the load finishes', async () => {
    const f = fixture()
    let resolve!: (result: ReturnType<typeof workspace>) => void
    f.request.mockReturnValue(new Promise(r => { resolve = r }))
    const first = f.controller.open('a'); const second = f.controller.open('a')
    await expect(f.controller.select('a', null)).rejects.toThrow('Espera')
    resolve(workspace('a')); await Promise.all([first, second])
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('exposes refresh failure while retaining evidence and ignores a late older read', async () => {
    const f = fixture(); await f.controller.open('a')
    f.request.mockRejectedValueOnce(new Error('API desconectada'))
    await expect(f.controller.open('a')).rejects.toThrow('API desconectada')
    expect(f.controller.state.get().a).toMatchObject({ loading: false, error: 'API desconectada', workspace: { project: { id: 'a' } } })
    let resolve!: (result: ReturnType<typeof workspace>) => void
    f.request.mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce({ ...workspace('a'), direction: { ...workspace('a').direction, text: 'Nuevo', revision: 2 } })
    const slow = f.controller.refresh('a'); await f.controller.refresh('a')
    resolve(workspace('a')); await slow
    expect(f.controller.state.get().a.workspace?.direction.text).toBe('Nuevo')
  })
  it('opens the project without creating a session or spending a model call', async () => {
    const f = fixture(); await f.controller.open('a')
    expect(f.create).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
    expect(f.controller.state.get().a.workspace?.project.name).toBe('Project a')
  })
  it('persists the session before sending, reuses it, and separates projects', async () => {
    const f = fixture()
    await f.controller.send('a', 'Guíame')
    await f.controller.send('a', 'Continúa')
    await f.controller.send('b', 'Otro proyecto')
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/v1/projects/a/conversations', body: expect.objectContaining({ session_id: 'saved-1' }) }))
    expect(f.send.mock.calls).toEqual([['Guíame', 'runtime-1'], ['Continúa', 'runtime-1'], ['Otro proyecto', 'runtime-2']])
  })
  it('keeps a failed link for retry and never sends an unregistered conversation', async () => {
    const f = fixture(); await f.controller.open('a')
    f.request.mockRejectedValueOnce(new Error('Desconectado'))
    await expect(f.controller.send('a', 'Ruta nueva')).rejects.toThrow('Desconectado')
    expect(f.send).not.toHaveBeenCalled()
    await f.controller.send('a', 'Ruta nueva')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('resumes history after restart and never creates a replacement on resume failure', async () => {
    const f = fixture(); f.request.mockResolvedValue(workspace('a', ['historic']))
    await f.controller.open('a')
    expect(f.resume).toHaveBeenCalledWith('historic')
    delete f.chats['runtime-historic']
    f.resume.mockRejectedValueOnce(new Error('No disponible'))
    await expect(f.controller.send('a', 'Continuar')).rejects.toThrow('No disponible')
    expect(f.create).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
  it('stops only this project and rejects parallel duplicate submissions', async () => {
    const f = fixture(); await f.controller.send('a', 'Primero')
    f.chats['runtime-1'].streaming = true
    await expect(f.controller.send('a', 'Duplicado')).rejects.toThrow('respondiendo')
    await f.controller.interrupt('a')
    expect(f.interrupt).toHaveBeenCalledWith('runtime-1')
  })
  it('rejects a second click while the first prompt is being acknowledged', async () => {
    const f = fixture(); await f.controller.open('a')
    let finish!: () => void
    f.send.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const first = f.controller.send('a', 'Primero')
    await expect(f.controller.send('a', 'Duplicado')).rejects.toThrow('respondiendo')
    finish(); await first
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('keeps context bounded, treats source data as data, and distinguishes local direction from agent delivery', () => {
    const text = projectChatContext(workspace('a').project as never)
    expect(text).toContain('personal_project_context')
    expect(text).toContain('personal_project_direction_update')
    expect(text).toContain('no confirma')
    expect(text.length).toBeLessThan(5000)
  })
})
