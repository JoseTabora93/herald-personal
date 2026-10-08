import { useStore } from '@nanostores/react'
import { IconArrowRight, IconBook, IconChecklist, IconClock, IconFileText, IconMail, IconSun } from '@tabler/icons-react'
import { EmptyGlass, GlassButton, GlassCard, Pill, Section } from '../../components/ui/glass.tsx'
import { $personal } from '../../store/personal.ts'
import { dateLabel, PERSONAL_TIMEZONE } from './model.ts'
import { ActionFeedback, ProviderConnections, usePersonalAction } from './shared.tsx'
import { TaskRow } from './TaskPanel.tsx'

export function TodayPanel() {
  const data = useStore($personal)
  const action = usePersonalAction()
  const overview = data.overview
  const day = new Intl.DateTimeFormat('es-HN', { timeZone: PERSONAL_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
  const counters = [
    { label: 'Compromisos abiertos', value: overview?.counts.open, icon: <IconChecklist size={20} />, command: 'personal.tasks.filter', args: { status: 'open' }, tone: 'text-accent-strong' },
    { label: 'Vencidos', value: overview?.counts.overdue, icon: <IconClock size={20} />, command: 'personal.tasks.filter', args: { status: 'overdue' }, tone: 'text-warn' },
    { label: 'Correos urgentes', value: overview?.counts.urgent_mail, icon: <IconMail size={20} />, command: 'personal.mail.search', args: { category: 'urgent' }, tone: 'text-progress' },
    { label: 'Esperan revisión', value: overview?.counts.waiting_review, icon: <IconFileText size={20} />, command: 'personal.tasks.filter', args: { status: 'waiting' }, tone: 'text-info' }
  ]
  return <div className="flex flex-col gap-6">
    <GlassCard className="flex flex-wrap items-center justify-between gap-5 p-5"><div><div className="mb-3 flex items-center gap-2 text-[12px] text-fg-3"><IconSun size={17} /><span className="capitalize">{day}</span><span>· Tegucigalpa</span></div><h2 className="text-[24px] font-semibold tracking-tight text-fg">Tu día, con intención.</h2><p className="mt-2 max-w-xl text-[12.5px] leading-relaxed text-fg-2">Lo que merece atención, los compromisos que avanzan y un espacio para cerrar el día.</p></div><div className="flex flex-wrap gap-2"><GlassButton disabled={action.busy || !data.status} onClick={() => void action.run('personal.brief', { kind: 'morning' })}>Resumen de inicio</GlassButton><GlassButton variant="primary" disabled={action.busy || !data.status} onClick={() => void action.run('personal.brief', { kind: 'evening' })}>Preparar cierre<IconArrowRight /></GlassButton></div></GlassCard>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{counters.map(counter => <GlassCard key={counter.label} as="button" interactive className="p-4" onClick={() => void action.run(counter.command, counter.args)}><div className={`mb-3 ${counter.tone}`}>{counter.icon}</div><div className="text-[27px] font-semibold tabular-nums text-fg">{counter.value ?? '—'}</div><div className="mt-1 text-[11.5px] text-fg-3">{counter.label}</div></GlassCard>)}</div>
    <ActionFeedback {...action} />
    {data.brief && <Section title="Tu resumen" action={<span className="text-[11px] text-fg-3">{dateLabel(data.brief.generated_at, true)}</span>}><GlassCard className="p-5"><p className="selectable whitespace-pre-wrap text-[13px] leading-relaxed text-fg-2">{data.brief.text}</p><p className="mt-4 text-[11px] text-fg-3">Basado en {data.brief.source_ids.length} registros guardados.</p></GlassCard></Section>}
    <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(240px,2fr)]"><Section title="Próximas prioridades" action={<GlassButton size="sm" variant="ghost" onClick={() => void action.run('personal.open', { tab: 'tasks' })}>Ver todos<IconArrowRight /></GlassButton>}>{overview?.priorities.length ? overview.priorities.slice(0, 6).map(task => <TaskRow key={task.id} task={task} onClick={() => void action.run('personal.task.show', { id: task.id })} />) : <EmptyGlass icon={<IconChecklist />} title={data.status ? 'Espacio para elegir tu siguiente paso' : 'El resumen espera conexión'} description={data.status ? 'Captura tus compromisos para darles seguimiento desde aquí.' : 'Al conectarse el servicio, verás el estado real de tu día.'} action={<GlassButton size="sm" onClick={() => void action.run('personal.task.new')}>Nuevo compromiso</GlassButton>} />}</Section>
      <Section title="Último registro" action={<GlassButton size="sm" variant="ghost" onClick={() => void action.run('personal.checkin.open')}>Abrir diario<IconArrowRight /></GlassButton>}>{overview?.recent_checkins[0] ? <GlassCard className="p-5"><Pill>{dateLabel(overview.recent_checkins[0].date)}</Pill><h3 className="mt-4 text-[12px] font-semibold text-fg-2">Lo que avanzó</h3><p className="mt-2 line-clamp-5 whitespace-pre-wrap text-[12px] leading-relaxed text-fg-3">{overview.recent_checkins[0].accomplished || 'Sin logros anotados.'}</p><h3 className="mt-4 text-[12px] font-semibold text-fg-2">Siguiente paso</h3><p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-fg-3">{overview.recent_checkins[0].tomorrow || 'Sin siguiente paso anotado.'}</p></GlassCard> : <EmptyGlass icon={<IconBook />} title="Un momento para ti" description="Anota lo que avanzó y decide con qué comenzar mañana." action={<GlassButton size="sm" onClick={() => void action.run('personal.checkin.open')}>Escribir en el diario</GlassButton>} />}</Section></div>
    <ProviderConnections />
    {overview && <p className="text-[11px] text-fg-4">Resumen consultado {dateLabel(overview.as_of, true)} · Fechas en America/Tegucigalpa</p>}
  </div>
}
