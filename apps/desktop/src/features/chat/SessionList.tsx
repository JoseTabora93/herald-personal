import { useStore } from '@nanostores/react'
import { IconRefresh, IconSearch } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button.tsx'
import { cn } from '../../lib/cn.ts'
import { $activeChatId, $chats, $chatOpening } from '../../store/chat.ts'
import { runCommand } from '../../store/os-commands.ts'
import { $history, $runtimeIds } from '../../store/sessions.ts'

export function SessionList() {
  const history = useStore($history)
  const runtimeIds = useStore($runtimeIds)
  const activeId = useStore($activeChatId)
  const chats = useStore($chats)
  const opening = useStore($chatOpening)
  const [query, setQuery] = useState(history.query)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => { setQuery(history.query) }, [history.query])
  const run = async (id: string, args = {}) => {
    setActionError(null)
    const result = await runCommand(id, args, { source: 'ui' })
    if (!result.ok) setActionError(result.error || result.summary)
  }
  const drafts = Object.values(chats).filter(chat => !history.query && !history.rows.some(row => row.id === chat.storedSessionId || runtimeIds[row.id] === chat.sessionId) && chat.messages.length === 0)

  return (
    <aside aria-label="Historial de conversaciones" className="flex h-full w-64 shrink-0 flex-col border-r border-hairline">
      <div className="flex items-center justify-between px-3 py-3">
        <h2 className="text-[13px] font-semibold text-fg">Historial</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Actualizar historial" disabled={history.loading} onClick={() => void run('chat.history.refresh')}><IconRefresh size={15} /></Button>
      </div>
      <form className="px-3 pb-2" onSubmit={event => { event.preventDefault(); void run('chat.history.search', { query, archived: history.includeArchived }) }}>
        <div className="glass-input flex items-center rounded-lg px-2">
          <input aria-label="Buscar conversaciones" placeholder="Título, contenido o ID" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-[12px] outline-none" />
          <button type="submit" aria-label="Buscar en el historial" className="p-1 text-fg-3"><IconSearch size={15} /></button>
        </div>
        {history.query ? <button type="button" className="mt-2 text-[11px] text-accent" onClick={() => { setQuery(''); void run('chat.history.search', { query: '', archived: history.includeArchived }) }}>Limpiar búsqueda</button> :
          <label className="mt-2 flex items-center gap-2 text-[11px] text-fg-3"><input type="checkbox" checked={history.includeArchived} onChange={event => void run('chat.history.search', { query: '', archived: event.target.checked })} />Incluir archivadas</label>}
      </form>
      <p className="px-3 pb-2 text-[10.5px] text-fg-3">Perfil de Herald · {history.total} {history.query ? 'resultados' : 'conversaciones'}</p>
      {(history.error || actionError) && <p role="alert" className="mx-3 mb-2 rounded-lg bg-danger/10 p-2 text-[12px] text-danger">{history.error || actionError}</p>}
      {history.loading && <p role="status" className="px-3 py-2 text-[12px] text-fg-3">Cargando historial…</p>}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!history.loading && !history.error && history.rows.length === 0 && <p className="px-2 py-4 text-[12px] text-fg-3">{history.query ? 'No hay coincidencias. Prueba otro texto.' : 'Aún no hay conversaciones guardadas en este perfil. Tu primer mensaje guardará la conversación.'}</p>}
        {drafts.map(chat => <button type="button" key={chat.sessionId} aria-current={activeId === chat.sessionId ? 'true' : undefined} onClick={() => void run('chat.resume', { id: chat.storedSessionId })} className="mb-1 w-full rounded-md bg-white/4 px-2.5 py-2 text-left text-[12px] text-fg-3">{chat.title || 'Nueva conversación'}<span className="block text-[10.5px] text-fg-3">Sin mensajes · todavía no guardada</span></button>)}
        {history.rows.map(row => {
          const runtimeId = runtimeIds[row.id]
          const live = runtimeId ? chats[runtimeId] : undefined
          const active = runtimeId === activeId && Boolean(activeId)
          const title = live?.title || row.title || row.preview || 'Sin título'
          const time = row.last_active ?? row.started_at
          return (
            <button key={row.id} type="button" aria-current={active ? 'true' : undefined} aria-busy={opening === row.id} onClick={() => void run('chat.resume', { id: row.id })} className={cn('mb-1 block w-full rounded-lg px-2.5 py-2.5 text-left', active ? 'bg-accent/15 ring-1 ring-accent/30' : 'hover:bg-white/4')}>
              <div className="flex items-center gap-2">
                {live?.streaming && <span className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse-soft" />}
                <span className={cn('truncate text-[12.5px]', active ? 'text-fg' : 'text-fg-2')}>{title}</span>
              </div>
              <div className="mt-1 flex gap-2 text-[10.5px] text-fg-3"><span>{opening === row.id ? 'Abriendo…' : time ? new Date(time * 1000).toLocaleDateString('es-HN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Guardada'}</span><span>· {row.message_count ?? 0} mensajes</span></div>
              <div className="mt-0.5 truncate text-[10px] text-fg-3">{row.archived ? 'Archivada · ' : ''}{row.source || 'Hermes'}</div>
            </button>
          )
        })}
        {history.hasMore && <Button className="mt-2 w-full" disabled={history.loading} onClick={() => void run('chat.history.more')}>Cargar anteriores</Button>}
        {history.truncated && <p className="p-2 text-[11px] text-fg-3">Primeras 100 coincidencias. Precisa la búsqueda para encontrar más.</p>}
      </div>
    </aside>
  )
}
