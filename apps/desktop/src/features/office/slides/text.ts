import type { Anchor, AutoFit, BodyStyle, NumberStyle, Paragraph, RunStyle, TextBody, TextRun } from './deck.ts'

/*
 * Text bodies: paragraphs of runs, as DrawingML has them. A paragraph is flat (its list and level
 * are properties of it, not a nesting), so a text box reads and writes PowerPoint's paragraphs one
 * for one, and the editor, the slide and the file all number a list the same way.
 */

/** PowerPoint's default text box insets: 0.1 inch at the sides, 0.05 inch above and below. */
export const DEFAULT_INSET: [number, number, number, number] = [7.2, 3.6, 7.2, 3.6]

/** How far each list level is indented, in points (PptxGenJS's step, so files match). */
export const LIST_INDENT = 27

export const MAX_LEVEL = 8

const BULLETS = ['•', '◦', '▪']
const NUMBERINGS: NumberStyle[] = ['arabicPeriod', 'alphaLcPeriod', 'romanLcPeriod']

export const bulletFor = (level: number): string => BULLETS[level % BULLETS.length]

export const numberingFor = (level: number): NumberStyle => NUMBERINGS[level % NUMBERINGS.length]

export const RUN_KEYS = ['font', 'size', 'color', 'bold', 'italic', 'underline', 'strike', 'highlight'] as const satisfies readonly (keyof RunStyle)[]

const SWITCHES: ReadonlySet<keyof RunStyle> = new Set(['bold', 'italic', 'underline', 'strike'])

export function textBody(style: BodyStyle, options: { anchor?: Anchor; fit?: AutoFit; inset?: [number, number, number, number]; paragraph?: Omit<Paragraph, 'runs'>; text?: string } = {}): TextBody {
  const lines = (options.text ?? '').split('\n')

  return {
    paragraphs: lines.map((line) => ({ ...options.paragraph, runs: [{ text: line }] })),
    style,
    anchor: options.anchor ?? 'top',
    inset: [...(options.inset ?? DEFAULT_INSET)],
    fit: options.fit ?? 'none',
    wrap: true
  }
}

/** The body's words, a line a paragraph. */
export const plainText = (body: TextBody): string => body.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join('')).join('\n')

export const isBlank = (body: TextBody): boolean => body.paragraphs.every((paragraph) => paragraph.runs.every((run) => !run.text.trim()))

/** What a run looks like: the body's style with the run's own on top. */
export function effectiveStyle(run: RunStyle, body: TextBody): Required<Pick<RunStyle, 'font' | 'size' | 'color'>> & RunStyle {
  const style: RunStyle = { ...body.style }

  for (const key of RUN_KEYS) {
    if (run[key] !== undefined) {
      ;(style as Record<string, unknown>)[key] = run[key]
    }
  }

  return style as Required<Pick<RunStyle, 'font' | 'size' | 'color'>> & RunStyle
}

const sameStyle = (a: RunStyle, b: RunStyle): boolean => RUN_KEYS.every((key) => (a[key] ?? undefined) === (b[key] ?? undefined))

/** A run's own style, without what equals the body's. */
export function ownStyle(run: TextRun, body: Pick<TextBody, 'style'>): TextRun {
  const out: TextRun = { text: run.text }

  for (const key of RUN_KEYS) {
    const value = run[key]
    const base = body.style[key] ?? (SWITCHES.has(key) ? false : undefined)

    if (value !== undefined && value !== base) {
      ;(out as unknown as Record<string, unknown>)[key] = value
    }
  }

  return out
}

/** Runs with neighbours of the same style joined and empty ones gone (one empty run stays, to hold the style). */
export function tidyRuns(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = []

  for (const run of runs) {
    const last = out.at(-1)

    if (!run.text) {
      continue
    }

    if (last && sameStyle(last, run)) {
      out[out.length - 1] = { ...last, text: last.text + run.text }
    } else {
      out.push({ ...run })
    }
  }

  return out.length ? out : [{ ...(runs[0] ?? {}), text: '' }]
}

/** The same style on every run (and as the body's), clearing what runs said otherwise. */
export function styleAll(body: TextBody, patch: RunStyle): TextBody {
  const keys = Object.keys(patch) as (keyof RunStyle)[]
  const style = { ...body.style, ...patch } as BodyStyle

  return {
    ...body,
    style,
    paragraphs: body.paragraphs.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.map((run) => {
        const next = { ...run }

        for (const key of keys) {
          delete next[key]
        }

        return next
      })
    }))
  }
}

/** Whether every run of the body shows `key` as `value` (for the toolbar's on and off states). */
export function allRuns<K extends keyof RunStyle>(body: TextBody, key: K, value: RunStyle[K]): boolean {
  return body.paragraphs.every((paragraph) => paragraph.runs.every((run) => (effectiveStyle(run, body)[key] ?? false) === (value ?? false)))
}

/** The same paragraph settings on every paragraph. */
export function paragraphsAll(body: TextBody, patch: Omit<Partial<Paragraph>, 'runs'>): TextBody {
  return { ...body, paragraphs: body.paragraphs.map((paragraph) => withParagraph(paragraph, patch)) }
}

/** A paragraph with settings changed; `undefined` clears one. */
export function withParagraph(paragraph: Paragraph, patch: Omit<Partial<Paragraph>, 'runs'>): Paragraph {
  const next: Paragraph = { ...paragraph }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete (next as unknown as Record<string, unknown>)[key]
    } else {
      ;(next as unknown as Record<string, unknown>)[key] = value
    }
  }

  // A list's glyph and numbering belong to the list kind they were made for.
  if (patch.list !== undefined && patch.list !== paragraph.list) {
    delete next.bullet
    delete next.numbering
    delete next.startAt
  }

  return next
}

/** A paragraph's text margin and first-line indent in points. */
export function paragraphIndent(paragraph: Paragraph): { margin: number; indent: number } {
  const level = paragraph.level ?? 0

  if (paragraph.margin !== undefined || paragraph.indent !== undefined) {
    return { margin: paragraph.margin ?? 0, indent: paragraph.indent ?? 0 }
  }

  return paragraph.list ? { margin: LIST_INDENT * (level + 1), indent: -LIST_INDENT } : { margin: 0, indent: 0 }
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i']
]

function roman(n: number): string {
  let rest = Math.max(1, Math.min(3999, n))
  let out = ''

  for (const [value, letters] of ROMAN) {
    while (rest >= value) {
      out += letters
      rest -= value
    }
  }

  return out
}

function alpha(n: number): string {
  let rest = Math.max(1, n)
  let out = ''

  while (rest > 0) {
    rest--
    out = String.fromCharCode(97 + (rest % 26)) + out
    rest = Math.floor(rest / 26)
  }

  return out
}

/** A list number as PowerPoint writes it in a numbering style. */
export function numberLabel(n: number, style: NumberStyle): string {
  const body = style.startsWith('roman') ? roman(n) : style.startsWith('alpha') ? alpha(n) : String(n)
  const cased = style.includes('Uc') ? body.toUpperCase() : body

  return style.endsWith('ParenR') ? `${cased})` : `${cased}.`
}

/**
 * Each paragraph's list marker, or null: bullets show their glyph; numbers count on from their start
 * through the paragraphs of a level until a paragraph of that level or a shallower one is not
 * numbered alike (deeper paragraphs in between do not interrupt), as PowerPoint numbers.
 */
export function listMarkers(paragraphs: readonly Paragraph[]): (string | null)[] {
  const counters: ({ n: number; style: NumberStyle; start: number } | undefined)[] = []

  return paragraphs.map((paragraph) => {
    const level = Math.max(0, Math.min(MAX_LEVEL, paragraph.level ?? 0))
    counters.length = Math.min(counters.length, level + 1)

    if (paragraph.list === 'bullet') {
      counters[level] = undefined

      return paragraph.bullet || bulletFor(level)
    }

    if (paragraph.list !== 'number') {
      counters.length = level

      return null
    }

    const style = paragraph.numbering ?? numberingFor(level)
    const start = paragraph.startAt ?? 1
    const known = counters[level]
    const n = known && known.style === style && known.start === start ? known.n + 1 : start
    counters[level] = { n, style, start }

    return numberLabel(n, style)
  })
}
