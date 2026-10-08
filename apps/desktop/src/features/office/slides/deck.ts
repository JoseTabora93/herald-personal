/*
 * Herald Slides' deck: slides holding text boxes, shapes, lines and pictures on a page measured in
 * points, as PowerPoint measures its slides (16:9 is 960 by 540, 4:3 is 720 by 540), so every
 * position is a whole number of EMU (12,700 a point) in a PowerPoint file. A deck is plain data,
 * replaced on every change, so undo is a step back to an earlier deck. Colours either name one of
 * the theme's slots or are literal, and fonts either name the theme's heading or body font or a
 * family: a new theme repaints whatever names a slot or a theme font, and leaves the rest alone.
 */

export const EMU_PER_POINT = 12700

export interface SlideSize {
  width: number
  height: number
}

export const SLIDE_SIZES = { wide: { width: 960, height: 540 }, standard: { width: 720, height: 540 } } as const satisfies Record<string, SlideSize>

export type SizeName = keyof typeof SLIDE_SIZES

export const SLOTS = ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'] as const

/** A theme colour: backgrounds and text (light and dark pairs, as in PowerPoint) and six accents. */
export type Slot = (typeof SLOTS)[number]

/** A theme slot, or a literal `#rrggbb`. */
export type Color = Slot | `#${string}`

export interface Theme {
  id: string
  name: string
  colors: Record<Slot, string>
  fonts: { heading: string; body: string }
}

/** `+heading` and `+body` stand for the theme's fonts; anything else is a family. */
export type FontRef = '+heading' | '+body' | (string & {})

export interface RunStyle {
  font?: FontRef
  /** Points. */
  size?: number
  color?: Color
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  highlight?: Color
}

export interface TextRun extends RunStyle {
  /** A `\n` is a line break inside the paragraph. */
  text: string
}

export type ListKind = 'bullet' | 'number'

export const NUMBER_STYLES = ['arabicPeriod', 'arabicParenR', 'alphaLcPeriod', 'alphaUcPeriod', 'alphaLcParenR', 'romanLcPeriod', 'romanUcPeriod'] as const

export type NumberStyle = (typeof NUMBER_STYLES)[number]

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

export interface Paragraph {
  runs: TextRun[]
  align?: TextAlign
  list?: ListKind
  /** 0 to 8. */
  level?: number
  /** The bullet's glyph (bullets only). */
  bullet?: string
  numbering?: NumberStyle
  startAt?: number
  /** A multiple of single spacing. */
  lineSpacing?: number
  /** Points. */
  spaceBefore?: number
  spaceAfter?: number
  /** The text's left margin and the first line's indent in points, where a file set them apart from the level's. */
  margin?: number
  indent?: number
}

export type Anchor = 'top' | 'middle' | 'bottom'

/** `shrink` makes text smaller to fit its box; `grow` makes the box as tall as its text. */
export type AutoFit = 'none' | 'shrink' | 'grow'

export interface BodyStyle extends RunStyle {
  font: FontRef
  size: number
  color: Color
}

export interface TextBody {
  paragraphs: Paragraph[]
  /** What a run has where it says nothing itself. */
  style: BodyStyle
  anchor: Anchor
  /** Left, top, right and bottom, in points. */
  inset: [number, number, number, number]
  fit: AutoFit
  wrap: boolean
}

export type PlaceholderRole = 'title' | 'subtitle' | 'body' | 'heading' | 'caption' | 'picture'

export interface Placeholder {
  role: PlaceholderRole
  /** Shown while it is empty ("Click to add title"); never presented, printed or saved as text. */
  prompt: string
}

/** An element's box before rotation, in points from the slide's top left. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface Frame extends Box {
  id: string
  /** Degrees clockwise about the box's centre. */
  rotation: number
  flipH?: boolean
  flipV?: boolean
  name?: string
  placeholder?: Placeholder
}

export interface Fill {
  color: Color
  /** 0 (clear) to 1 (solid). */
  alpha?: number
}

export const DASHES = ['solid', 'dash', 'dot', 'dashDot', 'longDash'] as const

export type Dash = (typeof DASHES)[number]

export interface Stroke {
  color: Color
  /** Points. */
  width: number
  dash: Dash
  alpha?: number
}

export const ARROW_HEADS = ['none', 'triangle', 'arrow', 'stealth', 'oval', 'diamond'] as const

export type ArrowHead = (typeof ARROW_HEADS)[number]

/** DrawingML's preset names, so a file keeps the very shape. */
export const SHAPE_KINDS = [
  'rect',
  'roundRect',
  'ellipse',
  'triangle',
  'rtTriangle',
  'diamond',
  'parallelogram',
  'trapezoid',
  'pentagon',
  'hexagon',
  'octagon',
  'plus',
  'star5',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow',
  'leftRightArrow',
  'chevron',
  'homePlate',
  'wedgeRectCallout',
  'wedgeRoundRectCallout'
] as const

export type ShapeKind = (typeof SHAPE_KINDS)[number]

/** How much of a picture is cut off at each side, as fractions of it. */
export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

export interface TextElement extends Frame {
  kind: 'text'
  body: TextBody
  fill: Fill | null
  stroke: Stroke | null
}

export interface ShapeElement extends Frame {
  kind: 'shape'
  shape: ShapeKind
  fill: Fill | null
  stroke: Stroke | null
  body: TextBody
  /** DrawingML's adjust values by guide name (`adj`, `adj1`…), where they differ from the preset's. */
  adjust?: Record<string, number>
}

export interface ImageElement extends Frame {
  kind: 'image'
  /** A data URL. */
  src: string
  /** The picture's own size in pixels. */
  natural: { width: number; height: number }
  crop?: Crop
  alt?: string
  stroke: Stroke | null
}

/** A straight line across its box: from the top left to the bottom right, unless flipped. */
export interface LineElement extends Frame {
  kind: 'line'
  stroke: Stroke
  /** The ends at the line's start and at its end. */
  start: ArrowHead
  end: ArrowHead
}

export type SlideElement = TextElement | ShapeElement | ImageElement | LineElement

export type ElementKind = SlideElement['kind']

export interface GradientStop {
  /** 0 to 1 along the gradient. */
  at: number
  color: Color
}

export type Background =
  | { kind: 'solid'; color: Color }
  /** `angle` in degrees: 0 runs left to right, 90 top to bottom. */
  | { kind: 'gradient'; stops: GradientStop[]; angle: number }
  | { kind: 'image'; src: string; natural: { width: number; height: number } }

export const LAYOUTS = ['title', 'title-content', 'two-content', 'section', 'title-only', 'blank', 'picture-caption', 'comparison'] as const

export type LayoutId = (typeof LAYOUTS)[number]

export interface Slide {
  id: string
  layout: LayoutId
  /** Null: the theme's background. */
  background: Background | null
  elements: SlideElement[]
  notes: string
  hidden: boolean
}

export const TRANSITIONS = ['none', 'fade', 'push'] as const

export type Transition = (typeof TRANSITIONS)[number]

export interface Deck {
  id: string
  title: string
  size: SlideSize
  theme: Theme
  /** How one slide gives way to the next when presenting. */
  transition: Transition
  slides: Slide[]
}

let counter = 0

export const newId = (prefix: string): string => `${prefix}-${(++counter).toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** The smallest side a box keeps, in points (a line may be flat). */
export const MIN_SIDE = 4

export const findSlide = (deck: Deck, slideId: string | null | undefined): Slide | undefined => deck.slides.find((slide) => slide.id === slideId)

export const findElement = (slide: Slide | undefined, elementId: string | null | undefined): SlideElement | undefined => slide?.elements.find((element) => element.id === elementId)

export const withSlide = (deck: Deck, slideId: string, change: (slide: Slide) => Slide): Deck => ({ ...deck, slides: deck.slides.map((slide) => (slide.id === slideId ? change(slide) : slide)) })

export const withElements = (deck: Deck, slideId: string, ids: ReadonlySet<string>, change: (element: SlideElement) => SlideElement): Deck =>
  withSlide(deck, slideId, (slide) => ({ ...slide, elements: slide.elements.map((element) => (ids.has(element.id) ? change(element) : element)) }))

/** Undo and redo over whole decks, each step with the name the Edit menu shows. */
export class DeckHistory {
  private past: { deck: Deck; label: string }[] = []
  private future: { deck: Deck; label: string }[] = []
  /** The last step, while later changes may still join it (typing notes, nudging). */
  private joinable: { key: string; at: number } | null = null

  constructor(
    public present: Deck,
    private readonly limit = 200
  ) {}

  /**
   * Make `next` the present deck as one step. A change with the same `join` key as the step before
   * it, within a couple of seconds, becomes part of that step.
   */
  commit(next: Deck, label: string, join?: string, now = Date.now()): void {
    if (next === this.present) {
      return
    }

    if (join && this.joinable?.key === join && now - this.joinable.at < 2000 && this.past.length) {
      this.present = next
      this.future = []
      this.joinable.at = now

      return
    }

    this.past.push({ deck: this.present, label })
    this.past.splice(0, Math.max(0, this.past.length - this.limit))
    this.future = []
    this.present = next
    this.joinable = join ? { key: join, at: now } : null
  }

  /** Start over from `deck` (a version loaded from disk). */
  reset(deck: Deck): void {
    this.past = []
    this.future = []
    this.present = deck
    this.joinable = null
  }

  undo(): string | null {
    const step = this.past.pop()

    if (!step) {
      return null
    }

    this.future.push({ deck: this.present, label: step.label })
    this.present = step.deck
    this.joinable = null

    return step.label
  }

  redo(): string | null {
    const step = this.future.pop()

    if (!step) {
      return null
    }

    this.past.push({ deck: this.present, label: step.label })
    this.present = step.deck
    this.joinable = null

    return step.label
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null
  }
}
