import type { JSONContent } from '@tiptap/core'
import type { Paragraph, RunStyle, TextBody, TextRun } from '../deck.ts'
import { effectiveStyle, ownStyle, tidyRuns } from '../text.ts'

/*
 * A text body and the text editor's document, one into the other. Each paragraph is a paragraph
 * node carrying its list, level and spacing; each run is text with marks. Bold, italic, underline
 * and strike are marks wherever they show (also when the body's own style has them), so the editor
 * can turn them off; fonts, sizes and colours are marks only where a run differs from the body.
 */

export const PARAGRAPH_ATTRS = ['align', 'list', 'level', 'bullet', 'numbering', 'startAt', 'lineSpacing', 'spaceBefore', 'spaceAfter', 'margin', 'indent'] as const

const SWITCH_MARKS = [
  ['bold', 'bold'],
  ['italic', 'italic'],
  ['underline', 'underline'],
  ['strike', 'strike']
] as const

/** The attributes the editor's run style mark carries. */
export const STYLE_ATTRS = ['font', 'size', 'color', 'highlight'] as const satisfies readonly (keyof RunStyle)[]

function marksFor(run: TextRun, body: TextBody): JSONContent['marks'] {
  const shown = effectiveStyle(run, body)
  const own = ownStyle(run, body)
  const marks: NonNullable<JSONContent['marks']> = []

  for (const [key, type] of SWITCH_MARKS) {
    if (shown[key]) {
      marks.push({ type })
    }
  }

  const attrs = Object.fromEntries(STYLE_ATTRS.filter((key) => own[key] !== undefined).map((key) => [key, own[key]]))

  if (Object.keys(attrs).length) {
    marks.push({ type: 'textStyle', attrs })
  }

  return marks.length ? marks : undefined
}

function paragraphAttrs(paragraph: Paragraph): Record<string, unknown> {
  return Object.fromEntries(PARAGRAPH_ATTRS.map((key) => [key, paragraph[key] ?? null]))
}

/** A body as the editor's document. */
export function bodyToDoc(body: TextBody): JSONContent {
  return {
    type: 'doc',
    content: body.paragraphs.map((paragraph) => {
      const content: JSONContent[] = []

      for (const run of paragraph.runs) {
        const marks = marksFor(run, body)

        run.text.split('\n').forEach((line, index) => {
          if (index) {
            content.push({ type: 'hardBreak', ...(marks ? { marks } : {}) })
          }

          if (line) {
            content.push({ type: 'text', text: line, ...(marks ? { marks } : {}) })
          }
        })
      }

      return { type: 'paragraph', attrs: paragraphAttrs(paragraph), ...(content.length ? { content } : {}) }
    })
  }
}

function runFrom(text: string, marks: JSONContent['marks'], body: TextBody): TextRun {
  const run: TextRun = { text }
  const types = new Set((marks ?? []).map((mark) => mark.type))

  for (const [key, type] of SWITCH_MARKS) {
    run[key] = types.has(type)
  }

  const style = (marks ?? []).find((mark) => mark.type === 'textStyle')?.attrs ?? {}

  for (const key of STYLE_ATTRS) {
    const value = style[key]

    if (value !== null && value !== undefined && value !== '') {
      ;(run as unknown as Record<string, unknown>)[key] = value
    }
  }

  return ownStyle(run, body)
}

/** One paragraph node of the editor's document as a paragraph. */
export function paragraphFromNode(node: JSONContent, body: TextBody): Paragraph {
  const attrs = node.attrs ?? {}
  const runs: TextRun[] = []

  for (const child of node.content ?? []) {
    if (child.type === 'text' && child.text) {
      runs.push(runFrom(child.text, child.marks, body))
    } else if (child.type === 'hardBreak') {
      const last = runs.at(-1)

      if (last) {
        last.text += '\n'
      } else {
        runs.push(runFrom('\n', child.marks, body))
      }
    }
  }

  const paragraph: Paragraph = { runs: tidyRuns(runs) }

  for (const key of PARAGRAPH_ATTRS) {
    const value = attrs[key]

    if (value !== null && value !== undefined) {
      ;(paragraph as unknown as Record<string, unknown>)[key] = value
    }
  }

  return paragraph
}

/** The editor's document as paragraphs (always at least one). */
export function paragraphsFromDoc(doc: JSONContent, body: TextBody): Paragraph[] {
  const paragraphs = (doc.content ?? []).filter((node) => node.type === 'paragraph').map((node) => paragraphFromNode(node, body))

  return paragraphs.length ? paragraphs : [{ ...(body.paragraphs[0] ? { ...body.paragraphs[0] } : {}), runs: [{ text: '' }] }]
}

const sorted = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sorted(entry)])) : value

/** Whether two paragraph lists say the same, whatever order their fields were written in. */
export const sameParagraphs = (a: readonly Paragraph[], b: readonly Paragraph[]): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
