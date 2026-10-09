import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineCommands, resetCommands, runCommand } from '../../store/os-commands.ts'
import { personalCommands } from '../../commands/personal.ts'

const mock = vi.hoisted(() => ({
  focus: vi.fn(), showPage: vi.fn(), saveDraft: vi.fn(), archiveMail: vi.fn(), undoArchive: vi.fn(), updateTask: vi.fn(), createTask: vi.fn(), openWeb: vi.fn(),
  refresh: vi.fn(), loadAgentRuns: vi.fn(), loadAgentObservations: vi.fn(), getTask: vi.fn(), searchMail: vi.fn(), pageMail: vi.fn(), syncMail: vi.fn(), categorizeMail: vi.fn(), captureMail: vi.fn(), saveCheckin: vi.fn(), loadBrief: vi.fn(),
  state: { error: null as string | null, mailError: null as string | null, agentRunsError: null as string | null, mail: [] as { id: string; subject: string; web_url: string | null }[] }
}))
vi.mock('../../store/personal.ts', () => ({
  focusPersonal: mock.focus,
  $personal: { get: () => mock.state },
  personal: mock
}))
vi.mock('../../store/windows.ts', () => ({ showPage: mock.showPage }))
vi.mock('../../store/web-windows.ts', () => ({ openWebWindow: mock.openWeb }))

describe('personal OS commands', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mock.state = { error: null, mailError: null, agentRunsError: null, mail: [] }
    resetCommands()
    defineCommands(personalCommands)
  })

  it('passes the submitted revision through to the service instead of taking a newer cached revision', async () => {
    mock.updateTask.mockResolvedValue({ id: 'task-1', title: 'Propuesta', revision: 5 })
    const result = await runCommand('personal.task.save', { id: 'task-1', title: 'Propuesta', status: 'next', priority: 'normal', revision: 4 }, { source: 'ui' })
    expect(result.ok).toBe(true)
    expect(mock.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ expected_revision: 4 }))
  })

  it('returns a readable conflict message to every command surface', async () => {
    mock.updateTask.mockRejectedValue(new Error("Error invoking remote method 'herald-os:personal:request': Error: 409: El registro cambió. Actualiza antes de continuar."))
    const result = await runCommand('personal.task.status', { id: 'task-1', status: 'done', revision: 3 }, { source: 'ui' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('El registro cambió. Actualiza antes de continuar.')
  })

  it.each(['today', 'mail', 'tasks', 'journal', 'development'])('opens %s through the shell navigation contract', async tab => {
    expect((await runCommand('personal.open', { tab }, { source: 'voice' })).ok).toBe(true)
    expect(mock.showPage).toHaveBeenCalledWith('personal')
    expect(mock.focus).toHaveBeenCalledWith({ tab })
  })

  it('reports service failures truthfully instead of claiming an update succeeded', async () => {
    expect((await runCommand('personal.refresh', {}, { source: 'ui' })).ok).toBe(true)
    mock.state.error = 'Servicio desconectado'
    expect((await runCommand('personal.refresh', {}, { source: 'ui' })).error).toBe('Servicio desconectado')
    expect((await runCommand('personal.development.refresh', {}, { source: 'ui' })).ok).toBe(true)
    mock.state.agentRunsError = 'Supervisor no disponible'
    expect((await runCommand('personal.development.refresh', {}, { source: 'ui' })).error).toBe('Supervisor no disponible')
  })

  it('creates and opens the returned durable task identity', async () => {
    mock.createTask.mockResolvedValue({ id: 'saved-task', title: 'Llamar' })
    expect((await runCommand('personal.task.new', {}, { source: 'ui' })).ok).toBe(true)
    expect(mock.focus).toHaveBeenCalledWith({ tab: 'tasks', compose: true })
    const result = await runCommand('personal.task.save', { title: 'Llamar', idempotencyKey: 'stable' }, { source: 'ui' })
    expect(result.data?.task).toMatchObject({ id: 'saved-task' })
    expect(mock.createTask).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: 'stable', source_type: 'manual' }))
    expect(mock.focus).toHaveBeenLastCalledWith({ tab: 'tasks', taskId: 'saved-task' })
  })

  it('loads a task before showing it and sends status revisions unchanged', async () => {
    mock.getTask.mockResolvedValue({ id: 'task-1', title: 'Propuesta' })
    expect((await runCommand('personal.task.show', { id: 'task-1' }, { source: 'agent' })).data?.task).toMatchObject({ id: 'task-1' })
    mock.updateTask.mockResolvedValue({ id: 'task-1', status: 'done' })
    expect((await runCommand('personal.task.status', { id: 'task-1', status: 'done', revision: 6 }, { source: 'ui' })).summary).toContain('Completado')
    expect(mock.updateTask).toHaveBeenCalledWith('task-1', { status: 'done', expected_revision: 6 })
    await runCommand('personal.tasks.filter', { query: 'BAC', status: 'waiting' }, { source: 'ui' })
    expect(mock.focus).toHaveBeenLastCalledWith({ tab: 'tasks', query: 'BAC', status: 'waiting' })
  })

  it('keeps check-in content and brief source records separate from task mutations', async () => {
    await runCommand('personal.checkin.open', { date: '2026-10-08' }, { source: 'ui' })
    expect(mock.focus).toHaveBeenLastCalledWith({ tab: 'journal', checkinDate: '2026-10-08' })
    mock.saveCheckin.mockResolvedValue({ id: 'entry-1' })
    await runCommand('personal.checkin.save', { date: '2026-10-08', accomplished: 'Listo', pending: 'Pendiente', tomorrow: 'Seguir' }, { source: 'ui' })
    expect(mock.saveCheckin).toHaveBeenCalledWith('2026-10-08', { accomplished: 'Listo', pending: 'Pendiente', tomorrow: 'Seguir' })
    mock.loadBrief.mockResolvedValue({ text: 'Un pendiente', source_ids: ['task-1'] })
    expect((await runCommand('personal.brief', { kind: 'evening' }, { source: 'ui' })).data?.brief).toMatchObject({ source_ids: ['task-1'] })
    expect(mock.updateTask).not.toHaveBeenCalled()
  })
})
