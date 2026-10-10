import { atom } from 'nanostores'
import { createProjectChatController } from '../features/personal/project-chat.ts'
import { $chats, createChat, interruptChat, openStoredSession, sendPrompt } from './chat.ts'

export const $projectChatOpen = atom(false)
export const projectChats = createProjectChatController({
  request: request => window.heraldOS.personal.request(request),
  create: createChat,
  resume: id => openStoredSession(id, { select: false }),
  send: (text, sessionId) => sendPrompt(text, { sessionId }),
  interrupt: interruptChat,
  chats: () => $chats.get()
})
export function projectDraftKey(id: string) {
  return `project:${id}:${projectChats.state.get()[id]?.storedId ?? 'new'}`
}
