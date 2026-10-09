import { useStore } from '@nanostores/react'
import { $activeChat, $chatError, $chatOpening } from '../../store/chat.ts'
import { $connection } from '../../store/gateway.ts'
import { Conversation } from '../hermes/Conversation.tsx'
import { SessionList } from './SessionList.tsx'

/** The popout uses the same transcript and draft handling as the main chat. */
export function ChatSurface() {
  const chat = useStore($activeChat)
  const opening = useStore($chatOpening)
  const error = useStore($chatError)
  const online = useStore($connection) === 'open'
  return <div className="flex h-full">
    <SessionList />
    <div className="flex min-w-0 flex-1 flex-col">
      {error && <p role="alert" className="p-3 text-[12px] text-danger">{error}</p>}
      {opening && <p role="status" className="px-3 pt-3 text-[12px] text-fg-3">Abriendo conversación…</p>}
      <div className="min-h-0 flex-1"><Conversation chat={chat} online={online && !opening} /></div>
    </div>
  </div>
}
