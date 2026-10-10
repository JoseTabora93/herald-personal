import type { PersonalEvent, PersonalProviderStatus, PersonalTask } from '../../../shared/personal.ts'

export const PERSONAL_TIMEZONE = 'America/Tegucigalpa'
export type PersonalTab = 'today' | 'mail' | 'tasks' | 'journal' | 'development' | 'projects'
export const TAB_LABELS: Record<PersonalTab, string> = { today: 'Hoy', mail: 'Correo', tasks: 'Compromisos', journal: 'Diario', development: 'Desarrollo', projects: 'Proyectos' }
export const TASK_STATUS: Record<PersonalTask['status'], string> = { inbox: 'Por ordenar', next: 'Siguiente', in_progress: 'En curso', waiting: 'En espera', done: 'Completado', cancelled: 'Cancelado' }
export const TASK_PRIORITY: Record<PersonalTask['priority'], string> = { low: 'Baja', normal: 'Normal', high: 'Alta' }
export const MAIL_CATEGORY = { urgent: 'Urgente', action: 'Por atender', waiting: 'En espera', reference: 'Referencia', newsletter: 'Boletín' } as const
export const PROVIDER_NAMES = { gmail: 'Gmail', microsoft365: 'Microsoft 365' } as const

export interface TaskForm {
  title: string
  description: string
  status: PersonalTask['status']
  priority: PersonalTask['priority']
  dueDate: string
  project: string
}

export function localDate(value: Date | string = new Date()): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PERSONAL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (type: string) => parts.find(item => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function dateToDueAt(value: string): string | null {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('La fecha debe tener el formato año-mes-día.')
  const date = new Date(`${value}T00:00:00-06:00`)
  if (Number.isNaN(date.getTime()) || localDate(date) !== value) throw new Error('La fecha no existe en el calendario.')
  return value
}

export const dueDateInput = (value: string | null): string => value ? value.length === 10 ? dateToDueAt(value) ?? '' : localDate(value) : ''

export function dateLabel(value: string | null, time = false): string {
  if (!value) return 'Sin fecha'
  const date = new Date(value.length === 10 ? `${value}T12:00:00-06:00` : value)
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible'
  return new Intl.DateTimeFormat('es-HN', { timeZone: PERSONAL_TIMEZONE, day: 'numeric', month: 'short', ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}) }).format(date)
}

export function taskForm(task?: PersonalTask): TaskForm {
  return { title: task?.title ?? '', description: task?.description ?? '', status: task?.status ?? 'inbox', priority: task?.priority ?? 'normal', dueDate: dueDateInput(task?.due_at ?? null), project: task?.project ?? '' }
}

function taskFields(form: TaskForm) {
  const title = form.title.trim()
  if (!title || title.length > 500) throw new Error('El título debe tener entre 1 y 500 caracteres.')
  if (!(form.status in TASK_STATUS) || !(form.priority in TASK_PRIORITY)) throw new Error('Selecciona un estado y una prioridad válidos.')
  return { title, description: form.description.trim() || null, status: form.status, priority: form.priority, due_at: dateToDueAt(form.dueDate), project: form.project.trim() || null }
}

export function buildTaskCreate(form: TaskForm, idempotencyKey: string) {
  if (!idempotencyKey) throw new Error('Falta la referencia de este compromiso. Vuelve a abrir el formulario.')
  return { ...taskFields(form), source_type: 'manual' as const, idempotency_key: idempotencyKey }
}

export function buildTaskPatch(form: TaskForm, expectedRevision: number, originalDueAt?: string | null) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('Recarga el compromiso antes de editarlo.')
  const fields = taskFields(form)
  const dueAt = originalDueAt && dueDateInput(originalDueAt) === form.dueDate ? originalDueAt : fields.due_at
  return { ...fields, due_at: dueAt, expected_revision: expectedRevision }
}

export function providerLabel(provider: PersonalProviderStatus): string {
  if (!provider.configured) return 'Sin configurar'
  if (provider.error) return 'Requiere atención'
  return provider.connected ? 'Conectado' : 'Sin conexión'
}

export function safeMailUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const hosts = ['mail.google.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.live.com']
    return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname) ? url.href : null
  } catch {
    return null
  }
}

export const isOpenTask = (task: PersonalTask): boolean => task.status !== 'done' && task.status !== 'cancelled'

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'No se pudo completar la operación.'
  return error.message.replace(/^Error invoking remote method 'herald-os:personal:request':\s*(?:Error:\s*)?/, '').replace(/^\d{3}:\s*/, '')
}

export function taskEventPresentation(event: Pick<PersonalEvent, 'kind' | 'detail'>): { label: string; detail: string } {
  const fallback = { label: 'Actividad registrada', detail: 'El servicio guardó un cambio en este compromiso.' }
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  let detail: unknown
  try { detail = JSON.parse(event.detail) } catch { return fallback }
  if (!record(detail)) return fallback
  if (event.kind === 'created') {
    const origins = { mail: 'Capturado desde un correo.', agent: 'Capturado desde un agente.', manual: 'Capturado en el espacio personal.' }
    const source = detail.source_type
    return { label: 'Creado', detail: typeof source === 'string' && Object.hasOwn(origins, source) ? origins[source as keyof typeof origins] : 'Compromiso capturado.' }
  }
  if (event.kind !== 'updated' || !record(detail.before) || !record(detail.after)) return fallback
  const before = detail.before
  const after = detail.after
  const labels: Record<string, string> = { title: 'título', description: 'detalle', status: 'estado', priority: 'prioridad', due_at: 'fecha límite', project: 'proyecto' }
  const changed = Object.keys(labels).filter(key => Object.hasOwn(after, key) && before[key] !== after[key])
  const parts: string[] = []
  const status = after.status
  const knownStatus = changed.includes('status') && typeof status === 'string' && Object.hasOwn(TASK_STATUS, status)
  if (knownStatus) parts.push(`Estado: ${TASK_STATUS[status as PersonalTask['status']]}.`)
  const fields = changed.filter(key => key !== 'status' || !knownStatus).map(key => labels[key])
  if (fields.length) parts.push(`Cambios: ${fields.join(', ')}.`)
  if (Number.isInteger(detail.revision) && Number(detail.revision) > 0) parts.push(`Revisión ${detail.revision}.`)
  return { label: 'Actualizado', detail: parts.join(' ') || 'El compromiso se guardó sin cambios de contenido.' }
}
