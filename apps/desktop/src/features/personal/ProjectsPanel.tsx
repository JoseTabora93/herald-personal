import { useStore } from '@nanostores/react'
import { IconAlertTriangle, IconArrowUpRight, IconCheck, IconClock, IconFolder, IconGitPullRequest, IconMessageCircle, IconRefresh } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import type { PersonalProject, PersonalProjectItem, PersonalProjectSource } from '../../../shared/personal.ts'
import { EmptyGlass, GlassButton, GlassCard, Pill, ProgressBar, Section } from '../../components/ui/glass.tsx'
import { $personal, $personalFocus, personal } from '../../store/personal.ts'
import { $page } from '../../store/windows.ts'
import { dateLabel, taskEventPresentation } from './model.ts'
import { PROJECT_LANES, PROJECT_STAGE, projectPresentation } from './projects-model.ts'
import { ActionFeedback, usePersonalAction } from './shared.tsx'

const sourceLabel = { ok: 'Consulta recibida', partial: 'Consulta parcial', stale: 'Consulta atrasada', error: 'Falló la consulta' }
const runLabel = { queued: 'En cola', running: 'En ejecución', completed: 'Proceso terminó', failed: 'Falló', cancelled: 'Cancelado', unknown: 'Sin ejecución confirmada' }

function ProjectSource({ source }: { source: PersonalProjectSource }) {
  return <div className="space-y-2 border-t border-line pt-3 text-[12px] first:border-t-0 first:pt-0" data-os-target={`project-source:${source.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{source.label}</span><Pill tone={source.health === 'ok' ? 'ok' : 'warn'} dot>{sourceLabel[source.health]}</Pill></div>
    <p className="text-fg-2">Última consulta: {dateLabel(source.last_attempt_at, true)} · cada {Math.round(source.interval_seconds / 60)} min.</p>
    {source.health !== 'ok' && <p className="text-warn">{source.github_error ? 'GitHub no respondió. Se conserva el último PR confirmado.' : source.error === 'source_invalid' ? 'El origen devolvió datos inválidos.' : source.health === 'stale' ? 'El sincronizador no ha enviado una consulta dentro del plazo esperado.' : 'No se pudo consultar el origen. Se conserva la evidencia anterior.'} {source.last_success_at && `Último éxito: ${dateLabel(source.last_success_at, true)}.`}</p>}
    <p className="text-fg-3">{source.run_fresh ? `Señal de ejecución: ${dateLabel(source.source_updated_at, true)}.` : source.source_updated_at ? `Señal de ejecución sin vigencia: ${dateLabel(source.source_updated_at, true)}.` : 'El origen no confirma la hora de su señal de ejecución.'}</p>
    {source.warnings.length > 0 && <ul className="space-y-1.5 text-warn">{source.warnings.map((warning, index) => <li key={`${index}-${warning}`} className="flex items-start gap-2"><IconAlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{warning}</span></li>)}</ul>}
  </div>
}

function Evidence({ item, project, action }: { item: PersonalProjectItem; project: PersonalProject; action: ReturnType<typeof usePersonalAction> }) {
  const presentation = PROJECT_STAGE[item.stage]
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }) }, [item.task.id])
  return <div ref={ref}><GlassCard selected className="p-5" data-testid="project-evidence">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="text-[11px] font-medium uppercase tracking-wider text-accent-strong">Detalle del trabajo</p><h3 className="mt-2 break-words text-[16px] font-semibold">{item.task.title}</h3></div><Pill tone={presentation.tone}>{presentation.label}</Pill></div>
    <p className="mt-3 text-[13px] text-fg-2">{item.reason}</p>
    <dl className="mt-4 grid gap-4 text-[12px] sm:grid-cols-3">
      <div><dt className="text-fg-3">Ejecución</dt><dd className="mt-1 text-fg-2">{item.run_id ? runLabel[item.run_status] : 'Sin ejecución vinculada'}</dd>{item.run_id && <dd className="selectable mt-1 break-all font-mono text-[11px] text-fg-3">{item.run_id}</dd>}{item.source_id && <dd className="mt-1 text-fg-3">{item.run_fresh && !item.missing ? 'Señal reciente del origen' : 'Actividad actual no confirmada'}</dd>}</div>
      <div><dt className="text-fg-3">Pull request</dt><dd className="mt-1 text-fg-2">{item.pr ? `#${item.pr.number} · ${item.pr.state === 'MERGED' ? 'Integrado' : item.pr.state === 'OPEN' ? 'Abierto' : 'Cerrado sin integrar'}` : 'Sin PR vinculado'}</dd>{item.pr_checked_at && <dd className="mt-1 text-fg-3">Consultado {dateLabel(item.pr_checked_at, true)}</dd>}{item.branch && <dd className="selectable mt-1 break-all text-[11px] text-fg-3">{item.branch}</dd>}</div>
      <div><dt className="text-fg-3">Entrega</dt><dd className="mt-1 text-fg-2">Despliegue: sin verificar</dd><dd className="mt-1 text-fg-2">Validación funcional: pendiente</dd></div>
    </dl>
    <div className="mt-4 flex flex-wrap gap-2">{item.pr && <GlassButton size="sm" onClick={() => void action.run('personal.project.pr', { id: project.id, taskId: item.task.id })}><IconGitPullRequest size={15} />Ver PR #{item.pr.number}<IconArrowUpRight size={14} /></GlassButton>}<GlassButton size="sm" onClick={() => void action.run('personal.task.show', { id: item.task.id })}>Abrir compromiso</GlassButton></div>
  </GlassCard></div>
}

export function ProjectsPanel() {
  const data = useStore($personal)
  const focus = useStore($personalFocus)
  const page = useStore($page)
  const action = usePersonalAction()
  const [now, setNow] = useState(Date.now)
  const active = page === 'personal' && focus.tab === 'projects'
  useEffect(() => {
    if (!active) return
    const refresh = () => { setNow(Date.now()); if (!personal.state.get().projectsLoading) void personal.loadProjects() }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => window.clearInterval(timer)
  }, [active])
  const projects = data.projects.map(project => projectPresentation(project, now))
  const project = projects.find(value => value.id === focus.projectId) ?? projects[0]
  const selected = project?.items.find(item => item.task.id === focus.projectItemId)
  const count = project?.counts
  const select = (id: string, taskId?: string) => void action.run('personal.project.select', { id, ...(taskId ? { taskId } : {}) })

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[16px] font-semibold">Seguimiento por proyecto</h2><p className="mt-1 text-[12px] text-fg-3">Avances, revisiones y próximos pasos en un mismo tablero.</p></div><div className="flex items-center gap-2"><GlassButton size="sm" disabled={data.projectsLoading || action.busy} onClick={() => void action.run('personal.projects.refresh')}><IconRefresh size={15} className={data.projectsLoading ? 'animate-spin' : ''} />Actualizar panel</GlassButton>{project && <GlassButton size="sm" variant="primary" onClick={() => void action.run('personal.project.chat.open', { id: project.id })}><IconMessageCircle size={16} />Conversar con Hermes</GlassButton>}</div></div>
    <ActionFeedback error={data.projectsError || action.error} />
    {!project || !count ? <EmptyGlass icon={<IconFolder />} title={data.projectsLoading ? 'Consultando proyectos…' : 'Todavía no hay proyectos'} description="Asigna un proyecto a un compromiso para reunir su seguimiento aquí. Los orígenes conectados añaden sus ejecuciones y PRs." /> : <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
      <nav aria-label="Proyectos" className="grid gap-3 sm:grid-cols-2 lg:sticky lg:top-0 lg:grid-cols-1">{projects.map(value => <GlassCard as="button" interactive selected={project.id === value.id} key={value.id} className="min-w-0 p-4" aria-label={`Ver proyecto ${value.name}`} aria-pressed={project.id === value.id} data-os-target={`personal-project:${value.id}`} onClick={() => select(value.id)}><div className="mb-3 flex items-center gap-2 text-accent-strong"><IconFolder size={18} /><span className="text-[11px]">PROYECTO</span></div><h3 className="break-words text-[14px] font-semibold">{value.name}</h3><p className="mt-2 text-[12px] text-fg-3">{value.counts.closed} de {value.counts.total} cerrados</p><ProgressBar value={value.counts.total ? value.counts.closed / value.counts.total * 100 : 0} tone="ok" className="mt-3" />{value.counts.attention + value.counts.review > 0 && <p className="mt-3 text-[11px] text-warn">{value.counts.attention + value.counts.review} por atender o revisar</p>}</GlassCard>)}</nav>
      <div className="min-w-0 space-y-5">
        <GlassCard className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="break-words text-[22px] font-semibold tracking-tight">{project.name}</h2><p className="mt-1 text-[12px] text-fg-3">{count.total} trabajos bajo seguimiento · incluye terminados</p></div><Pill tone={count.attention ? 'warn' : count.review ? 'info' : 'ok'} dot>{count.attention ? 'Necesita atención' : count.review ? 'Hay trabajo por revisar' : 'Sin bloqueos registrados'}</Pill></div>
          {project.sources.map(source => <div key={source.id} className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"><span className={source.health === 'ok' ? 'text-fg-3' : 'text-warn'}>{source.health === 'ok' ? 'Consulta del origen' : sourceLabel[source.health]}: {dateLabel(source.last_attempt_at, true)} · cada {Math.round(source.interval_seconds / 60)} min</span>{!source.run_fresh && <span className="text-warn">Actividad remota actual sin confirmar</span>}</div>)}
          <div className="mt-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
            {[{ label: 'En curso', value: count.running, icon: <IconClock size={16} />, color: 'text-progress' }, { label: 'Por atender', value: count.attention, icon: <IconAlertTriangle size={16} />, color: 'text-warn' }, { label: 'PRs abiertos', value: count.review, icon: <IconGitPullRequest size={16} />, color: 'text-info' }, { label: 'PRs integrados', value: count.merged, icon: <IconCheck size={16} />, color: 'text-ok' }].map(metric => <div key={metric.label} className="border-l border-line pl-4"><div className={`flex items-center gap-2 text-[11px] ${metric.color}`}>{metric.icon}{metric.label}</div><p className="mt-2 text-[28px] font-semibold leading-none tabular-nums">{metric.value}</p></div>)}
          </div>
          <div className="mt-5 border-t border-line pt-4"><div className="mb-2 flex justify-between gap-2 text-[12px]"><span className="text-fg-2">Cierre de compromisos</span><span className="font-medium text-ok">{count.closed} / {count.total}</span></div><ProgressBar value={count.total ? count.closed / count.total * 100 : 0} tone="ok" /><p className="mt-2 text-[11px] text-fg-3">Un PR integrado no confirma despliegue ni validación funcional.</p></div>
        </GlassCard>
        {selected && <Evidence item={selected} project={project} action={action} />}
        <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Tablero del proyecto">{PROJECT_LANES.map(lane => {
          const items = project.items.filter(item => lane.stages.includes(item.stage))
          return <section key={lane.id} aria-label={lane.label} className="min-w-0 rounded-xl bg-surface-2 p-3"><div className={`mb-3 flex items-center justify-between gap-2 text-[12px] font-semibold ${lane.tone}`}><h3>{lane.label}</h3><span className="rounded-md bg-line px-2 py-0.5 tabular-nums">{items.length}</span></div><div className="space-y-2.5">{items.length ? items.map(item => <GlassCard as="button" key={item.task.id} interactive selected={selected?.task.id === item.task.id} className="w-full min-w-0 p-3" data-os-target={`project-task:${item.task.id}`} aria-label={`Ver tarea ${item.task.title}`} onClick={() => select(project.id, item.task.id)}><p className="break-words text-[12px] font-medium leading-relaxed">{item.task.title}</p><div className="mt-3"><Pill className="max-w-full !text-[10px]" tone={PROJECT_STAGE[item.stage].tone}>{PROJECT_STAGE[item.stage].label}</Pill></div><p className="mt-2 text-[11px] text-fg-3">{item.pr ? `PR #${item.pr.number}` : item.run_id ? `Run ${item.run_id}` : item.source_id ? 'Sin ejecución vinculada' : 'Compromiso personal'}</p></GlassCard>) : <p className="py-5 text-center text-[11px] text-fg-4">Sin trabajos en esta etapa</p>}</div></section>
        })}</div>
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <GlassCard className="p-4"><Section title="Fuentes y sincronización"><div className="space-y-4">{project.sources.length ? project.sources.map(source => <ProjectSource key={source.id} source={source} />) : <p className="text-[12px] text-fg-3">Compromisos locales. Este proyecto todavía no tiene un origen de ejecuciones conectado.</p>}</div>{project.sources.length > 0 && <p className="mt-3 text-[11px] text-fg-4">El panel consulta Herald cada 15 s mientras está visible. El origen sigue su horario; el sincronizador local requiere la Mac encendida.</p>}</Section></GlassCard>
          <GlassCard className="p-4"><Section title="Últimos cambios"><ol className="space-y-4">{project.events.map(event => <li key={event.id} className="border-l border-line-strong pl-3"><p className="break-words text-[12px] font-medium">{event.title}</p><p className="mt-1 text-[11px] text-fg-2">{taskEventPresentation(event).detail}</p><p className="mt-1 text-[11px] text-fg-4">{dateLabel(event.created_at, true)}</p></li>)}</ol>{!project.events.length && <p className="text-[12px] text-fg-3">Sin cambios registrados.</p>}</Section></GlassCard>
        </div>
      </div>
    </div>}
  </div>
}
