import { useStore } from '@nanostores/react'
import { IconArrowUp, IconMessageCircle, IconMinus, IconPlayerStop, IconPlus, IconRefresh } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { HermesAvatar } from '../../components/app-icon.tsx'
import { GlassButton, Pill } from '../../components/ui/glass.tsx'
import { $chats, $visibleChatSessionIds } from '../../store/chat.ts'
import { $chatDrafts, EMPTY_DRAFT, setChatDraft, submitChatDraft } from '../../store/chat-drafts.ts'
import { $connection, onAnyGatewayEvent } from '../../store/gateway.ts'
import { runCommand } from '../../store/os-commands.ts'
import { $personal, $personalFocus, personal } from '../../store/personal.ts'
import { $projectChatOpen, projectChats, projectDraftKey } from '../../store/project-chat.ts'
import { $pendingRequests } from '../../store/requests.ts'
import { $page } from '../../store/windows.ts'
import { Transcript } from '../chat/Transcript.tsx'
import { dateLabel } from './model.ts'
import { EMPTY_PROJECT_ROOM } from './project-chat.ts'
import { ActionFeedback, usePersonalAction } from './shared.tsx'

const suggestions = ['¿Qué debo atender ahora?', 'Propón un cambio de rumbo', 'Ayúdame a crear un compromiso']

/** Kept mounted with Personal; only the visible project is resumed, never a global selection. */
export function ProjectChatWindow() {
  const open = useStore($projectChatOpen)
  const focus = useStore($personalFocus)
  const page = useStore($page)
  const data = useStore($personal)
  const rooms = useStore(projectChats.state)
  const chats = useStore($chats)
  const drafts = useStore($chatDrafts)
  const online = useStore($connection) === 'open'
  const requests = useStore($pendingRequests)
  const action = usePersonalAction()
  const input = useRef<HTMLTextAreaElement>(null)
  const project = data.projects.find(p => p.id === focus.projectId) ?? data.projects[0]
  const id = project?.id ?? ''
  const room = rooms[id] ?? EMPTY_PROJECT_ROOM
  const chat = room.runtimeId ? chats[room.runtimeId] : null
  const key = projectDraftKey(id)
  const draft = drafts[key] ?? EMPTY_DRAFT
  const visible = open && page === 'personal' && focus.tab === 'projects' && Boolean(project)
  const pending = requests.some(r => r.request.params.session_id === chat?.sessionId)

  useEffect(() => {
    const sid = visible ? chat?.sessionId : null
    if (!sid) return
    $visibleChatSessionIds.set([...new Set([...$visibleChatSessionIds.get(), sid])])
    return () => $visibleChatSessionIds.set($visibleChatSessionIds.get().filter(value => value !== sid))
  }, [visible, chat?.sessionId])

  useEffect(() => {
    if (visible && online) void projectChats.open(id).catch(() => { /* The room owns its error. */ })
  }, [id, online, visible])
  useEffect(() => {
    if (visible) input.current?.focus()
  }, [id, visible])
  useEffect(() => onAnyGatewayEvent(event => {
    if (event.type !== 'message.complete' && event.type !== 'tool.complete') return
    const entry = Object.entries(projectChats.state.get()).find(([, r]) => r.runtimeId === event.session_id)
    if (!entry) return
    void projectChats.refresh(entry[0]).catch(() => { /* Refresh errors remain visible in the room. */ })
    if (event.type === 'message.complete') void personal.loadProjects()
  }), [])
  useEffect(() => {
    const el = input.current
    if (el) { el.style.height = '0px'; el.style.height = `${Math.min(125, Math.max(44, el.scrollHeight))}px` }
  }, [draft.text, visible])

  if (!visible || !project) return null
  const disabled = !online || room.loading || room.sending || draft.sending
  const submit = () => {
    if (disabled || chat?.streaming) return
    void submitChatDraft(key, async text => {
      const result = await runCommand('personal.project.chat.send', { id, text }, { source: 'ui' })
      if (!result.ok) {
        const error = result.error ?? result.summary
        const destination = projectDraftKey(id)
        if (destination !== key) setChatDraft(destination, text, error)
        throw new Error(error)
      }
      return projectDraftKey(id)
    })
  }
  return <aside aria-label={`Chat del proyecto ${project.name}`} data-testid="project-chat" data-os-target={`project-chat:${id}`} className="absolute bottom-4 right-4 top-[130px] z-20 flex w-[min(440px,calc(100%-32px))] max-h-[680px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-bg shadow-panel">
    <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
      <HermesAvatar size={32} rounded={10} />
      <div className="min-w-0 flex-1"><h2 className="text-[14px] font-semibold">Hermes · Proyecto</h2><p className="truncate text-[12px] text-fg-2" title={project.name}>{project.name}</p></div>
      <GlassButton size="icon" aria-label="Actualizar chat del proyecto" disabled={room.loading || room.sending} onClick={() => void action.run('personal.project.chat.refresh', { id })}><IconRefresh size={16} /></GlassButton>
      <GlassButton size="icon" aria-label="Minimizar chat del proyecto" onClick={() => void action.run('personal.project.chat.close')}><IconMinus size={17} /></GlassButton>
    </header>
    <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
      <div className="flex items-center gap-2"><select aria-label="Conversaciones de este proyecto" className="glass-input min-w-0 flex-1 rounded-lg p-2 text-[12px]" value={room.storedId ?? ''} disabled={room.loading || room.sending} onChange={e => void action.run('personal.project.chat.select', { id, sessionId: e.target.value })}>
        <option value="">Nueva conversación</option>
        {room.storedId && !room.workspace?.conversations.some(c => c.session_id === room.storedId) && <option value={room.storedId}>Conversación actual</option>}
        {room.workspace?.conversations.map(c => <option key={c.session_id} value={c.session_id}>{dateLabel(c.created_at, true)} · {chats[room.runtimeId ?? '']?.storedSessionId === c.session_id ? chat?.title || c.title : c.title}</option>)}
      </select><GlassButton size="icon" aria-label="Nueva conversación del proyecto" disabled={room.loading || room.sending} onClick={() => void action.run('personal.project.chat.select', { id })}><IconPlus size={16} /></GlassButton></div>
      <div className="flex items-center justify-between gap-2 text-[11px]"><span className="text-fg-3">Contexto e historial propios del proyecto</span><Pill tone={pending ? 'warn' : online ? 'ok' : 'muted'} dot>{pending ? 'Necesita tu respuesta' : online ? 'Conectado' : 'Sin conexión'}</Pill></div>
      {room.workspace?.direction.text && <details className="text-[12px]" data-testid="project-direction"><summary className="cursor-pointer font-medium text-accent-strong">Rumbo guardado · v{room.workspace.direction.revision}</summary><p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-fg-2">{room.workspace.direction.text}</p><p className="mt-1 text-[11px] text-fg-3">Guardado en Herald. Aplicación en agentes externos: sin confirmar.</p></details>}
    </div>
    {(room.error || action.error) && <div className="shrink-0 px-4 pt-2"><ActionFeedback error={room.error || action.error} /></div>}
    {room.loading && <p role="status" className="px-4 py-2 text-[12px] text-fg-3">Abriendo conversación…</p>}
    {chat?.messages.length ? <Transcript key={chat.sessionId} chat={chat} /> : <div className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-y-auto p-5"><IconMessageCircle size={28} className="text-accent-strong" /><h3 className="text-[16px] font-semibold">Decide el siguiente paso</h3><p className="text-[12px] leading-relaxed text-fg-2">Pide orientación, registra un cambio de rumbo o encarga un compromiso. Hermes consultará el estado de este proyecto.</p><div className="space-y-2">{suggestions.map(text => <button type="button" key={text} className="glass-card glass-card-hover w-full px-3 py-2 text-left text-[12px] disabled:opacity-40" disabled={disabled} onClick={() => { void action.run('personal.project.chat.suggest', { id, text }); input.current?.focus() }}>{text}</button>)}</div></div>}
    <footer className="shrink-0 border-t border-line p-3">
      {draft.error && <p role="alert" className="mb-2 text-[12px] text-danger">{draft.error} El borrador se conserva.</p>}
      <div className="glass-input flex items-end gap-2 rounded-xl p-2"><textarea ref={input} aria-label="Mensaje del proyecto para Hermes" placeholder={online ? 'Pide ayuda o indica un cambio de rumbo…' : 'Esperando conexión con Hermes…'} rows={2} maxLength={20000} value={draft.text} disabled={disabled} onChange={e => setChatDraft(key, e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} className="min-h-11 flex-1 resize-none bg-transparent p-1 text-[13px] outline-none placeholder:text-fg-4 disabled:opacity-50" />
        {chat?.streaming ? <GlassButton size="icon" aria-label="Detener respuesta del proyecto" disabled={!online} onClick={() => void action.run('personal.project.chat.stop', { id })}><IconPlayerStop size={16} /></GlassButton> : <GlassButton size="icon" variant="primary" aria-label="Enviar mensaje del proyecto" disabled={disabled || !draft.text.trim()} onClick={submit}><IconArrowUp size={17} /></GlassButton>}
      </div><p className="mt-2 text-[10.5px] leading-relaxed text-fg-3">Enter envía · Mayús+Enter añade línea. Hermes muestra el resultado de sus acciones; registrar un rumbo no redirige por sí solo al VPS.</p>
    </footer>
  </aside>
}
