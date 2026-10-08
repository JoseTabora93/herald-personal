import { useStore } from '@nanostores/react'
import { IconCheck, IconPlus, IconReload, IconSearch, IconTarget } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import type { PersonalTask } from '../../../shared/personal.ts'
import { EmptyGlass, GlassButton, GlassCard, Pill } from '../../components/ui/glass.tsx'
import { $personal, $personalFocus, personal } from '../../store/personal.ts'
import type { TaskEvent } from './controller.ts'
import { dateLabel, dueDateInput, isOpenTask, localDate, TASK_PRIORITY, TASK_STATUS, taskEventPresentation, taskForm, type TaskForm } from './model.ts'
import { ActionFeedback, FIELD_CLASS, Field, usePersonalAction } from './shared.tsx'

export function TaskRow({ task, selected, onClick }: { task: PersonalTask; selected?: boolean; onClick: () => void }) {
  const overdue = Boolean(task.due_at && dueDateInput(task.due_at) < localDate() && isOpenTask(task))
  return <GlassCard as="button" interactive selected={selected} onClick={onClick} className="w-full p-4" data-os-target={`personal-task:${task.id}`}>
    <div className="flex items-start justify-between gap-3"><span className="min-w-0 break-words text-[13px] font-medium text-fg">{task.title}</span>{task.priority === 'high' && <Pill tone="warn">Alta</Pill>}</div>
    <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-fg-3"><Pill tone={task.status === 'done' ? 'ok' : task.status === 'in_progress' ? 'progress' : 'muted'}>{TASK_STATUS[task.status]}</Pill>{task.project && <span>{task.project}</span>}<span className={overdue ? 'text-danger' : ''}>{dateLabel(task.due_at)}</span></div>
  </GlassCard>
}

export function TaskPanel() {
  const data = useStore($personal)
  const focus = useStore($personalFocus)
  const action = usePersonalAction()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('open')
  const [selectedId, setSelectedId] = useState(focus.taskId)
  const [composing, setComposing] = useState(Boolean(focus.compose))
  useEffect(() => {
    if (focus.tab !== 'tasks') return
    if (focus.query !== undefined) setQuery(focus.query)
    if (focus.status !== undefined) setFilter(focus.status)
    if (focus.taskId) { setSelectedId(focus.taskId); setComposing(false) }
    if (focus.compose !== undefined) setComposing(focus.compose)
  }, [focus])
  const tasks = data.tasks.filter(task => {
    const statusMatches = filter === 'all' || filter === 'open' && isOpenTask(task) || filter === 'overdue' && isOpenTask(task) && task.due_at && dueDateInput(task.due_at) < localDate() || task.status === filter
    return statusMatches && `${task.title} ${task.description ?? ''} ${task.project ?? ''}`.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es'))
  })
  const selected = data.tasks.find(task => task.id === selectedId) ?? tasks[0]
  return <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(280px,2fr)]">
    <div className="flex min-w-0 flex-col gap-3">
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void action.run('personal.tasks.filter', { query, status: filter }) }}>
        <input aria-label="Buscar compromisos" className={`${FIELD_CLASS} min-w-32 flex-1`} placeholder="Buscar título o proyecto…" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="Filtrar compromisos por estado" className={`${FIELD_CLASS} max-w-44 shrink-0`} value={filter} onChange={event => { setFilter(event.target.value); void action.run('personal.tasks.filter', { query, status: event.target.value }) }}><option value="open">Abiertos</option><option value="all">Todos</option><option value="overdue">Vencidos</option>{Object.entries(TASK_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <GlassButton type="submit" size="icon" aria-label="Aplicar búsqueda de compromisos"><IconSearch /></GlassButton>
      </form>
      <div className="flex items-center justify-between"><span className="text-[12px] text-fg-3">{tasks.length} {tasks.length === 1 ? 'compromiso' : 'compromisos'}</span><GlassButton size="sm" onClick={() => void action.run('personal.task.new')}><IconPlus />Nuevo</GlassButton></div>
      {tasks.length ? <div className="stagger flex flex-col gap-3">{tasks.map(task => <TaskRow key={task.id} task={task} selected={!composing && selected?.id === task.id} onClick={() => void action.run('personal.task.show', { id: task.id })} />)}</div> : <EmptyGlass icon={<IconTarget />} title={data.tasks.length ? 'No hay coincidencias' : 'Tus compromisos comienzan aquí'} description={data.tasks.length ? 'Prueba otro texto o estado.' : 'Captura un pendiente o conviértelo desde un correo sincronizado.'} action={<GlassButton size="sm" onClick={() => void action.run('personal.task.new')}>Crear compromiso</GlassButton>} />}
      <ActionFeedback error={action.error} />
    </div>
    <GlassCard className="h-fit p-5">{composing || selected ? <TaskEditor key={composing ? 'new' : selected.id} task={composing ? undefined : selected} /> : <EmptyGlass title="Selecciona un compromiso" description="Aquí podrás editarlo, cambiar su estado y consultar su historial." />}</GlassCard>
  </div>
}

function TaskEditor({ task }: { task?: PersonalTask }) {
  const [base, setBase] = useState(task)
  const [form, setForm] = useState(() => taskForm(task))
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const createRef = useRef({ signature: '', key: crypto.randomUUID() })
  const action = usePersonalAction()
  const set = <K extends keyof TaskForm>(key: K, value: TaskForm[K]) => setForm(current => ({ ...current, [key]: value }))
  const stale = task && base && task.revision !== base.revision
  useEffect(() => {
    if (!base) return
    let active = true
    personal.taskEvents(base.id).then(result => { if (active) { setEvents(result.items); setHistoryError(null) } }).catch(() => { if (active) setHistoryError('No se pudo cargar el historial.') })
    return () => { active = false }
  }, [base?.id, base?.revision])
  const save = async () => {
    const signature = JSON.stringify(form)
    if (createRef.current.signature !== signature) createRef.current = { signature, key: crypto.randomUUID() }
    const result = await action.run('personal.task.save', { ...form, ...(base ? { id: base.id, revision: base.revision, originalDueAt: base.due_at ?? '' } : { idempotencyKey: createRef.current.key }) })
    const saved = result?.data?.task as PersonalTask | undefined
    if (saved) { setBase(saved); setForm(taskForm(saved)) }
  }
  const reload = async () => {
    if (!base) return
    const result = await action.run('personal.task.show', { id: base.id })
    const latest = result?.data?.task as PersonalTask | undefined
    if (latest) { setBase(latest); setForm(taskForm(latest)) }
  }
  return <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
    <div className="flex items-center justify-between gap-2"><h2 className="text-[14px] font-semibold">{base ? 'Editar compromiso' : 'Nuevo compromiso'}</h2>{base && <span className="text-[11px] text-fg-3">Revisión {base.revision}</span>}</div>
    {stale && <p className="text-[12px] text-warn">Hay una revisión más reciente. Tu borrador sigue aquí; recarga para editar la versión actual.</p>}
    <Field label="Título"><input required maxLength={500} autoFocus={!task} value={form.title} onChange={event => set('title', event.target.value)} className={FIELD_CLASS} placeholder="¿Qué necesitas resolver?" /></Field>
    <Field label="Detalle"><textarea rows={4} value={form.description} onChange={event => set('description', event.target.value)} className={`${FIELD_CLASS} resize-y`} placeholder="Resultado esperado, contexto o siguiente paso…" /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label="Estado"><select className={FIELD_CLASS} value={form.status} onChange={event => set('status', event.target.value as TaskForm['status'])}>{Object.entries(TASK_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Prioridad"><select className={FIELD_CLASS} value={form.priority} onChange={event => set('priority', event.target.value as TaskForm['priority'])}>{Object.entries(TASK_PRIORITY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>
    <div className="grid grid-cols-2 gap-3"><Field label="Fecha límite" hint="Fecha de Tegucigalpa"><input type="date" className={FIELD_CLASS} value={form.dueDate} onChange={event => set('dueDate', event.target.value)} /></Field><Field label="Proyecto"><input className={FIELD_CLASS} value={form.project} onChange={event => set('project', event.target.value)} placeholder="Opcional" /></Field></div>
    <ActionFeedback {...action} />
    <div className="flex flex-wrap gap-2"><GlassButton type="submit" variant="primary" disabled={action.busy}><IconCheck />{action.busy ? 'Guardando…' : 'Guardar compromiso'}</GlassButton>{base && <GlassButton disabled={action.busy} onClick={() => void reload()} title="Reemplaza el formulario con la versión guardada"><IconReload />Recargar versión</GlassButton>}</div>
    {base && <div className="border-t border-line pt-4"><div className="flex items-center justify-between"><h3 className="text-[12px] font-medium text-fg-2">Historial</h3><span className="text-[10px] text-fg-4">{base.source_type === 'mail' ? 'Desde correo' : base.source_type === 'agent' ? 'Desde agente' : 'Captura personal'}</span></div>{historyError ? <p className="mt-2 text-[11px] text-fg-3">{historyError}</p> : events.length ? <ol className="mt-3 space-y-3">{events.slice(-6).reverse().map(event => { const presentation = taskEventPresentation(event); return <li key={event.id} className="text-[11px] text-fg-3"><span className="text-fg-2">{presentation.label}</span> · {dateLabel(event.created_at, true)}<p className="mt-1 break-words">{presentation.detail}</p></li> })}</ol> : <p className="mt-2 text-[11px] text-fg-3">Sin eventos disponibles.</p>}</div>}
  </form>
}
