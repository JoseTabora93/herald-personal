import { beforeEach, expect, it } from 'vitest'
import { $chatDrafts, setChatDraft, submitChatDraft } from './chat-drafts.ts'
beforeEach(() => $chatDrafts.set({}))
it('preserves drafts independently when switching conversations', () => {
  setChatDraft('a', 'Pendiente A'); setChatDraft('b', 'Pendiente B')
  expect($chatDrafts.get()).toMatchObject({ a: { text: 'Pendiente A' }, b: { text: 'Pendiente B' } })
})
it('retains text and displays an error on failed submission', async () => {
  setChatDraft('a', 'No perder')
  await submitChatDraft('a', async () => { throw new Error('Sin conexión') })
  expect($chatDrafts.get().a).toMatchObject({ text: 'No perder', error: 'Sin conexión', sending: false })
})
it('does not clear another conversation or a newer draft after a delayed send', async () => {
  setChatDraft('a', 'Primero'); setChatDraft('b', 'Otro')
  await submitChatDraft('a', async () => { setChatDraft('a', 'Siguiente') })
  expect($chatDrafts.get().a.text).toBe('Siguiente')
  expect($chatDrafts.get().b.text).toBe('Otro')
})
it('clears only the acknowledged draft and suppresses duplicate submits', async () => {
  setChatDraft('a', 'Enviar')
  let count = 0
  await submitChatDraft('a', async () => { count++; await submitChatDraft('a', async () => { count++ }) })
  expect(count).toBe(1); expect($chatDrafts.get().a.text).toBe('')
})
