import {
  ARROW_HEADS,
  type Background,
  type BodyStyle,
  type Color,
  type Crop,
  DASHES,
  type Deck,
  type Fill,
  type FontRef,
  type GradientStop,
  LAYOUTS,
  newId,
  NUMBER_STYLES,
  type Paragraph,
  type Placeholder,
  type PlaceholderRole,
  SHAPE_KINDS,
  type Slide,
  type SlideElement,
  SLIDE_SIZES,
  SLOTS,
  type Stroke,
  type TextBody,
  type TextRun,
  type Theme,
  TRANSITIONS
} from './deck.ts'
import { PROMPTS } from './layouts.ts'
import { colorOf, DEFAULT_THEME, normalHex } from './themes.ts'
import { DEFAULT_INSET, MAX_LEVEL } from './text.ts'

/*
 * A deck as read from a file, made safe and whole: every field is checked and given its default
 * when it is missing or wrong, unknown kinds are dropped, and pictures may only be image data. A
 * file is never trusted to be what Herald wrote; what fails here is left out, never shown broken.
 */

type Raw = Record<string, unknown>

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)

const list = (value: unknown, most: number): unknown[] => (Array.isArray(value) ? value.slice(0, most) : [])

function num(value: unknown, fallback: number, low = -100_000, high = 100_000): number {
  const n = typeof value === 'number' ? value : Number.NaN

  return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback
}

const str = (value: unknown, fallback = '', most = 10_000): string => (typeof value === 'string' ? value.slice(0, most) : fallback)

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback)

const flag = (value: unknown): boolean => value === true

const color = (value: unknown, fallback: Color): Color => colorOf(value) ?? fallback

function font(value: unknown, fallback: FontRef): FontRef {
  if (value === '+heading' || value === '+body') {
    return value
  }

  const clean = str(value, '', 80)
    .replace(/["\\;{}<>]/g, '')
    .trim()

  return clean || fallback
}

const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\r\n]*$/

/** A picture source Herald shows: image data, nothing else. */
export const imageSource = (value: unknown): string => {
  const text = str(value, '', 400_000_000)

  return IMAGE_DATA.test(text) ? text : ''
}

function theme(value: unknown): Theme {
  if (!isObject(value)) {
    return DEFAULT_THEME
  }

  const colors = isObject(value.colors) ? value.colors : {}
  const fonts = isObject(value.fonts) ? value.fonts : {}

  return {
    id: str(value.id, 'custom', 80) || 'custom',
    name: str(value.name, 'Theme', 120) || 'Theme',
    colors: Object.fromEntries(SLOTS.map((slot) => [slot, normalHex(colors[slot]) ?? DEFAULT_THEME.colors[slot]])) as Theme['colors'],
    fonts: { heading: font(fonts.heading, DEFAULT_THEME.fonts.heading).replace(/^\+.*/, DEFAULT_THEME.fonts.heading), body: font(fonts.body, DEFAULT_THEME.fonts.body).replace(/^\+.*/, DEFAULT_THEME.fonts.body) }
  }
}

function run(value: unknown): TextRun | null {
  if (!isObject(value)) {
    return null
  }

  const out: TextRun = { text: str(value.text, '', 200_000) }

  if (value.font !== undefined) out.font = font(value.font, '+body')
  if (value.size !== undefined) out.size = num(value.size, 18, 1, 4000)
  if (value.color !== undefined) out.color = color(value.color, 'tx1')
  if (value.highlight !== undefined) out.highlight = color(value.highlight, '#ffff00')

  for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
    if (typeof value[key] === 'boolean') {
      out[key] = value[key] as boolean
    }
  }

  return out
}

function paragraph(value: unknown): Paragraph | null {
  if (!isObject(value)) {
    return null
  }

  const runs = list(value.runs, 5000)
    .map(run)
    .filter((entry): entry is TextRun => entry !== null)
  const out: Paragraph = { runs: runs.length ? runs : [{ text: '' }] }

  if (value.align !== undefined) out.align = oneOf(value.align, ['left', 'center', 'right', 'justify'] as const, 'left')
  if (value.list === 'bullet' || value.list === 'number') out.list = value.list
  if (value.level !== undefined) out.level = Math.round(num(value.level, 0, 0, MAX_LEVEL))
  if (typeof value.bullet === 'string' && value.bullet) out.bullet = [...value.bullet][0]
  if (value.numbering !== undefined) out.numbering = oneOf(value.numbering, NUMBER_STYLES, 'arabicPeriod')
  if (value.startAt !== undefined) out.startAt = Math.round(num(value.startAt, 1, 1, 30000))
  if (value.lineSpacing !== undefined) out.lineSpacing = num(value.lineSpacing, 1, 0.1, 10)
  if (value.spaceBefore !== undefined) out.spaceBefore = num(value.spaceBefore, 0, 0, 2000)
  if (value.spaceAfter !== undefined) out.spaceAfter = num(value.spaceAfter, 0, 0, 2000)
  if (value.margin !== undefined) out.margin = num(value.margin, 0, 0, 2000)
  if (value.indent !== undefined) out.indent = num(value.indent, 0, -2000, 2000)

  return out
}

function body(value: unknown): TextBody {
  const raw = isObject(value) ? value : {}
  const style = isObject(raw.style) ? raw.style : {}
  const paragraphs = list(raw.paragraphs, 5000)
    .map(paragraph)
    .filter((entry): entry is Paragraph => entry !== null)
  const inset = list(raw.inset, 4)
  const bodyStyle: BodyStyle = { font: font(style.font, '+body'), size: num(style.size, 18, 1, 4000), color: color(style.color, 'tx1') }

  for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
    if (typeof style[key] === 'boolean') {
      bodyStyle[key] = style[key] as boolean
    }
  }

  if (style.highlight !== undefined) {
    bodyStyle.highlight = color(style.highlight, '#ffff00')
  }

  return {
    paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: '' }] }],
    style: bodyStyle,
    anchor: oneOf(raw.anchor, ['top', 'middle', 'bottom'] as const, 'top'),
    inset: inset.length === 4 ? (inset.map((entry, index) => num(entry, DEFAULT_INSET[index], 0, 2000)) as TextBody['inset']) : [...DEFAULT_INSET],
    fit: oneOf(raw.fit, ['none', 'shrink', 'grow'] as const, 'none'),
    wrap: raw.wrap !== false
  }
}

const fill = (value: unknown): Fill | null => (isObject(value) ? { color: color(value.color, 'accent1'), ...(value.alpha !== undefined ? { alpha: num(value.alpha, 1, 0, 1) } : {}) } : null)

function stroke(value: unknown): Stroke | null {
  if (!isObject(value)) {
    return null
  }

  return { color: color(value.color, 'tx1'), width: num(value.width, 1, 0, 200), dash: oneOf(value.dash, DASHES, 'solid'), ...(value.alpha !== undefined ? { alpha: num(value.alpha, 1, 0, 1) } : {}) }
}

function crop(value: unknown): Crop | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const side = (key: string) => num(value[key], 0, 0, 0.99)
  const out = { left: side('left'), top: side('top'), right: side('right'), bottom: side('bottom') }

  return out.left + out.right < 0.99 && out.top + out.bottom < 0.99 ? out : undefined
}

function placeholder(value: unknown): Placeholder | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const role = oneOf<PlaceholderRole>(value.role, ['title', 'subtitle', 'body', 'heading', 'caption', 'picture'], 'body')

  return { role, prompt: str(value.prompt, PROMPTS[role], 200) || PROMPTS[role] }
}

function element(value: unknown): SlideElement | null {
  if (!isObject(value)) {
    return null
  }

  const frame = {
    id: str(value.id, '', 80).replace(/[^\w-]/g, '') || newId('element'),
    x: num(value.x, 0),
    y: num(value.y, 0),
    width: num(value.width, 100, 0),
    height: num(value.height, 100, 0),
    rotation: num(value.rotation, 0, -3600, 3600),
    ...(typeof value.flipH === 'boolean' ? { flipH: value.flipH } : {}),
    ...(typeof value.flipV === 'boolean' ? { flipV: value.flipV } : {}),
    ...(typeof value.name === 'string' && value.name ? { name: str(value.name, '', 200) } : {}),
    ...(placeholder(value.placeholder) ? { placeholder: placeholder(value.placeholder) } : {})
  }

  switch (value.kind) {
    case 'text':
      return { ...frame, kind: 'text', body: body(value.body), fill: fill(value.fill), stroke: stroke(value.stroke) }
    case 'shape': {
      const adjust = isObject(value.adjust) ? Object.fromEntries(Object.entries(value.adjust).filter(([key, entry]) => /^adj\d?$/.test(key) && typeof entry === 'number' && Number.isFinite(entry))) : undefined

      return { ...frame, kind: 'shape', shape: oneOf(value.shape, SHAPE_KINDS, 'rect'), fill: fill(value.fill), stroke: stroke(value.stroke), body: body(value.body), ...(adjust && Object.keys(adjust).length ? { adjust: adjust as Record<string, number> } : {}) }
    }
    case 'image': {
      const natural = isObject(value.natural) ? value.natural : {}
      const src = imageSource(value.src)

      if (!src && frame.placeholder?.role !== 'picture') {
        return null
      }

      return {
        ...frame,
        kind: 'image',
        src,
        natural: { width: num(natural.width, 0, 0, 1_000_000), height: num(natural.height, 0, 0, 1_000_000) },
        ...(crop(value.crop) ? { crop: crop(value.crop) } : {}),
        ...(typeof value.alt === 'string' && value.alt ? { alt: str(value.alt, '', 2000) } : {}),
        stroke: stroke(value.stroke)
      }
    }
    case 'line':
      return { ...frame, kind: 'line', stroke: stroke(value.stroke) ?? { color: 'tx1', width: 2, dash: 'solid' }, start: oneOf(value.start, ARROW_HEADS, 'none'), end: oneOf(value.end, ARROW_HEADS, 'none') }
    default:
      return null
  }
}

function background(value: unknown): Background | null {
  if (!isObject(value)) {
    return null
  }

  if (value.kind === 'solid') {
    return { kind: 'solid', color: color(value.color, 'bg1') }
  }

  if (value.kind === 'gradient') {
    const stops = list(value.stops, 16)
      .filter(isObject)
      .map((stop): GradientStop => ({ at: num(stop.at, 0, 0, 1), color: color(stop.color, 'bg1') }))

    return stops.length >= 2 ? { kind: 'gradient', stops, angle: num(value.angle, 90, -3600, 3600) } : null
  }

  if (value.kind === 'image') {
    const natural = isObject(value.natural) ? value.natural : {}
    const src = imageSource(value.src)

    return src ? { kind: 'image', src, natural: { width: num(natural.width, 0, 0, 1_000_000), height: num(natural.height, 0, 0, 1_000_000) } } : null
  }

  return null
}

function slide(value: unknown): Slide | null {
  if (!isObject(value)) {
    return null
  }

  const seen = new Set<string>()
  const elements = list(value.elements, 5000)
    .map(element)
    .filter((entry): entry is SlideElement => entry !== null)
    .map((entry) => {
      // Ids name elements in commands and selections, so each must be unique on its slide.
      const unique = seen.has(entry.id) ? { ...entry, id: newId(entry.kind) } : entry
      seen.add(unique.id)

      return unique
    })

  return {
    id: str(value.id, '', 80).replace(/[^\w-]/g, '') || newId('slide'),
    layout: oneOf(value.layout, LAYOUTS, 'blank'),
    background: background(value.background),
    elements,
    notes: str(value.notes, '', 200_000),
    hidden: flag(value.hidden)
  }
}

/** A deck from untrusted data, whole and safe; throws when it is not a deck at all. */
export function normalizeDeck(value: unknown, title?: string): Deck {
  if (!isObject(value) || !Array.isArray(value.slides)) {
    throw new Error('This is not a Herald Slides deck')
  }

  const size = isObject(value.size) ? value.size : {}
  const seen = new Set<string>()
  const slides = list(value.slides, 5000)
    .map(slide)
    .filter((entry): entry is Slide => entry !== null)
    .map((entry) => {
      const unique = seen.has(entry.id) ? { ...entry, id: newId('slide') } : entry
      seen.add(unique.id)

      return unique
    })

  return {
    id: str(value.id, '', 80).replace(/[^\w-]/g, '') || newId('deck'),
    title: title ?? (str(value.title, 'Untitled', 500) || 'Untitled'),
    size: { width: num(size.width, SLIDE_SIZES.wide.width, 72, 10_000), height: num(size.height, SLIDE_SIZES.wide.height, 72, 10_000) },
    theme: theme(value.theme),
    transition: oneOf(value.transition, TRANSITIONS, 'fade'),
    slides: slides.length ? slides : [{ id: newId('slide'), layout: 'blank', background: null, elements: [], notes: '', hidden: false }]
  }
}
