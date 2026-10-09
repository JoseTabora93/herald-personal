import { useStore } from '@nanostores/react'
import { IconArrowRight, IconChecklist, IconMail, IconMessageCircle, IconRefresh, IconWifiOff } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { EmptyGlass, GlassButton, Pill } from '../../components/ui/glass.tsx'
import { $personalFocus, mailWorkspace, nativeMail } from '../../store/personal.ts'
import { NativeMailPanel } from './NativeMailPanel.tsx'
import { $page, $windows, MAIN_WINDOW_ID, type OSWindow } from '../../store/windows.ts'
import { useNativeView } from '../web/native-view.ts'
import { mailEditorIsOpen, MAIL_WORKSPACE_VIEWS, type MailWorkspaceState } from './mail-workspace.ts'
import { ActionFeedback, usePersonalAction } from './shared.tsx'

function NativeMailSurface({ state, win, active }: { state: MailWorkspaceState; win: OSWindow; active: boolean }) {
  const content = useRef<HTMLDivElement>(null)
  const { visible, covered, occluded } = useNativeView(state.viewId, content, win, { active: active && state.phase === 'ready', followFrameRadius: false })
  useEffect(() => () => {
    if (state.viewId) window.heraldOS.web.setBounds(state.viewId, { x: 0, y: 0, width: 1, height: 1 }, false)
  }, [state.viewId])
  return <div ref={content} className="relative min-h-0 flex-1 overflow-hidden rounded-b-xl bg-surface-2" aria-label="Aplicación Ingelmec Mail integrada" data-os-target="personal-mail-workspace">
    {!visible && <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
      {state.phase === 'error' || state.phase === 'closed'
        ? <EmptyGlass icon={<IconWifiOff />} title={state.phase === 'closed' ? 'La vista de correo se cerró' : 'Correo necesita conexión'} description={state.error ?? 'Pulsa Reintentar para volver a abrir Ingelmec Mail.'} />
        : <div className="max-w-md text-[12px] leading-relaxed text-fg-3"><IconMail className="mx-auto mb-3 text-fg-4" size={30} /><p>{covered ? 'El correo se oculta mientras está abierto un panel de Hermes.' : occluded ? 'Trae Personal al frente para continuar con tu correo.' : state.phase === 'ready' ? 'El correo está listo para continuar.' : 'Cargando Ingelmec Mail…'}</p>{!covered && !occluded && state.phase !== 'ready' && <p className="mt-2 text-fg-4">Tu tablero, hilos, redactor y aprendizajes se abren en esta misma ventana.</p>}</div>}
    </div>}
  </div>
}

function LegacyMailWorkspacePanel() {
  const state = useStore(mailWorkspace.state)
  const native = useStore(nativeMail.state)
  const focus = useStore($personalFocus)
  const page = useStore($page)
  const windows = useStore($windows)
  const action = usePersonalAction()
  const active = page === 'personal' && focus.tab === 'mail' && native.legacy
  const win = windows[MAIN_WINDOW_ID]
  const loading = state.phase === 'opening' || state.phase === 'loading'
  const selected = state.phase === 'ready' && Boolean(state.selectedClave)
  const editorOpen = mailEditorIsOpen(state)
  const currentPath = state.url ? new URL(state.url).pathname : null
  useEffect(() => { if (active) void mailWorkspace.open() }, [active])
  useEffect(() => () => mailWorkspace.dispose(), [])

  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line">
    <div className="shrink-0 border-b border-line bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2"><IconMail size={18} className="text-accent-strong" /><h2 className="text-[14px] font-semibold">Ingelmec Mail</h2><Pill dot tone={state.phase === 'ready' ? 'ok' : state.phase === 'error' || state.phase === 'closed' ? 'warn' : 'muted'}>{state.phase === 'ready' ? 'Correo listo' : loading ? 'Cargando' : state.phase === 'error' ? 'Sin conexión' : state.phase === 'closed' ? 'Vista cerrada' : 'Pendiente'}</Pill>{selected && <Pill>{state.selectedClave}</Pill>}</div>
        <div className="flex flex-wrap items-center gap-2">
          <GlassButton size="sm" disabled={editorOpen || action.busy} onClick={() => void action.run('personal.nativeMail.return')}>Volver a Correo de Herald</GlassButton>
          <GlassButton size="sm" disabled={!selected || action.busy} onClick={() => void action.run('personal.mailWorkspace.capture')}><IconChecklist />Crear compromiso</GlassButton>
          <GlassButton size="sm" variant="primary" disabled={!selected || action.busy} onClick={() => void action.run('personal.mailWorkspace.ask')}><IconMessageCircle />Consultar a Hermes<IconArrowRight /></GlassButton>
          <GlassButton size="sm" disabled={editorOpen || loading || action.busy} aria-label="Recargar vista original" onClick={() => void action.run('personal.mailWorkspace.legacyReload')}><IconRefresh className={loading ? 'animate-spin' : ''} />Recargar</GlassButton>
        </div>
      </div>
      <nav aria-label="Vistas originales de correo" className="mt-3 flex flex-wrap gap-1.5">{Object.entries(MAIL_WORKSPACE_VIEWS).map(([view, label]) => <GlassButton key={view} size="sm" variant={currentPath === `/${view}` ? 'secondary' : 'ghost'} aria-pressed={currentPath === `/${view}`} disabled={editorOpen || action.busy} onClick={() => void action.run('personal.nativeMail.legacy', { view })}>{label}</GlassButton>)}</nav>
      {editorOpen && <p role="status" className="mt-2 text-[11px] text-fg-2">Cierra el editor de correo para cambiar de vista o recargar. Puedes continuar en otra pestaña o consultar a Hermes sin cerrar el editor.</p>}
      {!selected && <p className="mt-2 text-[11px] text-fg-3">Abre un hilo MAIL para consultarlo con Hermes o vincular un compromiso.</p>}
      {action.error && <div className="mt-2"><ActionFeedback error={action.error} /></div>}
    </div>
    {win ? <NativeMailSurface state={state} win={win} active={active} /> : <div role="status" className="p-6 text-[12px] text-fg-3">Preparando la ventana de correo…</div>}
  </div>
}

export function MailWorkspacePanel() {
  const state = useStore(nativeMail.state)
  const visited = useRef(false)
  if (state.legacy) visited.current = true
  return <div className="h-full min-h-0">
    <div className="h-full" hidden={state.legacy}><NativeMailPanel /></div>
    {visited.current && <div className="h-full" hidden={!state.legacy}><LegacyMailWorkspacePanel /></div>}
  </div>
}
