import { useStore } from '@nanostores/react'
import { IconArrowUpRight, IconHistory, IconPencil, IconPlus, IconTrash, IconLayoutSidebarRight } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, GlassCard, MoreButton } from '../../components/ui/glass.tsx'
import { $activeChat, $chatError, $chatOpening } from '../../store/chat.ts'
import { $connection } from '../../store/gateway.ts'
import { runCommand } from '../../store/os-commands.ts'
import { $chatResultsOpen, $historyOpen } from '../../store/sessions.ts'
import { SessionList } from '../chat/SessionList.tsx'
import { ArtifactPane } from './ArtifactPane.tsx'
import { Conversation } from './Conversation.tsx'
import { MenuDivider, MenuItem, PopMenu } from './Menu.tsx'

export function HermesPage() {
  const chat = useStore($activeChat)
  const opening = useStore($chatOpening)
  const chatError = useStore($chatError)
  const online = useStore($connection) === 'open'
  const historyOpen = useStore($historyOpen)
  const resultsOpen = useStore($chatResultsOpen)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setMenuOpen(false); setRenaming(false); setConfirmDelete(false); setError(null) }, [chat?.sessionId])
  useEffect(() => { if (!menuOpen) setConfirmDelete(false) }, [menuOpen])
  const run = async (command: string, args = {}) => {
    setError(null); setBusy(true)
    try {
      const result = await runCommand(command, args, { source: 'ui' })
      if (!result.ok) { setError(result.error || result.summary); return false }
      return true
    } finally { setBusy(false) }
  }
  return (
    <div className="page-enter relative flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3">
        <GlassButton aria-expanded={historyOpen} onClick={() => void run('chat.history.toggle')}><IconHistory />Historial</GlassButton>
        <div className="flex items-center gap-2">
          <GlassButton aria-expanded={resultsOpen} onClick={() => void run('chat.results.toggle')}><IconLayoutSidebarRight />Resultados</GlassButton>
          <GlassButton onClick={() => void run('chat.new')} disabled={!online || busy || Boolean(opening)}><IconPlus />Nueva conversación</GlassButton>
          <PopMenu open={menuOpen} onClose={() => setMenuOpen(false)} trigger={<MoreButton aria-label="Acciones de conversación" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)} />}>
            <MenuItem icon={<IconPencil />} disabled={!chat || Boolean(opening)} onClick={() => { setTitle(chat?.title || ''); setMenuOpen(false); setRenaming(true) }}>Renombrar</MenuItem>
            <MenuItem icon={<IconArrowUpRight />} disabled={!chat} onClick={() => { setMenuOpen(false); void run('chat.popout') }}>Abrir en otra ventana</MenuItem>
            <MenuDivider />
            <MenuItem icon={<IconTrash />} danger disabled={!chat || busy || chat.streaming || Boolean(opening)} onClick={() => {
              if (!confirmDelete) { setConfirmDelete(true); return }
              void run('chat.delete', { id: chat?.storedSessionId, confirmed: true }).then(() => setMenuOpen(false))
            }}>{confirmDelete ? 'Confirmar eliminación permanente' : 'Eliminar conversación'}</MenuItem>
          </PopMenu>
        </div>
      </div>
      {renaming && <form className="flex gap-2 px-5 pb-3" onSubmit={event => { event.preventDefault(); void run('chat.rename', { title }).then(saved => { if (saved) setRenaming(false) }) }}>
        <input autoFocus aria-label="Título de conversación" value={title} onChange={event => setTitle(event.target.value)} className="glass-input min-w-0 flex-1 rounded-lg px-3 py-2 text-[13px]" />
        <GlassButton type="submit" disabled={busy || !title.trim()}>Guardar título</GlassButton>
        <GlassButton type="button" onClick={() => setRenaming(false)}>Cancelar</GlassButton>
      </form>}
      {(error || chatError) && <p role="alert" className="mx-5 mb-3 rounded-lg bg-danger/10 p-3 text-[13px] text-danger">{error || chatError}</p>}
      {opening && <p role="status" className="px-5 pb-2 text-[12px] text-fg-3">Abriendo conversación…</p>}
      <div className="flex min-h-0 flex-1 gap-3 px-5 pb-5">
        {historyOpen && <GlassCard className="flex w-64 shrink-0 flex-col overflow-hidden [&>aside]:w-full [&>aside]:border-r-0"><SessionList /></GlassCard>}
        <GlassCard className="flex min-w-0 flex-1 flex-col overflow-hidden"><Conversation chat={chat} online={online && !opening} /></GlassCard>
        {resultsOpen && <GlassCard className="flex w-[35%] min-w-0 flex-col overflow-hidden"><ArtifactPane chat={chat} /></GlassCard>}
      </div>
    </div>
  )
}
