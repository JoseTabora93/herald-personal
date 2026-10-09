import type { PersonalAgentObservation, PersonalDailyPlan, PersonalObservationStatus } from '../../../shared/personal.ts'

const OBSERVATION_LABELS: Record<PersonalObservationStatus, string> = {
  active: 'Actividad reciente', idle: 'Sin actividad reciente', waiting_permission: 'Espera permiso', waiting_input: 'Espera tu respuesta',
  retrying: 'Reintentando', error: 'Error observado', ended: 'Sesión terminó', unknown: 'Estado desconocido'
}

export function observationPresentation(observation: PersonalAgentObservation) {
  const status = observation.is_stale ? 'unknown' : observation.effective_status
  const tone: 'muted' | 'warn' | 'danger' | 'progress' = status === 'error' ? 'danger' : status === 'active' ? 'progress' : ['waiting_permission', 'waiting_input', 'retrying', 'unknown'].includes(status) ? 'warn' : 'muted'
  return { label: OBSERVATION_LABELS[status], tone, freshness: observation.is_stale ? 'Observación vencida' : 'Observación reciente', verification: 'Resultado sin revisar' }
}

export function recommendationAuthor(author: 'rules' | 'hermes', model: string | null): string {
  return author === 'rules' ? 'Reglas del servicio' : `Hermes · ${model || 'modelo no informado'}`
}

export function modelErrorLabel(error: PersonalDailyPlan['model_error']): string | null {
  const labels = {
    not_configured: 'El modelo de Hermes no está configurado. Se conserva la propuesta basada en reglas.',
    timeout: 'Hermes no respondió a tiempo. Se conserva la propuesta basada en reglas.',
    invalid_response: 'La respuesta del modelo no fue válida. Se conserva la propuesta basada en reglas.',
    provider_error: 'El proveedor del modelo no respondió correctamente. Se conserva la propuesta basada en reglas.'
  }
  return error ? labels[error] : null
}
