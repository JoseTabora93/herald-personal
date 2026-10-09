import { atom } from 'nanostores'
export interface ChatDraft { text: string; error: string | null; sending: boolean }
export const EMPTY_DRAFT: ChatDraft = { text: '', error: null, sending: false }
/** Drafts are in memory only and keyed by the saved conversation, never the selected tab. */
export const $chatDrafts = atom<Record<string, ChatDraft>>({})
export function setChatDraft(key: string, text: string, error: string | null = null): void {
  $chatDrafts.set({ ...$chatDrafts.get(), [key]: { ...EMPTY_DRAFT, ...$chatDrafts.get()[key], text, error } })
}
export async function submitChatDraft(key: string, send: (text: string) => void | string | Promise<void | string>): Promise<void> {
  const draft = $chatDrafts.get()[key]
  if (!draft?.text.trim() || draft.sending) return
  $chatDrafts.set({ ...$chatDrafts.get(), [key]: { ...draft, sending: true, error: null } })
  try {
    const target = await send(draft.text.trim())
    for (const id of new Set([key, ...(typeof target === 'string' ? [target] : [])])) {
      const current = $chatDrafts.get()[id]
      if (current?.text === draft.text) setChatDraft(id, '')
    }
  } catch (error) {
    const current = $chatDrafts.get()[key] ?? draft
    setChatDraft(key, current.text, error instanceof Error ? error.message : String(error))
  } finally {
    const current = $chatDrafts.get()[key]
    if (current) $chatDrafts.set({ ...$chatDrafts.get(), [key]: { ...current, sending: false } })
  }
}
