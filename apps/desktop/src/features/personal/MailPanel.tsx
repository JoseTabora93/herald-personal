import { useStore } from '@nanostores/react'
import { IconArchive, IconArrowBackUp, IconChevronLeft, IconChevronRight, IconExternalLink, IconFileText, IconInbox, IconSearch, IconTarget, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { PersonalMailThread } from '../../../shared/personal.ts'
import { EmptyGlass, GlassButton, GlassCard, Pill } from '../../components/ui/glass.tsx'
import { $personal, $personalFocus, type PersonalFocus } from '../../store/personal.ts'
import { dateLabel, MAIL_CATEGORY, PROVIDER_NAMES, safeMailUrl } from './model.ts'
import { ActionFeedback, FIELD_CLASS, Field, ProviderConnections, usePersonalAction } from './shared.tsx'

export function MailPanel() {
  const data = useStore($personal)
  const requestFocus = useStore($personalFocus)
  const [focus, setFocus] = useState(requestFocus)
  useEffect(() => {
    if (requestFocus.tab !== 'mail') return
    if (requestFocus.resetMail) setFocus(current => ({ ...requestFocus, mailId: current.mailId }))
    else if (requestFocus.mailId || requestFocus.mailAction) setFocus(requestFocus)
  }, [requestFocus])
  const action = usePersonalAction()
  const [query, setQuery] = useState(data.mailQuery)
  const selected = data.mail.find(mail => mail.id === focus.mailId) ?? data.mail[0]
  return <div className="flex flex-col gap-5">
    <ProviderConnections sync />
    {data.lastArchive && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ok/25 bg-ok/10 px-4 py-3 text-[12px] text-fg-2"><span>El último mensaje fue archivado en su proveedor.</span><GlassButton size="sm" onClick={() => void action.run('personal.mail.undo', { id: data.lastArchive?.actionId })}><IconArrowBackUp />Deshacer archivo</GlassButton></div>}
    {focus.mailAction === 'undo' && focus.actionId && <MailConfirmation key={`undo:${focus.actionId}`} operation="undo" id={focus.actionId} />}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(280px,2fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void action.run('personal.mail.search', { query, category: data.mailCategory }) }}><input aria-label="Buscar en correo" className={`${FIELD_CLASS} min-w-0 flex-1`} value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar remitente, asunto o texto…" /><GlassButton type="submit" disabled={data.mailLoading} aria-label="Buscar correo"><IconSearch /></GlassButton></form>
        <select aria-label="Filtrar correo por categoría" className={`${FIELD_CLASS} max-w-64`} value={data.mailCategory} onChange={event => void action.run('personal.mail.search', { query, category: event.target.value })}><option value="">Todas las categorías</option>{Object.entries(MAIL_CATEGORY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] text-fg-3" role="status">{data.mailLoading ? 'Buscando…' : data.mail.length ? `${data.mailOffset + 1}–${data.mailOffset + data.mail.length} de ${data.mailTotal} ${data.mailTotal === 1 ? 'mensaje sincronizado' : 'mensajes sincronizados'}` : `0 de ${data.mailTotal} mensajes sincronizados`}</span><div className="flex gap-2"><GlassButton size="sm" aria-label="Correos anteriores" disabled={data.loading || data.mailLoading || !data.mailPreviousOffsets.length} onClick={() => void action.run('personal.mail.page', { direction: 'previous' })}><IconChevronLeft />Anterior</GlassButton><GlassButton size="sm" aria-label="Correos siguientes" disabled={data.loading || data.mailLoading || data.mailNextOffset === null} onClick={() => void action.run('personal.mail.page', { direction: 'next' })}>Siguiente<IconChevronRight /></GlassButton></div></div>
        <ActionFeedback error={data.mailError || action.error} />
        {data.mail.length ? <div className="stagger flex flex-col gap-3">{data.mail.map(mail => <GlassCard key={mail.id} as="button" interactive selected={selected?.id === mail.id} onClick={() => void action.run('personal.mail.show', { id: mail.id })} className="min-w-0 p-4" data-os-target={`personal-mail:${mail.id}`}>
          <div className="flex items-start justify-between gap-3"><span className="min-w-0 truncate text-[12px] text-fg-2">{mail.sender}</span><span className="shrink-0 text-[10.5px] text-fg-3">{dateLabel(mail.received_at)}</span></div>
          <p className={`mt-1.5 break-words text-[13px] text-fg ${mail.unread ? 'font-semibold' : 'font-medium'}`}>{mail.subject || '(Sin asunto)'}</p><p className="mt-1.5 line-clamp-2 break-words text-[12px] text-fg-3">{mail.preview}</p>
          <div className="mt-3 flex flex-wrap gap-1.5"><Pill tone={mail.category === 'urgent' ? 'warn' : 'muted'}>{MAIL_CATEGORY[mail.category]}</Pill>{mail.task_id && <Pill tone="accent">Con compromiso</Pill>}{mail.archived && <Pill>Archivado</Pill>}</div>
        </GlassCard>)}</div> : <EmptyGlass icon={<IconInbox />} title={data.mailQuery || data.mailCategory ? 'Sin coincidencias' : data.providers.some(provider => provider.connected) ? 'No hay correo sincronizado' : 'Tu correo aún no está conectado'} description={data.providers.some(provider => provider.connected) ? 'Sincroniza tu cuenta o ajusta la búsqueda.' : 'Al conectar una cuenta, aquí aparecerán sus mensajes reales.'} />}
      </div>
      <GlassCard className="h-fit min-w-0 p-5">{selected ? <MailDetail key={selected.id} mail={selected} focus={focus} /> : <EmptyGlass icon={<IconInbox />} title="Selecciona un correo" description="Lee, clasifica y captura compromisos. Cada escritura en el proveedor se confirma por separado." />}</GlassCard>
    </div>
  </div>
}

function MailDetail({ mail, focus }: { mail: PersonalMailThread; focus: PersonalFocus }) {
  const data = useStore($personal)
  const action = usePersonalAction()
  const capability = data.status?.capabilities
  return <div className="flex min-w-0 flex-col gap-4">
    <div><div className="mb-2 flex items-center gap-2"><Pill>{PROVIDER_NAMES[mail.provider]}</Pill>{mail.unread && <Pill tone="accent">No leído</Pill>}</div><h2 className="break-words text-[16px] font-semibold text-fg">{mail.subject || '(Sin asunto)'}</h2><p className="mt-2 break-words text-[12px] text-fg-2">{mail.sender}</p><p className="mt-1 text-[11px] text-fg-3">{dateLabel(mail.received_at, true)}</p></div>
    <Field label="Categoría personal"><select className={FIELD_CLASS} value={mail.category} disabled={action.busy} onChange={event => void action.run('personal.mail.category', { id: mail.id, category: event.target.value })}>{Object.entries(MAIL_CATEGORY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    <div className="selectable max-h-[420px] overflow-y-auto whitespace-pre-wrap break-words border-y border-line py-4 text-[12.5px] leading-relaxed text-fg-2">{mail.body || mail.preview || 'Este mensaje no contiene texto disponible.'}</div>
    <div className="flex flex-wrap gap-2"><GlassButton size="sm" variant="primary" disabled={action.busy} onClick={() => void action.run(mail.task_id ? 'personal.task.show' : 'personal.mail.capture', { id: mail.task_id ?? mail.id })}><IconTarget />{mail.task_id ? 'Ver compromiso' : 'Crear compromiso'}</GlassButton>{safeMailUrl(mail.web_url) && <GlassButton size="sm" onClick={() => void action.run('personal.mail.openProvider', { id: mail.id })}><IconExternalLink />Abrir proveedor</GlassButton>}</div>
    <div className="flex flex-wrap gap-2"><GlassButton size="sm" disabled={!capability?.mail_draft} title={!capability?.mail_draft ? 'El operador no ha habilitado borradores para esta conexión.' : undefined} onClick={() => void action.run('personal.mail.draft', { id: mail.id })}><IconFileText />Preparar borrador</GlassButton><GlassButton size="sm" disabled={!capability?.mail_archive || mail.archived} title={!capability?.mail_archive ? 'El operador no ha habilitado archivar para esta conexión.' : undefined} onClick={() => void action.run('personal.mail.archive', { id: mail.id })}><IconArchive />{mail.archived ? 'Archivado' : 'Archivar'}</GlassButton></div>
    {(!capability?.mail_draft || !capability?.mail_archive) && <p className="text-[11px] text-fg-3">Las acciones deshabilitadas requieren permisos del operador. Leer y clasificar no modifica tu bandeja.</p>}
    <ActionFeedback {...action} />
    {focus.mailId === mail.id && (focus.mailAction === 'draft' || focus.mailAction === 'archive') && <MailConfirmation key={`${focus.mailAction}:${focus.tick}`} operation={focus.mailAction} id={mail.id} mail={mail} />}
  </div>
}

function MailConfirmation({ operation, id, mail }: { operation: 'draft' | 'archive' | 'undo'; id: string; mail?: PersonalMailThread }) {
  const [body, setBody] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const action = usePersonalAction()
  const close = usePersonalAction()
  const label = operation === 'draft' ? 'Guardar borrador' : operation === 'archive' ? 'Archivar mensaje' : 'Restaurar mensaje'
  const submit = async () => {
    setAttempted(true)
    await action.run('personal.mail.confirmWrite', { operation, id, ...(operation === 'draft' ? { body } : {}), confirmed })
  }
  return <section aria-label={`Confirmar: ${label}`} className="rounded-xl border border-warn/30 bg-warn/5 p-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-[13px] font-semibold">{label}</h3><GlassButton size="icon" variant="ghost" aria-label="Cerrar confirmación" onClick={() => void close.run('personal.mail.cancel')}><IconX /></GlassButton></div>
    <p className="mt-2 text-[12px] leading-relaxed text-fg-2">{operation === 'draft' ? `Se guardará una respuesta como borrador en ${mail ? PROVIDER_NAMES[mail.provider] : 'tu proveedor'}. Podrás revisarla allí antes de enviarla.` : operation === 'archive' ? 'Este mensaje saldrá de la bandeja de entrada de su proveedor. Podrás restaurarlo con Deshacer archivo.' : 'El mensaje volverá a sus carpetas o etiquetas anteriores en el proveedor.'}</p>
    {operation === 'draft' && <div className="mt-3"><Field label="Texto completo del borrador"><textarea rows={6} className={`${FIELD_CLASS} resize-y`} value={body} disabled={attempted} onChange={event => setBody(event.target.value)} placeholder="Escribe tu respuesta…" /></Field></div>}
    {!attempted && <label className="mt-4 flex items-start gap-2 text-[12px] text-fg-2"><input type="checkbox" className="mt-0.5 accent-accent" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>He revisado esta acción y autorizo {operation === 'draft' ? 'guardar este borrador.' : operation === 'archive' ? 'archivar este mensaje.' : 'restaurar este mensaje.'}</span></label>}
    <div className="mt-3"><ActionFeedback {...action} /></div>
    {attempted && action.error && <p className="mt-2 text-[11px] text-warn">No se ha repetido la escritura. Revisa el estado en el proveedor antes de iniciar otra acción.</p>}
    {!attempted && <GlassButton className="mt-3" variant="primary" disabled={action.busy || !confirmed || operation === 'draft' && !body.trim()} onClick={() => void submit()}>{label}</GlassButton>}
    {action.busy && <p role="status" className="mt-2 text-[12px] text-fg-3">Esperando confirmación del proveedor…</p>}
  </section>
}
