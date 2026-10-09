import { useStore } from '@nanostores/react'
import { IconArrowRight, IconCalendar, IconRefresh, IconSparkles } from '@tabler/icons-react'
import { useEffect } from 'react'
import type { PersonalDailyPlan } from '../../../shared/personal.ts'
import { EmptyGlass, GlassButton, GlassCard, Pill, Section } from '../../components/ui/glass.tsx'
import { $personal, $personalFocus, personal } from '../../store/personal.ts'
import { $page } from '../../store/windows.ts'
import { dateLabel, localDate } from './model.ts'
import { modelErrorLabel, recommendationAuthor } from './planning-model.ts'
import { ActionFeedback, usePersonalAction } from './shared.tsx'

function SourceButton({ source }: { source: PersonalDailyPlan['sources'][number] }) {
  const action = usePersonalAction()
  const taskId = source.id.match(/^task:([a-zA-Z0-9-]+)$/)?.[1]
  const target = taskId ? { command: 'personal.task.show', args: { id: taskId } } : source.id === 'mail-workspace' ? { command: 'personal.mailWorkspace.open', args: { view: 'seguimiento' } } : source.id.startsWith('agent:') ? { command: 'personal.open', args: { tab: 'development' } } : null
  return <div className="rounded-lg border border-line p-3 text-[11px]">
    <div className="flex flex-wrap items-start justify-between gap-2"><span className="min-w-0 flex-1 break-words text-fg-2">{source.description}</span><Pill tone={source.status === 'available' ? 'muted' : 'warn'}>{source.status === 'available' ? 'Consultada' : source.status === 'stale' ? 'Información antigua' : 'No disponible'}</Pill></div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="break-all text-fg-3">{source.id} · {source.as_of ? dateLabel(source.as_of, true) : 'Sin fecha de consulta'}</span>{target && <GlassButton size="sm" variant="ghost" disabled={action.busy} onClick={() => void action.run(target.command, target.args)}>Ver fuente<IconArrowRight /></GlassButton>}</div>
    <ActionFeedback error={action.error} />
  </div>
}

export function DailyPlanPanel() {
  const data = useStore($personal)
  const action = usePersonalAction()
  const date = localDate()
  const focus = useStore($personalFocus)
  const page = useStore($page)
  const plan = data.dailyPlan?.date === date ? data.dailyPlan : null
  useEffect(() => { if (page === 'personal' && focus.tab === 'today') void personal.loadDailyPlan(date) }, [date, page, focus.tab, focus.tick])
  const busy = data.dailyPlanLoading || action.busy
  const modelError = modelErrorLabel(plan?.model_error ?? null)
  return <Section title="Plan del día" action={<div className="flex flex-wrap gap-2"><GlassButton size="sm" disabled={busy} onClick={() => void action.run('personal.plan.refresh', { date })}><IconRefresh className={data.dailyPlanLoading ? 'animate-spin' : ''} />Consultar guardado</GlassButton>{!plan && <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void action.run('personal.plan.generate', { date })}><IconSparkles />Preparar plan</GlassButton>}</div>}>
    <p className="text-[11px] text-fg-3">{dateLabel(date)} · Rutina de las 08:00 en Tegucigalpa</p>
    <ActionFeedback error={data.dailyPlanError || action.error} />
    {plan ? <GlassCard className="overflow-hidden">
      <div className="border-b border-line p-5"><div className="mb-3 flex flex-wrap gap-2"><Pill tone={plan.status === 'partial' ? 'warn' : 'muted'}>{plan.status === 'partial' ? 'Fuentes incompletas' : 'Propuesta guardada'}</Pill><Pill tone="warn">Pendiente de tu revisión</Pill><Pill>Revisión {plan.revision}</Pill></div><p className="selectable whitespace-pre-wrap text-[14px] leading-relaxed text-fg">{plan.summary}</p><p className="mt-3 text-[11px] text-fg-3">Preparado {dateLabel(plan.generated_at, true)} · Actualizado {dateLabel(plan.updated_at, true)}</p>
        {modelError && <p role="status" className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3 text-[12px] leading-relaxed text-warn">{modelError}</p>}
      </div>
      <div className="grid gap-5 p-5 xl:grid-cols-2">
        <div><h3 className="text-[12px] font-semibold">Prioridades propuestas</h3>{plan.priorities.length ? <ol className="mt-3 space-y-3">{plan.priorities.map((priority, index) => <li key={priority.id} className="flex gap-3 rounded-lg bg-surface-2 p-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent-strong">{index + 1}</span><div className="min-w-0"><p className="break-words text-[12.5px] font-medium">{priority.title}</p><p className="mt-1 text-[11px] leading-relaxed text-fg-3">{priority.reason}</p><p className="mt-2 break-all text-[10px] text-fg-4">Fuente: {priority.source_ref}</p></div></li>)}</ol> : <p className="mt-3 text-[12px] text-fg-3">No hay prioridades propuestas en este plan. Puedes registrar tus compromisos para el siguiente.</p>}</div>
        <div><h3 className="text-[12px] font-semibold">Siguientes pasos sugeridos</h3>{plan.recommendations.length ? <div className="mt-3 space-y-3">{plan.recommendations.map((recommendation, index) => <div key={`${index}:${recommendation.title}`} className="rounded-lg border border-line p-3"><p className="break-words text-[12.5px] font-medium">{recommendation.title}</p><p className="mt-1 text-[11px] leading-relaxed text-fg-3">{recommendation.reason}</p><p className="mt-2 text-[10.5px] text-accent-strong">{recommendationAuthor(recommendation.author, plan.model)}</p><p className="mt-1 break-words text-[10px] text-fg-4">Fuentes: {recommendation.evidence_refs.join(' · ') || 'No informadas'}</p></div>)}</div> : <p className="mt-3 text-[12px] text-fg-3">No hay recomendaciones adicionales guardadas.</p>}</div>
      </div>
      <div className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-2"><div className="text-[11.5px] text-fg-2"><p className="font-medium">Correo en el plan</p><p className="mt-1 text-fg-3">{plan.mail_summary.available ? `${plan.mail_summary.needs_reply} por responder · ${plan.mail_summary.waiting_reply} en espera · ${plan.mail_summary.unclassified} sin clasificar` : 'No disponible; no se interpreta como un buzón vacío.'}</p>{plan.mail_summary.available && <p className="mt-1 text-[10.5px] text-fg-4">Última sincronización: {dateLabel(plan.mail_summary.last_sync_at, true)}</p>}</div><div className="text-[11.5px] text-fg-2"><p className="font-medium">Sesiones observadas en el plan</p><p className="mt-1 text-fg-3">{plan.agent_summary.active} con actividad · {plan.agent_summary.attention} requieren atención · {plan.agent_summary.unknown} sin estado conocido</p></div></div>
      {plan.limitations.length > 0 && <div className="border-t border-line px-5 py-4"><h3 className="text-[11.5px] font-medium text-fg-2">Límites de esta propuesta</h3><ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-fg-3">{plan.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></div>}
      <details className="border-t border-line px-5 py-4"><summary className="cursor-pointer text-[12px] font-medium text-fg-2">Fuentes y frescura · {plan.sources.length}</summary><div className="mt-3 grid max-h-80 gap-2 overflow-y-auto">{plan.sources.map(source => <SourceButton key={source.id} source={source} />)}</div></details>
    </GlassCard> : <EmptyGlass icon={<IconCalendar />} title={data.dailyPlanLoading ? 'Consultando el plan guardado…' : 'Todavía no hay un plan guardado para hoy'} description="Prepararlo reúne los compromisos, el estado del correo y las observaciones disponibles. Después podrás revisar la propuesta y sus fuentes." />}
  </Section>
}
