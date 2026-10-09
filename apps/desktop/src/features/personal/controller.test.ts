import { describe, expect, it, vi } from 'vitest'
import { createPersonalController, type PersonalTransport } from './controller.ts'

const task = { id: 't-1', title: 'Compromiso', description: null, status: 'next', priority: 'normal', due_at: null, source_type: 'manual', source_id: null, project: null, agent_task_id: null, created_at: '2026-10-08T12:00:00Z', updated_at: '2026-10-08T12:00:00Z', revision: 3 }
const status = { version: '1', timezone: 'America/Tegucigalpa', providers: [], capabilities: { mail_read: true, mail_draft: false, mail_archive: false, agent_supervision: false } }
const overview = { timezone: 'America/Tegucigalpa', as_of: '2026-10-08T12:00:00Z', counts: { open: 1, overdue: 0, urgent_mail: 0, waiting_review: 0 }, priorities: [task], recent_checkins: [], providers: [] }

function transport(overrides: Record<string, unknown> = {}) {
  const records: Record<string, unknown> = {
    '/v1/status': status, '/v1/overview': overview, '/v1/tasks': { items: [task] },
    '/v1/mail/threads?limit=50&offset=0': { items: [], providers: [], total: 0, offset: 0, next_offset: null }, '/v1/checkins': { items: [] }, ...overrides
  }
  return vi.fn<PersonalTransport>(async request => {
    const value = records[request.path]
    if (value instanceof Error) throw value
    return value
  })
}

describe('personal data controller', () => {
  it('refreshes the personal day without depending on the retired mail copy', async () => {
    const request = transport({ '/v1/mail/threads?limit=50&offset=0': new Error('Retired copy is unavailable') })
    const personal = createPersonalController(request)
    await personal.refresh()
    expect(personal.state.get()).toMatchObject({ error: null, tasks: [task] })
    expect(request.mock.calls.some(([req]) => req.path.startsWith('/v1/mail/threads'))).toBe(false)
  })

  it('follows service offsets and returns through the visited pages when page lengths vary', async () => {
    const pages = {
      0: { items: [{ id: 'm-1' }, { id: 'm-2' }], providers: [], total: 6, offset: 0, next_offset: 2 },
      2: { items: [{ id: 'm-3' }, { id: 'm-4' }, { id: 'm-5' }], providers: [], total: 6, offset: 2, next_offset: 5 },
      5: { items: [{ id: 'm-6' }], providers: [], total: 6, offset: 5, next_offset: null }
    }
    const request = vi.fn<PersonalTransport>(async req => pages[Number(new URL(req.path, 'http://qa.test').searchParams.get('offset') ?? 0) as keyof typeof pages])
    const personal = createPersonalController(request)
    await personal.searchMail('', '')
    expect(personal.state.get()).toMatchObject({ mailTotal: 6, mailOffset: 0, mailNextOffset: 2, mailPreviousOffsets: [] })
    await personal.pageMail('next')
    expect(personal.state.get()).toMatchObject({ mailOffset: 2, mailNextOffset: 5, mailPreviousOffsets: [0] })
    await personal.pageMail('next')
    expect(personal.state.get()).toMatchObject({ mailOffset: 5, mailNextOffset: null, mailPreviousOffsets: [0, 2] })
    await personal.pageMail('next')
    expect(request).toHaveBeenCalledTimes(3)
    await personal.pageMail('previous')
    expect(personal.state.get().mail.map(item => item.id)).toEqual(['m-3', 'm-4', 'm-5'])
    await personal.pageMail('previous')
    await personal.pageMail('previous')
    expect(personal.state.get().mailPreviousOffsets).toEqual([])
    expect(request.mock.calls.map(([req]) => new URL(req.path, 'http://qa.test').searchParams.get('offset'))).toEqual(['0', '2', '5', '2', '0'])
    expect(request.mock.calls.every(([req]) => new URL(req.path, 'http://qa.test').searchParams.get('limit') === '50')).toBe(true)
  })

  it('resets pagination when filtering or syncing while retaining the selected search', async () => {
    const base = transport({ '/v1/mail/sync': { count: 60, provider: 'gmail' } })
    const request = vi.fn<PersonalTransport>(async req => {
      if (req.path.startsWith('/v1/mail/threads')) {
        const offset = Number(new URL(req.path, 'http://qa.test').searchParams.get('offset') ?? 0)
        return { items: [{ id: `mail-${offset}` }], providers: [], total: 60, offset, next_offset: offset < 2 ? offset + 1 : null }
      }
      return base(req)
    })
    const personal = createPersonalController(request)
    await personal.searchMail('', '')
    await personal.pageMail('next')
    await personal.searchMail('propuesta', 'action')
    expect(personal.state.get()).toMatchObject({ mailOffset: 0, mailPreviousOffsets: [], mailQuery: 'propuesta', mailCategory: 'action' })
    await personal.pageMail('next')
    await personal.syncMail('gmail')
    expect(personal.state.get()).toMatchObject({ mailOffset: 0, mailPreviousOffsets: [], mailQuery: 'propuesta', mailCategory: 'action' })
    const lastList = request.mock.calls.filter(([req]) => req.path.startsWith('/v1/mail/threads')).at(-1)![0]
    expect(new URL(lastList.path, 'http://qa.test').searchParams.get('q')).toBe('propuesta')
    expect(new URL(lastList.path, 'http://qa.test').searchParams.get('offset')).toBe('0')
  })

  it('keeps the current page and navigation history when the next page fails', async () => {
    const request = vi.fn<PersonalTransport>().mockResolvedValueOnce({ items: [{ id: 'retained' }], providers: [], total: 8, offset: 0, next_offset: 1 }).mockRejectedValueOnce(new Error('Página no disponible'))
    const personal = createPersonalController(request)
    await personal.searchMail('', '')
    await personal.pageMail('next')
    expect(personal.state.get()).toMatchObject({ mailOffset: 0, mailNextOffset: 1, mailPreviousOffsets: [], mailError: 'Página no disponible', mailLoading: false })
    expect(personal.state.get().mail.map(item => item.id)).toEqual(['retained'])
  })

  it('ignores an older page completion after a new filter has finished', async () => {
    let finishPage!: (value: unknown) => void
    const request = vi.fn<PersonalTransport>().mockResolvedValueOnce({ items: [{ id: 'first' }], providers: [], total: 8, offset: 0, next_offset: 1 }).mockImplementationOnce(() => new Promise(resolve => { finishPage = resolve })).mockResolvedValueOnce({ items: [{ id: 'filtered' }], providers: [], total: 1, offset: 0, next_offset: null })
    const personal = createPersonalController(request)
    await personal.searchMail('', '')
    const oldPage = personal.pageMail('next')
    await personal.searchMail('new', '')
    finishPage({ items: [{ id: 'outdated' }], providers: [], total: 8, offset: 1, next_offset: 2 })
    await oldPage
    expect(personal.state.get()).toMatchObject({ mailTotal: 1, mailOffset: 0, mailNextOffset: null, mailPreviousOffsets: [], mailQuery: 'new' })
    expect(personal.state.get().mail.map(item => item.id)).toEqual(['filtered'])
  })

  it('loads real records and preserves the last successful snapshot on a failed refresh', async () => {
    const request = transport()
    const personal = createPersonalController(request)
    expect(personal.state.get().tasks).toEqual([])
    await personal.refresh()
    expect(personal.state.get().tasks[0].id).toBe('t-1')
    request.mockRejectedValue(new Error('Servicio desconectado'))
    await personal.refresh()
    expect(personal.state.get().tasks[0].id).toBe('t-1')
    expect(personal.state.get().error).toContain('Servicio desconectado')
    expect(personal.state.get().loading).toBe(false)
  })

  it('does not let an older mail search replace newer results', async () => {
    let resolveOld!: (value: unknown) => void
    const request = transport()
    request.mockImplementation(async req => new URL(req.path, 'http://qa.test').searchParams.get('q') === 'old' ? new Promise(resolve => { resolveOld = resolve }) : { items: [{ id: 'new' }], providers: [], total: 1, offset: 0, next_offset: null })
    const personal = createPersonalController(request)
    const old = personal.searchMail('old', '')
    await personal.searchMail('new', '')
    resolveOld({ items: [{ id: 'old' }], providers: [], total: 1, offset: 0, next_offset: null })
    await old
    expect(personal.state.get().mail.map(item => item.id)).toEqual(['new'])
  })

  it('sends revision-checked updates and preserves errors for conflict recovery', async () => {
    const request = transport({ '/v1/tasks/t-1': new Error('409: El compromiso cambió; recarga su revisión.') })
    const personal = createPersonalController(request)
    await personal.refresh()
    await expect(personal.updateTask('t-1', { status: 'done', expected_revision: 3 })).rejects.toThrow(/409/)
    expect(request).toHaveBeenCalledWith({ method: 'PATCH', path: '/v1/tasks/t-1', body: { status: 'done', expected_revision: 3 } })
    expect(personal.state.get().tasks[0].status).toBe('next')
  })

  it('captures a mail as a commitment through the deduplicating API route', async () => {
    const request = transport({ '/v1/mail/threads/m-1/task': task })
    const personal = createPersonalController(request)
    await personal.captureMail('m-1')
    expect(request).toHaveBeenCalledWith({ method: 'POST', path: '/v1/mail/threads/m-1/task', body: {} })
    expect(personal.state.get().tasks.filter(item => item.id === 't-1')).toHaveLength(1)
  })

  it('requires draft confirmation and fresh operator capability before any provider write', async () => {
    const request = transport()
    const personal = createPersonalController(request)
    await expect(personal.saveDraft('m-1', 'Respuesta', false)).rejects.toThrow(/confirm/i)
    await expect(personal.saveDraft('m-1', 'Respuesta', true)).rejects.toThrow(/habilitad/i)
    expect(request.mock.calls.some(([req]) => req.path.endsWith('/draft'))).toBe(false)
  })

  it('saves a confirmed draft, without calling any send endpoint', async () => {
    const request = transport({ '/v1/status': { ...status, capabilities: { ...status.capabilities, mail_draft: true } }, '/v1/mail/threads/m-1/draft': { id: 'd-1', provider: 'gmail', web_url: null } })
    const personal = createPersonalController(request)
    await personal.saveDraft('m-1', 'Respuesta', true)
    expect(request).toHaveBeenCalledWith({ method: 'POST', path: '/v1/mail/threads/m-1/draft', body: { body: 'Respuesta' } })
    expect(request.mock.calls.some(([req]) => req.path.includes('/send'))).toBe(false)
  })

  it('requires separate confirmation for archive and undo', async () => {
    const request = transport({ '/v1/status': { ...status, capabilities: { ...status.capabilities, mail_archive: true } }, '/v1/mail/threads/m-1/archive': { action_id: 'a-1', archived: true }, '/v1/mail/actions/a-1/undo': { restored: true } })
    const personal = createPersonalController(request)
    await expect(personal.archiveMail('m-1', false)).rejects.toThrow(/confirm/i)
    await personal.archiveMail('m-1', true)
    await expect(personal.undoArchive('a-1', false)).rejects.toThrow(/confirm/i)
    await personal.undoArchive('a-1', true)
    expect(request).toHaveBeenCalledWith({ method: 'POST', path: '/v1/mail/actions/a-1/undo', body: { confirmed: true } })
  })

  it('does not retry an uncertain external write', async () => {
    const request = transport({ '/v1/status': { ...status, capabilities: { ...status.capabilities, mail_archive: true } }, '/v1/mail/threads/m-1/archive': new Error('Resultado no confirmado') })
    const personal = createPersonalController(request)
    await expect(personal.archiveMail('m-1', true)).rejects.toThrow(/no confirmado/)
    expect(request.mock.calls.filter(([req]) => req.path.endsWith('/archive'))).toHaveLength(1)
  })

  it('saves one check-in for the selected local date without completing tasks', async () => {
    const entry = { id: 'c-1', date: '2026-10-08', accomplished: 'Una llamada', pending: 'Propuesta', tomorrow: 'Revisión', created_at: '', updated_at: '' }
    const request = transport({ '/v1/checkins/2026-10-08': entry })
    const personal = createPersonalController(request)
    await personal.saveCheckin('2026-10-08', { accomplished: entry.accomplished, pending: entry.pending, tomorrow: entry.tomorrow })
    expect(personal.state.get().checkins).toEqual([entry])
    expect(request.mock.calls.some(([req]) => req.method === 'PATCH')).toBe(false)
  })

  it('reads actual coding runs without executing a process or inventing validation', async () => {
    const run = { run_id: 'run-1', revision: 2, scope_id: 'approved-scope', task_id: null, workspace: 'project-alias', agent: 'claude', status: 'completed', created_at: '', updated_at: '', verification: 'not_run', attempts: [{ number: 1, status: 'completed', exit_code: 0 }] }
    const request = transport({ '/v1/agent-runs': { items: [run] } })
    const personal = createPersonalController(request)
    await personal.loadAgentRuns()
    expect(personal.state.get().agentRuns[0].verification).toBe('not_run')
    expect(request).toHaveBeenCalledExactlyOnceWith({ method: 'GET', path: '/v1/agent-runs' })
    request.mockRejectedValue(new Error('Supervisor no disponible'))
    await personal.loadAgentRuns()
    expect(personal.state.get().agentRuns[0].run_id).toBe('run-1')
    expect(personal.state.get().agentRunsError).toContain('Supervisor no disponible')
  })

  it('keeps a saved commitment successful even if the summary refresh fails', async () => {
    const request = transport({ '/v1/tasks/t-1': { ...task, revision: 4, status: 'done' }, '/v1/overview': new Error('Summary offline') })
    const personal = createPersonalController(request)
    const saved = await personal.updateTask('t-1', { status: 'done', expected_revision: 3 })
    expect(saved.revision).toBe(4)
    expect(personal.state.get().tasks[0].status).toBe('done')
    expect(personal.state.get().error).toContain('El cambio se guardó')
  })

  it('replays task creation with the caller identity without duplicating the cached commitment', async () => {
    const request = transport({ '/v1/tasks': task })
    const personal = createPersonalController(request)
    const body = { title: 'Compromiso', idempotency_key: 'stable-request' }
    await personal.createTask(body)
    await personal.createTask(body)
    expect(personal.state.get().tasks).toHaveLength(1)
    expect(request.mock.calls.filter(([req]) => req.method === 'POST')).toEqual([[{ method: 'POST', path: '/v1/tasks', body }], [{ method: 'POST', path: '/v1/tasks', body }]])
  })

  it('reloads a newer task revision and retrieves its audit events', async () => {
    const event = { id: 'e-1', kind: 'updated', created_at: '2026-10-08T12:00:00Z', detail: 'Estado guardado' }
    const request = transport({ '/v1/tasks/t-1': { ...task, revision: 4 }, '/v1/tasks/t-1/events': { items: [event] } })
    const personal = createPersonalController(request)
    await personal.refresh()
    expect((await personal.getTask('t-1')).revision).toBe(4)
    expect(personal.state.get().tasks).toHaveLength(1)
    expect((await personal.taskEvents('t-1')).items).toEqual([event])
  })

  it('syncs only the requested provider and then reads back persisted records', async () => {
    const request = transport({ '/v1/mail/sync': { count: 3, provider: 'gmail' } })
    const personal = createPersonalController(request)
    expect(await personal.syncMail('gmail')).toEqual({ count: 3, provider: 'gmail' })
    expect(request).toHaveBeenCalledWith({ method: 'POST', path: '/v1/mail/sync', body: { provider: 'gmail' } })
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/mail/threads?limit=50&offset=0' })
    expect(personal.state.get().lastLoadedAt).not.toBeNull()
  })

  it('uses encoded mail queries and preserves results after a failed search', async () => {
    const request = transport({ '/v1/mail/threads?category=urgent&q=sender%26subject&limit=50&offset=0': { items: [{ id: 'mail-1' }], providers: [], total: 1, offset: 0, next_offset: null } })
    const personal = createPersonalController(request)
    await personal.searchMail('sender&subject', 'urgent')
    expect(personal.state.get().mail[0].id).toBe('mail-1')
    request.mockRejectedValue(new Error('Búsqueda no disponible'))
    await personal.searchMail('second', 'urgent')
    expect(personal.state.get().mail[0].id).toBe('mail-1')
    expect(personal.state.get().mailError).toBe('Búsqueda no disponible')
    expect(personal.state.get().mailLoading).toBe(false)
  })

  it('updates only the selected mail while preserving other cached messages', async () => {
    const first = { id: 'm-1', category: 'action', task_id: null, archived: false }
    const second = { id: 'm-2', category: 'reference', task_id: null, archived: false }
    const request = transport({ '/v1/mail/threads?limit=50&offset=0': { items: [first, second], providers: [], total: 2, offset: 0, next_offset: null }, '/v1/mail/threads/m-1': { ...first, category: 'urgent' }, '/v1/mail/threads/m-1/task': task, '/v1/status': { ...status, capabilities: { ...status.capabilities, mail_archive: true } }, '/v1/mail/threads/m-1/archive': { action_id: 'a-1', archived: true } })
    const personal = createPersonalController(request)
    await personal.searchMail('', '')
    await personal.categorizeMail('m-1', 'urgent')
    expect(personal.state.get().mail[0].category).toBe('urgent')
    await personal.captureMail('m-1')
    expect(personal.state.get().mail[0].task_id).toBe('t-1')
    await personal.archiveMail('m-1', true)
    expect(personal.state.get().mail[0].archived).toBe(true)
    expect(personal.state.get().mail[1]).toEqual(second)
    expect(personal.state.get().lastArchive).toEqual({ actionId: 'a-1', threadId: 'm-1' })
  })

  it('prevents a double click from creating two provider drafts', async () => {
    let resolveStatus!: (value: unknown) => void
    const request = transport()
    request.mockImplementation(async req => req.path === '/v1/status' ? new Promise(resolve => { resolveStatus = resolve }) : { id: 'draft-1' })
    const personal = createPersonalController(request)
    const first = personal.saveDraft('m-1', 'Texto', true)
    await expect(personal.saveDraft('m-1', 'Texto', true)).rejects.toThrow(/en curso/)
    resolveStatus({ ...status, capabilities: { ...status.capabilities, mail_draft: true } })
    await first
    expect(request.mock.calls.filter(([req]) => req.path.endsWith('/draft'))).toHaveLength(1)
    await expect(personal.saveDraft('m-1', ' ', true)).rejects.toThrow(/texto/)
  })

  it('keeps daily entries sorted and rejects missing calendar dates', async () => {
    const entry = { id: 'day-1', date: '2026-10-08', accomplished: 'Listo', pending: '', tomorrow: '', created_at: '', updated_at: '' }
    const later = { ...entry, id: 'day-2', date: '2026-10-09' }
    const request = transport({ '/v1/checkins/2026-10-08': entry, '/v1/checkins/2026-10-09': later })
    const personal = createPersonalController(request)
    await personal.saveCheckin('2026-10-09', { accomplished: 'Listo', pending: '', tomorrow: '' })
    await personal.saveCheckin('2026-10-08', { accomplished: 'Listo', pending: '', tomorrow: '' })
    expect(personal.state.get().checkins.map(item => item.date)).toEqual(['2026-10-09', '2026-10-08'])
    await expect(personal.saveCheckin('', { accomplished: '', pending: '', tomorrow: '' })).rejects.toThrow(/fecha/)
  })

  it('stores a server brief with its source identities unchanged', async () => {
    const brief = { text: 'Un compromiso abierto', generated_at: '2026-10-08T12:00:00Z', source_ids: ['t-1'] }
    const personal = createPersonalController(transport({ '/v1/brief?kind=morning': brief }))
    expect(await personal.loadBrief('morning')).toEqual(brief)
    expect(personal.state.get().brief).toEqual(brief)
  })
})
