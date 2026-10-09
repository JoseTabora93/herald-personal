import { useStore } from '@nanostores/react'
import { IconActivity, IconRefresh } from '@tabler/icons-react'
import { EmptyGlass, GlassButton, GlassCard, Pill, Section } from '../../components/ui/glass.tsx'
import { $personal } from '../../store/personal.ts'
import { dateLabel } from './model.ts'
import { observationPresentation } from './planning-model.ts'
import { ActionFeedback, usePersonalAction } from './shared.tsx'

const CONFIDENCE = { high: 'Alta', medium: 'Media', low: 'Baja' }

export function AgentObservationsPanel() {
  const data = useStore($personal)
  const action = usePersonalAction()
  return <Section title="Sesiones observadas" action={<GlassButton size="sm" disabled={data.agentObservationsLoading || action.busy} onClick={() => void action.run('personal.development.refresh')}><IconRefresh className={data.agentObservationsLoading ? 'animate-spin' : ''} />Actualizar</GlassButton>}>
    <p className="max-w-3xl text-[12px] leading-relaxed text-fg-3">Lee la actividad registrada por Claude Code y OpenCode. Una espera de permiso requiere tu decisión en la sesión original. Estas observaciones no ejecutan ni aprueban trabajo.</p>
    <ActionFeedback error={data.agentObservationsError || action.error} />
    {data.agentObservations.length ? <div className="grid gap-3 xl:grid-cols-2">{data.agentObservations.map(observation => {
      const display = observationPresentation(observation)
      return <GlassCard key={observation.observer_id} className="p-5" data-os-target={`personal-observation:${observation.observer_id}`}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-[14px] font-semibold">{observation.agent === 'claude' ? 'Claude Code' : 'OpenCode'}</h3><p className="mt-1 break-words text-[12px] text-fg-3">{observation.workspace}</p></div><Pill tone={display.tone}>{display.label}</Pill></div>
        <div className="mt-3 flex flex-wrap gap-2"><Pill tone="warn">{display.verification}</Pill><Pill tone={observation.is_stale ? 'warn' : 'muted'}>{display.freshness}</Pill></div>
        <dl className="mt-4 grid gap-3 text-[11px] sm:grid-cols-2"><div><dt className="text-fg-3">Observado</dt><dd className="mt-1 text-fg-2">{dateLabel(observation.observed_at, true)}</dd></div><div><dt className="text-fg-3">Última actividad de la fuente</dt><dd className="mt-1 text-fg-2">{observation.source_updated_at ? dateLabel(observation.source_updated_at, true) : 'No informada'}</dd></div></dl>
        {observation.signals.length > 0 && <ul className="mt-4 list-disc space-y-1 pl-4 text-[11.5px] leading-relaxed text-fg-2">{observation.signals.map((signal, index) => <li key={index}>{signal}</li>)}</ul>}
        <details className="mt-4 border-t border-line pt-3 text-[11px]"><summary className="cursor-pointer text-fg-3">Fuente y sesión</summary><dl className="mt-3 space-y-2"><div><dt className="text-fg-3">Fuente de observación</dt><dd className="mt-1 break-words text-fg-2">{observation.evidence_source}</dd></div><div><dt className="text-fg-3">Sesión original</dt><dd className="selectable mt-1 break-all text-fg-2">{observation.native_session_id}</dd></div><div><dt className="text-fg-3">Confianza del observador</dt><dd className="mt-1 text-fg-2">{CONFIDENCE[observation.confidence]} · revisión {observation.revision} · vigencia {observation.stale_after_seconds} s</dd></div></dl></details>
      </GlassCard>
    })}</div> : <EmptyGlass icon={<IconActivity />} title={data.agentObservationsLoading ? 'Consultando sesiones…' : 'Todavía no hay sesiones observadas'} description="Aquí aparecerán las sesiones que detecte el observador configurado. Un listado vacío no confirma que todos tus agentes estén detenidos." />}
  </Section>
}
