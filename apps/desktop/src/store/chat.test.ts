import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ rpc: vi.fn(), refresh: vi.fn(), remember: vi.fn(), rename: vi.fn(), watch: vi.fn() }))
vi.mock('./gateway.ts', () => ({ gatewayRequest: io.rpc, onAnyGatewayEvent: io.watch }))
vi.mock('./backend.ts', () => ({ $env: atom(null), $prefs: atom({}) }))
vi.mock('./sessions.ts', () => ({ refreshSessions: io.refresh, rememberRuntimeId: io.remember, updateSessionTitle: io.rename, $runtimeIds: atom({}) }))
vi.mock('./notifications.ts', () => ({ notify: vi.fn() }))
import * as chat from './chat.ts'
import { $chatDrafts, setChatDraft } from './chat-drafts.ts'

const result = (id: string) => ({ session_id: `runtime-${id}`, session_key: id, messages: [{ role: 'user', text: `historial ${id}` }], info: { title: id } })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => { chat.resetChats(); vi.clearAllMocks() })

describe('resuming saved conversations', () => {
  it('uses the canonical stored ID returned by Hermes after compaction', async () => {
    io.rpc.mockResolvedValueOnce(result('canonical'))
    const resumed = await chat.openStoredSession('ancestor')
    expect(resumed.storedSessionId).toBe('canonical')
    expect(resumed.messages[0]).toMatchObject({ text: 'historial canonical' })
  })
  it('deduplicates a double click and does not create a new session', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    io.rpc.mockReturnValueOnce(pending.promise)
    const a = chat.openStoredSession('same'); const b = chat.openStoredSession('same')
    pending.resolve(result('same')); await Promise.all([a, b])
    expect(io.rpc).toHaveBeenCalledTimes(1)
    expect(io.rpc).toHaveBeenCalledWith('session.resume', expect.objectContaining({ session_id: 'same' }))
  })
  it('keeps the last clicked conversation active when older loads finish late', async () => {
    const slow = deferred<ReturnType<typeof result>>()
    io.rpc.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(result('b'))
    const pending = chat.openStoredSession('a'); await chat.openStoredSession('b')
    slow.resolve(result('a')); await pending
    expect(chat.$activeChat.get()?.storedSessionId).toBe('b')
  })
  it('shows resume failure without discarding the current conversation', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockRejectedValueOnce(new Error('No se pudo abrir'))
    await chat.openStoredSession('a')
    await expect(chat.openStoredSession('b')).rejects.toThrow('No se pudo abrir')
    expect(chat.$activeChat.get()?.storedSessionId).toBe('a')
    expect(chat.$chatOpening.get()).toBeNull()
    expect(chat.$chatError.get()).toContain('No se pudo abrir')
  })
  it('does not resurrect old runtime IDs after backend reset', async () => {
    const slow = deferred<ReturnType<typeof result>>()
    io.rpc.mockReturnValueOnce(slow.promise)
    const pending = chat.openStoredSession('old').catch(() => null)
    chat.resetChats(); slow.resolve(result('old')); await pending
    expect(chat.$chats.get()).toEqual({})
    expect(chat.$activeChatId.get()).toBeNull()
  })
  it('persists rename through Hermes and updates the history after acknowledgement', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockResolvedValueOnce({ title: 'Título guardado' })
    await chat.openStoredSession('a'); await chat.renameChat('runtime-a', 'Título guardado')
    expect(io.rpc).toHaveBeenLastCalledWith('session.title', { session_id: 'runtime-a', title: 'Título guardado' })
    expect(chat.$activeChat.get()?.title).toBe('Título guardado')
    expect(io.rename).toHaveBeenCalledWith('a', 'Título guardado')
  })
  it('keeps the original title if persistence fails', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockRejectedValueOnce(new Error('No guardado'))
    await chat.openStoredSession('a')
    await expect(chat.renameChat('runtime-a', 'Nuevo')).rejects.toThrow('No guardado')
    expect(chat.$activeChat.get()?.title).toBe('a')
  })
  it('rejects a stale explicit runtime ID rather than sending to another chat', async () => {
    await expect(chat.sendPrompt('Mensaje', { sessionId: 'missing' })).rejects.toThrow()
    expect(io.rpc).not.toHaveBeenCalled()
  })
  it('reports failed sends to the composer and does not leave a false sent message', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockRejectedValueOnce(new Error('Sin conexión'))
    await chat.openStoredSession('a')
    await expect(chat.sendPrompt('Borrador')).rejects.toThrow('Sin conexión')
    expect(chat.$activeChat.get()?.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['historial a'])
    expect(chat.$activeChat.get()?.streaming).toBe(false)
  })
  it('prevents overlapping submissions in the same conversation', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockReturnValueOnce(new Promise(() => {}))
    await chat.openStoredSession('a'); void chat.sendPrompt('Primero')
    await expect(chat.sendPrompt('Duplicado')).rejects.toThrow()
    expect(io.rpc).toHaveBeenCalledTimes(2)
  })
})

describe('chat lifecycle and delivery', () => {
  it('creates one chat for overlapping new-chat actions, exposes create failures', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    io.rpc.mockReturnValueOnce(pending.promise)
    const first = chat.createChat(); const second = chat.createChat()
    pending.resolve(result('new')); await Promise.all([first, second])
    expect(io.rpc).toHaveBeenCalledTimes(1)
    expect(chat.$activeChat.get()?.title).toBe('new')
    io.rpc.mockRejectedValueOnce(new Error('No se pudo crear'))
    await expect(chat.createChat()).rejects.toThrow('No se pudo crear')
    expect(chat.$chatError.get()).toBe('No se pudo crear')
    expect(chat.$activeChat.get()?.title).toBe('new')
  })
  it('returns to an already loaded session without resuming again', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockResolvedValueOnce(result('b'))
    await chat.openStoredSession('a'); await chat.openStoredSession('b'); await chat.openStoredSession('a')
    expect(io.rpc).toHaveBeenCalledTimes(2)
    expect(chat.$activeChat.get()?.storedSessionId).toBe('a')
  })
  it('continues the resumed runtime session and forwards voice interruption context', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockResolvedValueOnce({ accepted: true })
    await chat.openStoredSession('a')
    await chat.sendPrompt(' continuar ', { sessionId: 'runtime-a', surface: 'voice-live', voiceContext: 'contexto', interrupted: true })
    expect(io.rpc).toHaveBeenLastCalledWith('prompt.submit', { session_id: 'runtime-a', text: 'continuar', surface: 'voice-live', voice_context: 'contexto', interrupted: true })
    expect(chat.$activeChat.get()?.messages.at(-1)).toMatchObject({ role: 'user', text: 'continuar' })
  })
  it('creates a session on the first message but ignores empty prompts', async () => {
    expect(await chat.sendPrompt('   ')).toBeNull()
    io.rpc.mockResolvedValueOnce(result('first')).mockResolvedValueOnce({ accepted: true })
    expect(await chat.sendPrompt('Hola')).toBe('runtime-first')
    expect(io.rpc).toHaveBeenLastCalledWith('prompt.submit', expect.objectContaining({ session_id: 'runtime-first' }))
  })
  it('blocks sending while another history entry is opening', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    io.rpc.mockReturnValueOnce(pending.promise)
    const opening = chat.openStoredSession('a')
    await expect(chat.sendPrompt('No va al chat anterior')).rejects.toThrow('Espera')
    pending.resolve(result('a')); await opening
  })
  it('stops the selected session and forgets only that conversation', async () => {
    await chat.interruptChat(); expect(io.rpc).not.toHaveBeenCalled()
    io.rpc.mockResolvedValueOnce(result('a')).mockResolvedValueOnce({})
    await chat.openStoredSession('a'); await chat.interruptChat()
    expect(io.rpc).toHaveBeenLastCalledWith('session.interrupt', { session_id: 'runtime-a' })
    chat.forgetChat('runtime-a')
    expect(chat.$activeChat.get()).toBeNull()
    expect(chat.$chats.get()).toEqual({})
  })
  it('renders slash-command output without sending a model prompt', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockResolvedValueOnce({ type: 'display', display: 'Estado local', notice: 'Aviso' })
    await chat.openStoredSession('a'); await chat.runSlash('/status')
    expect(chat.$activeChat.get()?.messages.at(-1)).toMatchObject({ role: 'system', text: 'Estado local\n\nAviso' })
    expect(chat.$activeChat.get()?.streaming).toBe(false)
    expect(io.rpc).toHaveBeenCalledTimes(2)
  })
  it('forwards a resolved skill to the same runtime session', async () => {
    io.rpc.mockResolvedValueOnce(result('a')).mockResolvedValueOnce({ type: 'skill', message: 'Habilidad resuelta' }).mockResolvedValueOnce({ accepted: true })
    await chat.openStoredSession('a'); await chat.runSlash('/skill')
    expect(io.rpc).toHaveBeenLastCalledWith('prompt.submit', { session_id: 'runtime-a', text: 'Habilidad resuelta', surface: 'herald_os' })
    await expect(chat.runSlash('/otra')).rejects.toThrow('respondiendo')
  })
  it('reports slash failures and rejects stale explicit IDs', async () => {
    await expect(chat.runSlash('/status', 'missing')).rejects.toThrow('historial')
    io.rpc.mockResolvedValueOnce(result('a')).mockRejectedValueOnce(new Error('Comando fallido'))
    await expect(chat.runSlash('/status')).rejects.toThrow('Comando fallido')
    expect(chat.$activeChat.get()?.streaming).toBe(false)
  })
  it('shows failures from background callers without an unhandled promise', async () => {
    io.rpc.mockRejectedValueOnce(new Error('Sin servicio'))
    await expect(chat.sendPromptInBackground('Hola')).resolves.toBeUndefined()
    expect(chat.$chatError.get()).toBe('Sin servicio')
  })
  it('rejects empty renames before any backend write', async () => {
    await expect(chat.renameChat('missing', 'Nombre')).rejects.toThrow()
    io.rpc.mockResolvedValueOnce(result('a')); await chat.openStoredSession('a')
    await expect(chat.renameChat('runtime-a', ' ')).rejects.toThrow('título')
    expect(io.rpc).toHaveBeenCalledTimes(1)
  })
})

it('keeps an unsent draft through a Hermes compaction event without stealing focus', async () => {
  io.rpc.mockResolvedValueOnce(result('a')).mockResolvedValueOnce(result('other'))
  await chat.openStoredSession('a'); await chat.openStoredSession('other')
  setChatDraft('a', 'No perder al compactar')
  chat.bindChatEvents()
  const receive = io.watch.mock.calls[0][0]
  receive({ type: 'session.info', session_id: 'runtime-a', payload: { stored_session_id: 'compacted' } })
  expect(chat.$chats.get()['runtime-a'].storedSessionId).toBe('compacted')
  expect($chatDrafts.get().compacted.text).toBe('No perder al compactar')
  expect(chat.$activeChat.get()?.storedSessionId).toBe('other')
  receive({ type: 'message.complete', session_id: 'runtime-a', payload: { text: 'Terminado', status: 'complete' } })
  expect(io.refresh).toHaveBeenCalled()
  receive({ type: 'message.delta', session_id: 'unknown', payload: { text: 'Ajeno' } })
  expect(chat.$chats.get().unknown).toBeUndefined()
})
