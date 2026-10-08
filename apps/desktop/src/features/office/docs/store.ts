import type { Editor } from '@tiptap/core'
import { atom } from 'nanostores'
import { createSession } from '../session.ts'
import { docsAdapter } from './adapter.ts'

/** Herald Docs' open documents in this window. */
export const docsSession = createSession(docsAdapter)

/** The live editor of each open document, by its key, while its view is mounted. */
export const $editors = atom<Readonly<Record<string, Editor>>>({})

export const editorOf = (key: string | null | undefined): Editor | null => (key ? ($editors.get()[key] ?? null) : null)

export const activeEditor = (): Editor | null => editorOf(docsSession.$activeKey.get())

/** Each document's page zoom (1 is actual size). */
export const $zoom = atom<Readonly<Record<string, number>>>({})

/** The find bar: the document it is open on, and whether it shows replace. */
export const $find = atom<{ key: string; replace: boolean; at: number } | null>(null)

/** A request to edit the link at the selection (⌘K), for one document. */
export const $linkEdit = atom<{ key: string; at: number } | null>(null)
