import type { PersonalProject, PersonalProjectStage } from '../../../shared/personal.ts'
import type { PillTone } from '../../components/ui/glass.tsx'

export const PROJECT_STAGE: Record<PersonalProjectStage, { label: string; tone: PillTone }> = {
  planned: { label: 'Por hacer', tone: 'muted' }, running: { label: 'En curso', tone: 'progress' },
  review: { label: 'PR abierto', tone: 'info' }, attention: { label: 'Requiere atención', tone: 'warn' },
  unknown: { label: 'Sin señal reciente', tone: 'warn' }, integrated: { label: 'PR integrado', tone: 'ok' },
  completed: { label: 'Completado', tone: 'ok' }, cancelled: { label: 'Cancelado', tone: 'muted' }
}
export const PROJECT_LANES: { id: string; label: string; stages: PersonalProjectStage[]; tone: string }[] = [
  { id: 'planned', label: 'Por hacer', stages: ['planned'], tone: 'text-fg-2' },
  { id: 'running', label: 'En curso', stages: ['running'], tone: 'text-progress' },
  { id: 'attention', label: 'Revisar / atender', stages: ['review', 'attention', 'unknown'], tone: 'text-warn' },
  { id: 'closed', label: 'Cerrados', stages: ['integrated', 'completed', 'cancelled'], tone: 'text-ok' }
]

export function safeProjectPr(url: string): string | null {
  return /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/pull\/[1-9][0-9]*$/.test(url) ? url : null
}

/** A disconnected renderer must expire its last observed execution as well. */
export function projectPresentation(project: PersonalProject, now = Date.now()): PersonalProject {
  const sources = project.sources.map(source => now - Date.parse(source.last_attempt_at) > (source.interval_seconds * 2 + 60) * 1000 ? { ...source, health: 'stale' as const, run_fresh: false } : source)
  const items = project.items.map(item => {
    const source = sources.find(value => value.id === item.source_id)
    if (!source || !['running', 'planned'].includes(item.stage)) return item
    const age = item.source_updated_at ? now - Date.parse(item.source_updated_at) : Infinity
    return source.health === 'error' || source.health === 'stale' || !Number.isFinite(age) || age < -60_000 || age > (source.interval_seconds * 2 + 60) * 1000
      ? { ...item, stage: 'unknown' as const, run_fresh: false, reason: 'La señal de ejecución perdió vigencia. Se conserva la última evidencia recibida.' }
      : item
  })
  return { ...project, sources, items, counts: { ...project.counts, running: items.filter(i => i.stage === 'running').length, attention: items.filter(i => ['attention', 'unknown'].includes(i.stage)).length } }
}
