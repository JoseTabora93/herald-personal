import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineCommands, resetCommands, runCommand } from '../../store/os-commands.ts'
import { personalCommands } from '../../commands/personal.ts'

const mock = vi.hoisted(() => ({
  focus: vi.fn(), showPage: vi.fn(), sendPrompt: vi.fn(), navigate: vi.fn(), reload: vi.fn(), captureWorkspaceMail: vi.fn(),
  state: { phase: 'ready', selectedClave: 'MAIL-243', error: null as string | null },
  personalState: { error: null, mailError: null, agentRunsError: null, mail: [] }
}))
vi.mock('../../store/personal.ts', () => ({
  focusPersonal: mock.focus,
  $personal: { get: () => mock.personalState },
  personal: { captureWorkspaceMail: mock.captureWorkspaceMail },
  mailWorkspace: { state: { get: () => mock.state }, navigate: mock.navigate, reload: mock.reload }
}))
vi.mock('../../store/windows.ts', () => ({ showPage: mock.showPage }))
vi.mock('../../store/chat.ts', () => ({ sendPrompt: mock.sendPrompt }))
vi.mock('../../store/web-windows.ts', () => ({ openWebWindow: vi.fn() }))

describe('embedded mail OS commands', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mock.state = { phase: 'ready', selectedClave: 'MAIL-243', error: null }
    resetCommands()
    defineCommands(personalCommands)
  })

  it('does not expose commands that read or mutate the retired personal mail copy', () => {
    const ids = personalCommands.map(command => command.id)
    for (const suffix of ['search', 'page', 'show', 'sync', 'category', 'capture', 'draft', 'archive', 'undo', 'cancel', 'confirmWrite', 'openProvider']) {
      expect(ids).not.toContain(`personal.mail.${suffix}`)
    }
  })

  it.each(['tablero', 'lista', 'seguimiento', 'aprendizajes', 'limpieza', 'rezagados', 'historico'])('opens %s inside Personal Correo through the existing guest', async view => {
    const result = await runCommand('personal.mailWorkspace.open', { view }, { source: 'ui' })
    expect(result.ok).toBe(true)
    expect(mock.focus).toHaveBeenCalledWith({ tab: 'mail' })
    expect(mock.showPage).toHaveBeenCalledWith('personal')
    expect(mock.navigate).toHaveBeenCalledExactlyOnceWith(`/${view}`)
  })

  it('retries the mail service explicitly and surfaces the current failure', async () => {
    mock.state.error = 'Ingelmec Mail no está disponible.'
    const result = await runCommand('personal.mailWorkspace.reload', {}, { source: 'ui' })
    expect(mock.reload).toHaveBeenCalledOnce()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Ingelmec Mail no está disponible.')
  })

  it('reports a guarded open editor without claiming navigation or reload succeeded', async () => {
    const error = new Error('Cierra el editor de correo antes de cambiar de vista o recargar.')
    mock.navigate.mockRejectedValueOnce(error)
    mock.reload.mockRejectedValueOnce(error)
    expect((await runCommand('personal.mailWorkspace.open', { view: 'lista' }, { source: 'voice' })).error).toBe(error.message)
    expect((await runCommand('personal.mailWorkspace.reload', {}, { source: 'ui' })).error).toBe(error.message)
  })

  it('passes only the current trusted MAIL key to Hermes and rejects caller-supplied context', async () => {
    mock.sendPrompt.mockResolvedValue('hermes-session')
    const rejected = await runCommand('personal.mailWorkspace.ask', { clave: 'MAIL-999', body: 'Untrusted body', title: 'Untrusted title' }, { source: 'ui' })
    expect(rejected.ok).toBe(false)
    expect(mock.sendPrompt).not.toHaveBeenCalled()
    const result = await runCommand('personal.mailWorkspace.ask', {}, { source: 'ui' })
    expect(result.ok).toBe(true)
    expect(mock.showPage).toHaveBeenCalledWith('hermes')
    expect(mock.sendPrompt).toHaveBeenCalledOnce()
    const text = mock.sendPrompt.mock.calls[0]?.[0] as string
    expect(text).toContain('MAIL-243')
    expect(text).not.toMatch(/MAIL-999|Untrusted/)
    expect(mock.captureWorkspaceMail).not.toHaveBeenCalled()
  })

  it.each(['loading', 'error', 'closed'])('does not ask Hermes using a stale selection while %s', async phase => {
    mock.state.phase = phase
    const result = await runCommand('personal.mailWorkspace.ask', {}, { source: 'ui' })
    expect(result.ok).toBe(false)
    expect(mock.sendPrompt).not.toHaveBeenCalled()
  })

  it('requires an actual selected mail before asking Hermes or capturing a task', async () => {
    mock.state.selectedClave = ''
    expect((await runCommand('personal.mailWorkspace.ask', {}, { source: 'ui' })).ok).toBe(false)
    expect((await runCommand('personal.mailWorkspace.capture', {}, { source: 'ui' })).ok).toBe(false)
    expect(mock.sendPrompt).not.toHaveBeenCalled()
    expect(mock.captureWorkspaceMail).not.toHaveBeenCalled()
  })

  it('captures the selected workspace identity once through the authoritative API and opens its task', async () => {
    mock.captureWorkspaceMail.mockResolvedValue({ id: 'durable-task-7', source_id: 'MAIL-243', title: 'Dar seguimiento' })
    const result = await runCommand('personal.mailWorkspace.capture', {}, { source: 'ui' })
    expect(result.ok).toBe(true)
    expect(mock.captureWorkspaceMail).toHaveBeenCalledExactlyOnceWith('MAIL-243')
    expect(mock.focus).toHaveBeenLastCalledWith({ tab: 'tasks', taskId: 'durable-task-7' })
    expect(result.data?.task).toMatchObject({ id: 'durable-task-7' })
  })
})
