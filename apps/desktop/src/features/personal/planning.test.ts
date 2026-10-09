import { describe, expect, it, vi } from 'vitest'
import type { PersonalAgentObservation, PersonalDailyPlan } from '../../../shared/personal.ts'
import { createPersonalController, type PersonalTransport } from './controller.ts'
import { modelErrorLabel, observationPresentation, recommendationAuthor } from './planning-model.ts'

const plan: PersonalDailyPlan = {
  date: '2026-10-09', timezone: 'America/Tegucigalpa', revision: 2, generated_at: '2026-10-09T14:00:00Z', updated_at: '2026-10-09T14:01:00Z',
  status: 'partial', summary: 'Revisar las prioridades guardadas.', priorities: [], recommendations: [],
  sources: [{ id: 'mail-workspace', kind: 'mail_workspace', status: 'unavailable', as_of: null, description: 'Correo no disponible' }],
  mail_summary: { available: false, last_sync_at: null, window_days: null, total: 0, needs_reply: 0, waiting_reply: 0, unclassified: 0 },
  agent_summary: { active: 0, attention: 0, unknown: 1 }, limitations: ['No hay calendario.'], model: null, model_error: 'timeout', verification: 'not_run'
}
const observation: PersonalAgentObservation = { observer_id: 'observe-1', revision: 1, observed_at: '2026-10-09T14:00:00Z', agent: 'claude', native_session_id: 'session-1', workspace: 'fixture-project', status: 'active', effective_status: 'active', evidence_source: 'claude-session-events', confidence: 'medium', source_updated_at: '2026-10-09T13:59:58Z', stale_after_seconds: 180, signals: ['Actividad de herramienta reciente'], verification: 'not_run', is_stale: false }

describe('daily plan and observer controller', () => {
  it('loads the persisted plan for a local calendar date without generating or modifying anything', async () => {
    const request = vi.fn<PersonalTransport>().mockResolvedValue({ items: [plan] })
    const personal = createPersonalController(request)
    await personal.loadDailyPlan('2026-10-09')
    expect(request).toHaveBeenCalledExactlyOnceWith({ method: 'GET', path: '/v1/daily-plans?date=2026-10-09' })
    expect(personal.state.get()).toMatchObject({ dailyPlan: plan, dailyPlanDate: '2026-10-09', dailyPlanError: null })
  })

  it('leaves an absent plan empty and generates only through the explicit operation', async () => {
    const request = vi.fn<PersonalTransport>().mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce(plan)
    const personal = createPersonalController(request)
    await personal.loadDailyPlan('2026-10-09')
    expect(personal.state.get().dailyPlan).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    await personal.generateDailyPlan('2026-10-09')
    expect(request).toHaveBeenLastCalledWith({ method: 'POST', path: '/v1/daily-plans/generate', body: { date: '2026-10-09' } })
    expect(personal.state.get().dailyPlan).toEqual(plan)
  })

  it('retains the last saved plan with an explicit error when the next read fails', async () => {
    const request = vi.fn<PersonalTransport>().mockResolvedValueOnce({ items: [plan] }).mockRejectedValueOnce(new Error('Servicio sin conexión'))
    const personal = createPersonalController(request)
    await personal.loadDailyPlan('2026-10-09')
    await personal.loadDailyPlan('2026-10-09')
    expect(personal.state.get()).toMatchObject({ dailyPlan: plan, dailyPlanError: 'Servicio sin conexión', dailyPlanLoading: false })
  })

  it('does not show an earlier date response after a later date was selected', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn<PersonalTransport>().mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ items: [{ ...plan, date: '2026-10-10' }] })
    const personal = createPersonalController(request)
    const old = personal.loadDailyPlan('2026-10-09')
    await personal.loadDailyPlan('2026-10-10')
    finish({ items: [plan] })
    await old
    expect(personal.state.get().dailyPlan?.date).toBe('2026-10-10')
  })

  it('does not replace a new generated revision with an older in-flight read', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn<PersonalTransport>().mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ ...plan, revision: 3 })
    const personal = createPersonalController(request)
    const old = personal.loadDailyPlan('2026-10-09')
    await personal.generateDailyPlan('2026-10-09')
    finish({ items: [plan] })
    await old
    expect(personal.state.get().dailyPlan?.revision).toBe(3)
  })

  it('loads actual observations separately from managed runner execution records', async () => {
    const request = vi.fn<PersonalTransport>().mockResolvedValue({ items: [observation] })
    const personal = createPersonalController(request)
    await personal.loadAgentObservations()
    expect(request).toHaveBeenCalledExactlyOnceWith({ method: 'GET', path: '/v1/agent-observations' })
    expect(personal.state.get()).toMatchObject({ agentObservations: [observation], agentObservationsError: null, agentRuns: [] })
  })

  it('preserves observations with a visible refresh error instead of reporting an empty agent list', async () => {
    const request = vi.fn<PersonalTransport>().mockResolvedValueOnce({ items: [observation] }).mockRejectedValueOnce(new Error('Observador sin conexión'))
    const personal = createPersonalController(request)
    await personal.loadAgentObservations()
    await personal.loadAgentObservations()
    expect(personal.state.get()).toMatchObject({ agentObservations: [observation], agentObservationsError: 'Observador sin conexión', agentObservationsLoading: false })
  })
})

describe('honest planning and observation presentation', () => {
  it('labels elapsed observer evidence as unknown even if its last raw state was active', () => {
    const display = observationPresentation({ ...observation, is_stale: true, effective_status: 'unknown' })
    expect(display).toMatchObject({ label: 'Estado desconocido', freshness: 'Observación vencida', verification: 'Resultado sin revisar' })
    expect(display.label).not.toContain('Activo')
  })

  it('separates a session ending from independent result review', () => {
    expect(observationPresentation({ ...observation, status: 'ended', effective_status: 'ended' })).toMatchObject({ label: 'Sesión terminó', verification: 'Resultado sin revisar' })
  })

  it('identifies permissions and user input as different attention states', () => {
    expect(observationPresentation({ ...observation, effective_status: 'waiting_permission' }).label).toBe('Espera permiso')
    expect(observationPresentation({ ...observation, effective_status: 'waiting_input' }).label).toBe('Espera tu respuesta')
  })

  it('identifies deterministic recommendations and the actual model used by Hermes', () => {
    expect(recommendationAuthor('rules', null)).toBe('Reglas del servicio')
    expect(recommendationAuthor('hermes', 'fixture-model')).toBe('Hermes · fixture-model')
    expect(recommendationAuthor('hermes', null)).toBe('Hermes · modelo no informado')
  })

  it('reports model failure without calling deterministic guidance an AI-reviewed plan', () => {
    expect(modelErrorLabel('timeout')).toContain('tiempo')
    expect(modelErrorLabel('not_configured')).toContain('configurado')
    expect(modelErrorLabel('invalid_response')).toContain('válida')
    expect(modelErrorLabel('provider_error')).toContain('proveedor')
    expect(modelErrorLabel(null)).toBeNull()
  })
})
