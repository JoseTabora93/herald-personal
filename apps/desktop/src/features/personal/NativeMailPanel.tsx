import { useStore } from '@nanostores/react'
import { IconArrowLeft, IconArrowRight, IconChecklist, IconEdit, IconMail, IconMessageCircle, IconPaperclip, IconRefresh, IconSearch, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { EmptyGlass, GlassButton, Pill } from '../../components/ui/glass.tsx'
import { nativeMail, $personalFocus } from '../../store/personal.ts'
import { $page } from '../../store/windows.ts'
import { runCommand } from '../../store/os-commands.ts'
import { MAIL_WORKSPACE_VIEWS } from './mail-workspace.ts'
import { MAIL_STATES, MAIL_CATEGORIES, MAIL_PRIORITIES, parseRecipients, recipientsText, records, textValue as txt, type JsonRecord, type MailFilters, type MailItem } from './native-mail.ts'
import { ActionFeedback, FIELD_CLASS, usePersonalAction } from './shared.tsx'

const day = (value: unknown) => { const date = new Date(txt(value)); return Number.isNaN(date.getTime()) ? 'Sin fecha' : date.toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' }) }
const obj = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
const labels = (value: unknown) => Array.isArray(value) ? value.map(txt).join(', ') : txt(value)
const person = (value: unknown) => { const p = obj(value); return [txt(p.nombre ?? p.name), txt(p.direccion ?? p.address)].filter(Boolean).join(' · ') }

function Filters() {
  const state = useStore(nativeMail.state)
  const [form, setForm] = useState(state.filters)
  const action = usePersonalAction()
  useEffect(() => { setForm(state.filters) }, [state.filters])
  const set = (value: Partial<MailFilters>) => setForm(current => ({ ...current, ...value }))
  const special = state.view === 'aprendizajes' || state.view === 'limpieza' || state.view === 'rezagados'
  return <form aria-label="Filtros de correo" className="shrink-0 border-b border-line px-4 py-3" onSubmit={event => { event.preventDefault(); void action.run('personal.nativeMail.filter', { filters: JSON.stringify({ ...form, desplazamiento: 0 }) }) }}>
    <div className="flex flex-wrap items-center gap-2">
      {!special && <><div className="relative min-w-44 flex-1"><IconSearch size={14} className="absolute left-3 top-2.5 text-fg-3" /><input aria-label="Buscar correo" placeholder="Buscar asunto, remitente o texto…" maxLength={500} className={`${FIELD_CLASS} pl-9`} value={form.texto} onChange={e => set({ texto: e.target.value })} /></div>
        <select aria-label="Estado de correo" className={`${FIELD_CLASS} !w-auto`} value={form.estado} onChange={e => set({ estado: e.target.value })}><option value="">Todos los estados</option>{Object.entries(MAIL_STATES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select aria-label="Período de correo" className={`${FIELD_CLASS} !w-auto`} value={state.view === 'historico' ? 'todo' : form.periodo} disabled={state.view === 'historico'} onChange={e => set({ periodo: e.target.value })}><option value="ventana">Ventana habitual</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option><option value="todo">Todo el correo</option></select></>}
      {state.view !== 'aprendizajes' && <select aria-label="Carpeta de correo" className={`${FIELD_CLASS} max-w-52 !w-auto`} value={form.carpeta} onChange={e => set({ carpeta: e.target.value })}><option value="">Todas las carpetas</option>{state.folders.map(f => <option key={txt(f.clave)} value={txt(f.clave)}>{txt(f.ruta || f.nombre)} ({txt(f.hilos)})</option>)}</select>}
      {state.view !== 'aprendizajes' && <GlassButton size="sm" type="submit" disabled={action.busy}>Aplicar filtros</GlassButton>}
    </div>
    {!special && <details className="mt-2 text-[11px] text-fg-3"><summary className="w-fit cursor-pointer">Más filtros</summary><div className="mt-2 flex flex-wrap items-center gap-3">
      <select aria-label="Categoría de correo" className={`${FIELD_CLASS} !w-auto`} value={form.categoria} onChange={e => set({ categoria: e.target.value })}><option value="">Todas las categorías</option>{MAIL_CATEGORIES.map(label => <option key={label}>{label}</option>)}</select>
      <select aria-label="Prioridad de correo" className={`${FIELD_CLASS} !w-auto`} value={form.prioridad} onChange={e => set({ prioridad: e.target.value })}><option value="">Todas las prioridades</option>{Object.entries(MAIL_PRIORITIES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <select aria-label="Orden del correo" className={`${FIELD_CLASS} !w-auto`} value={form.orden} onChange={e => set({ orden: e.target.value })}><option value="recientes">Más recientes</option><option value="antiguos">Más antiguos</option><option value="prioridad">Por prioridad</option><option value="noleidos">No leídos primero</option></select>
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.noLeido} onChange={e => set({ noLeido: e.target.checked })} />Solo no leídos</label>
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.jevDuda} onChange={e => set({ jevDuda: e.target.checked })} />JEV necesita revisión</label>
    </div></details>}
    <ActionFeedback error={action.error} />
  </form>
}

function ThreadRow({ item }: { item: MailItem }) {
  const state = useStore(nativeMail.state)
  const action = usePersonalAction()
  return <button type="button" className={`w-full border-b border-line px-4 py-3 text-left transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent ${state.selectedClave === item.clave ? 'bg-accent/10 shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`} aria-pressed={state.selectedClave === item.clave} onClick={() => void action.run('personal.nativeMail.select', { clave: item.clave })}>
    <div className="flex items-center justify-between gap-2 text-[11px] text-fg-3"><span>{item.clave} {item.noLeido === true && <span aria-label="No leído" className="text-accent-strong">●</span>}</span><span>{day(item.ultimoMensajeEn)}</span></div>
    <p className="mt-1 truncate text-[13px] font-medium text-fg">{item.asunto || '(Sin asunto)'}</p>
    <p className="mt-1 truncate text-[12px] text-fg-2">{item.ultimoRemitente.nombre || item.ultimoRemitente.direccion}</p>
    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fg-3">{txt(item.vistaPrevia)}</p>
    <div className="mt-2 flex flex-wrap gap-1"><Pill>{MAIL_STATES[item.estado as keyof typeof MAIL_STATES] ?? item.estado}</Pill>{item.prioridad === 'alta' && <Pill tone="warn">Alta</Pill>}{item.jevDuda === true && <Pill tone="warn">JEV duda</Pill>}{item.revisadoPorAgente === true && <Pill>Revisado por GLM</Pill>}{item.tieneAdjuntos === true && <IconPaperclip size={13} aria-label="Tiene adjuntos" />}</div>
  </button>
}

function ThreadDetail() {
  const state = useStore(nativeMail.state)
  const action = usePersonalAction()
  if (state.detailLoading) return <div role="status" className="p-6 text-[13px] text-fg-3">Abriendo {state.selectedClave}…</div>
  if (state.detailError) return <div className="p-5"><ActionFeedback error={state.detailError} /><GlassButton className="mt-3" onClick={() => void action.run('personal.nativeMail.select', { clave: state.selectedClave })}>Reintentar hilo</GlassButton></div>
  const thread = state.thread
  if (!thread) return <div className="flex h-full items-center justify-center p-8"><EmptyGlass icon={<IconMail />} title="Elige un hilo" description="Lee tu correo, prepara una respuesta o conviértelo en un compromiso." /></div>
  const { item } = thread
  const recipient = obj(item.destinatario); const agent = obj(item.agente)
  return <article aria-label={`Hilo ${item.clave}`} className="flex min-h-0 flex-col">
    <div className="border-b border-line p-5">
      <div className="flex items-center gap-2 text-[11px] text-fg-3"><span>{item.clave}</span><span>·</span><span>{labels(item.carpetas)}</span></div>
      <h3 className="mt-2 break-words text-[18px] font-semibold leading-snug">{item.asunto || '(Sin asunto)'}</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        <GlassButton size="sm" variant="primary" disabled={state.busy} onClick={() => void action.run('personal.nativeMail.compose', { mode: 'responder' })}><IconEdit />Responder</GlassButton>
        <GlassButton size="sm" disabled={state.busy} onClick={() => void action.run('personal.nativeMail.compose', { mode: 'responder_todos' })}>Responder a todos</GlassButton>
        <GlassButton size="sm" disabled={state.busy} onClick={() => void action.run('personal.nativeMail.compose', { mode: 'reenviar' })}>Reenviar</GlassButton>
        <GlassButton size="sm" disabled={state.busy || action.busy} onClick={() => void action.run('personal.nativeMail.draft', { mode: 'generar' })}>Borrador sugerido</GlassButton>
        <GlassButton size="sm" disabled={action.busy} onClick={() => void action.run('personal.mailWorkspace.capture')}><IconChecklist />Compromiso</GlassButton>
        <GlassButton size="sm" disabled={action.busy} onClick={() => void action.run('personal.mailWorkspace.ask')}><IconMessageCircle />Hermes</GlassButton>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {[['estado', 'Estado', MAIL_STATES], ['categoria', 'Categoría', Object.fromEntries(MAIL_CATEGORIES.map(x => [x, x]))], ['prioridad', 'Prioridad', MAIL_PRIORITIES]].map(([field, label, options]) => <label key={String(field)} className="text-[11px] text-fg-3">{String(label)}<select className={`${FIELD_CLASS} mt-1 !px-2 !text-[12px]`} aria-label={`Cambiar ${String(label).toLowerCase()}`} value={txt(item[String(field)])} disabled={state.busy || action.busy} onChange={e => void action.run('personal.nativeMail.update', { field, value: e.target.value })}><option value="" disabled>Sin clasificar</option>{Object.entries(options).map(([id, name]) => <option key={id} value={id}>{String(name)}</option>)}</select></label>)}
      </div>
      <details className="mt-3 rounded-lg bg-surface-2 p-3 text-[12px] text-fg-2"><summary className="cursor-pointer">Criterio de clasificación y destinatario</summary><dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[11px]">
        <dt>Decidido por</dt><dd>{item.revisadoPorAgente ? 'GLM, segundo criterio' : txt(obj(item.clasificacion).nivel) || 'JEV'}</dd>
        <dt>Destinatario</dt><dd>{txt(recipient.tipo || recipient.senal) || 'Sin determinar'} {txt(recipient.nombre)}</dd>
        <dt>Motivo</dt><dd>{txt(agent.motivo || recipient.motivo || item.regla) || 'Sin motivo registrado'}</dd>
        <dt>Campos fijados</dt><dd>{labels(item.camposManuales) || 'Ninguno'}</dd>
        <dt>Cliente / proyecto</dt><dd>{[txt(item.cliente), txt(item.proyecto)].filter(Boolean).join(' / ') || 'Sin asignar'}</dd>
        <dt>Vencimiento</dt><dd>{item.vence ? day(item.vence) : 'Sin fecha'}</dd>
      </dl></details>
      {state.busy && <p role="status" className="mt-2 text-[12px] text-fg-3">Preparando correo… El redactor puede tardar hasta dos minutos.</p>}
      <div className="mt-2"><ActionFeedback error={action.error || state.composerError} notice={action.notice} /></div>
    </div>
    <div className="space-y-3 p-4">
      {thread.totalMensajes > thread.mensajes.length && <div className="rounded-lg border border-line p-3 text-[12px] text-fg-3">Mostrando los últimos {thread.mensajes.length} de {thread.totalMensajes} mensajes. {state.messageLimit < 25 ? <GlassButton size="sm" onClick={() => void action.run('personal.nativeMail.select', { clave: item.clave, limit: 25 })}>Cargar más mensajes</GlassButton> : <GlassButton size="sm" onClick={() => void action.run('personal.nativeMail.legacy')}>Abrir hilo completo</GlassButton>}</div>}
      {thread.mensajes.map((message, index) => <section key={txt(message.id) || index} className="rounded-xl border border-line bg-surface-2/50 p-4">
        <div className="flex flex-wrap justify-between gap-2"><p className="text-[12px] font-medium">{person(message.de) || 'Remitente no disponible'}</p><p className="text-[11px] text-fg-3">{day(message.fecha)}</p></div>
        <details className="mt-1 text-[11px] text-fg-3"><summary className="cursor-pointer">Destinatarios</summary><p className="mt-1 break-words">Para: {records(message.para).map(person).join('; ') || '—'}</p><p className="break-words">CC: {records(message.cc).map(person).join('; ') || '—'}</p></details>
        {message.errorCuerpo ? <p role="alert" className="mt-3 text-[12px] text-warn">No se pudo cargar el cuerpo de este mensaje. Reintenta el hilo.</p> : <div className="mt-4 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg-2">{txt(message.cuerpoTexto) || txt(message.vistaPrevia) || 'Mensaje sin texto disponible.'}</div>}
        {records(message.adjuntos).length > 0 && <ul className="mt-3 space-y-1 border-t border-line pt-3 text-[11px] text-fg-3">{records(message.adjuntos).map((file, i) => <li key={i} className="flex items-center gap-2"><IconPaperclip size={13} />{txt(file.name || file.nombre)} {file.size ? `· ${Math.ceil(Number(file.size) / 1024)} KB` : ''}</li>)}</ul>}
        {message.errorAdjuntos ? <p className="mt-2 text-[11px] text-warn">No se pudieron consultar los adjuntos.</p> : null}
      </section>)}
    </div>
  </article>
}

function Composer() {
  const state = useStore(nativeMail.state)
  const c = state.compose!
  const action = usePersonalAction()
  const [recipientInputs, setRecipientInputs] = useState({ para: recipientsText(c.para), cc: recipientsText(c.cc), cco: recipientsText(c.cco) })
  const [recipientError, setRecipientError] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [preview, setPreview] = useState(false)
  useEffect(() => { void nativeMail.loadDraft() }, [c.id])
  useEffect(() => { if (!state.dirty) { setRecipientInputs({ para: recipientsText(c.para), cc: recipientsText(c.cc), cco: recipientsText(c.cco) }); setRecipientError(null) } }, [c.id, c.version, state.dirty])
  const editRecipients = (field: 'para' | 'cc' | 'cco', value: string) => {
    const updated = { ...recipientInputs, [field]: value }; setRecipientInputs(updated)
    // The typed text stays in component memory; mark dirty even while an address is incomplete.
    nativeMail.editCompose({})
    try { const parsed = { para: parseRecipients(updated.para), cc: parseRecipients(updated.cc), cco: parseRecipients(updated.cco) }; nativeMail.editCompose(parsed); setRecipientError(null) }
    catch (error) { setRecipientError(error instanceof Error ? error.message : 'Revisa los destinatarios.') }
  }
  const busy = state.busy || action.busy
  return <section aria-label="Redactor de correo" className="p-5">
    <div className="flex items-center justify-between gap-2"><div><h3 className="text-[16px] font-semibold">{c.modo === 'nuevo' ? 'Nuevo correo' : 'Tu respuesta'}</h3><p className="mt-1 text-[11px] text-fg-3">{c.clave || 'Borrador nuevo'} · {state.dirty ? 'Cambios sin guardar' : 'Guardado en el servicio de correo'}</p></div><GlassButton size="icon" aria-label="Cerrar redactor" disabled={busy || state.dirty} onClick={() => void action.run('personal.nativeMail.close')}><IconX size={16} /></GlassButton></div>
    <div className="mt-4 space-y-2">{(['para', 'cc', 'cco'] as const).map(field => <label key={field} className="grid grid-cols-[40px_1fr] items-center gap-2 text-[12px] text-fg-3"><span>{field === 'para' ? 'Para' : field.toUpperCase()}</span><input aria-label={`Redactor ${field}`} className={FIELD_CLASS} value={recipientInputs[field]} disabled={busy} placeholder="Nombre <correo@dominio.com>; otra dirección" onChange={e => editRecipients(field, e.target.value)} /></label>)}
      <label className="grid grid-cols-[40px_1fr] items-center gap-2 text-[12px] text-fg-3"><span>Asunto</span><input aria-label="Asunto del borrador" className={FIELD_CLASS} maxLength={500} value={c.asunto} disabled={busy || c.asuntoEditable === false} onChange={e => nativeMail.editCompose({ asunto: e.target.value })} /></label>
    </div>
    <div className="mt-4 flex items-center justify-between"><p className="text-[11px] text-fg-3">Admite Markdown: **negrita**, listas y enlaces.</p><button className="text-[11px] text-accent-strong" type="button" onClick={() => setPreview(value => !value)}>{preview ? 'Editar texto' : 'Vista previa'}</button></div>
    {preview ? <div className="prose prose-sm mt-2 min-h-56 rounded-lg border border-line p-4 text-fg-2"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span className="underline">{children}</span> }}>{c.cuerpoMd || 'Borrador vacío'}</ReactMarkdown></div> : <textarea aria-label="Texto del borrador" className={`${FIELD_CLASS} mt-2 min-h-64 resize-y leading-relaxed`} maxLength={50000} value={c.cuerpoMd} disabled={busy} onChange={e => nativeMail.editCompose({ cuerpoMd: e.target.value })} />}
    <label className="mt-3 flex items-center gap-2 text-[12px] text-fg-2"><input type="checkbox" checked={c.incluirFirma} disabled={busy} onChange={e => nativeMail.editCompose({ incluirFirma: e.target.checked })} />Incluir mi firma configurada al enviar</label>
    {c.adjuntos?.length > 0 && <p className="mt-2 flex items-center gap-1 text-[11px] text-fg-3"><IconPaperclip size={13} />{c.adjuntos.map(f => txt(f.nombre || f.name)).join(', ')}</p>}
    <div className="mt-4 flex flex-wrap gap-2"><GlassButton variant="primary" disabled={busy || Boolean(recipientError)} onClick={() => void action.run('personal.nativeMail.save')}>Guardar borrador</GlassButton><GlassButton disabled={busy || state.dirty || Boolean(recipientError)} onClick={() => void action.run('personal.nativeMail.legacy')}>Adjuntos, Outlook y envío</GlassButton></div>
    <p className="mt-2 text-[11px] leading-relaxed text-fg-3">El envío se revisa en la vista original con sus destinatarios, firma y ventana de deshacer. El mismo borrador te acompaña.</p>
    {c.clave && <div className="mt-5 rounded-xl border border-line p-3"><h4 className="text-[12px] font-medium">Redactor y revisor</h4><label className="mt-2 block text-[11px] text-fg-3">Qué quieres decir o cambiar<input aria-label="Instrucciones para el borrador" maxLength={600} className={`${FIELD_CLASS} mt-1`} value={instruction} disabled={busy} onChange={e => setInstruction(e.target.value)} placeholder="Pide que confirme la fecha de visita…" /></label><div className="mt-3 flex flex-wrap gap-2"><GlassButton size="sm" disabled={busy || Boolean(recipientError)} onClick={() => void action.run('personal.nativeMail.draft', { mode: 'generar', instruction })}>Generar sugerencia</GlassButton><GlassButton size="sm" disabled={busy || Boolean(recipientError) || !instruction.trim()} onClick={() => void action.run('personal.nativeMail.draft', { mode: 'ajustar', instruction })}>Aplicar cambio</GlassButton>{state.draft && <><GlassButton size="sm" disabled={busy || state.dirty} onClick={() => void action.run('personal.nativeMail.draft', { mode: 'anterior' })}>Versión anterior</GlassButton><GlassButton size="sm" disabled={busy || state.dirty} onClick={() => void action.run('personal.nativeMail.draft', { mode: 'siguiente' })}>Versión siguiente</GlassButton></>}</div>
      {state.draft && <div className="mt-3 space-y-2 text-[11px] text-fg-3"><p>Versión {txt(state.draft.versionActual)} · {txt(state.draft.modelo)}</p>{state.draft.notas ? <p>{txt(state.draft.notas)}</p> : null}{['huecos', 'fuentes', 'cambiosRevision'].map(field => Array.isArray(state.draft?.[field]) && (state.draft?.[field] as unknown[]).length > 0 ? <p key={field}><strong>{field === 'huecos' ? 'Por confirmar' : field === 'fuentes' ? 'Fuentes' : 'Revisión'}:</strong> {labels(state.draft?.[field])}</p> : null)}</div>}
    </div>}
    {busy && <p role="status" className="mt-3 text-[12px] text-fg-3">Preparando correo…</p>}
    <div className="mt-3"><ActionFeedback error={recipientError || action.error || state.composerError} notice={action.notice} /></div>
  </section>
}

function AuxiliaryView() {
  const state = useStore(nativeMail.state); const action = usePersonalAction()
  if (state.view === 'aprendizajes') {
    const list = records(state.auxiliary?.aprendizajes)
    return <div className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[12px] text-fg-3">Reglas propuestas y aprendidas de tus correcciones.</p><GlassButton size="sm" onClick={() => void action.run('personal.nativeMail.legacy', { view: 'aprendizajes' })}>Revisar y decidir</GlassButton></div>{!list.length && <EmptyGlass icon={<IconChecklist />} title="Sin aprendizajes registrados" description="Aquí aparecerán las propuestas y reglas del servicio de correo." />}{list.map(entry => <article key={txt(entry.id)} className="rounded-xl border border-line bg-surface-2 p-4"><div className="flex items-center gap-2"><Pill>{txt(entry.clave)}</Pill><Pill tone={entry.estado === 'activo' ? 'ok' : 'muted'}>{txt(entry.estado)}</Pill><span className="text-[11px] text-fg-3">{txt(entry.ambito)} · {txt(entry.nCasos)} casos</span></div><p className="mt-3 text-[13px] leading-relaxed">{txt(entry.texto)}</p><p className="mt-2 text-[11px] text-fg-3">{txt(entry.condicionTexto)}</p><div className="mt-2 flex flex-wrap gap-1">{Array.isArray(entry.ejemplos) && entry.ejemplos.filter(x => typeof x === 'string' && /^MAIL-\d+$/.test(x)).map(clave => <GlassButton size="sm" key={String(clave)} onClick={() => void action.run('personal.nativeMail.select', { clave })}>{String(clave)}</GlassButton>)}</div></article>)}<ActionFeedback error={action.error} /></div>
  }
  const proposals = state.auxiliary ?? {}; const totals = obj(proposals.totales); const groups = records(proposals.grupos)
  return <div className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[12px] text-fg-3">{txt(totals.correos) || '0'} correos · {txt(totals.grupos) || '0'} grupos propuestos para marcar como leídos.</p><GlassButton size="sm" onClick={() => void action.run('personal.nativeMail.legacy', { view: 'limpieza' })}>Aprobar limpieza y ver lotes</GlassButton></div>{!groups.length && <EmptyGlass icon={<IconMail />} title="Sin propuestas de limpieza" description="El servicio no encontró grupos que cumplan sus reglas actuales." />}{groups.map(group => <article key={txt(group.id)} className="rounded-xl border border-line bg-surface-2 p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-[13px] font-medium">{txt(group.nombre || group.valor)}</h3><Pill tone={group.muyAlta ? 'ok' : 'muted'}>{group.muyAlta ? 'Confianza muy alta' : 'Revisar propuesta'}</Pill></div><p className="mt-1 break-words text-[11px] text-fg-3">{txt(group.valor)} · {txt(group.categoria)} · {txt(group.correos)} correos · {txt(group.anios)}</p><ul className="mt-3 space-y-1 text-[12px] text-fg-2">{Array.isArray(group.muestras) && group.muestras.map((sample, i) => <li key={i}>{txt(sample)}</li>)}</ul></article>)}<div className="flex items-center justify-between"><GlassButton size="sm" disabled={state.filters.desplazamiento === 0} onClick={() => void action.run('personal.nativeMail.filter', { filters: JSON.stringify({ desplazamiento: Math.max(0, state.filters.desplazamiento - 25) }) })}>Anterior</GlassButton><GlassButton size="sm" disabled={!proposals.hayMas} onClick={() => void action.run('personal.nativeMail.filter', { filters: JSON.stringify({ desplazamiento: state.filters.desplazamiento + 25 }) })}>Siguiente</GlassButton></div><ActionFeedback error={action.error} /></div>
}

export function NativeMailPanel() {
  const state = useStore(nativeMail.state); const focus = useStore($personalFocus); const page = useStore($page); const action = usePersonalAction()
  const active = !state.legacy && focus.tab === 'mail' && page === 'personal'
  useEffect(() => { if (active && state.phase === 'idle') void nativeMail.boot() }, [active, state.phase])
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (nativeMail.state.get().dirty) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard) }, [])
  const auxiliary = state.view === 'aprendizajes' || state.view === 'limpieza'
  const counts = obj(state.counts?.porEstado)
  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line" data-testid="native-mail-workspace">
    <header className="shrink-0 border-b border-line bg-surface-2 px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><IconMail size={18} className="text-accent-strong" /><h2 className="text-[14px] font-semibold">Correo</h2><Pill tone={state.phase === 'error' ? 'warn' : state.phase === 'ready' ? 'ok' : 'muted'} dot>{state.phase === 'error' ? 'Sin actualizar' : state.phase === 'ready' ? 'Conectado' : 'Consultando'}</Pill></div><div className="flex gap-2"><GlassButton size="sm" disabled={state.busy || state.dirty} onClick={() => void action.run('personal.nativeMail.legacy')}>Vista original</GlassButton><GlassButton size="icon" aria-label="Actualizar correo nativo" disabled={state.phase === 'loading'} onClick={() => void action.run('personal.mailWorkspace.reload')}><IconRefresh size={15} className={state.phase === 'loading' ? 'animate-spin' : ''} /></GlassButton><GlassButton size="sm" variant="primary" disabled={state.busy || state.dirty} onClick={() => void action.run('personal.nativeMail.compose', { mode: 'nuevo' })}><IconEdit />Nuevo correo</GlassButton></div></div>
      <nav className="mt-3 flex flex-wrap gap-1" aria-label="Vistas de correo nativo">{Object.entries(MAIL_WORKSPACE_VIEWS).map(([view, label]) => <GlassButton key={view} size="sm" variant={state.view === view ? 'secondary' : 'ghost'} aria-pressed={state.view === view} onClick={() => void runCommand('personal.mailWorkspace.open', { view }, { source: 'ui' })}>{label}</GlassButton>)}</nav>
    </header>
    <Filters />
    {(state.view === 'historico' || state.view === 'limpieza') && <details className="shrink-0 border-b border-line px-4 py-2 text-[11px] text-fg-3"><summary className="cursor-pointer">{state.view === 'historico' ? 'Progreso de carga histórica' : 'Lotes de limpieza aprobados'}</summary>{state.supplementalError ? <p role="alert" className="mt-2 text-warn">{state.supplementalError}</p> : state.supplemental ? state.view === 'historico' ? <div className="mt-2 space-y-1"><p>{state.supplemental.hayCorrida ? `Estado: ${txt(obj(state.supplemental.corrida).estado)} · ${txt(obj(state.supplemental.corrida).mensaje)}` : 'No hay una carga histórica registrada.'}</p>{records(state.supplemental.fases).map(fase => <p key={txt(fase.id)}>{txt(fase.etiqueta)}: {txt(fase.hechos)} / {txt(fase.total) || 'por determinar'} · {txt(fase.estado)}</p>)}</div> : <div className="mt-2 space-y-1">{records(state.supplemental.lotes).length ? records(state.supplemental.lotes).map((lote, index) => <p key={txt(lote.id) || index}>{txt(lote.estado)} · {txt(lote.mensaje)}</p>) : <p>No hay lotes recientes.</p>}</div> : <p className="mt-2">Consultando progreso…</p>}</details>}
    {state.view === 'tablero' && <div className="flex shrink-0 flex-wrap gap-2 border-b border-line px-4 py-2">{Object.entries(MAIL_STATES).map(([id, label]) => <GlassButton key={id} size="sm" variant={state.filters.estado === id ? 'secondary' : 'ghost'} onClick={() => void action.run('personal.nativeMail.filter', { filters: JSON.stringify({ estado: id }) })}>{label}<span className="ml-1 text-fg-3">{txt(counts[id]) || '—'}</span></GlassButton>)}</div>}
    {action.error && <div className="p-3"><ActionFeedback error={action.error} /></div>}
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section aria-label={auxiliary ? 'Resumen de correo' : 'Bandeja de correo'} className="flex min-h-0 w-[42%] min-w-64 flex-col border-r border-line max-xl:w-[38%]">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.phase === 'loading' || state.phase === 'idle' ? <p role="status" className="p-5 text-[12px] text-fg-3">Consultando correo…</p> : state.phase === 'error' ? <div className="p-4"><ActionFeedback error={state.error} /><GlassButton className="mt-3" onClick={() => void action.run('personal.mailWorkspace.reload')}>Reintentar</GlassButton></div> : auxiliary ? <AuxiliaryView /> : !state.items.length ? <div className="p-6"><EmptyGlass icon={<IconMail />} title="Sin hilos para estos filtros" description="Amplía el período o cambia los filtros de búsqueda." /></div> : state.items.map(item => <ThreadRow key={item.clave} item={item} />)}
        </div>
        {!auxiliary && <footer className="flex shrink-0 items-center justify-between gap-1 border-t border-line px-3 py-2 text-[11px] text-fg-3"><GlassButton size="icon" aria-label="Página anterior de correo" disabled={state.phase !== 'ready' || state.filters.desplazamiento === 0} onClick={() => void action.run('personal.nativeMail.filter', { filters: JSON.stringify({ desplazamiento: Math.max(0, state.filters.desplazamiento - 25) }) })}><IconArrowLeft size={14} /></GlassButton><span>{state.total ? `${state.filters.desplazamiento + 1}–${Math.min(state.filters.desplazamiento + state.items.length, state.total)} de ${state.total}` : '0 hilos'}</span><GlassButton size="icon" aria-label="Página siguiente de correo" disabled={state.phase !== 'ready' || state.filters.desplazamiento + state.items.length >= state.total} onClick={() => void action.run('personal.nativeMail.filter', { filters: JSON.stringify({ desplazamiento: state.filters.desplazamiento + 25 }) })}><IconArrowRight size={14} /></GlassButton></footer>}
      </section>
      <div className="min-w-0 flex-1 overflow-y-auto">{state.compose ? <Composer key={state.compose.id} /> : <ThreadDetail />}</div>
    </div>
  </div>
}
