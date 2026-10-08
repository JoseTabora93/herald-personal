import type { Anchor, BodyStyle, Box, LayoutId, Paragraph, PlaceholderRole, Slide, SlideElement, SlideSize, TextAlign } from './deck.ts'
import { newId, SLIDE_SIZES } from './deck.ts'
import { imageElement, textElement } from './elements.ts'
import { isBlank, textBody } from './text.ts'

/*
 * The slide layouts: where each placeholder sits and how its text looks, laid out on a 16:9 slide
 * of 960 by 540 points and stretched across for other widths. A slide keeps the layout it was made
 * from, so a PowerPoint file gets a layout for each and changing layout moves text into its place.
 */

export const LAYOUT_NAMES: Record<LayoutId, string> = {
  title: 'Title',
  'title-content': 'Title and Content',
  'two-content': 'Two Content',
  section: 'Section Header',
  'title-only': 'Title Only',
  blank: 'Blank',
  'picture-caption': 'Picture with Caption',
  comparison: 'Comparison'
}

export const PROMPTS: Record<PlaceholderRole, string> = {
  title: 'Click to add title',
  subtitle: 'Click to add subtitle',
  body: 'Click to add text',
  heading: 'Click to add heading',
  caption: 'Click to add text',
  picture: 'Click to add a picture'
}

export interface PlaceholderSpec {
  role: PlaceholderRole
  box: Box
  style: BodyStyle
  anchor: Anchor
  align: TextAlign
  paragraph?: Omit<Paragraph, 'runs'>
}

const BASE = SLIDE_SIZES.wide

const title = (box: Box, size = 40, anchor: Anchor = 'middle', align: TextAlign = 'left'): PlaceholderSpec => ({ role: 'title', box, style: { font: '+heading', size, color: 'tx1' }, anchor, align })
const body = (box: Box, size = 24, role: PlaceholderRole = 'body'): PlaceholderSpec => ({ role, box, style: { font: '+body', size, color: 'tx1' }, anchor: 'top', align: 'left', paragraph: { list: 'bullet', spaceAfter: 6 } })
const subtitle = (box: Box, size: number, align: TextAlign): PlaceholderSpec => ({ role: 'subtitle', box, style: { font: '+body', size, color: 'tx2' }, anchor: 'top', align })
const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height })

const SPECS: Record<LayoutId, PlaceholderSpec[]> = {
  title: [title(box(80, 150, 800, 130), 54, 'bottom', 'center'), subtitle(box(80, 292, 800, 80), 24, 'center')],
  'title-content': [title(box(60, 36, 840, 84)), body(box(60, 136, 840, 364))],
  'two-content': [title(box(60, 36, 840, 84)), body(box(60, 136, 408, 364), 22), body(box(492, 136, 408, 364), 22)],
  section: [title(box(66, 150, 828, 150), 48, 'bottom'), subtitle(box(66, 312, 828, 72), 22, 'left')],
  'title-only': [title(box(60, 36, 840, 84))],
  blank: [],
  'picture-caption': [
    title(box(66, 48, 316, 120), 28, 'bottom'),
    { role: 'picture', box: box(418, 48, 476, 444), style: { font: '+body', size: 18, color: 'tx1' }, anchor: 'top', align: 'left' },
    { role: 'caption', box: box(66, 180, 316, 312), style: { font: '+body', size: 16, color: 'tx2' }, anchor: 'top', align: 'left', paragraph: { spaceAfter: 6 } }
  ],
  comparison: [
    title(box(60, 30, 840, 76)),
    { role: 'heading', box: box(60, 118, 408, 44), style: { font: '+body', size: 22, color: 'tx1', bold: true }, anchor: 'bottom', align: 'left' },
    body(box(60, 168, 408, 332), 20),
    { role: 'heading', box: box(492, 118, 408, 44), style: { font: '+body', size: 22, color: 'tx1', bold: true }, anchor: 'bottom', align: 'left' },
    body(box(492, 168, 408, 332), 20)
  ]
}

/** A layout's placeholders on a slide of `size`. */
export function layoutPlaceholders(layout: LayoutId, size: SlideSize = BASE): PlaceholderSpec[] {
  const sx = size.width / BASE.width
  const sy = size.height / BASE.height

  return SPECS[layout].map((spec) => ({ ...spec, box: { x: spec.box.x * sx, y: spec.box.y * sy, width: spec.box.width * sx, height: spec.box.height * sy } }))
}

/** An empty placeholder: a text box that shrinks its text to fit, or a frame waiting for a picture. */
export function placeholderElement(spec: PlaceholderSpec): SlideElement {
  const placeholder = { role: spec.role, prompt: PROMPTS[spec.role] }

  if (spec.role === 'picture') {
    return imageElement('', { width: 0, height: 0 }, spec.box, { placeholder })
  }

  return textElement(spec.box, textBody(spec.style, { anchor: spec.anchor, fit: 'shrink', paragraph: { align: spec.align, ...spec.paragraph } }), { placeholder })
}

export function newSlide(layout: LayoutId, size: SlideSize = BASE): Slide {
  return { id: newId('slide'), layout, background: null, elements: layoutPlaceholders(layout, size).map(placeholderElement), notes: '', hidden: false }
}

/** Whether an element still shows only its placeholder's prompt. */
export function isEmptyPlaceholder(element: SlideElement): boolean {
  if (!element.placeholder) {
    return false
  }

  if (element.kind === 'image') {
    return !element.src
  }

  return element.kind === 'text' || element.kind === 'shape' ? isBlank(element.body) : false
}

/**
 * A slide moved onto another layout: each new placeholder takes the content of the first unused
 * placeholder of the same role, in the new layout's place; content with no place of its own stays
 * where it was as an ordinary element, and empty placeholders with no place go.
 */
export function changeLayout(slide: Slide, layout: LayoutId, size: SlideSize = BASE): Slide {
  const old = slide.elements.filter((element) => element.placeholder)
  const used = new Set<string>()
  const placed: SlideElement[] = layoutPlaceholders(layout, size).map((spec) => {
    const match = old.find((element) => !used.has(element.id) && element.placeholder?.role === spec.role)

    if (!match) {
      return placeholderElement(spec)
    }

    used.add(match.id)

    return { ...match, ...spec.box, rotation: 0 } as SlideElement
  })
  const rest = slide.elements.flatMap((element): SlideElement[] => {
    if (!element.placeholder) {
      return [element]
    }

    if (used.has(element.id) || isEmptyPlaceholder(element)) {
      return []
    }

    const free = { ...element }
    delete free.placeholder

    return [free]
  })

  return { ...slide, layout, elements: [...placed, ...rest] }
}

/** The element a role's text goes into on a slide (the first such placeholder). */
export const placeholderFor = (slide: Slide, role: PlaceholderRole, nth = 0): SlideElement | undefined => slide.elements.filter((element) => element.placeholder?.role === role)[nth]
