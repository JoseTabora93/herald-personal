import { describe, expect, it, vi } from 'vitest'
import { createNativeMailController, parseMailPage, parseRecipients, recipientsText, records, record, textValue } from './native-mail.ts'

const item = (clave: string) => ({ clave, asunto: 'Tema ' + clave, estado: 'debo_respuesta', prioridad: 'alta', ultimoRemitente: { nombre: 'Prueba', direccion: 'test@example.test' }, ultimoMensajeEn: '2026-10-08T12:00:00Z' })
const compose = { id: 'compose-1', clave: 'MAIL-1', modo: 'responder', asunto: 'Tema', para: [], cc: [], cco: [], cuerpoMd: 'Original', incluirFirma: true, adjuntos: [], estado: 'borrador', version: 1 }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('native mailbox authority and continuity', () => {
  it('rejects malformed responses instead of showing an invented empty inbox', () => {
    expect(() => parseMailPage({ items: [], total: '200' })).toThrow()
    expect(() => parseMailPage({ items: [{ ...item('MAIL-1'), clave: '../secret' }], total: 1 })).toThrow()
    expect(parseMailPage({ items: [item('MAIL-1')], total: 82 }).total).toBe(82)
  })
  it('ignores a late list response after a newer search and resets pagination on filters', async () => {
    const old = deferred<unknown>()
    const request = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ items: [item('MAIL-2')], total: 1 })
    const c = createNativeMailController(request)
    const first = c.load()
    await c.filter({ texto: 'actual', desplazamiento: 0 })
    old.resolve({ items: [item('MAIL-1')], total: 90 }); await first
    expect(c.state.get().items[0]?.clave).toBe('MAIL-2')
    expect(request.mock.calls[1][0].body.params.texto).toBe('actual')
  })
  it('does not display a previous body under a newly selected mail or run mail-seen on read', async () => {
    const old = deferred<unknown>()
    const request = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ item: item('MAIL-2'), mensajes: [], totalMensajes: 0 })
    const c = createNativeMailController(request)
    const first = c.select('MAIL-1'); const second = c.select('MAIL-2')
    expect(c.state.get().thread).toBe(null)
    await second; old.resolve({ item: item('MAIL-1'), mensajes: [], totalMensajes: 0 }); await first
    expect(c.state.get().thread?.item.clave).toBe('MAIL-2')
    expect(request.mock.calls.every(([r]) => r.body.action === 'mail-get-item')).toBe(true)
  })
  it('rejects a mismatched detail key and a failed load cannot become a usable selection', async () => {
    const c = createNativeMailController(vi.fn().mockResolvedValue({ item: item('MAIL-2'), mensajes: [] }))
    await c.select('MAIL-1')
    expect(c.state.get().thread).toBe(null)
    expect(c.state.get().detailError).toBeTruthy()
  })
  it('preserves unsaved edits after a failed save and blocks handoff until persisted', async () => {
    const request = vi.fn().mockResolvedValueOnce(compose).mockRejectedValueOnce(new Error('Sin conexión'))
    const c = createNativeMailController(request)
    await c.openCompose('responder', 'MAIL-1')
    c.editCompose({ cuerpoMd: 'Mi respuesta pendiente' })
    await expect(c.saveCompose()).rejects.toThrow('Sin conexión')
    expect(c.state.get().compose?.cuerpoMd).toBe('Mi respuesta pendiente')
    expect(c.state.get().dirty).toBe(true)
    expect(() => c.handoffRoute()).toThrow()
  })
  it('reads back a save and hands off the same persisted draft, never sends', async () => {
    const saved = { ...compose, cuerpoMd: 'Revisado', version: 2 }
    const request = vi.fn().mockResolvedValueOnce(compose).mockResolvedValueOnce(saved).mockResolvedValueOnce(saved)
    const c = createNativeMailController(request)
    await c.openCompose('responder', 'MAIL-1'); c.editCompose({ cuerpoMd: 'Revisado' }); await c.saveCompose()
    expect(c.state.get().dirty).toBe(false)
    expect(c.handoffRoute()).toBe('/correo/MAIL-1?redactar=compose-1')
    expect(request.mock.calls.map(([r]) => r.body.action)).toEqual(['mail-compose-open', 'mail-compose-save', 'mail-compose-get'])
  })
  it('does not overwrite edits made while a save is in flight', async () => {
    const waiting = deferred<unknown>()
    const request = vi.fn().mockResolvedValueOnce(compose).mockImplementationOnce(() => waiting.promise).mockResolvedValue({ ...compose, cuerpoMd: 'Primero', version: 2 })
    const c = createNativeMailController(request)
    await c.openCompose('nuevo'); c.editCompose({ cuerpoMd: 'Primero' }); const saving = c.saveCompose()
    c.editCompose({ cuerpoMd: 'Más reciente' }); waiting.resolve({ ...compose, cuerpoMd: 'Primero', version: 2 }); await saving
    expect(c.state.get().compose?.cuerpoMd).toBe('Más reciente')
    expect(c.state.get().dirty).toBe(true)
  })
  it('guards a second composer while changes are unsaved', async () => {
    const request = vi.fn().mockResolvedValue(compose); const c = createNativeMailController(request)
    await c.openCompose('nuevo'); c.editCompose({ cuerpoMd: 'No perder' })
    await expect(c.openCompose('responder', 'MAIL-2')).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('restores only a compose identity after restart and never stores mail bodies in browser storage', async () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const c = createNativeMailController(vi.fn().mockResolvedValue(compose), storage)
    await c.openCompose('nuevo')
    expect([...values.values()]).toEqual(['compose-1'])
    const request = vi.fn().mockResolvedValue(compose)
    const restarted = createNativeMailController(request, storage)
    await restarted.resumeCompose()
    expect(restarted.state.get().compose?.cuerpoMd).toBe('Original')
    restarted.editCompose({ cuerpoMd: 'Todavía editando' }); await restarted.resumeCompose()
    expect(request).toHaveBeenCalledTimes(1)
    expect(() => restarted.closeCompose()).toThrow()
    c.closeCompose(); expect(values.size).toBe(0)
  })

  it('does not lose unsaved data when the saved compose can no longer be read', async () => {
    const storage = { getItem: () => 'compose-1', setItem: vi.fn(), removeItem: vi.fn() }
    const c = createNativeMailController(vi.fn().mockRejectedValue(new Error('Registro no disponible')), storage)
    await c.resumeCompose(); expect(c.state.get().composerError).toContain('Registro no disponible')
    expect(c.state.get().compose).toBeNull()
  })

  it('does not acknowledge a save whose readback differs', async () => {
    const c = createNativeMailController(vi.fn().mockResolvedValueOnce(compose).mockResolvedValueOnce({}).mockResolvedValueOnce({ ...compose, cuerpoMd: 'Otra respuesta' }))
    await c.openCompose('nuevo'); c.editCompose({ cuerpoMd: 'Mi respuesta' })
    await expect(c.saveCompose()).rejects.toThrow('guardado no pudo verificarse')
    expect(c.state.get().dirty).toBe(true)
  })

  it('keeps a truthful error when a list is unavailable and allows retry', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Fuera de línea')).mockResolvedValue({ items: [], total: 0 })
    const c = createNativeMailController(request); await c.load()
    expect(c.state.get()).toMatchObject({ phase: 'error', error: 'Fuera de línea' })
    await c.load(); expect(c.state.get()).toMatchObject({ phase: 'ready', error: null, total: 0 })
  })

  it('reads historical progress separately from a mailbox list and reports an unavailable progress source', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [], total: 0 }).mockRejectedValueOnce(new Error('Histórico fuera de línea'))
    const c = createNativeMailController(request); await c.navigate('historico')
    expect(request.mock.calls[0][0].body.params.periodo).toBe('todo')
    expect(c.state.get().phase).toBe('ready')
    expect(c.state.get().supplementalError).toBeTruthy()
    await expect(c.navigate('no-existe' as never)).rejects.toThrow()
  })

  it('applies the follow-up states and independently obtains counts and folders', async () => {
    const request = vi.fn().mockImplementation(async r => r.body.action === 'mail-counts' ? { total: 56 } : r.body.action === 'mail-carpetas' ? { carpetas: [{ clave: 'inbox' }] } : { items: [], total: 0 })
    const c = createNativeMailController(request); await c.navigate('seguimiento'); await c.overview()
    expect(request.mock.calls[0][0].body.params.estado).toEqual(['debo_respuesta', 'esperando_respuesta', 'agendado'])
    expect(c.state.get().counts?.total).toBe(56)
    expect(c.state.get().folders[0].clave).toBe('inbox')
  })

  it('accepts the actual flat cleanup response and refuses malformed learning data', async () => {
    const request = vi.fn().mockResolvedValueOnce({ grupos: [], totales: { correos: 0 } }).mockResolvedValueOnce({ lotes: [] }).mockResolvedValueOnce({ total: 0 })
    const c = createNativeMailController(request); await c.navigate('limpieza')
    expect(c.state.get().phase).toBe('ready'); expect(c.state.get().supplemental).toEqual({ lotes: [] })
    await c.navigate('aprendizajes'); expect(c.state.get().phase).toBe('error')
  })

  it('loads learning proposals and backlog without exposing approval writes', async () => {
    const request = vi.fn().mockResolvedValueOnce({ aprendizajes: [{ clave: 'APR-1' }] }).mockResolvedValueOnce({ items: [item('MAIL-1')], total: 1 })
    const c = createNativeMailController(request); await c.navigate('aprendizajes'); expect(c.state.get().auxiliary?.aprendizajes).toBeTruthy()
    await c.navigate('rezagados'); expect(c.state.get().items).toHaveLength(1)
    expect(request.mock.calls.map(([r])=>r.body.action)).toEqual(['mail-aprendizajes-listar','mail-rezagados'])
  })

  it('confirms classification by rereading the mail authority', async () => {
    const request = vi.fn().mockImplementation(async r => r.body.action === 'mail-get-item' ? { item: { ...item('MAIL-1'), estado: 'agendado' }, mensajes: [] } : r.body.action === 'mail-list-items' ? { items: [], total: 0 } : {})
    const c = createNativeMailController(request); await c.select('MAIL-1'); await c.updateItem('estado', 'agendado')
    expect(request.mock.calls.map(([r])=>r.body.action)).toContain('mail-update-item')
    expect(c.state.get().thread?.item.estado).toBe('agendado')
    await expect(c.updateItem('send', 'true')).rejects.toThrow()
    await expect(c.select('../inbox')).rejects.toThrow()
  })

  it('rejects a classification that did not persist and leaves the thread intact', async () => {
    const c = createNativeMailController(vi.fn().mockResolvedValue({ item: item('MAIL-1'), mensajes: [] }))
    await c.select('MAIL-1'); await expect(c.updateItem('estado', 'hecho')).rejects.toThrow('clasificación no pudo verificarse')
    expect(c.state.get().thread?.item.estado).toBe('debo_respuesta')
  })

  it('generates, rereads and loads a suggested draft without a provider write', async () => {
    const request = vi.fn().mockImplementation(async r => r.body.action === 'mail-get-item' ? { item: item('MAIL-1'), mensajes: [] } : r.body.action === 'mail-draft-get' ? { borrador: { texto: 'Sugerido', versionActual: 2 } } : r.body.action === 'mail-compose-open' ? { ...compose, cuerpoMd: 'Sugerido' } : {})
    const c = createNativeMailController(request); await c.select('MAIL-1'); await c.draft('Confirma la recepción', 'generar')
    expect(c.state.get().compose?.cuerpoMd).toBe('Sugerido')
    expect(c.state.get().draft?.versionActual).toBe(2)
    await c.draft('Más breve', 'ajustar'); await c.draft('', 'anterior'); await c.loadDraft()
    expect(request.mock.calls.every(([r]) => !/send|outlook/.test(r.body.action))).toBe(true)
  })

  it('requires clarification instead of inventing a reply when the recipient is blocked', async () => {
    const request = vi.fn().mockResolvedValueOnce({ item: item('MAIL-1'), mensajes: [] }).mockResolvedValueOnce({ bloqueado: true, motivo: 'Dirigido a otra persona' })
    const c = createNativeMailController(request); await c.select('MAIL-1')
    await expect(c.draft('', 'generar')).rejects.toThrow('Dirigido a otra persona')
    expect(c.state.get().compose).toBeNull()
  })

  it('does not overlap model work or allow a new composer during an operation', async () => {
    const wait = deferred<unknown>(); const request = vi.fn().mockImplementation(() => wait.promise); const c = createNativeMailController(request)
    const pending = c.openCompose('nuevo'); await expect(c.openCompose('nuevo')).rejects.toThrow('Espera')
    expect(() => c.handoffRoute()).toThrow(); wait.resolve(compose); await pending
  })

  it('validates recipient addresses without dropping CC or names', () => {
    const list = parseRecipients('Ana <ana@example.test>; otro@example.test')
    expect(recipientsText(list)).toBe('Ana <ana@example.test>; otro@example.test')
    expect(parseRecipients('')).toEqual([])
    expect(() => parseRecipients('mal formado')).toThrow()
    expect(() => parseRecipients(Array(101).fill('test@example.test').join(';'))).toThrow()
    expect(records([null, [], { clave: 'MAIL-1' }])).toEqual([{ clave: 'MAIL-1' }])
    expect(records(null)).toEqual([]); expect(textValue(2)).toBe('2'); expect(textValue(null)).toBe('')
    expect(() => record(null)).toThrow()
  })
})
