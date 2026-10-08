import type {
  Anchor,
  ArrowHead,
  AutoFit,
  Background,
  Color,
  Deck,
  Fill,
  FontRef,
  LayoutId,
  ListKind,
  RunStyle,
  ShapeKind,
  SlideElement,
  SlideSize,
  Stroke,
  TextAlign,
  TextBody,
  Theme,
  Transition
} from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { lineElement, shapeElement, textElement } from '../elements.ts'
import * as model from '../model.ts'
import type { DeckChange } from '../model.ts'
import { normalizeDeck } from '../normalize.ts'
import { startPresenting } from '../Present.tsx'
import { decks, slidesSession } from '../store.ts'
import { allRuns, effectiveStyle, paragraphsAll, styleAll, textBody, withParagraph } from '../text.ts'
import { $textSession, flushTyping, requestEditStart, textSessionOf } from './active.ts'
import { changeParagraphs, selectedParagraphs, shiftLevel, toggleList } from './tiptap.ts'

/*
 * What the menus, the formatting bar and the keyboard do to the deck in front. Each change is one
 * step (typing in progress is folded in first), and formatting goes to the selected text while
 * typing and to every selected box otherwise.
 */

/** The deck in front in this window. */
export const live = (): SlidesDocument | undefined => {
  const active = slidesSession.active()

  return active ? decks.get(active.key) : undefined
}

/** Make a change to the deck in front (or `doc`) as one step; nothing when it changes nothing. */
export function change(make: (deck: Deck, doc: SlidesDocument) => DeckChange | null | undefined, doc = live()): DeckChange | null {
  if (!doc) {
    return null
  }

  flushTyping(doc)
  const next = make(doc.history.present, doc)

  if (next && next.deck !== doc.history.present) {
    doc.commit(next)
  }

  return next ?? null
}

const editing = (doc = live()) => textSessionOf(doc)

/** Text and shape elements among the selection, which formatting applies to. */
const textTargets = (doc: SlidesDocument): (SlideElement & { body: TextBody })[] => doc.selection.filter((element): element is SlideElement & { body: TextBody } => element.kind === 'text' || element.kind === 'shape')

function changeBodies(label: string, edit: (body: TextBody) => TextBody, doc = live()): void {
  change((deck, d) => {
    const ids = textTargets(d).map((element) => element.id)

    return ids.length ? model.updateElements(deck, d.slideId, ids, (element) => (element.kind === 'text' || element.kind === 'shape' ? { ...element, body: edit(element.body) } : element), label) : null
  }, doc)
}

export const notify = (message: string): void => slidesSession.notify(message, 'error')

/** Present the deck in front, from the slide in front or from the start. */
export function present(fromStart: boolean): void {
  const active = slidesSession.active()
  const doc = live()

  if (active && doc) {
    flushTyping(doc)
    doc.edit(null)
    startPresenting(active.key, fromStart ? 0 : doc.index)
  }
}

export const newSlide = (layout: LayoutId = 'title-content') => change((deck, doc) => model.addSlide(deck, { layout, after: doc.slideId }))

export const duplicateSlides = () => change((deck, doc) => model.duplicateSlides(deck, doc.pickedSlides))

export const deleteSlides = () => change((deck, doc) => model.removeSlides(deck, doc.pickedSlides))

export function toggleHidden(): void {
  change((deck, doc) => {
    const picked = doc.pickedSlides
    const hide = !picked.every((id) => deck.slides.find((slide) => slide.id === id)?.hidden)

    return model.setHidden(deck, picked, hide)
  })
}

export function moveSlidesBy(by: number): void {
  change((deck, doc) => {
    const picked = doc.pickedSlides
    const first = deck.slides.findIndex((slide) => slide.id === picked[0])

    return model.moveSlides(deck, picked, Math.max(0, first + by))
  })
}

export const moveSlidesTo = (ids: string[], index: number) => change((deck) => model.moveSlides(deck, ids, index))

export const setLayout = (layout: LayoutId) => change((deck, doc) => model.setLayout(deck, doc.slideId, layout))

export const applyTheme = (theme: Theme | string) => change((deck) => model.applyTheme(deck, theme))

export const setBackground = (background: Background | null, all = false) => change((deck, doc) => model.setBackground(deck, all ? 'all' : doc.pickedSlides, background))

export const setSlideSize = (size: SlideSize) => change((deck) => model.setSize(deck, size))

export const setTransition = (transition: Transition) => change((deck) => model.setTransition(deck, transition))

/** A new text box in the middle of the slide, ready to type into. */
export function insertText(): void {
  const doc = live()

  if (!doc) {
    return
  }

  const { width, height } = doc.deck.size
  const element = textElement({ x: width / 2 - 180, y: height / 2 - 20, width: 360, height: 40 }, textBody({ font: '+body', size: 24, color: 'tx1' }, { fit: 'grow' }))
  change((deck) => model.insertElements(deck, doc.slideId, [element], 'New Text Box'), doc)
  requestEditStart({ elementId: element.id, select: 'end' })
  doc.edit(element.id)
}

export function insertShape(kind: ShapeKind): void {
  const doc = live()

  if (!doc) {
    return
  }

  const { width, height } = doc.deck.size
  const side = kind === 'rect' || kind === 'roundRect' || kind.includes('Arrow') || kind.includes('Callout') ? { w: 240, h: 150 } : { w: 180, h: 180 }
  const element = shapeElement(kind, { x: width / 2 - side.w / 2, y: height / 2 - side.h / 2, width: side.w, height: side.h })
  change((deck) => model.insertElements(deck, doc.slideId, [element], 'New Shape'), doc)
}

export function insertLine(end: ArrowHead = 'none'): void {
  const doc = live()

  if (!doc) {
    return
  }

  const { width, height } = doc.deck.size
  const element = lineElement([width / 2 - 140, height / 2], [width / 2 + 140, height / 2], { end })
  change((deck) => model.insertElements(deck, doc.slideId, [element], end === 'none' ? 'New Line' : 'New Arrow'), doc)
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif'])
const LONGEST_SIDE = 4096

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

/**
 * A picture file as image data PowerPoint takes (PNG, JPEG or GIF; other kinds become PNG) and its
 * size; very large pictures are scaled down to 4096 pixels on their longest side.
 */
export async function readPicture(file: Blob): Promise<{ src: string; natural: { width: number; height: number } }> {
  const bitmap = await createImageBitmap(file)

  try {
    const natural = { width: bitmap.width, height: bitmap.height }
    const scale = Math.min(1, LONGEST_SIDE / Math.max(natural.width, natural.height))

    if (IMAGE_TYPES.has(file.type) && scale === 1) {
      return { src: await readAsDataUrl(file), natural }
    }

    const width = Math.max(1, Math.round(natural.width * scale))
    const height = Math.max(1, Math.round(natural.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'

    return { src: await readAsDataUrl(await canvas.convertToBlob({ type, quality: 0.9 })), natural: { width, height } }
  } finally {
    bitmap.close()
  }
}

/** Pictures put on the slide in front, centred on `at` (points) when given. */
export async function insertPictures(files: readonly Blob[], at?: [number, number], doc = live()): Promise<void> {
  if (!doc) {
    return
  }

  for (const [index, file] of files.entries()) {
    try {
      const picture = await readPicture(file)
      const slideId = doc.slideId
      change((deck) => {
        const placed = model.addImage(deck, slideId, { src: picture.src, natural: picture.natural })

        if (!at) {
          return placed
        }

        const element = placed.deck.slides.find((slide) => slide.id === slideId)?.elements.find((entry) => entry.id === placed.elementId)

        return element ? model.updateElements(placed.deck, slideId, [element.id], (entry) => ({ ...entry, x: at[0] - entry.width / 2 + index * 16, y: at[1] - entry.height / 2 + index * 16 }), placed.label) : placed
      }, doc)
    } catch {
      slidesSession.notify('Herald Slides could not read that picture', 'error')
    }
  }
}

let picker: HTMLInputElement | null = null

/** Ask for picture files, then put them on the slide (into an empty picture placeholder first). */
export function pickPictures(doc = live()): void {
  picker ??= Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml', multiple: true })
  picker.onchange = () => {
    const files = [...(picker?.files ?? [])]
    picker!.value = ''
    void insertPictures(files, undefined, doc)
  }
  picker.click()
}

export const deleteSelection = () => change((deck, doc) => (doc.selected.length ? model.removeElements(deck, doc.slideId, doc.selected) : null))

export const duplicateSelection = () => change((deck, doc) => (doc.selected.length ? model.duplicateElements(deck, doc.slideId, doc.selected) : null))

export function selectAll(): void {
  const doc = live()
  doc?.select(doc.slide.elements.map((element) => element.id))
}

export const arrange = (how: model.Arrangement) => change((deck, doc) => (doc.selected.length ? model.arrange(deck, doc.slideId, doc.selected, how) : null))

export const alignSelection = (edge: model.AlignEdge) => change((deck, doc) => (doc.selected.length ? model.align(deck, doc.slideId, doc.selected, edge) : null))

export const distributeSelection = (axis: 'horizontal' | 'vertical') => change((deck, doc) => (doc.selected.length > 2 ? model.distribute(deck, doc.slideId, doc.selected, axis) : null))

export const nudgeSelection = (dx: number, dy: number) => change((deck, doc) => (doc.selected.length ? model.nudge(deck, doc.slideId, doc.selected, dx, dy) : null))

/** Start typing into the selected text box or shape. */
export function editSelection(select: 'end' | 'all' = 'end'): void {
  const doc = live()
  const [only] = doc?.selection ?? []

  if (doc && only && doc.selected.length === 1 && (only.kind === 'text' || only.kind === 'shape')) {
    requestEditStart({ elementId: only.id, select })
    doc.edit(only.id)
  }
}

export const changeSelected = (label: string, edit: (element: SlideElement) => SlideElement) => change((deck, doc) => (doc.selected.length ? model.updateElements(deck, doc.slideId, doc.selected, edit, label) : null))

export const setFill = (fill: Fill | null) => changeSelected('Fill', (element) => (element.kind === 'shape' || element.kind === 'text' ? { ...element, fill } : element))

/** The outline of shapes, text boxes and pictures, and the stroke of lines (which always have one). */
export function setStroke(patch: Partial<Stroke> | null): void {
  changeSelected('Outline', (element) => {
    if (element.kind === 'line') {
      return patch ? { ...element, stroke: { ...element.stroke, ...patch } } : element
    }

    const base: Stroke = element.stroke ?? { color: 'tx1', width: 1, dash: 'solid' }

    return { ...element, stroke: patch ? { ...base, ...patch } : null }
  })
}

export const setArrowHeads = (patch: { start?: ArrowHead; end?: ArrowHead }) => changeSelected('Arrows', (element) => (element.kind === 'line' ? { ...element, ...patch } : element))

export const setShapeKind = (shape: ShapeKind) => changeSelected('Change Shape', (element) => (element.kind === 'shape' ? { ...element, shape, adjust: undefined } : element))

export const resetCrop = () => changeSelected('Reset Crop', (element) => (element.kind === 'image' ? { ...element, crop: undefined } : element))

export const setAlt = (alt: string) => changeSelected('Description', (element) => (element.kind === 'image' ? { ...element, alt } : element))

export type Switch = 'bold' | 'italic' | 'underline' | 'strike'

const SWITCH_LABELS: Record<Switch, string> = { bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough' }

export function toggleSwitch(key: Switch): void {
  const session = editing()

  if (session) {
    session.editor.chain().focus().toggleMark(key).run()

    return
  }

  const doc = live()

  if (!doc) {
    return
  }

  const on = !textTargets(doc).every((element) => allRuns(element.body, key, true))
  changeBodies(SWITCH_LABELS[key], (body) => styleAll(body, { [key]: on }), doc)
}

const RUN_LABELS: Record<keyof RunStyle, string> = { font: 'Font', size: 'Text Size', color: 'Text Colour', highlight: 'Highlight', bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough' }

/** A font, size, colour or highlight for the selected text (`null` takes it back to the box's own). */
export function setRunStyle(patch: { font?: FontRef | null; size?: number | null; color?: Color | null; highlight?: Color | null }): void {
  const session = editing()
  const key = Object.keys(patch)[0] as keyof RunStyle

  if (session) {
    const chain = session.editor.chain().focus().setMark('textStyle', patch)
    const clears = Object.values(patch).some((value) => value === null)
    ;(clears ? chain.removeEmptyTextStyle() : chain).run()

    return
  }

  changeBodies(RUN_LABELS[key] ?? 'Text', (body) => {
    const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)) as RunStyle
    const cleared = (Object.keys(patch) as (keyof RunStyle)[]).filter((name) => patch[name as keyof typeof patch] === null)
    const next = styleAll(body, set)

    if (!cleared.length) {
      return next
    }

    const style = { ...next.style }

    // Only a highlight can leave the box's own style; the others go back to it.
    if (cleared.includes('highlight')) {
      delete style.highlight
    }

    return {
      ...next,
      style,
      paragraphs: next.paragraphs.map((paragraph) => ({
        ...paragraph,
        runs: paragraph.runs.map((run) => {
          const plain = { ...run }

          for (const name of cleared) {
            delete plain[name]
          }

          return plain
        })
      }))
    }
  })
}

/** The text size one step up or down from the selection's. */
export function stepSize(direction: 1 | -1): void {
  const sizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96, 120, 144]
  const current = currentFormat().size
  const next = direction > 0 ? (sizes.find((size) => size > current + 0.01) ?? current + 12) : ([...sizes].reverse().find((size) => size < current - 0.01) ?? Math.max(1, current - 1))
  setRunStyle({ size: next })
}

export function setAlign(align: TextAlign): void {
  const session = editing()

  if (session) {
    changeParagraphs(session.editor, () => ({ align }))

    return
  }

  changeBodies('Align Text', (body) => paragraphsAll(body, { align }))
}

export function toggleListKind(kind: ListKind): void {
  const session = editing()

  if (session) {
    toggleList(session.editor, kind)

    return
  }

  const doc = live()

  if (!doc) {
    return
  }

  const all = textTargets(doc).every((element) => element.body.paragraphs.every((paragraph) => paragraph.list === kind))
  changeBodies(kind === 'bullet' ? 'Bullets' : 'Numbering', (body) => ({ ...body, paragraphs: body.paragraphs.map((paragraph) => withParagraph(paragraph, all ? { list: undefined, level: undefined } : { list: kind })) }), doc)
}

export function shiftLevels(by: 1 | -1): void {
  const session = editing()

  if (session) {
    shiftLevel(session.editor, by)

    return
  }

  changeBodies(by > 0 ? 'Increase Level' : 'Decrease Level', (body) => ({
    ...body,
    paragraphs: body.paragraphs.map((paragraph) => (paragraph.list ? withParagraph(paragraph, { level: Math.max(0, Math.min(8, (paragraph.level ?? 0) + by)), bullet: undefined, numbering: undefined }) : paragraph))
  }))
}

export function setLineSpacing(lineSpacing: number): void {
  const session = editing()

  if (session) {
    changeParagraphs(session.editor, () => ({ lineSpacing: lineSpacing === 1 ? null : lineSpacing }))

    return
  }

  changeBodies('Line Spacing', (body) => paragraphsAll(body, { lineSpacing: lineSpacing === 1 ? undefined : lineSpacing }))
}

export const setAnchor = (anchor: Anchor) => changeBodies('Text Position', (body) => ({ ...body, anchor }))

export const setAutoFit = (fit: AutoFit) => changeBodies('Autofit', (body) => ({ ...body, fit }))

export interface Format {
  font: FontRef
  size: number
  color: Color
  highlight: Color | null
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  align: TextAlign
  list: ListKind | null
  lineSpacing: number
}

/** The formatting of the text being edited at its selection, or of the first selected box. */
export function currentFormat(doc = live()): Format {
  const session = textSessionOf(doc)
  const element = doc?.selection.find((entry): entry is SlideElement & { body: TextBody } => entry.kind === 'text' || entry.kind === 'shape')
  const body = element?.body ?? textBody({ font: '+body', size: 18, color: 'tx1' })

  if (session) {
    const { editor } = session
    const style = editor.getAttributes('textStyle')
    const paragraph = selectedParagraphs(editor)[0]?.node.attrs ?? {}

    return {
      font: style.font ?? body.style.font,
      size: Number(style.size ?? body.style.size),
      color: style.color ?? body.style.color,
      highlight: style.highlight ?? null,
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      align: paragraph.align ?? 'left',
      list: paragraph.list ?? null,
      lineSpacing: Number(paragraph.lineSpacing ?? 1)
    }
  }

  const first = body.paragraphs[0]
  const run = effectiveStyle(first?.runs[0] ?? {}, body)

  return {
    font: run.font,
    size: run.size,
    color: run.color,
    highlight: run.highlight ?? null,
    bold: allRuns(body, 'bold', true),
    italic: allRuns(body, 'italic', true),
    underline: allRuns(body, 'underline', true),
    strike: allRuns(body, 'strike', true),
    align: first?.align ?? 'left',
    list: first?.list ?? null,
    lineSpacing: first?.lineSpacing ?? 1
  }
}

/** Whether text formatting has anything to work on. */
export const canFormatText = (doc = live()): boolean => Boolean($textSession.get()?.doc === doc && doc) || Boolean(doc && textTargets(doc).length)

const CLIPBOARD_TYPE = 'application/x-herald-slides'

/** The selection on the clipboard: Herald's own copy, and its words as text for other apps. */
export function copySelection(data: DataTransfer, doc = live()): boolean {
  const chosen = doc?.selection ?? []

  if (!chosen.length) {
    return false
  }

  data.setData(CLIPBOARD_TYPE, JSON.stringify({ elements: chosen }))
  data.setData('text/plain', chosen.map((element) => (element.kind === 'text' || element.kind === 'shape' ? element.body.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join('')).join('\n') : '')).filter(Boolean).join('\n\n'))

  return true
}

/** Copy (or cut) the selection from a menu: the copy event goes to the page, whatever has focus. */
export function copyToClipboard(cut = false, doc = live()): void {
  const onCopy = (event: ClipboardEvent) => {
    if (event.clipboardData && copySelection(event.clipboardData, doc)) {
      event.preventDefault()

      if (cut) {
        deleteSelection()
      }
    }
  }

  document.addEventListener('copy', onCopy, { once: true, capture: true })
  document.execCommand('copy')
  document.removeEventListener('copy', onCopy, { capture: true })
}

/** Elements copied from Herald Slides, made safe. */
export function clipboardElements(text: string): SlideElement[] {
  try {
    const parsed = JSON.parse(text) as { elements?: unknown }

    return normalizeDeck({ slides: [{ elements: parsed.elements }] }).slides[0].elements
  } catch {
    return []
  }
}

/** Paste what the clipboard holds: Herald's own elements, pictures, or text as a new text box. */
export async function pasteFrom(data: DataTransfer, doc = live()): Promise<boolean> {
  if (!doc) {
    return false
  }

  const own = data.getData(CLIPBOARD_TYPE)

  if (own) {
    const elements = clipboardElements(own)
    const onSlide = new Set(doc.slide.elements.map((element) => element.id))
    const offset = elements.some((element) => onSlide.has(element.id)) ? 12 : 0

    change((deck) => (elements.length ? model.pasteElements(deck, doc.slideId, elements, offset) : null), doc)

    return elements.length > 0
  }

  const pictures = [...data.files].filter((file) => file.type.startsWith('image/'))

  if (pictures.length) {
    await insertPictures(pictures, undefined, doc)

    return true
  }

  const text = data.getData('text/plain').trim()

  if (text) {
    change((deck) => model.addText(deck, doc.slideId, { text }), doc)

    return true
  }

  return false
}
