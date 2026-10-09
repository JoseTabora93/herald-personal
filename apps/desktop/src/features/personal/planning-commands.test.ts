import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineCommands, resetCommands, runCommand } from '../../store/os-commands.ts'
import { personalCommands } from '../../commands/personal.ts'

const mock = vi.hoisted(() => ({
  focus: vi.fn(), showPage: vi.fn(), loadDailyPlan: vi.fn(), generateDailyPlan: vi.fn(), loadAgentRuns: vi.fn(), loadAgentObservations: vi.fn(),
  state: { dailyPlanError: null as string | null, agentRunsError: null as string | null, agentObservationsError: null as string | null }
}))
vi.mock('../../store/personal.ts', () => ({ focusPersonal: mock.focus, $personal: { get: () => mock.state }, personal: mock }))
vi.mock('../../store/windows.ts', () => ({ showPage: mock.showPage }))
vi.mock('../../store/web-windows.ts', () => ({ openWebWindow: vi.fn() }))

describe('plan and observation OS commands', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mock.state = { dailyPlanError: null, agentRunsError: null, agentObservationsError: null }
    resetCommands()
    defineCommands(personalCommands)
  })

  it('reads an existing daily plan without generating a new one', async () => {
    expect((await runCommand('personal.plan.refresh', { date: '2026-10-09' }, { source: 'ui' })).ok).toBe(true)
    expect(mock.loadDailyPlan).toHaveBeenCalledExactlyOnceWith('2026-10-09')
    expect(mock.generateDailyPlan).not.toHaveBeenCalled()
  })

  it('generates only when that action is explicitly requested', async () => {
    expect((await runCommand('personal.plan.generate', { date: '2026-10-09' }, { source: 'ui' })).ok).toBe(true)
    expect(mock.generateDailyPlan).toHaveBeenCalledExactlyOnceWith('2026-10-09')
  })

  it('surfaces plan failure instead of claiming a prepared or reviewed plan', async () => {
    mock.state.dailyPlanError = 'No se pudo guardar el plan.'
    const result = await runCommand('personal.plan.generate', { date: '2026-10-09' }, { source: 'ui' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('No se pudo guardar el plan.')
  })

  it('refreshes both observation and managed execution sources and reports either failure', async () => {
    const result = await runCommand('personal.development.refresh', {}, { source: 'ui' })
    expect(result.ok).toBe(true)
    expect(mock.loadAgentObservations).toHaveBeenCalledOnce()
    expect(mock.loadAgentRuns).toHaveBeenCalledOnce()
    mock.state.agentObservationsError = 'Observaciones no disponibles.'
    expect((await runCommand('personal.development.refresh', {}, { source: 'ui' })).error).toBe('Observaciones no disponibles.')
  })
})
