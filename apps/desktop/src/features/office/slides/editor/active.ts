import type { Editor } from '@tiptap/core'
import { atom } from 'nanostores'
import type { SlidesDocument } from '../document.ts'

/*
 * The text being edited, if any: its TipTap editor, for the toolbar and the menus to format the
 * selection with, and a way to fold what was typed into the deck before another change.
 */

export interface TextSession {
  editor: Editor
  doc: SlidesDocument
  elementId: string
  /** Record what was typed so far as a step and carry on editing (before a save, or another change). */
  flush: () => void
  /** Stop editing, keeping what was typed. */
  finish: () => void
}

export const $textSession = atom<TextSession | null>(null)

/** Bumped on every change in the editor, so the toolbar shows the selection's formatting. */
export const $textRevision = atom(0)

/** Where the caret goes when editing starts: under a point on screen, around the word there, at the end, or over everything. */
export interface EditStart {
  elementId: string
  point?: { x: number; y: number }
  select: 'caret' | 'word' | 'end' | 'all'
}

let start: EditStart | null = null

export const requestEditStart = (request: EditStart | null): void => {
  start = request
}

/** The start asked for an element; it stands until another is asked for, since a view may mount twice. */
export const editStartFor = (elementId: string): EditStart | null => (start?.elementId === elementId ? start : null)

/** The text session of a document, when it is the one being edited. */
export function textSessionOf(doc: SlidesDocument | undefined): TextSession | null {
  const session = $textSession.get()

  return session && session.doc === doc ? session : null
}

/** Fold typing into the deck before a change made elsewhere (a menu, a command, a save). */
export function flushTyping(doc: SlidesDocument | undefined): void {
  textSessionOf(doc)?.flush()
}
