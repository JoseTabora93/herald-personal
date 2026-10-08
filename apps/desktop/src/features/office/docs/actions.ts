import type { ChainedCommands, Editor } from '@tiptap/core'
import { type CalloutKind, type PageSizeName } from '../../../../shared/office/document.ts'
import { messageOf } from '../../canvas/errors.ts'
import { insertPictures, mimeOfName } from './editor.ts'
import { applyLive, type BlockStyle, clearFormatting, indent, insertPageBreak, insertTable, type Op, setAlignment, setLineSpacing, setPage, setStyle } from './model.ts'
import { $find, $linkEdit, $zoom, activeEditor, docsSession } from './store.ts'

/*
 * What the toolbar, the menus and the '/' menu do to the document in front. Formatting goes
 * through TipTap's commands (they carry formatting over to what is typed next); styles, layout
 * and insertions go through the document API, one undo step each.
 */

export function apply(op: Op, editor: Editor | null = activeEditor()): void {
  if (editor) {
    applyLive(editor.view, op)
    editor.commands.focus()
  }
}

export function chain(build: (chain: ChainedCommands) => ChainedCommands, editor: Editor | null = activeEditor()): void {
  if (editor) {
    build(editor.chain().focus()).run()
  }
}

export const hasEditor = (): boolean => Boolean(activeEditor())
export const isActive = (name: string, attrs?: Record<string, unknown>): boolean => Boolean(activeEditor()?.isActive(name, attrs))

export type MarkName = 'bold' | 'italic' | 'underline' | 'strike' | 'superscript' | 'subscript' | 'code'

export function toggleMark(name: MarkName): void {
  chain((c) => {
    switch (name) {
      case 'bold':
        return c.toggleBold()
      case 'italic':
        return c.toggleItalic()
      case 'underline':
        return c.toggleUnderline()
      case 'strike':
        return c.toggleStrike()
      case 'superscript':
        return c.unsetSubscript().toggleSuperscript()
      case 'subscript':
        return c.unsetSuperscript().toggleSubscript()
      case 'code':
        return c.toggleCode()
    }
  })
}

export const style = (name: BlockStyle): void => apply(setStyle(name))
export const align = (value: 'left' | 'center' | 'right' | 'justify'): void => apply(setAlignment(value))
export const lineSpacing = (multiple: number | null): void => apply(setLineSpacing(multiple))
export const font = (family: string | null): void => chain((c) => (family ? c.setFontFamily(family) : c.unsetFontFamily()))
export const fontSize = (points: number | null): void => chain((c) => (points ? c.setFontSize(`${points}pt`) : c.unsetFontSize()))
export const color = (value: string | null): void => chain((c) => (value ? c.setColor(value) : c.unsetColor()))
export const highlight = (value: string | null): void => chain((c) => (value ? c.setHighlight({ color: value }) : c.unsetHighlight()))
export const clear = (): void => {
  chain((c) => c.unsetAllMarks())
  apply(clearFormatting())
}

export type ListKind = 'bullet' | 'ordered' | 'task'

export const list = (kind: ListKind): void => chain((c) => (kind === 'bullet' ? c.toggleBulletList() : kind === 'ordered' ? c.toggleOrderedList() : c.toggleTaskList()))

const listItem = (): string | null => (isActive('taskItem') ? 'taskItem' : isActive('listItem') ? 'listItem' : null)

export function shiftIndent(direction: 1 | -1): void {
  const item = listItem()

  if (item) {
    chain((c) => (direction > 0 ? c.sinkListItem(item) : c.liftListItem(item)))
  } else {
    apply(indent(36 * direction))
  }
}

export function callout(kind: CalloutKind): void {
  if (isActive('callout')) {
    chain((c) => c.updateAttributes('callout', { kind }))
  } else {
    chain((c) => c.wrapIn('callout', { kind }))
  }
}

export const removeCallout = (): void => chain((c) => c.lift('callout'))

export const table = (rows = 3, cols = 3): void => apply(insertTable({ rows, cols }, 'selection'))
export const rule = (): void => chain((c) => c.setHorizontalRule())
export const pageBreak = (): void => apply(insertPageBreak())
export const page = (change: { size?: PageSizeName; orientation?: 'portrait' | 'landscape'; margins?: number }): void => apply(setPage(change))

export function editLink(): void {
  const key = docsSession.$activeKey.get()

  if (key) {
    $linkEdit.set({ key, at: Date.now() })
  }
}

export function openFind(replace: boolean): void {
  const key = docsSession.$activeKey.get()

  if (key) {
    $find.set({ key, replace, at: Date.now() })
  }
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

export function zoom(key: string, step: 'in' | 'out' | 'reset'): void {
  const current = $zoom.get()[key] ?? 1
  const index = ZOOM_STEPS.findIndex((value) => value >= current - 0.001)
  const next = step === 'reset' ? 1 : (ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index < 0 ? ZOOM_STEPS.length - 1 : index) + (step === 'in' ? 1 : -1)))] ?? 1)
  $zoom.set({ ...$zoom.get(), [key]: next })
}

/** Pictures picked in a file dialog, put in at the selection. */
export async function picturesFromFiles(files: readonly File[]): Promise<void> {
  const editor = activeEditor()

  if (!editor || !files.length) {
    return
  }

  const read = await Promise.all(files.map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || mimeOfName(file.name) })))
  const added = await insertPictures(editor.view, read)

  if (added < read.length) {
    docsSession.notify('Herald Docs shows PNG, JPEG, GIF, WebP, BMP and SVG pictures', 'error')
  }

  editor.commands.focus()
}

/** A picture file dropped from Files or Finder, put in where it was dropped. */
export async function pictureFromPath(file: string, at?: { left: number; top: number }): Promise<void> {
  const editor = activeEditor()
  const mime = mimeOfName(file)

  if (!editor) {
    return
  }

  try {
    const data = await window.heraldOS.office.read(file)
    const pos = at ? editor.view.posAtCoords(at)?.pos : undefined
    const added = await insertPictures(editor.view, [{ bytes: data.bytes, mime }], pos === undefined ? 'selection' : { pos })

    if (!added) {
      docsSession.notify(`Herald Docs does not show ${file.split('/').pop()} as a picture`, 'error')
    }
  } catch (error) {
    docsSession.notify(`Could not add ${file.split('/').pop()}: ${messageOf(error)}`, 'error')
  }
}
