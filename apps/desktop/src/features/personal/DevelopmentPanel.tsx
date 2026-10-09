import { useStore } from '@nanostores/react'
import { IconCode, IconRefresh } from '@tabler/icons-react'
import { useEffect } from 'react'
import type { PersonalAgentRunStatus } from '../../../shared/personal.ts'
import { EmptyGlass, GlassButton, GlassCard, Pill, Section } from '../../components/ui/glass.tsx'
import { $personal, $personalFocus, personal } from '../../store/personal.ts'
import { $page } from '../../store/windows.ts'
import { AgentObservationsPanel } from './AgentObservationsPanel.tsx'
import { dateLabel } from './model.ts'
import { ActionFeedback, usePersonalAction } from './shared.tsx'
import { TaskRow } from './TaskPanel.tsx'

const RUN_LABELS: Record<PersonalAgentRunStatus, string> = { queued: 'En cola', running: 'En ejecución', cancel_requested: 'Cancelación solicitada', completed: 'Proceso terminó', failed: 'Falló', timed_out: 'Tiempo agotado', cancelled: 'Cancelado', interrupted: 'Interrumpido' }

export function DevelopmentPanel() {
  const data = useStore($personal)
  const action = usePersonalAction()
  const focus = useStore($personalFocus)
  const page = useStore($page)
  const active = page === 'personal' && focus.tab === 'development'
  const linkedTasks = data.tasks.filter(task => task.source_type === 'agent' || task.agent_task_id)
  useEffect(() => {
    if (!active) return
    const refresh = () => { void Promise.all([personal.loadAgentObservations(), personal.loadAgentRuns()]) }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => window.clearInterval(timer)
  }, [active, focus.tick])
  return <div className="flex flex-col gap-5">
    <GlassCard className="p-5"><div><h2 className="text-[16px] font-semibold">Desarrollo bajo seguimiento</h2><p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-fg-2">Observa las sesiones reales de Claude Code y OpenCode y consulta las ejecuciones administradas desde Hermes.</p></div><p className="mt-4 text-[12px] text-fg-3">Que una sesión o un proceso termine no confirma que su resultado esté probado. La revisión pendiente permanece visible hasta una validación independiente.</p></GlassCard>
    <AgentObservationsPanel />
    <Section title="Ejecuciones administradas" action={<GlassButton size="sm" disabled={data.agentRunsLoading || action.busy} onClick={() => void action.run('personal.development.refresh')}><IconRefresh />{data.agentRunsLoading ? 'Actualizando…' : 'Actualizar'}</GlassButton>}>
      <div className="flex flex-wrap items-center gap-2"><Pill tone={data.status?.capabilities.agent_supervision ? 'progress' : 'muted'}>{data.status?.capabilities.agent_supervision ? 'Supervisor disponible' : 'Supervisor sin configurar'}</Pill><p className="text-[11px] text-fg-3">Procesos iniciados mediante un alcance autorizado en Hermes.</p></div>
      <ActionFeedback error={data.agentRunsError || action.error} />
      {data.agentRuns.length ? <div className="grid gap-3 xl:grid-cols-2">{data.agentRuns.map(run => <GlassCard key={run.run_id} className="p-5" data-os-target={`personal-run:${run.run_id}`}><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="break-words text-[14px] font-semibold">{run.scope_id}</h3><p className="mt-1 text-[12px] text-fg-3">{run.agent === 'claude' ? 'Claude Code' : 'OpenCode'} · {run.workspace}</p></div><Pill tone={run.status === 'running' ? 'progress' : run.status === 'failed' || run.status === 'timed_out' ? 'danger' : 'muted'}>{RUN_LABELS[run.status]}</Pill></div><div className="mt-3 flex flex-wrap gap-2"><Pill tone="warn">Validación pendiente</Pill><span className="text-[11px] leading-6 text-fg-3">{run.attempts.length} {run.attempts.length === 1 ? 'intento' : 'intentos'} · revisión {run.revision}</span></div><dl className="mt-4 space-y-2 text-[11px]"><div><dt className="text-fg-3">ID de ejecución</dt><dd className="selectable mt-1 break-all text-fg-2">{run.run_id}</dd></div><div><dt className="text-fg-3">Última actualización</dt><dd className="mt-1 text-fg-2">{dateLabel(run.updated_at, true)}</dd></div></dl>{run.attempts.length > 0 && <ol className="mt-4 space-y-2 border-t border-line pt-3">{run.attempts.map(attempt => <li key={attempt.number} className="rounded-lg bg-surface-2 p-3 text-[11px] text-fg-2"><div className="flex flex-wrap justify-between gap-2"><span>Intento {attempt.number} · {RUN_LABELS[attempt.status]}</span><span className="text-fg-3">Salida {attempt.exit_code ?? 'pendiente'}</span></div><p className="mt-1 text-fg-3">{dateLabel(attempt.started_at, true)}{attempt.finished_at ? ` → ${dateLabel(attempt.finished_at, true)}` : ''}</p>{attempt.outcome && <p className="mt-2 break-words">{attempt.outcome}</p>}{(attempt.stdout_sha256 || attempt.stderr_sha256) && <p className="mt-2 text-fg-3">Huellas de evidencia registradas en el supervisor.</p>}</li>)}</ol>}{run.task_id && <GlassButton size="sm" className="mt-4" onClick={() => void action.run('personal.task.show', { id: run.task_id })}>Ver compromiso vinculado</GlassButton>}</GlassCard>)}</div> : <EmptyGlass icon={<IconCode />} title={data.agentRunsLoading ? 'Consultando ejecuciones…' : 'No hay ejecuciones registradas'} description="Las ejecuciones aparecerán cuando el operador configure un proyecto y un alcance autorizado en el supervisor de Hermes." />}
    </Section>
    <Section title="Compromisos vinculados a agentes">{linkedTasks.length ? <div className="grid gap-3 lg:grid-cols-2">{linkedTasks.map(task => <TaskRow key={task.id} task={task} onClick={() => void action.run('personal.task.show', { id: task.id })} />)}</div> : <p className="text-[12px] text-fg-3">Todavía no hay compromisos asociados a un agente.</p>}</Section>
  </div>
}
