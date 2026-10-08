import { useStore } from '@nanostores/react'
import { IconBook, IconCheck } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { PersonalCheckin } from '../../../shared/personal.ts'
import { EmptyGlass, GlassButton, GlassCard, Pill } from '../../components/ui/glass.tsx'
import { $personal, $personalFocus } from '../../store/personal.ts'
import { dateLabel, localDate } from './model.ts'
import { ActionFeedback, FIELD_CLASS, Field, usePersonalAction } from './shared.tsx'

type Entry = Pick<PersonalCheckin, 'accomplished' | 'pending' | 'tomorrow'>
const empty: Entry = { accomplished: '', pending: '', tomorrow: '' }

export function JournalPanel() {
  const data = useStore($personal)
  const focus = useStore($personalFocus)
  const action = usePersonalAction()
  const [date, setDate] = useState(focus.checkinDate ?? localDate())
  useEffect(() => { if (focus.tab === 'journal' && focus.checkinDate) setDate(focus.checkinDate) }, [focus])
  const saved = data.checkins.find(entry => entry.date === date)
  const [drafts, setDrafts] = useState<Record<string, Entry>>({})
  const form = drafts[date] ?? saved ?? empty
  const dirty = JSON.stringify({ accomplished: form.accomplished, pending: form.pending, tomorrow: form.tomorrow }) !== JSON.stringify(saved ? { accomplished: saved.accomplished, pending: saved.pending, tomorrow: saved.tomorrow } : empty)
  const set = (key: keyof Entry, value: string) => setDrafts(current => ({ ...current, [date]: { ...form, [key]: value } }))
  const save = async () => {
    const result = await action.run('personal.checkin.save', { date, accomplished: form.accomplished, pending: form.pending, tomorrow: form.tomorrow })
    if (result) setDrafts(current => { const next = { ...current }; delete next[date]; return next })
  }
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(240px,2fr)]">
    <GlassCard className="p-5"><form className="flex flex-col gap-5" onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[16px] font-semibold">Una pausa para cerrar el día</h2><p className="mt-1 text-[12px] text-fg-3">Deja por escrito lo logrado y el siguiente paso.</p></div><Pill tone={dirty ? 'warn' : saved ? 'ok' : 'muted'}>{dirty ? 'Sin guardar' : saved ? 'Guardado' : 'Nueva entrada'}</Pill></div>
      <Field label="Fecha del diario" hint="Calendario de Tegucigalpa"><input type="date" className={`${FIELD_CLASS} max-w-48`} value={date} onChange={event => { if (event.target.value) { action.clear(); void action.run('personal.checkin.open', { date: event.target.value }) } }} /></Field>
      <Field label="¿Qué avanzó hoy?"><textarea className={`${FIELD_CLASS} resize-y`} rows={4} value={form.accomplished} onChange={event => set('accomplished', event.target.value)} placeholder="Logros, decisiones o algo que aprendiste…" /></Field>
      <Field label="¿Qué quedó pendiente?"><textarea className={`${FIELD_CLASS} resize-y`} rows={3} value={form.pending} onChange={event => set('pending', event.target.value)} placeholder="Pendientes, bloqueos o personas por contactar…" /></Field>
      <Field label="¿Qué sigue mañana?"><textarea className={`${FIELD_CLASS} resize-y`} rows={3} value={form.tomorrow} onChange={event => set('tomorrow', event.target.value)} placeholder="El siguiente paso que merece tu atención…" /></Field>
      <ActionFeedback {...action} />
      <div className="flex flex-wrap items-center gap-3"><GlassButton type="submit" variant="primary" disabled={action.busy}><IconCheck />{action.busy ? 'Guardando…' : 'Guardar entrada'}</GlassButton><span className="text-[11px] text-fg-3">Guardar el diario no cambia tus compromisos.</span></div>
    </form></GlassCard>
    <div className="flex flex-col gap-3"><h2 className="text-[14px] font-semibold">Entradas anteriores</h2>{data.checkins.length ? data.checkins.map(entry => <GlassCard key={entry.id} as="button" interactive selected={date === entry.date} className="p-4" data-os-target={`personal-checkin:${entry.date}`} onClick={() => { action.clear(); void action.run('personal.checkin.open', { date: entry.date }) }}><div className="text-[13px] font-medium">{dateLabel(entry.date)}</div><p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[12px] text-fg-3">{entry.accomplished || entry.pending || entry.tomorrow || 'Entrada guardada.'}</p><p className="mt-3 text-[10.5px] text-fg-4">Actualizada {dateLabel(entry.updated_at, true)}</p></GlassCard>) : <EmptyGlass icon={<IconBook />} title="Tu primer registro" description="Guarda una entrada y podrás volver a ella desde aquí." />}</div>
  </div>
}
