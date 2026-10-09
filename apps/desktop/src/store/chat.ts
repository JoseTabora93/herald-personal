import type { GatewayEvent, SessionCreateResult, SessionResumeResult } from '@herald-os/client'
import { atom, computed, map } from 'nanostores'
import { appendSystem, appendUser, type ChatState, emptyChat, fromTranscript, reduceChatEvent } from '../lib/chat-model.ts'
import { $env, $prefs } from './backend.ts'
import { $chatDrafts } from './chat-drafts.ts'
import { gatewayRequest, onAnyGatewayEvent } from './gateway.ts'
import { notify } from './notifications.ts'
import { $runtimeIds, refreshSessions, rememberRuntimeId, updateSessionTitle } from './sessions.ts'

export const SESSION_SOURCE = 'herald_os'
/** Sessions this shell lists: its own (including those saved before the rename) and other interactive clients. */
export const LISTED_SESSION_SOURCES: ReadonlySet<string> = new Set([SESSION_SOURCE, 'hermes_os', 'desktop', 'cli', 'tui'])

/** Live chat state per runtime session id. */
export const $chats = map<Record<string, ChatState>>({})
export const $activeChatId = atom<string | null>(null)
export const $activeChat = computed([$chats, $activeChatId], (chats, id) => (id ? (chats[id] ?? null) : null))
export const $chatOpening = atom<string | null>(null)
export const $chatError = atom<string | null>(null)
let selection = 0
let backendEpoch = 0
let creating: Promise<ChatState> | null = null
const resuming = new Map<string, Promise<ChatState>>()

const CHAT_EVENTS = new Set<GatewayEvent['type']>([
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'thinking.delta',
  'reasoning.delta',
  'tool.start',
  'tool.complete',
  'status.update',
  'session.title',
  'session.info',
  'session.usage',
  'error'
])

function adopt(result: SessionCreateResult | SessionResumeResult, fallbackStored?: string): ChatState {
  const stored = result.stored_session_id ?? result.info?.stored_session_id ?? ('session_key' in result ? result.session_key : undefined) ?? fallbackStored ?? result.session_id
  const state = emptyChat(result.session_id, stored, result.info)
  state.messages = fromTranscript(result.messages ?? [])
  state.title = result.info?.title ?? state.title
  const inflight = 'inflight' in result ? result.inflight : null

  if (inflight?.assistant) {
    state.messages.push({ id: `inflight-${result.session_id}`, role: 'assistant', text: inflight.assistant, reasoning: '', streaming: Boolean(inflight.streaming), ts: Date.now() })
    state.openAssistantId = inflight.streaming ? `inflight-${result.session_id}` : null
  }

  state.streaming = Boolean(result.info?.running || ('running' in result && result.running))
  rememberRuntimeId(stored, result.session_id)

  return state
}

export function bindChatEvents(): () => void {
  return onAnyGatewayEvent(event => {
    const sid = event.session_id

    if (!sid || !CHAT_EVENTS.has(event.type)) {
      return
    }

    const current = $chats.get()[sid]

    if (!current) {
      return
    }

    const next = reduceChatEvent(current, event)

    if (next !== current) {
      if (next.storedSessionId !== current.storedSessionId) {
        const drafts = $chatDrafts.get()
        if (drafts[current.storedSessionId] && !drafts[next.storedSessionId]) {
          $chatDrafts.set({ ...drafts, [next.storedSessionId]: drafts[current.storedSessionId] })
        }
      }
      $chats.setKey(sid, next)
      rememberRuntimeId(next.storedSessionId, sid)
    }

    if (event.type === 'message.complete' && $activeChatId.get() !== sid) {
      notify({ title: next.title || 'Hermes', body: 'Finished a turn in another session', level: 'info', surface: 'chat' })
    }

    if (event.type === 'session.title' || event.type === 'message.complete') {
      void refreshSessions()
    }
  })
}

export async function createChat(options: { cwd?: string; title?: string } = {}): Promise<ChatState> {
  if (creating) return creating
  const chosen = ++selection
  const epoch = backendEpoch
  $chatOpening.set('new'); $chatError.set(null)
  const cwd = options.cwd ?? $prefs.get().defaultCwd ?? $env.get()?.homeDir ?? null
  const pending = gatewayRequest('session.create', { source: SESSION_SOURCE, cwd, title: options.title ?? null }).then(result => {
    if (epoch !== backendEpoch) throw new Error('Hermes se reconectó. Abre de nuevo la conversación.')
    const state = adopt(result)
    $chats.setKey(state.sessionId, state)
    if (chosen === selection) $activeChatId.set(state.sessionId)
    return state
  }).catch(error => {
    if (chosen === selection) $chatError.set(error instanceof Error ? error.message : String(error))
    throw error
  }).finally(() => {
    if (creating === pending) creating = null
    if (chosen === selection) $chatOpening.set(null)
  })
  creating = pending
  return pending
}

export async function openStoredSession(storedId: string): Promise<ChatState> {
  const chosen = ++selection
  const epoch = backendEpoch
  $chatError.set(null)
  const existing = Object.values($chats.get()).find(chat => chat.storedSessionId === storedId || chat.sessionId === $runtimeIds.get()[storedId])

  if (existing) {
    $activeChatId.set(existing.sessionId)
    $chatOpening.set(null)

    return existing
  }

  $chatOpening.set(storedId)
  let pending = resuming.get(storedId)
  if (!pending) {
    pending = gatewayRequest('session.resume', { session_id: storedId, source: SESSION_SOURCE }).then(result => {
      if (epoch !== backendEpoch) throw new Error('Hermes se reconectó. Abre de nuevo la conversación.')
      const state = adopt(result, storedId)
      rememberRuntimeId(storedId, state.sessionId)
      $chats.setKey(state.sessionId, state)
      return state
    }).finally(() => { if (resuming.get(storedId) === pending) resuming.delete(storedId) })
    resuming.set(storedId, pending)
  }
  try {
    const state = await pending
    if (chosen === selection) $activeChatId.set(state.sessionId)
    return state
  } catch (error) {
    if (chosen === selection) $chatError.set(error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    if (chosen === selection) $chatOpening.set(null)
  }
}

export async function renameChat(sessionId: string, title: string): Promise<void> {
  const current = $chats.get()[sessionId]
  if (!current) throw new Error('Abre la conversación antes de renombrarla.')
  if (!title.trim()) throw new Error('Escribe un título para guardar.')
  const result = await gatewayRequest('session.title', { session_id: sessionId, title: title.trim() })
  const latest = $chats.get()[sessionId]
  if (!latest) return
  const saved = result.title ?? title.trim()
  $chats.setKey(sessionId, { ...latest, title: saved, info: { ...latest.info, title: saved } })
  updateSessionTitle(latest.storedSessionId, saved)
}

export interface SendPromptOptions {
  sessionId?: string
  cwd?: string
  /**
   * Client surface the turn comes from. `voice-live` makes the backend prepend its spoken-reply
   * note (short, no markdown) and accept `voiceContext`; the default is the shell itself.
   */
  surface?: 'voice-live'
  /** Recent spoken exchange (newest last) so "yes" or "Thursday, not Friday" has its referent. */
  voiceContext?: string
  /** The user spoke over an in-flight reply; the backend notes the interruption for the model. */
  interrupted?: boolean
}

/** Send a prompt to the active chat, creating one when none exists. Resolves with the session id used. */
export async function sendPrompt(text: string, options: SendPromptOptions = {}): Promise<string | null> {
  const trimmed = text.trim()

  if (!trimmed) {
    return null
  }

  let sid = options.sessionId ?? $activeChatId.get()

  if (options.sessionId && !$chats.get()[options.sessionId]) throw new Error('Esta sesión ya no está activa. Vuelve a abrirla desde el historial.')
  if ($chatOpening.get() && !creating) throw new Error('Espera a que termine de abrir la conversación.')

  if (!sid || !$chats.get()[sid]) {
    sid = (await createChat({ cwd: options.cwd })).sessionId
  }

  const before = $chats.get()[sid]
  if (before?.streaming && !options.interrupted) throw new Error('Hermes todavía está respondiendo en esta conversación.')

  if (before) {
    $chats.setKey(sid, appendUser(before, trimmed))
  }

  try {
    await gatewayRequest('prompt.submit', {
      session_id: sid,
      text: trimmed,
      surface: options.surface ?? SESSION_SOURCE,
      ...(options.surface && options.voiceContext ? { voice_context: options.voiceContext } : {}),
      ...(options.interrupted ? { interrupted: true } : {})
    })
  } catch (error) {
    const current = $chats.get()[sid]

    if (current) {
      const optimisticId = current.messages.find(m => !before.messages.some(old => old.id === m.id) && m.role === 'user')?.id
      $chats.setKey(sid, { ...appendSystem({ ...current, messages: current.messages.filter(m => m.id !== optimisticId) }, error instanceof Error ? error.message : String(error), 'error'), streaming: false })
    }
    throw error
  }

  return sid
}

export async function runSlash(command: string, sessionId?: string): Promise<void> {
  let sid = sessionId ?? $activeChatId.get()
  if (sessionId && !$chats.get()[sessionId]) throw new Error('Vuelve a abrir la conversación desde el historial.')
  if ($chatOpening.get() && !creating) throw new Error('Espera a que termine de abrir la conversación.')

  if (!sid || !$chats.get()[sid]) {
    sid = (await createChat()).sessionId
  }

  const chat = $chats.get()[sid]
  if (chat?.streaming) throw new Error('Hermes todavía está respondiendo.')

  if (chat) {
    $chats.setKey(sid, appendUser(chat, command))
  }

  try {
    const result = await gatewayRequest('slash.exec', { session_id: sid, command })
    const current = $chats.get()[sid]

    if (!current) {
      return
    }

    if (result.type === 'send' || result.type === 'skill') {
      // The command resolved to a message the agent should receive.
      $chats.setKey(sid, { ...current, streaming: true })
      await gatewayRequest('prompt.submit', { session_id: sid, text: result.message ?? command, surface: SESSION_SOURCE })

      return
    }

    const text = [result.display ?? result.output ?? '', result.notice ?? '', result.warning ?? ''].filter(Boolean).join('\n\n')
    $chats.setKey(sid, { ...appendSystem(current, text || `${command} done`), streaming: false })
  } catch (error) {
    const current = $chats.get()[sid]

    if (current) {
      $chats.setKey(sid, { ...appendSystem(current, error instanceof Error ? error.message : String(error), 'error'), streaming: false })
    }
    throw error
  }
}

export async function interruptChat(sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()

  if (!sid) {
    return
  }

  await gatewayRequest('session.interrupt', { session_id: sid })
}

export function forgetChat(sessionId: string): void {
  const next = { ...$chats.get() }
  delete next[sessionId]
  $chats.set(next)
  $runtimeIds.set(Object.fromEntries(Object.entries($runtimeIds.get()).filter(([, id]) => id !== sessionId)))

  if ($activeChatId.get() === sessionId) {
    $activeChatId.set(null)
  }
}

export function resetChats(): void {
  backendEpoch++; selection++; creating = null; resuming.clear()
  $chatOpening.set(null); $chatError.set(null); $runtimeIds.set({})
  $chats.set({})
  $activeChatId.set(null)
}

/** Fire-and-forget surfaces still expose failures, without unhandled promises. */
export async function sendPromptInBackground(text: string, options: SendPromptOptions = {}): Promise<void> {
  try { await sendPrompt(text, options) } catch (error) { reportChatError(error) }
}
export function reportChatError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  $chatError.set(message)
  notify({ title: 'No se pudo completar la acción', body: message, level: 'error', surface: 'hermes' })
}
