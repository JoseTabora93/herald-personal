import { atom } from 'nanostores'
import type { PersonalObserverMonitor, PersonalAgentObservation, PersonalAgentRun, PersonalCheckin, PersonalDailyPlan, PersonalMailPage, PersonalMailThread, PersonalOverview, PersonalProviderStatus, PersonalRequest, PersonalStatus, PersonalTask } from '../../../shared/personal.ts'
import { dateToDueAt, errorMessage } from './model.ts'
import type { PersonalProject } from '../../../shared/personal.ts'

export type PersonalTransport = (request: PersonalRequest) => Promise<unknown>
export interface PersonalBrief { text: string; generated_at: string; source_ids: string[] }
export interface TaskEvent { id: string; kind: string; created_at: string; detail: string }
export interface PersonalData {
  projects: PersonalProject[]
  projectsLoading: boolean
  projectsError: string | null
  projectsLoadedAt: string | null
  status: PersonalStatus | null
  overview: PersonalOverview | null
  tasks: PersonalTask[]
  mail: PersonalMailThread[]
  providers: PersonalProviderStatus[]
  checkins: PersonalCheckin[]
  loading: boolean
  mailLoading: boolean
  error: string | null
  mailError: string | null
  lastLoadedAt: string | null
  mailQuery: string
  mailCategory: string
  mailTotal: number
  mailOffset: number
  mailNextOffset: number | null
  mailPreviousOffsets: number[]
  brief: PersonalBrief | null
  lastArchive: { actionId: string; threadId: string } | null
  agentRuns: PersonalAgentRun[]
  agentRunsLoading: boolean
  agentRunsError: string | null
  observationHistory: boolean
  observerMonitor: PersonalObserverMonitor | null
  agentObservations: PersonalAgentObservation[]
  agentObservationsLoading: boolean
  agentObservationsError: string | null
  dailyPlan: PersonalDailyPlan | null
  dailyPlanDate: string | null
  dailyPlanLoading: boolean
  dailyPlanError: string | null
}

const itemPath = (prefix: string, id: string) => `${prefix}/${encodeURIComponent(id)}`
const upsert = <T extends { id: string }>(items: T[], value: T): T[] => [value, ...items.filter(item => item.id !== value.id)]
const mailPath = (query: string, category: string, offset: number) => {
  const params = new URLSearchParams()
  if (category) params.set('category', category)
  if (query.trim()) params.set('q', query.trim())
  params.set('limit', '50')
  params.set('offset', String(offset))
  return `/v1/mail/threads?${params}`
}

const mailSnapshot = (result: PersonalMailPage, query: string, category: string, previousOffsets: number[]): Partial<PersonalData> => ({ mail: result.items, providers: result.providers, mailTotal: result.total, mailOffset: result.offset, mailNextOffset: result.next_offset, mailPreviousOffsets: previousOffsets, mailQuery: query, mailCategory: category, mailLoading: false, mailError: null })

/** Renderer state contains service records only. The injected transport owns authentication. */
export function createPersonalController(transport: PersonalTransport) {
  const state = atom<PersonalData>({ projects: [], projectsLoading: false, projectsError: null, projectsLoadedAt: null, status: null, overview: null, tasks: [], mail: [], providers: [], checkins: [], loading: false, mailLoading: false, error: null, mailError: null, lastLoadedAt: null, mailQuery: '', mailCategory: '', mailTotal: 0, mailOffset: 0, mailNextOffset: null, mailPreviousOffsets: [], brief: null, lastArchive: null, agentRuns: [], agentRunsLoading: false, agentRunsError: null, observationHistory: false, observerMonitor: null, agentObservations: [], agentObservationsLoading: false, agentObservationsError: null, dailyPlan: null, dailyPlanDate: null, dailyPlanLoading: false, dailyPlanError: null })
  const patch = (value: Partial<PersonalData>) => state.set({ ...state.get(), ...value })
  const request = async <T>(method: PersonalRequest['method'], path: string, body?: unknown): Promise<T> => transport({ method, path, ...(body === undefined ? {} : { body }) } as PersonalRequest) as Promise<T>
  let generation = 0
  let mailGeneration = 0
  let runsGeneration = 0
  let observationsGeneration = 0
  let planGeneration = 0
  let projectsGeneration = 0
  const writes = new Set<string>()

  async function refresh() {
    const current = ++generation
    patch({ loading: true, error: null })
    try {
      const [status, overview, tasks, checkins] = await Promise.all([
        request<PersonalStatus>('GET', '/v1/status'), request<PersonalOverview>('GET', '/v1/overview'),
        request<{ items: PersonalTask[] }>('GET', '/v1/tasks'),
        request<{ items: PersonalCheckin[] }>('GET', '/v1/checkins')
      ])
      if (current !== generation) return
      patch({ status, overview, tasks: tasks.items, checkins: checkins.items, providers: status.providers, loading: false, error: null, lastLoadedAt: new Date().toISOString() })
    } catch (error) {
      if (current === generation) patch({ loading: false, error: errorMessage(error) })
    }
  }

  async function loadMailPage(query: string, category: string, offset: number, previousOffsets: number[]) {
    const current = ++mailGeneration
    patch({ mailLoading: true, mailError: null })
    try {
      const result = await request<PersonalMailPage>('GET', mailPath(query, category, offset))
      if (current === mailGeneration) patch(mailSnapshot(result, query, category, previousOffsets))
    } catch (error) {
      if (current === mailGeneration) patch({ mailError: errorMessage(error), mailLoading: false })
    }
  }

  const searchMail = (query: string, category: string) => loadMailPage(query, category, 0, [])

  async function pageMail(direction: 'next' | 'previous') {
    const data = state.get()
    if (data.mailLoading || data.loading) return
    const offset = direction === 'next' ? data.mailNextOffset : data.mailPreviousOffsets.at(-1)
    if (offset == null) return
    const previousOffsets = direction === 'next' ? [...data.mailPreviousOffsets, data.mailOffset] : data.mailPreviousOffsets.slice(0, -1)
    await loadMailPage(data.mailQuery, data.mailCategory, offset, previousOffsets)
  }

  async function updateOverview() {
    try {
      const overview = await request<PersonalOverview>('GET', '/v1/overview')
      patch({ overview })
    } catch {
      patch({ error: 'El cambio se guardó. No se pudo actualizar el resumen; vuelve a actualizarlo.' })
    }
  }

  async function saveTask(method: 'POST' | 'PATCH', path: string, body: unknown) {
    const result = await request<PersonalTask>(method, path, body)
    ++generation
    patch({ tasks: upsert(state.get().tasks, result), loading: false })
    await updateOverview()
    return result
  }

  async function externalWrite<T>(key: string, capability: 'mail_draft' | 'mail_archive', confirmed: boolean, action: () => Promise<T>) {
    if (!confirmed) throw new Error('Confirma esta acción en la pantalla de correo.')
    if (writes.has(key)) throw new Error('Esta operación está en curso. Espera su resultado.')
    writes.add(key)
    try {
      const status = await request<PersonalStatus>('GET', '/v1/status')
      patch({ status, providers: status.providers })
      if (!status.capabilities[capability]) throw new Error('Esta acción no está habilitada por el operador de la conexión.')
      return await action()
    } finally {
      writes.delete(key)
    }
  }

  return {
    state, refresh, searchMail, pageMail,
    async loadProjects() {
      const current = ++projectsGeneration
      patch({ projectsLoading: true, projectsError: null })
      try {
        const result = await request<{ items: PersonalProject[]; as_of: string }>('GET', '/v1/projects')
        if (current === projectsGeneration) patch({ projects: result.items, projectsLoading: false, projectsLoadedAt: result.as_of })
      } catch (error) {
        if (current === projectsGeneration) patch({ projectsLoading: false, projectsError: errorMessage(error) })
      }
    },
    async loadDailyPlan(date: string) {
      const current = ++planGeneration
      patch({ dailyPlanDate: date, dailyPlan: state.get().dailyPlan?.date === date ? state.get().dailyPlan : null, dailyPlanLoading: true, dailyPlanError: null })
      try {
        const result = await request<{ items: PersonalDailyPlan[] }>('GET', `/v1/daily-plans?date=${encodeURIComponent(date)}`)
        if (current === planGeneration) patch({ dailyPlan: result.items.find(plan => plan.date === date) ?? null, dailyPlanLoading: false })
      } catch (error) {
        if (current === planGeneration) patch({ dailyPlanLoading: false, dailyPlanError: errorMessage(error) })
      }
    },
    async generateDailyPlan(date: string) {
      const current = ++planGeneration
      patch({ dailyPlanDate: date, dailyPlan: state.get().dailyPlan?.date === date ? state.get().dailyPlan : null, dailyPlanLoading: true, dailyPlanError: null })
      try {
        const result = await request<PersonalDailyPlan>('POST', '/v1/daily-plans/generate', { date })
        if (current === planGeneration) patch({ dailyPlan: result, dailyPlanLoading: false })
      } catch (error) {
        if (current === planGeneration) patch({ dailyPlanLoading: false, dailyPlanError: errorMessage(error) })
      }
    },
    showObservationHistory(show: boolean) { patch({ observationHistory: show }) },
    async loadAgentObservations() {
      const current = ++observationsGeneration
      patch({ agentObservationsLoading: true, agentObservationsError: null })
      try {
        const result = await request<{ items: PersonalAgentObservation[]; monitor?: PersonalObserverMonitor }>('GET', '/v1/agent-observations')
        if (current === observationsGeneration) patch({ observerMonitor: result.monitor || null, agentObservations: result.items, agentObservationsLoading: false })
      } catch (error) {
        if (current === observationsGeneration) patch({ agentObservationsLoading: false, agentObservationsError: errorMessage(error) })
      }
    },
    async loadAgentRuns() {
      const current = ++runsGeneration
      patch({ agentRunsLoading: true, agentRunsError: null })
      try {
        const result = await request<{ items: PersonalAgentRun[] }>('GET', '/v1/agent-runs')
        if (current === runsGeneration) patch({ agentRuns: result.items, agentRunsLoading: false })
      } catch (error) {
        if (current === runsGeneration) patch({ agentRunsError: errorMessage(error), agentRunsLoading: false })
      }
    },
    createTask: (body: unknown) => saveTask('POST', '/v1/tasks', body),
    captureWorkspaceMail: (clave: string) => saveTask('POST', '/v1/mail-workspace/tasks', { clave }),
    updateTask: (id: string, body: { expected_revision: number } & Record<string, unknown>) => saveTask('PATCH', itemPath('/v1/tasks', id), body),
    async getTask(id: string) {
      const task = await request<PersonalTask>('GET', itemPath('/v1/tasks', id))
      patch({ tasks: upsert(state.get().tasks, task) })
      return task
    },
    taskEvents: (id: string) => request<{ items: TaskEvent[] }>('GET', `${itemPath('/v1/tasks', id)}/events`),
    async syncMail(provider: PersonalProviderStatus['provider']) {
      const result = await request<{ count: number; provider: string }>('POST', '/v1/mail/sync', { provider })
      await refresh()
      await searchMail(state.get().mailQuery, state.get().mailCategory)
      return result
    },
    async categorizeMail(id: string, category: PersonalMailThread['category']) {
      const result = await request<PersonalMailThread>('PATCH', itemPath('/v1/mail/threads', id), { category })
      ++mailGeneration
      patch({ mail: state.get().mail.map(item => item.id === id ? result : item), mailLoading: false })
      await updateOverview()
      return result
    },
    async captureMail(id: string) {
      const task = await request<PersonalTask>('POST', `${itemPath('/v1/mail/threads', id)}/task`, {})
      ++generation
      ++mailGeneration
      patch({ tasks: upsert(state.get().tasks, task), mail: state.get().mail.map(item => item.id === id ? { ...item, task_id: task.id } : item), loading: false, mailLoading: false })
      await updateOverview()
      return task
    },
    async saveDraft(id: string, body: string, confirmed: boolean) {
      if (!body.trim()) throw new Error('Escribe el texto del borrador.')
      return externalWrite(`draft:${id}`, 'mail_draft', confirmed, () => request<{ id: string; web_url: string | null; provider: string }>('POST', `${itemPath('/v1/mail/threads', id)}/draft`, { body }))
    },
    async archiveMail(id: string, confirmed: boolean) {
      const result = await externalWrite(`archive:${id}`, 'mail_archive', confirmed, () => request<{ action_id: string; archived: true }>('POST', `${itemPath('/v1/mail/threads', id)}/archive`, { confirmed: true }))
      ++mailGeneration
      patch({ mail: state.get().mail.map(item => item.id === id ? { ...item, archived: true } : item), lastArchive: { actionId: result.action_id, threadId: id }, mailLoading: false })
      await updateOverview()
      return result
    },
    async undoArchive(actionId: string, confirmed: boolean) {
      const result = await externalWrite(`undo:${actionId}`, 'mail_archive', confirmed, () => request<{ restored: true }>('POST', `${itemPath('/v1/mail/actions', actionId)}/undo`, { confirmed: true }))
      patch({ lastArchive: null })
      await refresh()
      return result
    },
    async saveCheckin(date: string, body: Pick<PersonalCheckin, 'accomplished' | 'pending' | 'tomorrow'>) {
      if (!date) throw new Error('Selecciona la fecha del diario.')
      dateToDueAt(date)
      const result = await request<PersonalCheckin>('PUT', itemPath('/v1/checkins', date), body)
      ++generation
      patch({ checkins: upsert(state.get().checkins, result).sort((a, b) => b.date.localeCompare(a.date)), loading: false })
      await updateOverview()
      return result
    },
    async loadBrief(kind: 'morning' | 'evening') {
      const brief = await request<PersonalBrief>('GET', `/v1/brief?kind=${kind}`)
      patch({ brief })
      return brief
    }
  }
}
