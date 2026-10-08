import type JSZip from 'jszip'
import type { Anchor, ArrowHead, Background, BodyStyle, Box, Color, Crop, Dash, Deck, Fill, FontRef, LayoutId, NumberStyle, Paragraph, Placeholder, PlaceholderRole, ShapeKind, Slide, SlideElement, SlideSize, Slot, Stroke, TextAlign, TextBody, Theme, Transition } from '../deck.ts'
import { ARROW_HEADS, EMU_PER_POINT, LAYOUTS, newId, NUMBER_STYLES, SHAPE_KINDS, SLIDE_SIZES, SLOTS } from '../deck.ts'
import { imageElement, lineElement, type Point, rotatePoint, shapeElement, textElement } from '../elements.ts'
import { LAYOUT_NAMES, newSlide, PROMPTS } from '../layouts.ts'
import { bulletFor, isBlank, MAX_LEVEL, numberingFor, ownStyle, paragraphIndent, tidyRuns } from '../text.ts'
import { colorIn, isColorElement, OFFICE_SCHEME, type Paint, type Palette, readColorMap, readScheme, SCHEME_NAMES, themeColor } from './color.ts'
import { imageSize } from './image-size.ts'
import { placeholderNames } from './placeholders.ts'
import { count, drop, emptyReport, type ImportReport, type ReportKind } from './report.ts'
import { attr, child, childrenNamed, descendants, elements, find, flagAttr, numberAttr, parseXml, textOf, xml, type XmlElement } from './xml.ts'

/*
 * Reading a PowerPoint file (.pptx, and .pptm the same way) into a Herald deck. Parts are found
 * through their relationships, as PowerPoint finds them. Each slide's shapes are read back to front
 * with what their placeholders, layout, master and theme lend them, and become Herald's text boxes,
 * shapes, lines and pictures. What Herald has no element for is shown as the nearest thing it has
 * (a gradient as one colour, a group as its members) or left out, and the report counts every
 * element once, as kept, approximated or left out, with the reasons.
 */

/** How deep groups may nest before what is deeper is left out. */
const MAX_DEPTH = 32

/** Why elements are approximated or left out, as the report lists them. */
const WHY = {
  hidden: 'hidden objects left out',
  unreadable: 'objects that could not be read left out',
  grouped: 'grouped elements kept as separate elements',
  nested: 'groups nested too deeply left out',
  nearestShape: 'shapes Herald does not draw shown as the nearest shape it does',
  customShape: 'custom shapes drawn as rectangles',
  gradient: 'gradient fills shown as a solid colour',
  pattern: 'pattern fills shown as a solid colour',
  pictureShape: 'shapes filled with a picture shown as the picture',
  pictureFill: 'picture fills shown as a colour',
  effects: 'shadows and other effects left out',
  objectLinks: 'links on objects left out',
  lineText: 'text on lines left out',
  connectors: 'connectors drawn straight',
  customDash: 'custom dashes shown as plain dashes',
  links: 'links kept as plain text',
  scripts: 'superscript and subscript shown as ordinary text',
  capitals: 'all caps kept as capital letters',
  smallCapitals: 'small capitals shown as ordinary letters',
  vertical: 'vertical text shown horizontally',
  columns: 'text in columns shown as one column',
  turnedText: 'text turned inside its shape shown upright',
  wordArt: 'WordArt shown as plain text',
  exactSpacing: 'exact line spacing shown as a multiple',
  numbering: 'list numbers shown in the nearest style Herald has',
  pictureBullets: 'picture bullets shown as dots',
  pictureCut: 'pictures cut to shapes shown as rectangles',
  tiled: 'tiled pictures shown stretched',
  inset: 'pictures inset in their frames shown filling them',
  pictureEffects: 'picture colour effects left out',
  video: 'videos shown as their poster frame',
  sound: 'sounds left out',
  ole: 'embedded objects shown as their picture',
  format: 'pictures in formats Herald cannot show',
  missing: 'pictures missing from the file left out',
  linked: 'pictures linked from outside the file left out',
  tables: 'tables left out; they come in a later version',
  backgroundStretch: 'background pictures fill the slide without stretching',
  backgroundTiles: 'tiled backgrounds shown as one picture',
  radial: 'radial gradient backgrounds shown as linear ones',
  transitions: 'transitions (Herald uses one transition for the whole deck)'
} as const

const FILLS: ReadonlySet<string> = new Set(['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'])

const each = <T extends string>(value: T, keys: string): Record<string, T> => Object.fromEntries(keys.split(' ').map((key) => [key, value]))

/** Property children that stand in for each other (one fill, one bullet…), so a later layer's replaces an earlier one's. */
const GROUPS: Record<string, string> = {
  ...each('fill', [...FILLS].join(' ')),
  ...each('geometry', 'a:prstGeom a:custGeom'),
  ...each('dash', 'a:prstDash a:custDash'),
  ...each('join', 'a:round a:bevel a:miter'),
  ...each('autofit', 'a:noAutofit a:normAutofit a:spAutoFit'),
  ...each('effect', 'a:effectLst a:effectDag'),
  ...each('underline', 'a:uLnTx a:uLn'),
  ...each('underlineFill', 'a:uFillTx a:uFill'),
  ...each('bulletColor', 'a:buClrTx a:buClr'),
  ...each('bulletSize', 'a:buSzTx a:buSzPct a:buSzPts'),
  ...each('bulletFont', 'a:buFontTx a:buFont'),
  ...each('bullet', 'a:buNone a:buAutoNum a:buChar a:buBlip')
}

/** Presets Herald does not draw, by the shape of its own they look most like (anything else is a rectangle). */
const NEAREST: Record<string, ShapeKind> = {
  ...each('rect', 'flowChartProcess flowChartPredefinedProcess flowChartInternalStorage'),
  ...each('roundRect', 'flowChartAlternateProcess flowChartTerminator round1Rect round2SameRect round2DiagRect snipRoundRect snip1Rect snip2SameRect snip2DiagRect plaque'),
  ...each('diamond', 'flowChartDecision flowChartSort'),
  ...each('ellipse', 'flowChartConnector flowChartOr flowChartSummingJunction donut heptagon decagon dodecagon cloud pie chord teardrop smileyFace noSmoking blockArc'),
  ...each('star5', 'star4 star6 star7 star8 star10 star12 star16 star24 star32 irregularSeal1 irregularSeal2'),
  ...each(
    'wedgeRoundRectCallout',
    'wedgeEllipseCallout cloudCallout callout1 callout2 callout3 accentCallout1 accentCallout2 accentCallout3 borderCallout1 borderCallout2 borderCallout3 accentBorderCallout1 accentBorderCallout2 accentBorderCallout3'
  ),
  ...each('rightArrow', 'notchedRightArrow stripedRightArrow rightArrowCallout curvedRightArrow bentArrow'),
  ...each('leftArrow', 'leftArrowCallout curvedLeftArrow'),
  ...each('upArrow', 'upArrowCallout curvedUpArrow bentUpArrow'),
  ...each('downArrow', 'downArrowCallout curvedDownArrow'),
  ...each('leftRightArrow', 'leftRightArrowCallout'),
  ...each('parallelogram', 'flowChartInputOutput'),
  ...each('trapezoid', 'flowChartManualOperation nonIsoscelesTrapezoid'),
  ...each('hexagon', 'flowChartPreparation'),
  ...each('triangle', 'flowChartExtract'),
  ...each('plus', 'quadArrow mathPlus')
}

/** Presets drawn as a line from corner to corner of their box. */
const LINES: ReadonlySet<string> = new Set([
  'line',
  'lineInv',
  'straightConnector1',
  'bentConnector2',
  'bentConnector3',
  'bentConnector4',
  'bentConnector5',
  'curvedConnector2',
  'curvedConnector3',
  'curvedConnector4',
  'curvedConnector5'
])

const LAYOUT_TYPES: Record<string, LayoutId> = {
  ...each('title-content', 'obj tx objTx txAndObj objAndTx txAndChart chartAndTx txAndClipArt clipArtAndTx txAndMedia mediaAndTx objOverTx txOverObj objOnly tbl chart dgm vertTx vertTitleAndTx clipArtAndVertTx vertTitleAndTxOverChart'),
  ...each('two-content', 'twoObj twoColTx twoObjAndTx txAndTwoObj twoObjOverTx objAndTwoObj twoObjAndObj fourObj'),
  title: 'title',
  twoTxTwoObj: 'comparison',
  secHead: 'section',
  titleOnly: 'title-only',
  blank: 'blank',
  picTx: 'picture-caption'
}

/** Layouts by name, for layouts without a type: Herald's names (which the layouts it writes carry) and PowerPoint's own for its title slide. */
const LAYOUT_BY_NAME: Record<string, LayoutId> = { ...Object.fromEntries(LAYOUTS.map((id) => [LAYOUT_NAMES[id].toLowerCase(), id])), 'title slide': 'title' }

/** Placeholder types that hold a layout's content. */
const CONTENT: ReadonlySet<string> = new Set(['body', 'obj', 'chart', 'tbl', 'clipArt', 'dgm', 'media'])

/** Date, footer, slide number and header placeholders. */
const FOOTERS: ReadonlySet<string> = new Set(['dt', 'ftr', 'sldNum', 'hdr'])

/** What Herald's layouts call the body placeholders that PowerPoint's leave as plain text. */
const BODY_ROLES: Partial<Record<LayoutId, PlaceholderRole>> = { section: 'subtitle', comparison: 'heading', 'picture-caption': 'caption' }

const ALIGNS: Record<string, TextAlign> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', justLow: 'justify', dist: 'justify', thaiDist: 'justify' }

const ANCHORS: Record<string, Anchor> = { t: 'top', ctr: 'middle', b: 'bottom' }

/** PowerPoint's list numbering, as Herald's own styles or the nearest of them. */
const NUMBERINGS: Record<string, NumberStyle> = {
  ...Object.fromEntries(NUMBER_STYLES.map((style) => [style, style])),
  alphaLcParenBoth: 'alphaLcParenR',
  alphaUcParenR: 'alphaUcPeriod',
  alphaUcParenBoth: 'alphaUcPeriod',
  arabicParenBoth: 'arabicParenR',
  romanLcParenR: 'romanLcPeriod',
  romanLcParenBoth: 'romanLcPeriod',
  romanUcParenR: 'romanUcPeriod',
  romanUcParenBoth: 'romanUcPeriod'
}

const DASH_PRESETS: Record<string, Dash> = {
  solid: 'solid',
  dash: 'dash',
  sysDash: 'dash',
  dot: 'dot',
  sysDot: 'dot',
  dashDot: 'dashDot',
  sysDashDot: 'dashDot',
  lgDashDot: 'dashDot',
  lgDashDotDot: 'dashDot',
  sysDashDotDot: 'dashDot',
  lgDash: 'longDash'
}

/** The bullets PowerPoint offers in Wingdings, as the characters they look like. */
const WINGDINGS: Record<string, string> = { '§': '▪', 'q': '❑', 'v': '❖', 'Ø': '➢', 'ü': '✓', 'l': '●', 'n': '■', 'u': '◆', 'Ÿ': '•', 'à': '➔' }

const SYMBOL_FONTS = /wingdings|webdings|symbol|marlett/i

/** Transitions that move the slide, which Herald's push stands for. */
const PUSHES: ReadonlySet<string> = new Set(['push', 'wipe', 'cover', 'pull', 'split', 'reveal', 'randomBar', 'strips', 'blinds', 'checker', 'comb', 'pan', 'conveyor', 'ferris', 'gallery', 'switch', 'flip', 'doors', 'window'])

/** Timing behaviours that animate something. */
const ANIMATIONS = ['p:anim', 'p:animClr', 'p:animEffect', 'p:animMotion', 'p:animRot', 'p:animScale', 'p:set', 'p:cmd']

const AUDIO = /\.(aac|aif|aiff|au|flac|m4a|mid|midi|mp3|oga|ogg|wav|wma)$/i

/** The main part's content types, presentations, shows and templates, with macros or without. */
const MAIN_TYPES = /presentationml\.(presentation|slideshow|template)\.main\+xml|powerpoint\.(presentation|slideshow|template|addin)\.macroEnabled\.main\+xml/

/** Shape tree children that are not shapes. */
const STRUCTURE: ReadonlySet<string> = new Set(['p:nvGrpSpPr', 'p:grpSpPr', 'p:extLst'])

const NODE_KINDS: Record<string, ReportKind> = { 'p:sp': 'shape', 'p:pic': 'picture', 'p:cxnSp': 'line', 'p:grpSp': 'group', 'p:contentPart': 'ink' }

const SOLID_PLACEHOLDER = xml('a:solidFill', {}, [xml('a:schemeClr', { val: 'phClr' })])

const THEME_LINE = xml('a:ln', { w: 12700 }, [SOLID_PLACEHOLDER])

const EMPTY_PARAGRAPH = xml('a:p')

/** A line with nothing to draw it with, kept so it can be given a colour. */
const UNSEEN: Stroke = { color: 'tx1', width: 0.75, dash: 'solid', alpha: 0 }

const round2 = (value: number): number => Math.round(value * 100) / 100 || 0

const pt = (emu: number): number => round2(emu / EMU_PER_POINT)

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

function degrees(value: number): number {
  const turned = round2(((value % 360) + 360) % 360)

  return turned === 360 ? 0 : turned
}

function remember<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let entry = cache.get(key)

  if (!entry) {
    entry = make()
    cache.set(key, entry)
  }

  return entry
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    // A structure too deep to walk counts as having nothing.
    return fallback
  }
}

interface Relationship {
  id: string
  /** The type URI's last segment, such as `slide`, `image` or `notesSlide`. */
  type: string
  /** The target's path in the zip, or its URL when it is outside the file. */
  target: string
  external: boolean
}

/** Where a relationship's target is in the zip: from its source part's folder, or from the root when it starts with `/`. */
function resolveTarget(source: string, target: string): string {
  const path = target.replace(/\\/g, '/')
  const parts = path.startsWith('/') ? [] : source.split('/').slice(0, -1)

  for (const piece of path.split('/')) {
    if (piece === '..') {
      parts.pop()
    } else if (piece && piece !== '.') {
      parts.push(piece)
    }
  }

  return parts.join('/')
}

function relationshipsPart(part: string): string {
  const slash = part.lastIndexOf('/')

  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

function readRelationships(root: XmlElement | undefined, part: string): Relationship[] {
  return childrenNamed(root, 'Relationship').flatMap((entry) => {
    const id = attr(entry, 'Id')
    const type = attr(entry, 'Type') ?? ''
    const target = attr(entry, 'Target')
    const external = attr(entry, 'TargetMode') === 'External'

    return id && target ? [{ id, type: type.slice(type.lastIndexOf('/') + 1), target: external ? target : resolveTarget(part, target), external }] : []
  })
}

const targetOf = (relationships: readonly Relationship[], type: string): string | undefined => relationships.find((entry) => entry.type === type && !entry.external)?.target

const byId = (relationships: readonly Relationship[], id: string | undefined): Relationship | undefined => (id ? relationships.find((entry) => entry.id === id) : undefined)

const partOf = (relationships: readonly Relationship[], id: string | undefined): string | undefined => {
  const relationship = byId(relationships, id)

  return relationship && !relationship.external ? relationship.target : undefined
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    // A `%` that starts no escape is part of the name.
    return path
  }
}

/** The zip's parts, each read and parsed once. */
class Package {
  private readonly parsed = new Map<string, Promise<XmlElement | undefined>>()
  private readonly related = new Map<string, Promise<Relationship[]>>()
  private lowerCase: Map<string, string> | null = null

  constructor(private readonly zip: JSZip) {}

  /** A file by its path, or by the same path URL-decoded or in other letter case (as some tools write names). */
  file(path: string): JSZip.JSZipObject | null {
    if (!path) {
      return null
    }

    const plain = decodePath(path)
    const exact = this.zip.file(path) ?? this.zip.file(plain)

    if (exact) {
      return exact
    }

    this.lowerCase ??= new Map(Object.keys(this.zip.files).map((name) => [name.toLowerCase(), name]))
    const name = this.lowerCase.get(path.toLowerCase()) ?? this.lowerCase.get(plain.toLowerCase())

    return name ? this.zip.file(name) : null
  }

  /** A part's XML, or nothing when it is missing or is not XML. */
  xml(path: string | undefined): Promise<XmlElement | undefined> {
    return path ? remember(this.parsed, path, () => this.parse(path)) : Promise.resolve(undefined)
  }

  /** A part's relationships with their targets resolved; none when it has no relationships part. */
  relationships(part: string): Promise<Relationship[]> {
    return remember(this.related, part, async () => readRelationships(await this.xml(relationshipsPart(part)), part))
  }

  private async parse(path: string): Promise<XmlElement | undefined> {
    const file = this.file(path)

    if (!file) {
      return undefined
    }

    try {
      return parseXml(await file.async('string'))
    } catch {
      return undefined
    }
  }
}

interface ThemeInfo {
  name: string
  scheme: Record<string, string>
  fonts: { heading: string; body: string }
  fills: XmlElement[]
  lines: XmlElement[]
  effects: XmlElement[]
  backgrounds: XmlElement[]
}

function readTheme(root: XmlElement | undefined): ThemeInfo {
  const parts = child(root, 'a:themeElements')
  const fonts = child(parts, 'a:fontScheme')
  const formats = child(parts, 'a:fmtScheme')

  return {
    name: attr(root, 'name') || 'Imported theme',
    scheme: readScheme(child(parts, 'a:clrScheme')),
    fonts: { heading: attr(find(fonts, 'a:majorFont/a:latin'), 'typeface') || 'Calibri', body: attr(find(fonts, 'a:minorFont/a:latin'), 'typeface') || 'Calibri' },
    fills: elements(child(formats, 'a:fillStyleLst')),
    lines: childrenNamed(child(formats, 'a:lnStyleLst'), 'a:ln'),
    effects: childrenNamed(child(formats, 'a:effectStyleLst'), 'a:effectStyle'),
    backgrounds: elements(child(formats, 'a:bgFillStyleLst'))
  }
}

const themeOf = (theme: ThemeInfo, slots: Record<Slot, string>): Theme => ({
  id: 'imported',
  name: theme.name,
  colors: Object.fromEntries(SLOTS.map((slot) => [slot, theme.scheme[slots[slot]] ?? OFFICE_SCHEME[slots[slot]] ?? '#000000'])) as Record<Slot, string>,
  fonts: { ...theme.fonts }
})

/** A shape tree's children, with markup-compatibility choices made: the fallback where there is one, else the first choice. */
function treeChildren(tree: XmlElement | undefined, depth = 0): XmlElement[] {
  return elements(tree).flatMap((node) => (node.name !== 'mc:AlternateContent' ? [node] : depth < MAX_DEPTH ? treeChildren(child(node, 'mc:Fallback') ?? child(node, 'mc:Choice'), depth + 1) : []))
}

/** The element holding a shape's non-visual properties (`p:nvSpPr`, `p:nvPicPr`…). */
const nonVisual = (node: XmlElement): XmlElement | undefined => elements(node).find((entry) => entry.name.startsWith('p:nv'))

interface PlaceholderShape {
  element: XmlElement
  ph: XmlElement
  type: string
  idx: number
}

function placeholdersOf(root: XmlElement | undefined): PlaceholderShape[] {
  return treeChildren(find(root, 'p:cSld/p:spTree')).flatMap((element) => {
    const ph = find(nonVisual(element), 'p:nvPr/p:ph')

    return ph ? [{ element, ph, type: attr(ph, 'type') ?? 'obj', idx: numberAttr(ph, 'idx', 0) }] : []
  })
}

type TextKind = 'title' | 'body' | 'other'

interface Fonts {
  heading: FontRef
  body: FontRef
}

const THEME_FONTS: Fonts = { heading: '+heading', body: '+body' }

/** The scheme colours the deck theme's slots can hold: all but the two link colours. */
const SLOT_COLORS = SCHEME_NAMES.filter((name) => name !== 'hlink' && name !== 'folHlink')

interface Master {
  path: string
  root: XmlElement | undefined
  relationships: Relationship[]
  theme: ThemeInfo
  map: Record<string, string>
  /** Whether its colours are the deck theme's, so theme colours stay slots. */
  slots: boolean
  fonts: Fonts
  placeholders: PlaceholderShape[]
  styles: Record<TextKind, XmlElement | undefined>
}

interface Layout {
  path: string
  root: XmlElement
  relationships: Relationship[]
  master: Master
  map: Record<string, string>
  placeholders: PlaceholderShape[]
  /** Whether the master's own shapes show on this layout's slides. */
  showsMaster: boolean
  id: LayoutId
  /** Known by its name alone, as the layouts Herald writes are (they number their placeholders from 100, in Herald's order). */
  named: boolean
}

type Loaded = { src: string; natural: { width: number; height: number } } | { reason: string }

interface Context {
  pkg: Package
  report: ImportReport
  size: SlideSize
  /** The presentation's default text style, under every other. */
  defaults: XmlElement | undefined
  /** The deck theme, from the first slide master's theme part. */
  theme: ThemeInfo
  /** The scheme colour each slot of the deck theme holds. */
  slots: Record<Slot, string>
  /** The first slide master, or a stand-in for a file without one. */
  first: Master
  masters: Map<string, Promise<Master | undefined>>
  layouts: Map<string, Promise<Layout | undefined>>
  pictures: Map<string, Promise<Loaded>>
  /** Masters and layouts whose shapes are counted already, and backgrounds whose approximations are. */
  counted: Set<string>
}

function masterOf(deck: ThemeInfo, path: string, root: XmlElement | undefined, relationships: Relationship[], theme: ThemeInfo): Master {
  const styles = child(root, 'p:txStyles')
  const sameFonts = theme.fonts.heading === deck.fonts.heading && theme.fonts.body === deck.fonts.body

  return {
    path,
    root,
    relationships,
    theme,
    map: readColorMap(child(root, 'p:clrMap')),
    slots: SLOT_COLORS.every((name) => theme.scheme[name] === deck.scheme[name]),
    fonts: sameFonts ? THEME_FONTS : theme.fonts,
    placeholders: placeholdersOf(root),
    styles: { title: child(styles, 'p:titleStyle'), body: child(styles, 'p:bodyStyle'), other: child(styles, 'p:otherStyle') }
  }
}

function masterAt(ctx: Context, path: string): Promise<Master | undefined> {
  return remember(ctx.masters, path, async () => {
    const root = await ctx.pkg.xml(path)

    if (root?.name !== 'p:sldMaster') {
      return undefined
    }

    const relationships = await ctx.pkg.relationships(path)
    const theme = await ctx.pkg.xml(targetOf(relationships, 'theme'))

    return masterOf(ctx.theme, path, root, relationships, theme ? readTheme(theme) : ctx.theme)
  })
}

/** A part's colour map: its own override over `base`, or `base`. */
function mapOver(root: XmlElement, base: Record<string, string>): Record<string, string> {
  const override = find(root, 'p:clrMapOvr/a:overrideClrMapping')

  return override ? readColorMap(override, base) : base
}

/** The Herald layout for a layout whose type and name do not say, by the placeholders it has. */
function layoutFrom(placeholders: readonly PlaceholderShape[]): LayoutId {
  const types = placeholders.map((entry) => entry.type)

  if (types.includes('ctrTitle')) {
    return 'title'
  }

  return types.some((entry) => CONTENT.has(entry)) ? 'title-content' : types.includes('title') ? 'title-only' : 'blank'
}

function layoutAt(ctx: Context, path: string): Promise<Layout | undefined> {
  return remember(ctx.layouts, path, async () => {
    const root = await ctx.pkg.xml(path)

    if (root?.name !== 'p:sldLayout') {
      return undefined
    }

    const relationships = await ctx.pkg.relationships(path)
    const masterPath = targetOf(relationships, 'slideMaster')
    const master = (masterPath ? await masterAt(ctx, masterPath) : undefined) ?? ctx.first
    const placeholders = placeholdersOf(root)
    const type = attr(root, 'type')
    const byType = type ? LAYOUT_TYPES[type] : undefined
    const byName = LAYOUT_BY_NAME[(attr(child(root, 'p:cSld'), 'name') ?? '').trim().toLowerCase()]

    return {
      path,
      root,
      relationships,
      master,
      map: mapOver(root, master.map),
      placeholders,
      showsMaster: flagAttr(root, 'showMasterSp') !== false,
      id: byType ?? byName ?? layoutFrom(placeholders),
      named: !byType && byName !== undefined
    }
  })
}

interface Scope {
  ctx: Context
  report: ImportReport
  /** The relationships of the part whose shapes these are, for its pictures. */
  relationships: Relationship[]
  palette: Palette
  fonts: Fonts
  /** Text's colour where nothing says: `tx1` under this colour map. */
  text: Color
  master: Master
  layout: Layout | undefined
  /** A slide's own shapes: placeholders are drawn, with what the layout and master lend them. */
  slide: boolean
  /** The slide's number, for slide number fields. */
  number: number
}

/**
 * Property elements laid over each other, the most general first: each later one's attributes win,
 * and so do its children, a group at a time (a fill replaces any fill, a bullet any bullet).
 */
function overlay(name: string, layers: readonly (XmlElement | undefined)[], skip?: string): XmlElement {
  const attrs: Record<string, string> = {}
  const parts = new Map<string, XmlElement>()

  for (const layer of layers) {
    if (!layer) {
      continue
    }

    Object.assign(attrs, layer.attrs)

    for (const node of elements(layer)) {
      if (node.name !== skip) {
        parts.set(GROUPS[node.name] ?? node.name, node)
      }
    }
  }

  return { name, attrs, children: [...parts.values()] }
}

/** A shape's properties over what its placeholders lend it, the outline merged attribute by attribute. */
function shapeProps(layers: readonly (XmlElement | undefined)[]): XmlElement {
  const props = overlay('p:spPr', layers)
  const lines = layers.map((layer) => child(layer, 'a:ln')).filter((line): line is XmlElement => line !== undefined)

  return lines.length > 1 ? { ...props, children: elements(props).map((node) => (node.name === 'a:ln' ? overlay('a:ln', lines) : node)) } : props
}

interface Placement {
  x: number
  y: number
  width: number
  height: number
  /** Degrees clockwise. */
  rotation: number
  flipH: boolean
  flipV: boolean
}

/** How a group places its members: from its own coordinates onto its parent's, in points. */
type Transform = (placement: Placement) => Placement

function placementOf(xfrm: XmlElement | undefined): Placement {
  const offset = child(xfrm, 'a:off')
  const extent = child(xfrm, 'a:ext')

  return {
    x: numberAttr(offset, 'x', 0) / EMU_PER_POINT,
    y: numberAttr(offset, 'y', 0) / EMU_PER_POINT,
    width: Math.max(0, numberAttr(extent, 'cx', 0)) / EMU_PER_POINT,
    height: Math.max(0, numberAttr(extent, 'cy', 0)) / EMU_PER_POINT,
    rotation: numberAttr(xfrm, 'rot', 0) / 60000,
    flipH: flagAttr(xfrm, 'flipH') ?? false,
    flipV: flagAttr(xfrm, 'flipV') ?? false
  }
}

/** A group's members' placement on its parent: scaled from the group's child space to its box, flipped, then turned about its centre. */
function groupTransform(xfrm: XmlElement | undefined): Transform {
  const outer = placementOf(xfrm)
  const origin = child(xfrm, 'a:chOff')
  const extent = child(xfrm, 'a:chExt')
  const left = origin ? numberAttr(origin, 'x', 0) / EMU_PER_POINT : outer.x
  const top = origin ? numberAttr(origin, 'y', 0) / EMU_PER_POINT : outer.y
  const width = extent ? numberAttr(extent, 'cx', 0) / EMU_PER_POINT : outer.width
  const height = extent ? numberAttr(extent, 'cy', 0) / EMU_PER_POINT : outer.height
  const sx = width > 0 ? outer.width / width : 1
  const sy = height > 0 ? outer.height / height : 1
  const middle: Point = [outer.x + outer.width / 2, outer.y + outer.height / 2]

  return (inner) => {
    // A member turned nearer a quarter turn than upright lies across the group's scaling.
    const across = Math.abs((((inner.rotation % 180) + 180) % 180) - 90) < 45
    const w = inner.width * (across ? sy : sx)
    const h = inner.height * (across ? sx : sy)
    let cx = outer.x + (inner.x + inner.width / 2 - left) * sx
    let cy = outer.y + (inner.y + inner.height / 2 - top) * sy
    let rotation = inner.rotation

    if (outer.flipH) {
      cx = 2 * middle[0] - cx
      rotation = -rotation
    }

    if (outer.flipV) {
      cy = 2 * middle[1] - cy
      rotation = -rotation
    }

    const [x, y] = rotatePoint([cx, cy], middle, outer.rotation)

    return { x: x - w / 2, y: y - h / 2, width: w, height: h, rotation: rotation + outer.rotation, flipH: inner.flipH !== outer.flipH, flipV: inner.flipV !== outer.flipV }
  }
}

/** A placement through its groups' transforms, the innermost first. */
const place = (placement: Placement, at: readonly Transform[]): Placement => at.reduceRight((inner, transform) => transform(inner), placement)

const boxOf = (placement: Placement): Box => ({ x: round2(placement.x), y: round2(placement.y), width: round2(placement.width), height: round2(placement.height) })

const nameOf = (info: XmlElement | undefined): { name?: string } => {
  const name = attr(info, 'name')

  return name ? { name } : {}
}

const frameOf = (placement: Placement, info: XmlElement | undefined): { rotation: number; flipH?: boolean; flipV?: boolean; name?: string } => ({
  rotation: degrees(placement.rotation),
  ...(placement.flipH ? { flipH: true } : {}),
  ...(placement.flipV ? { flipV: true } : {}),
  ...nameOf(info)
})

/** Count an element once: kept, or approximated with every reason it was. */
function tally(report: ImportReport, kind: ReportKind, issues: ReadonlySet<string>): void {
  const [first, ...rest] = issues

  count(report, kind, first ? 'approximated' : 'imported', first)

  for (const reason of rest) {
    report.reasons[reason] = (report.reasons[reason] ?? 0) + 1
  }
}

/** Add reasons to the report once for what they belong to (a background many slides share). */
function noteOnce(ctx: Context, key: string, reasons: ReadonlySet<string>): void {
  if (ctx.counted.has(key)) {
    return
  }

  ctx.counted.add(key)

  for (const reason of reasons) {
    ctx.report.reasons[reason] = (ctx.report.reasons[reason] ?? 0) + 1
  }
}

interface Inherited {
  layout: XmlElement | undefined
  master: XmlElement | undefined
  type: string
  /** The master text style the placeholder's text starts from. */
  text: TextKind
  role: PlaceholderRole | undefined
  prompt: string
}

const titleLike = (type: string): boolean => type === 'title' || type === 'ctrTitle'

/** The kind a master's placeholder answers for: titles for titles, footers for their own kind, the body for the rest. */
const kindOf = (type: string): string => (titleLike(type) ? 'title' : FOOTERS.has(type) ? type : 'body')

function matching(shapes: readonly PlaceholderShape[], type: string, idx: number | undefined): PlaceholderShape | undefined {
  const same = idx === undefined ? undefined : shapes.find((shape) => shape.idx === idx)

  return same ?? shapes.find((shape) => shape.type === type) ?? shapes.find((shape) => kindOf(shape.type) === kindOf(type))
}

function roleOf(type: string, layout: LayoutId | undefined): PlaceholderRole | undefined {
  if (titleLike(type)) {
    return 'title'
  }

  if (FOOTERS.has(type)) {
    return undefined
  }

  if (type === 'subTitle') {
    return 'subtitle'
  }

  if (type === 'pic') {
    return 'picture'
  }

  return type === 'body' ? (BODY_ROLES[layout ?? 'title-content'] ?? 'body') : 'body'
}

/** The role of a placeholder in a layout Herald wrote, which numbers its placeholders from 100 in its own layout's order. */
function writtenRole(layout: Layout | undefined, shape: PlaceholderShape | undefined): PlaceholderRole | undefined {
  if (!layout?.named || !shape || shape.idx < 100) {
    return undefined
  }

  return placeholderNames(layout.id)[shape.idx - 100]?.role
}

const paragraphText = (paragraph: XmlElement): string =>
  treeChildren(paragraph)
    .map((node) => (node.name === 'a:br' ? '\n' : node.name === 'a:r' || node.name === 'a:fld' ? textOf(child(node, 'a:t')) : ''))
    .join('')

/** A layout placeholder's own prompt, where it has one ("Insert the company's name"). */
function customPrompt(shape: PlaceholderShape | undefined): string | undefined {
  if (!shape || !flagAttr(shape.ph, 'hasCustomPrompt')) {
    return undefined
  }

  return childrenNamed(child(shape.element, 'p:txBody'), 'a:p').map(paragraphText).join('\n').trim() || undefined
}

/** What a slide placeholder takes from its layout's (matched by index, then type) and its master's (matched by kind). */
function inheritance(ph: XmlElement, scope: Scope): Inherited {
  const idx = attr(ph, 'idx') === undefined ? undefined : numberAttr(ph, 'idx', 0)
  const layout = scope.layout ? matching(scope.layout.placeholders, attr(ph, 'type') ?? 'obj', idx) : undefined
  const type = attr(ph, 'type') ?? layout?.type ?? 'obj'
  const master = matching(scope.master.placeholders, layout?.type ?? type, undefined)
  const role = FOOTERS.has(type) ? undefined : (writtenRole(scope.layout, layout) ?? roleOf(type, scope.layout?.id))

  return {
    layout: layout?.element,
    master: master?.element,
    type,
    text: titleLike(type) ? 'title' : FOOTERS.has(type) ? 'other' : 'body',
    role,
    prompt: role ? (customPrompt(layout) ?? PROMPTS[role]) : ''
  }
}

const alphaOf = (paint: Paint): { alpha?: number } => (paint.alpha < 1 ? { alpha: Math.round(paint.alpha * 1000) / 1000 } : {})

const fillOf = (paint: Paint | null): Fill | null => (paint ? { color: paint.color, ...alphaOf(paint) } : null)

/** A style reference's theme fill: `idx` 1 to 999 picks a fill style, 1001 on a background fill style, and 0 none. */
function themeFill(ref: XmlElement | undefined, theme: ThemeInfo): XmlElement | undefined {
  const idx = Math.round(numberAttr(ref, 'idx', 0))

  if (idx >= 1001) {
    return theme.backgrounds[idx - 1001] ?? theme.backgrounds.at(-1) ?? SOLID_PLACEHOLDER
  }

  return idx > 0 ? (theme.fills[idx - 1] ?? theme.fills.at(-1) ?? SOLID_PLACEHOLDER) : undefined
}

/** The stop a gradient is shown as: the middle one of three or more, else the first. */
function gradientStop(gradient: XmlElement, palette: Palette, placeholder: Paint | null): Paint | null {
  const stops = childrenNamed(child(gradient, 'a:gsLst'), 'a:gs').sort((a, b) => numberAttr(a, 'pos', 0) - numberAttr(b, 'pos', 0))

  return colorIn(stops.length > 2 ? stops[Math.floor(stops.length / 2)] : stops[0], palette, placeholder)
}

interface FillRead {
  fill: Fill | null
  /** A picture fill (`a:blipFill`), which only a picture can show. */
  picture?: XmlElement
}

/** A fill element as Herald's fill; `group` is the enclosing group's fill, for `a:grpFill`. */
function readFill(element: XmlElement | undefined, palette: Palette, placeholder: Paint | null, issues: Set<string>, group?: XmlElement): FillRead {
  if (element?.name === 'a:solidFill') {
    return { fill: fillOf(colorIn(element, palette, placeholder)) }
  }

  if (element?.name === 'a:gradFill') {
    issues.add(WHY.gradient)

    return { fill: fillOf(gradientStop(element, palette, placeholder)) }
  }

  if (element?.name === 'a:pattFill') {
    issues.add(WHY.pattern)

    return { fill: fillOf(colorIn(child(element, 'a:fgClr'), palette, placeholder)) }
  }

  if (element?.name === 'a:blipFill') {
    return { fill: null, picture: element }
  }

  return element?.name === 'a:grpFill' && group ? readFill(group, palette, placeholder, issues) : { fill: null }
}

/** A shape's outline: its own over the theme line style its style refers to. */
function lineProps(props: XmlElement | undefined, style: XmlElement | undefined, theme: ThemeInfo): XmlElement | undefined {
  const idx = Math.round(numberAttr(child(style, 'a:lnRef'), 'idx', 0))
  const themed = idx > 0 ? (theme.lines[idx - 1] ?? theme.lines.at(-1) ?? THEME_LINE) : undefined
  const own = child(props, 'a:ln')

  return themed || own ? overlay('a:ln', [themed, own]) : undefined
}

function dashOf(line: XmlElement, issues: Set<string>): Dash {
  if (child(line, 'a:custDash')) {
    issues.add(WHY.customDash)

    return 'dash'
  }

  return DASH_PRESETS[attr(child(line, 'a:prstDash'), 'val') ?? 'solid'] ?? 'solid'
}

/** An outline (`a:ln`) as Herald's stroke; null when nothing draws it. */
function readStroke(line: XmlElement | undefined, palette: Palette, placeholder: Paint | null, issues: Set<string>): Stroke | null {
  const fill = elements(line).find((node) => FILLS.has(node.name))
  let paint: Paint | null = null

  if (fill?.name === 'a:solidFill') {
    paint = colorIn(fill, palette, placeholder)
  } else if (fill?.name === 'a:gradFill') {
    paint = gradientStop(fill, palette, placeholder)
    issues.add(WHY.gradient)
  } else if (fill?.name === 'a:pattFill') {
    paint = colorIn(child(fill, 'a:fgClr'), palette, placeholder)
    issues.add(WHY.pattern)
  }

  if (!line || !paint) {
    return null
  }

  const width = numberAttr(line, 'w', 0)

  return { color: paint.color, width: width > 0 ? pt(width) : 0.75, dash: dashOf(line, issues), ...alphaOf(paint) }
}

const arrowOf = (end: XmlElement | undefined): ArrowHead => {
  const type = attr(end, 'type') as ArrowHead | undefined

  return type && ARROW_HEADS.includes(type) ? type : 'none'
}

/** Whether a shape has shadows, glows, reflections or bevels, its own or its style's. */
function hasEffects(props: XmlElement | undefined, style: XmlElement | undefined, theme: ThemeInfo): boolean {
  const own = elements(props).find((node) => GROUPS[node.name] === 'effect')
  const depth = child(props, 'a:sp3d')

  if (depth && (child(depth, 'a:bevelT') || child(depth, 'a:bevelB') || numberAttr(depth, 'extrusionH', 0) > 0)) {
    return true
  }

  if (own) {
    return own.name === 'a:effectDag' || elements(own).length > 0
  }

  const idx = Math.round(numberAttr(child(style, 'a:effectRef'), 'idx', 0))
  const themed = idx > 0 ? theme.effects[idx - 1] : undefined

  return elements(child(themed, 'a:effectLst')).length > 0 || child(child(themed, 'a:sp3d'), 'a:bevelT') !== undefined
}

interface TextSources {
  /** List styles (`a:lstStyle`, `p:titleStyle`…), the most general first. */
  styles: readonly (XmlElement | undefined)[]
  /** Body properties (`a:bodyPr`), the most general first. */
  bodies: readonly (XmlElement | undefined)[]
  /** Title text, in the heading font where nothing says otherwise. */
  title: boolean
}

/** A shape style's font reference as a list style: its colour, and the heading or body font. */
function fontRefStyle(style: XmlElement | undefined): XmlElement | undefined {
  const ref = child(style, 'a:fontRef')

  if (!ref) {
    return undefined
  }

  const color = elements(ref).find(isColorElement)
  const idx = attr(ref, 'idx')
  const props = [...(color ? [xml('a:solidFill', {}, [color])] : []), ...(idx === 'major' || idx === 'minor' ? [xml('a:latin', { typeface: idx === 'major' ? '+mj-lt' : '+mn-lt' })] : [])]

  return xml('a:lstStyle', {}, [xml('a:defPPr', {}, [xml('a:defRPr', {}, props)])])
}

/** Where a shape's text takes its look from: the presentation, the master's text style, its placeholders, its style and its own list style. */
function textSources(scope: Scope, from: Inherited | undefined, shape: XmlElement, style: XmlElement | undefined): TextSources {
  const kind = from?.text ?? 'other'
  const list = (element: XmlElement | undefined) => find(element, 'p:txBody/a:lstStyle')
  const body = (element: XmlElement | undefined) => find(element, 'p:txBody/a:bodyPr')

  return {
    styles: [scope.ctx.defaults, scope.master.styles[kind], list(from?.master), list(from?.layout), fontRefStyle(style), list(shape)],
    bodies: [body(from?.master), body(from?.layout), body(shape)],
    title: kind === 'title'
  }
}

/** A paragraph level's properties in each list style, and their default run properties. */
function levelLayers(styles: readonly (XmlElement | undefined)[], level: number): { paragraph: XmlElement[]; run: XmlElement[] } {
  const paragraph: XmlElement[] = []
  const run: XmlElement[] = []

  for (const style of styles) {
    for (const entry of [child(style, 'a:defPPr'), child(style, `a:lvl${level + 1}pPr`)]) {
      const defaults = child(entry, 'a:defRPr')

      if (entry) {
        paragraph.push(entry)
      }

      if (defaults) {
        run.push(defaults)
      }
    }
  }

  return { paragraph, run }
}

/** A run's whole look, every switch said either way. */
type RunLook = BodyStyle & { bold: boolean; italic: boolean; underline: boolean; strike: boolean }

interface Draft {
  text: string
  look: RunLook
}

function fontOf(typeface: string | undefined, fonts: Fonts): FontRef | undefined {
  if (!typeface) {
    return undefined
  }

  if (typeface.startsWith('+mj')) {
    return fonts.heading
  }

  return typeface.startsWith('+mn') ? fonts.body : typeface
}

function readRun(text: string, props: XmlElement, sources: TextSources, scope: Scope, issues: Set<string>): Draft {
  const fill = elements(props).find((node) => FILLS.has(node.name))
  const paint = fill?.name === 'a:solidFill' ? colorIn(fill, scope.palette) : fill?.name === 'a:gradFill' ? gradientStop(fill, scope.palette, null) : fill?.name === 'a:pattFill' ? colorIn(child(fill, 'a:fgClr'), scope.palette) : null
  const size = numberAttr(props, 'sz', 0)
  const highlight = colorIn(child(props, 'a:highlight'), scope.palette)
  const cap = attr(props, 'cap')
  const look: RunLook = {
    font: fontOf(attr(child(props, 'a:latin'), 'typeface'), scope.fonts) ?? (sources.title ? scope.fonts.heading : scope.fonts.body),
    size: size > 0 ? round2(size / 100) : 18,
    color: paint?.color ?? scope.text,
    bold: flagAttr(props, 'b') ?? false,
    italic: flagAttr(props, 'i') ?? false,
    underline: (attr(props, 'u') ?? 'none') !== 'none',
    strike: (attr(props, 'strike') ?? 'noStrike') !== 'noStrike'
  }

  if (highlight) {
    look.highlight = highlight.color
  }

  if (text.trim()) {
    const reasons = [
      fill?.name === 'a:gradFill' && WHY.gradient,
      fill?.name === 'a:pattFill' && WHY.pattern,
      numberAttr(props, 'baseline', 0) !== 0 && WHY.scripts,
      cap === 'all' && WHY.capitals,
      cap === 'small' && WHY.smallCapitals,
      child(props, 'a:hlinkClick') !== undefined && WHY.links,
      elements(child(props, 'a:effectLst')).length > 0 && WHY.effects
    ]

    for (const reason of reasons) {
      if (reason) {
        issues.add(reason)
      }
    }
  }

  return { text: cap === 'all' ? text.toUpperCase() : text, look }
}

/** A bullet's glyph as Herald can show it: a symbol font's character becomes what it looks like, or a dot. */
function glyphOf(char: string | undefined, font: string | undefined): string {
  const glyph = char || '•'
  const code = glyph.codePointAt(0) ?? 0
  // Symbol fonts' characters may be written 0xf000 above the letter, in the private use area.
  const letter = code >= 0xf000 && code <= 0xf0ff ? String.fromCharCode(code - 0xf000) : glyph

  if (font && /wingdings/i.test(font)) {
    return WINGDINGS[letter] ?? '•'
  }

  if ((font && SYMBOL_FONTS.test(font)) || (code >= 0xe000 && code <= 0xf8ff)) {
    return '•'
  }

  return font && /courier/i.test(font) && glyph === 'o' ? '◦' : glyph
}

/** Paragraph spacing in points: given in points, or as a share of the text's size. */
function spacingOf(spacing: XmlElement | undefined, size: number): number | undefined {
  const points = numberAttr(child(spacing, 'a:spcPts'), 'val')
  const share = numberAttr(child(spacing, 'a:spcPct'), 'val')

  return points !== undefined ? round2(points / 100) : share !== undefined ? round2((share / 100000) * size) : undefined
}

function paragraphProps(props: XmlElement, level: number, size: number, issues: Set<string>): Omit<Paragraph, 'runs'> {
  const out: Omit<Paragraph, 'runs'> = {}
  const align = ALIGNS[attr(props, 'algn') ?? 'l'] ?? 'left'
  const bullet = elements(props).find((node) => GROUPS[node.name] === 'bullet')
  const line = child(props, 'a:lnSpc')
  const share = numberAttr(child(line, 'a:spcPct'), 'val')
  const points = numberAttr(child(line, 'a:spcPts'), 'val')
  const before = spacingOf(child(props, 'a:spcBef'), size)
  const after = spacingOf(child(props, 'a:spcAft'), size)

  if (align !== 'left') {
    out.align = align
  }

  if (bullet?.name === 'a:buChar' || bullet?.name === 'a:buBlip') {
    const glyph = bullet.name === 'a:buChar' ? glyphOf(attr(bullet, 'char'), attr(child(props, 'a:buFont'), 'typeface')) : '•'
    out.list = 'bullet'

    if (bullet.name === 'a:buBlip') {
      issues.add(WHY.pictureBullets)
    }

    if (glyph !== bulletFor(level)) {
      out.bullet = glyph
    }
  } else if (bullet?.name === 'a:buAutoNum') {
    const type = attr(bullet, 'type') ?? 'arabicPeriod'
    const numbering = NUMBERINGS[type] ?? 'arabicPeriod'
    const startAt = Math.round(numberAttr(bullet, 'startAt', 1))
    out.list = 'number'

    if (!NUMBER_STYLES.includes(type as NumberStyle)) {
      issues.add(WHY.numbering)
    }

    if (numbering !== numberingFor(level)) {
      out.numbering = numbering
    }

    if (startAt !== 1) {
      out.startAt = startAt
    }
  }

  if (level) {
    out.level = level
  }

  if (share !== undefined && share > 0 && share !== 100000) {
    out.lineSpacing = round2(share / 100000)
  } else if (points !== undefined && points > 0 && size > 0) {
    out.lineSpacing = round2(points / 100 / (1.2 * size))
    issues.add(WHY.exactSpacing)
  }

  if (before) {
    out.spaceBefore = before
  }

  if (after) {
    out.spaceAfter = after
  }

  const margin = pt(numberAttr(props, 'marL', 0))
  const indent = pt(numberAttr(props, 'indent', 0))
  const usual = paragraphIndent({ ...out, runs: [] })

  if (Math.abs(margin - usual.margin) > 0.01 || Math.abs(indent - usual.indent) > 0.01) {
    out.margin = margin
    out.indent = indent
  }

  return out
}

function readParagraph(paragraph: XmlElement, sources: TextSources, scope: Scope, issues: Set<string>): { props: Omit<Paragraph, 'runs'>; runs: Draft[] } {
  const own = child(paragraph, 'a:pPr')
  const level = Math.min(MAX_LEVEL, Math.max(0, Math.round(numberAttr(own, 'lvl', 0))))
  const layers = levelLayers(sources.styles, level)
  // A paragraph's own default run properties are for text typed later, not for its runs.
  const props = overlay('a:pPr', [...layers.paragraph, own], 'a:defRPr')
  const look = (runProps: XmlElement | undefined): XmlElement => overlay('a:rPr', [...layers.run, runProps])
  const runs: Draft[] = []

  for (const node of treeChildren(paragraph)) {
    if (node.name === 'a:r' || node.name === 'a:fld') {
      const text = node.name === 'a:fld' && attr(node, 'type') === 'slidenum' ? String(scope.number) : textOf(child(node, 'a:t')).replace(/\v/g, '\n')
      runs.push(readRun(text, look(child(node, 'a:rPr')), sources, scope, issues))
    } else if (node.name === 'a:br') {
      const last = runs.at(-1)

      if (last) {
        last.text += '\n'
      } else {
        runs.push(readRun('\n', look(child(node, 'a:rPr')), sources, scope, issues))
      }
    }
  }

  if (!runs.length) {
    runs.push(readRun('', look(child(paragraph, 'a:endParaRPr')), sources, scope, issues))
  }

  return { props: paragraphProps(props, level, (runs.find((run) => run.text.trim()) ?? runs[0]).look.size, issues), runs }
}

/** The look most of a body's text has (by length), which runs then differ from. */
function sharedLook(drafts: readonly Draft[]): BodyStyle {
  const most = <K extends keyof RunLook>(key: K): RunLook[K] => {
    const weights = new Map<RunLook[K], number>()

    for (const draft of drafts) {
      weights.set(draft.look[key], (weights.get(draft.look[key]) ?? 0) + Math.max(1, draft.text.length))
    }

    return [...weights].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0]
  }

  const style: BodyStyle = { font: most('font'), size: most('size'), color: most('color') }

  for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
    if (most(key)) {
      style[key] = true
    }
  }

  const highlight = drafts[0]?.look.highlight

  if (highlight && drafts.every((draft) => draft.look.highlight === highlight)) {
    style.highlight = highlight
  }

  return style
}

const insetOf = (props: XmlElement, name: string, fallback: number): number => pt(Math.max(0, numberAttr(props, name, fallback)))

/** A text body (`p:txBody`) with what its sources lend it, as Herald's: paragraphs of runs over the look most of them share. */
function readBody(txBody: XmlElement | undefined, sources: TextSources, scope: Scope, issues: Set<string>): TextBody {
  const props = overlay('a:bodyPr', sources.bodies)
  const drafts = childrenNamed(txBody, 'a:p').map((paragraph) => readParagraph(paragraph, sources, scope, issues))

  if (!drafts.length) {
    drafts.push(readParagraph(EMPTY_PARAGRAPH, sources, scope, issues))
  }

  const style = sharedLook(drafts.flatMap((draft) => draft.runs))
  const vertical = attr(props, 'vert')
  const warp = attr(child(props, 'a:prstTxWarp'), 'prst')

  if (drafts.some((draft) => draft.runs.some((run) => run.text.trim()))) {
    const reasons = [
      vertical !== undefined && vertical !== 'horz' && WHY.vertical,
      numberAttr(props, 'numCol', 1) > 1 && WHY.columns,
      numberAttr(props, 'rot', 0) % 21600000 !== 0 && WHY.turnedText,
      warp !== undefined && warp !== 'textNoShape' && WHY.wordArt
    ]

    for (const reason of reasons) {
      if (reason) {
        issues.add(reason)
      }
    }
  }

  return {
    paragraphs: drafts.map((draft) => ({ ...draft.props, runs: tidyRuns(draft.runs.map((run) => ownStyle({ ...run.look, text: run.text }, { style }))) })),
    style,
    anchor: ANCHORS[attr(props, 'anchor') ?? 't'] ?? 'top',
    inset: [insetOf(props, 'lIns', 91440), insetOf(props, 'tIns', 45720), insetOf(props, 'rIns', 91440), insetOf(props, 'bIns', 45720)],
    fit: child(props, 'a:normAutofit') ? 'shrink' : child(props, 'a:spAutoFit') ? 'grow' : 'none',
    wrap: attr(props, 'wrap') !== 'none'
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ''

  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }

  return btoa(binary)
}

async function readImage(pkg: Package, path: string): Promise<Loaded> {
  const bytes = await pkg
    .file(path)
    ?.async('uint8array')
    .catch(() => undefined)

  if (!bytes) {
    return { reason: WHY.missing }
  }

  const size = imageSize(bytes)

  return size ? { src: `data:${size.mime};base64,${base64(bytes)}`, natural: { width: size.width, height: size.height } } : { reason: WHY.format }
}

/** A blip's picture as a data URL with its pixel size, read once however many shapes show it; or why it cannot be shown. */
function loadPicture(scope: Scope, blip: XmlElement | undefined): Promise<Loaded> {
  const relationship = byId(scope.relationships, attr(blip, 'r:embed'))

  if (!relationship || relationship.external) {
    return Promise.resolve({ reason: relationship?.external || attr(blip, 'r:link') ? WHY.linked : WHY.missing })
  }

  return remember(scope.ctx.pictures, relationship.target, () => readImage(scope.ctx.pkg, relationship.target))
}

/** How much of a picture its frame cuts off; a negative side insets it, which Herald shows filling the frame. */
function cropOf(rect: XmlElement | undefined, issues: Set<string>): Crop | undefined {
  if (!rect) {
    return undefined
  }

  const sides = ['l', 't', 'r', 'b'].map((side) => numberAttr(rect, side, 0) / 100000)
  const [left, top, right, bottom] = sides.map((side) => Math.max(0, side))

  if (sides.some((side) => side < 0)) {
    issues.add(WHY.inset)
  }

  return left + right < 1 && top + bottom < 1 && (left || top || right || bottom) ? { left, top, right, bottom } : undefined
}

/** A line from corner to corner of its box, its turn folded into where it starts and ends. */
function lineFrom(placement: Placement, inverted: boolean): { from: Point; to: Point } {
  const { x, y, width, height, flipH } = placement
  const flipV = placement.flipV !== inverted
  const middle: Point = [x + width / 2, y + height / 2]
  const ends: Point[] = [
    [flipH ? x + width : x, flipV ? y + height : y],
    [flipH ? x : x + width, flipV ? y : y + height]
  ]
  const [from, to] = ends.map((end) => rotatePoint(end, middle, placement.rotation).map(round2) as Point)

  return { from, to }
}

function readLine(props: XmlElement, style: XmlElement | undefined, info: XmlElement | undefined, placement: Placement, preset: string, scope: Scope, issues: Set<string>): SlideElement {
  const theme = scope.master.theme
  const outline = lineProps(props, style, theme)
  const stroke = readStroke(outline, scope.palette, colorIn(child(style, 'a:lnRef'), scope.palette), issues) ?? { ...UNSEEN }
  const { from, to } = lineFrom(placement, preset === 'lineInv')
  const line = lineElement(from, to, { stroke, start: arrowOf(child(outline, 'a:headEnd')), end: arrowOf(child(outline, 'a:tailEnd')), ...nameOf(info) })

  if (preset !== 'line' && preset !== 'lineInv' && preset !== 'straightConnector1') {
    issues.add(WHY.connectors)
  }

  if (hasEffects(props, style, theme)) {
    issues.add(WHY.effects)
  }

  tally(scope.report, 'line', issues)

  return { ...line, x: round2(line.x), y: round2(line.y), width: round2(line.width), height: round2(line.height) }
}

async function readShape(sp: XmlElement, scope: Scope, at: readonly Transform[], group: XmlElement | undefined): Promise<SlideElement[]> {
  const nv = child(sp, 'p:nvSpPr')
  const info = child(nv, 'p:cNvPr')
  const ph = find(nv, 'p:nvPr/p:ph')
  const textBox = flagAttr(child(nv, 'p:cNvSpPr'), 'txBox') === true

  if (ph && !scope.slide) {
    return []
  }

  if (flagAttr(info, 'hidden')) {
    count(scope.report, textBox || ph ? 'text' : 'shape', 'skipped', WHY.hidden)

    return []
  }

  const from = ph ? inheritance(ph, scope) : undefined
  const layers = [from?.master, from?.layout, sp]
  const props = shapeProps(layers.map((layer) => child(layer, 'p:spPr')))
  const style = layers.map((layer) => child(layer, 'p:style')).findLast((entry) => entry !== undefined)
  const placement = place(placementOf(child(props, 'a:xfrm')), at)
  const custom = child(props, 'a:custGeom')
  const preset = custom ? undefined : (attr(child(props, 'a:prstGeom'), 'prst') ?? 'rect')
  const theme = scope.master.theme
  const issues = new Set<string>()

  if (preset && LINES.has(preset)) {
    if (textOf(child(sp, 'p:txBody')).trim()) {
      issues.add(WHY.lineText)
    }

    return [readLine(props, style, info, placement, preset, scope, issues)]
  }

  const fillRef = child(style, 'a:fillRef')
  const read = readFill(elements(props).find((node) => FILLS.has(node.name)) ?? themeFill(fillRef, theme), scope.palette, colorIn(fillRef, scope.palette), issues, group)
  const stroke = readStroke(lineProps(props, style, theme), scope.palette, colorIn(child(style, 'a:lnRef'), scope.palette), issues)
  const body = readBody(child(sp, 'p:txBody'), textSources(scope, from, sp, style), scope, issues)
  const box = boxOf(placement)
  const frame = frameOf(placement, info)
  const placeholder: Placeholder | undefined = from?.role ? { role: from.role, prompt: from.prompt } : undefined
  const picturePlaceholder = from?.role === 'picture'
  let fill = read.fill

  if (hasEffects(props, style, theme)) {
    issues.add(WHY.effects)
  }

  if (child(info, 'a:hlinkClick')) {
    issues.add(WHY.objectLinks)
  }

  if (read.picture) {
    const loaded = !custom && preset === 'rect' ? await loadPicture(scope, child(read.picture, 'a:blip')) : undefined

    if (loaded && 'src' in loaded) {
      const crop = cropOf(child(read.picture, 'a:srcRect'), issues)
      const out: SlideElement[] = [imageElement(loaded.src, loaded.natural, box, { ...frame, stroke, ...(crop ? { crop } : {}), ...(picturePlaceholder ? { placeholder } : {}) })]

      if (!picturePlaceholder) {
        issues.add(WHY.pictureShape)
      }

      if (!isBlank(body)) {
        out.push(textElement(box, body, { ...frame, ...(placeholder && !picturePlaceholder ? { placeholder } : {}) }))
      }

      tally(scope.report, picturePlaceholder ? 'picture' : 'shape', issues)

      return out
    }

    fill = fillOf(themeColor('accent1', scope.palette))
    issues.add(WHY.pictureFill)
  }

  if (picturePlaceholder) {
    tally(scope.report, 'picture', issues)

    return [imageElement('', { width: 0, height: 0 }, box, { ...frame, stroke, placeholder })]
  }

  const visible = fill !== null || stroke !== null
  const plain = !custom && preset === 'rect'

  if ((textBox || ph || !visible) && (plain || !visible)) {
    tally(scope.report, 'text', issues)

    return [textElement(box, body, { ...frame, fill, stroke, ...(placeholder ? { placeholder } : {}) })]
  }

  const known = preset !== undefined && SHAPE_KINDS.includes(preset as ShapeKind)
  const kind: ShapeKind = known ? (preset as ShapeKind) : (NEAREST[preset ?? 'rect'] ?? 'rect')
  const adjust = known ? adjustOf(child(props, 'a:prstGeom')) : undefined

  if (!known) {
    issues.add(custom ? WHY.customShape : WHY.nearestShape)
  }

  tally(scope.report, 'shape', issues)

  return [shapeElement(kind, box, { ...frame, fill, stroke, body, ...(adjust ? { adjust } : {}), ...(placeholder ? { placeholder } : {}) })]
}

/** A preset's adjust values (`a:gd fmla="val 16667"`) by guide name. */
function adjustOf(geometry: XmlElement | undefined): Record<string, number> | undefined {
  const entries = childrenNamed(child(geometry, 'a:avLst'), 'a:gd').flatMap((guide) => {
    const name = attr(guide, 'name')
    const value = /^val\s+(-?\d+(?:\.\d+)?)$/.exec((attr(guide, 'fmla') ?? '').trim())

    return name && value ? [[name, Number(value[1])] as const] : []
  })

  return entries.length ? Object.fromEntries(entries) : undefined
}

function mediaOf(nvPr: XmlElement | undefined, scope: Scope): 'audio' | 'video' | null {
  if (child(nvPr, 'a:audioFile') || child(nvPr, 'a:wavAudioFile') || child(nvPr, 'a:audioCd')) {
    return 'audio'
  }

  if (child(nvPr, 'a:videoFile') || child(nvPr, 'a:quickTimeFile')) {
    return 'video'
  }

  const media = descendants(child(nvPr, 'p:extLst'), 'p14:media')[0]

  if (!media) {
    return null
  }

  return AUDIO.test(byId(scope.relationships, attr(media, 'r:embed') ?? attr(media, 'r:link'))?.target ?? '') ? 'audio' : 'video'
}

/** A picture (`p:pic`), or an embedded object's picture when `frame` is the object's frame. */
async function readPicture(pic: XmlElement, scope: Scope, at: readonly Transform[], as: 'picture' | 'ole', frame?: XmlElement): Promise<SlideElement[]> {
  const nv = child(pic, 'p:nvPicPr')
  const info = frame ? find(frame, 'p:nvGraphicFramePr/p:cNvPr') : child(nv, 'p:cNvPr')
  const ph = find(nv, 'p:nvPr/p:ph')

  if (ph && !scope.slide) {
    return []
  }

  const media = mediaOf(child(nv, 'p:nvPr'), scope)
  const kind = media ?? as

  if (flagAttr(info, 'hidden') || media === 'audio') {
    count(scope.report, kind, 'skipped', flagAttr(info, 'hidden') ? WHY.hidden : WHY.sound)

    return []
  }

  const from = ph ? inheritance(ph, scope) : undefined
  const props = shapeProps([from?.master, from?.layout, pic].map((layer) => child(layer, 'p:spPr')))
  const placement = place(placementOf((frame && child(frame, 'p:xfrm')) ?? child(props, 'a:xfrm')), at)
  const fill = child(pic, 'p:blipFill')
  const blip = child(fill, 'a:blip')
  const loaded = await loadPicture(scope, blip)

  if ('reason' in loaded) {
    count(scope.report, kind, 'skipped', loaded.reason)

    return []
  }

  const style = child(pic, 'p:style')
  const theme = scope.master.theme
  const issues = new Set<string>(media === 'video' ? [WHY.video] : as === 'ole' ? [WHY.ole] : [])
  const crop = cropOf(child(fill, 'a:srcRect'), issues)
  const stroke = readStroke(lineProps(props, style, theme), scope.palette, colorIn(child(style, 'a:lnRef'), scope.palette), issues)
  const alt = attr(info, 'descr') || attr(child(nv, 'p:cNvPr'), 'descr')
  const geometry = attr(child(props, 'a:prstGeom'), 'prst') ?? 'rect'
  const placeholder: Placeholder | undefined = from?.role === 'picture' ? { role: 'picture', prompt: from.prompt } : undefined
  const reasons = [
    child(fill, 'a:tile') !== undefined && WHY.tiled,
    (child(props, 'a:custGeom') !== undefined || geometry !== 'rect') && WHY.pictureCut,
    elements(blip).some((node) => node.name !== 'a:extLst') && WHY.pictureEffects,
    hasEffects(props, style, theme) && WHY.effects,
    child(info, 'a:hlinkClick') !== undefined && WHY.objectLinks
  ]

  for (const reason of reasons) {
    if (reason) {
      issues.add(reason)
    }
  }

  tally(scope.report, kind, issues)

  return [imageElement(loaded.src, loaded.natural, boxOf(placement), { ...frameOf(placement, info), stroke, ...(crop ? { crop } : {}), ...(alt ? { alt } : {}), ...(placeholder ? { placeholder } : {}) })]
}

async function readConnector(connector: XmlElement, scope: Scope, at: readonly Transform[]): Promise<SlideElement[]> {
  const info = find(connector, 'p:nvCxnSpPr/p:cNvPr')
  const props = child(connector, 'p:spPr') ?? xml('p:spPr')

  if (flagAttr(info, 'hidden')) {
    count(scope.report, 'line', 'skipped', WHY.hidden)

    return []
  }

  const placement = place(placementOf(child(props, 'a:xfrm')), at)

  return [readLine(props, child(connector, 'p:style'), info, placement, attr(child(props, 'a:prstGeom'), 'prst') ?? 'line', scope, new Set())]
}

async function readGroup(group: XmlElement, scope: Scope, at: readonly Transform[], depth: number, fill: XmlElement | undefined): Promise<SlideElement[]> {
  const props = child(group, 'p:grpSpPr')
  const own = elements(props).find((node) => FILLS.has(node.name))

  if (flagAttr(find(group, 'p:nvGrpSpPr/p:cNvPr'), 'hidden')) {
    count(scope.report, 'group', 'skipped', WHY.hidden)

    return []
  }

  if (depth >= MAX_DEPTH) {
    count(scope.report, 'group', 'skipped', WHY.nested)

    return []
  }

  count(scope.report, 'group', 'approximated', WHY.grouped)

  return walk(treeChildren(group), scope, [...at, groupTransform(child(props, 'a:xfrm'))], depth + 1, own && own.name !== 'a:grpFill' ? own : fill)
}

const frameKind = (uri: string): ReportKind =>
  uri.endsWith('/table') ? 'table' : /\/chart(ex)?$/.test(uri) ? 'chart' : uri.endsWith('/diagram') ? 'smartart' : uri.endsWith('/ole') ? 'ole' : 'other'

/** An embedded object's picture: its fallback's where it offers a choice, else any it holds. */
function olePicture(data: XmlElement | undefined): XmlElement | undefined {
  return treeChildren(data)
    .map((node) => child(node, 'p:pic'))
    .find((pic) => pic !== undefined) ?? descendants(data, 'p:pic')[0]
}

async function readFrame(frame: XmlElement, scope: Scope, at: readonly Transform[]): Promise<SlideElement[]> {
  const data = find(frame, 'a:graphic/a:graphicData')
  const kind = frameKind(attr(data, 'uri') ?? '')

  if (flagAttr(find(frame, 'p:nvGraphicFramePr/p:cNvPr'), 'hidden')) {
    count(scope.report, kind, 'skipped', WHY.hidden)

    return []
  }

  const picture = kind === 'ole' ? olePicture(data) : undefined

  if (picture) {
    return readPicture(picture, scope, at, 'ole', frame)
  }

  count(scope.report, kind, 'skipped', kind === 'table' ? WHY.tables : undefined)

  return []
}

function kindGuess(node: XmlElement): ReportKind {
  if (node.name === 'p:graphicFrame') {
    return frameKind(attr(find(node, 'a:graphic/a:graphicData'), 'uri') ?? '')
  }

  return node.name === 'p:sp' && flagAttr(find(node, 'p:nvSpPr/p:cNvSpPr'), 'txBox') ? 'text' : (NODE_KINDS[node.name] ?? 'other')
}

async function readNode(node: XmlElement, scope: Scope, at: readonly Transform[], depth: number, group: XmlElement | undefined): Promise<SlideElement[]> {
  if (node.name === 'p:sp') {
    return readShape(node, scope, at, group)
  }

  if (node.name === 'p:pic') {
    return readPicture(node, scope, at, 'picture')
  }

  if (node.name === 'p:cxnSp') {
    return readConnector(node, scope, at)
  }

  if (node.name === 'p:grpSp') {
    return readGroup(node, scope, at, depth, group)
  }

  if (node.name === 'p:graphicFrame') {
    return readFrame(node, scope, at)
  }

  // Elements in other namespaces are extensions PowerPoint itself may ignore.
  if (node.name.startsWith('p:') && !STRUCTURE.has(node.name)) {
    count(scope.report, node.name === 'p:contentPart' ? 'ink' : 'other', 'skipped')
  }

  return []
}

/** Shapes back to front as Herald's elements; one that cannot be read is counted as left out and the rest go on. */
async function walk(nodes: readonly XmlElement[], scope: Scope, at: readonly Transform[], depth: number, group?: XmlElement): Promise<SlideElement[]> {
  const out: SlideElement[] = []

  for (const node of nodes) {
    try {
      out.push(...(await readNode(node, scope, at, depth, group)))
    } catch {
      count(scope.report, kindGuess(node), 'skipped', WHY.unreadable)
    }
  }

  return out
}

/** A master's or layout's own shapes (not its placeholders), drawn on a slide behind the slide's own; counted for the first slide only. */
async function decorations(scope: Scope, path: string, root: XmlElement, relationships: Relationship[]): Promise<SlideElement[]> {
  const counted = scope.ctx.counted.has(path)
  scope.ctx.counted.add(path)

  return walk(treeChildren(find(root, 'p:cSld/p:spTree')), { ...scope, relationships, slide: false, report: counted ? emptyReport() : scope.report }, [], 0)
}

async function readBackground(bg: XmlElement, scope: Scope, notes: Set<string>): Promise<Background | null> {
  const props = child(bg, 'p:bgPr')
  const ref = child(bg, 'p:bgRef')
  const fill = props ? elements(props).find((node) => FILLS.has(node.name)) : themeFill(ref, scope.master.theme)
  const placeholder = props ? null : colorIn(ref, scope.palette)

  if (fill?.name === 'a:solidFill' || fill?.name === 'a:pattFill') {
    const paint = colorIn(fill.name === 'a:pattFill' ? child(fill, 'a:fgClr') : fill, scope.palette, placeholder)

    if (fill.name === 'a:pattFill') {
      notes.add(WHY.pattern)
    }

    return paint && paint.color !== 'bg1' ? { kind: 'solid', color: paint.color } : null
  }

  if (fill?.name === 'a:gradFill') {
    const stops = childrenNamed(child(fill, 'a:gsLst'), 'a:gs')
      .flatMap((stop) => {
        const paint = colorIn(stop, scope.palette, placeholder)

        return paint ? [{ at: clamp01(numberAttr(stop, 'pos', 0) / 100000), color: paint.color }] : []
      })
      .sort((a, b) => a.at - b.at)

    if (child(fill, 'a:path')) {
      notes.add(WHY.radial)
    }

    if (stops.length < 2) {
      return stops[0] ? { kind: 'solid', color: stops[0].color } : null
    }

    return { kind: 'gradient', stops, angle: degrees(numberAttr(child(fill, 'a:lin'), 'ang', 5400000) / 60000) }
  }

  if (fill?.name !== 'a:blipFill') {
    return null
  }

  const picture = await loadPicture(scope, child(fill, 'a:blip'))

  if ('reason' in picture) {
    notes.add(picture.reason)

    return null
  }

  const size = scope.ctx.size

  if (child(fill, 'a:tile')) {
    notes.add(WHY.backgroundTiles)
  } else if (Math.abs(picture.natural.width / picture.natural.height / (size.width / size.height) - 1) > 0.02) {
    notes.add(WHY.backgroundStretch)
  }

  return { kind: 'image', src: picture.src, natural: picture.natural }
}

interface Source {
  path: string
  root: XmlElement
  relationships: Relationship[]
}

/** A slide's background: its own, else its layout's, else its master's, in the slide's colours. */
async function backgroundOf(scope: Scope, sources: readonly Source[]): Promise<Background | null> {
  for (const source of sources) {
    const bg = find(source.root, 'p:cSld/p:bg')

    if (bg) {
      const notes = new Set<string>()
      const background = await readBackground(bg, { ...scope, relationships: source.relationships }, notes)
      noteOnce(scope.ctx, `background ${source.path}`, notes)

      return background
    }
  }

  return null
}

async function notesOf(ctx: Context, relationships: readonly Relationship[]): Promise<string> {
  const root = await ctx.pkg.xml(targetOf(relationships, 'notesSlide'))
  const body = treeChildren(find(root, 'p:cSld/p:spTree')).find((node) => node.name === 'p:sp' && attr(find(node, 'p:nvSpPr/p:nvPr/p:ph'), 'type') === 'body')

  return childrenNamed(child(body, 'p:txBody'), 'a:p').map(paragraphText).join('\n').replace(/\v/g, '\n').trimEnd()
}

interface TransitionRead {
  kind: Transition
  /** Whether Herald's transition is the very one the slide had. */
  exact: boolean
}

/** A slide's transition: a choice's, which holds the effect itself, over its fallback's stand-in for older readers. */
function transitionElement(root: XmlElement): XmlElement | undefined {
  const alternatives = childrenNamed(root, 'mc:AlternateContent').flatMap((node) => [...childrenNamed(node, 'mc:Choice'), ...childrenNamed(node, 'mc:Fallback')])

  return child(root, 'p:transition') ?? alternatives.map((node) => child(node, 'p:transition')).find((entry) => entry !== undefined)
}

/** A transition's effect as Herald's nearest; null for a transition with no effect (one that only times the slide). */
function transitionOf(transition: XmlElement | undefined): TransitionRead | null {
  const effect = elements(transition).find((node) => node.name !== 'p:sndAc' && node.name !== 'p:extLst')

  if (!effect) {
    return null
  }

  const name = effect.name.slice(effect.name.indexOf(':') + 1)

  if (name === 'fade' || name === 'cut') {
    return { kind: name === 'fade' ? 'fade' : 'none', exact: !flagAttr(effect, 'thruBlk') }
  }

  return { kind: PUSHES.has(name) ? 'push' : 'fade', exact: name === 'push' }
}

function animated(root: XmlElement): boolean {
  const timings = [child(root, 'p:timing'), ...childrenNamed(root, 'mc:AlternateContent').map((node) => child(child(node, 'mc:Fallback') ?? child(node, 'mc:Choice'), 'p:timing'))]

  return timings.some((timing) => ANIMATIONS.some((name) => descendants(timing, name).length > 0))
}

async function commentsOf(ctx: Context, relationships: readonly Relationship[]): Promise<number> {
  let total = 0

  for (const relationship of relationships) {
    if (relationship.type === 'comments' && !relationship.external) {
      const root = await ctx.pkg.xml(relationship.target)
      total += root ? elements(root).filter((node) => node.name === 'cm' || node.name.endsWith(':cm')).length : 1
    }
  }

  return total
}

interface SlideRead {
  slide: Slide
  transition: TransitionRead | null
  /** Whether the slide moves on by itself after a time. */
  timed: boolean
  animated: boolean
  comments: number
}

async function readSlide(ctx: Context, path: string | undefined, index: number): Promise<SlideRead> {
  const root = await ctx.pkg.xml(path)

  if (!path || root?.name !== 'p:sld') {
    throw new Error('A slide could not be read')
  }

  const relationships = await ctx.pkg.relationships(path)
  const layoutPath = targetOf(relationships, 'slideLayout')
  const layout = layoutPath ? await layoutAt(ctx, layoutPath) : undefined
  const master = layout?.master ?? ctx.first
  const palette: Palette = { scheme: master.theme.scheme, map: mapOver(root, layout?.map ?? master.map), slots: master.slots ? ctx.slots : null }
  const scope: Scope = { ctx, report: ctx.report, relationships, palette, fonts: master.fonts, text: themeColor('tx1', palette)?.color ?? 'tx1', master, layout, slide: true, number: index + 1 }
  const drawn: SlideElement[] = []
  const sources: Source[] = [{ path, root, relationships }]

  if (layout) {
    sources.push({ path: layout.path, root: layout.root, relationships: layout.relationships })
  }

  if (master.root) {
    sources.push({ path: master.path, root: master.root, relationships: master.relationships })
  }

  if (layout && flagAttr(root, 'showMasterSp') !== false) {
    if (layout.showsMaster && master.root) {
      drawn.push(...(await decorations(scope, master.path, master.root, master.relationships)))
    }

    drawn.push(...(await decorations(scope, layout.path, layout.root, layout.relationships)))
  }

  drawn.push(...(await walk(treeChildren(find(root, 'p:cSld/p:spTree')), scope, [], 0)))

  const transition = transitionElement(root)

  return {
    slide: {
      id: newId('slide'),
      layout: layout?.id ?? layoutFrom(placeholdersOf(root)),
      background: await backgroundOf(scope, sources),
      elements: drawn,
      notes: await notesOf(ctx, relationships),
      hidden: flagAttr(root, 'show') === false
    },
    transition: transitionOf(transition),
    timed: attr(transition, 'advTm') !== undefined,
    animated: attempt(() => animated(root), false),
    comments: await commentsOf(ctx, relationships)
  }
}

const emptySlide = (): Slide => ({ id: newId('slide'), layout: 'blank', background: null, elements: [], notes: '', hidden: false })

/** The deck's one transition, the slides' most common; and how many slides had one, when that is not what every slide had. */
function deckTransition(reads: readonly (SlideRead | null)[]): { transition: Transition; inexact: number } {
  const effects = reads.map((read) => read?.transition ?? null)
  const counts = new Map<Transition, number>()

  for (const effect of effects) {
    if (effect) {
      counts.set(effect.kind, (counts.get(effect.kind) ?? 0) + 1)
    }
  }

  const transition = [...counts].reduce<[Transition, number]>((best, entry) => (entry[1] > best[1] ? entry : best), ['none', 0])[0]
  const exact = effects.every((effect) => (effect?.kind ?? 'none') === transition && (effect?.exact ?? true))

  return { transition, inexact: exact ? 0 : effects.filter((effect) => effect !== null).length }
}

async function hasMacros(pkg: Package, relationships: readonly Relationship[]): Promise<boolean> {
  if (relationships.some((entry) => entry.type === 'vbaProject') || pkg.file('ppt/vbaProject.bin')) {
    return true
  }

  return elements(await pkg.xml('[Content_Types].xml')).some((entry) => /macroEnabled|vbaProject/i.test(attr(entry, 'ContentType') ?? ''))
}

async function presentationPath(pkg: Package): Promise<string | undefined> {
  const main = targetOf(await pkg.relationships(''), 'officeDocument')

  if (main) {
    return main
  }

  // Without the package's relationships, its content types still name the main part.
  const override = childrenNamed(await pkg.xml('[Content_Types].xml'), 'Override').find((entry) => MAIN_TYPES.test(attr(entry, 'ContentType') ?? ''))

  return override ? resolveTarget('', attr(override, 'PartName') ?? '') : undefined
}

function sizeOf(presentation: XmlElement): SlideSize {
  const size = child(presentation, 'p:sldSz')
  const width = numberAttr(size, 'cx', 0)
  const height = numberAttr(size, 'cy', 0)

  return width > 0 && height > 0 ? { width: pt(width), height: pt(height) } : { ...SLIDE_SIZES.wide }
}

/** A PowerPoint file's slides as a Herald deck, with what reading kept, approximated and left out. */
export async function importPresentation(zip: JSZip, title: string): Promise<{ deck: Deck; report: ImportReport }> {
  const pkg = new Package(zip)
  const path = await presentationPath(pkg)
  const presentation = await pkg.xml(path)

  if (!path || presentation?.name !== 'p:presentation') {
    throw new Error('This is not a PowerPoint presentation')
  }

  const relationships = await pkg.relationships(path)
  const firstPath = childrenNamed(child(presentation, 'p:sldMasterIdLst'), 'p:sldMasterId').map((entry) => partOf(relationships, attr(entry, 'r:id'))).find((entry) => entry !== undefined) ?? targetOf(relationships, 'slideMaster')
  const firstRoot = await pkg.xml(firstPath)
  const themePath = (firstPath && targetOf(await pkg.relationships(firstPath), 'theme')) || targetOf(relationships, 'theme')
  const theme = readTheme(await pkg.xml(themePath))
  const map = readColorMap(child(firstRoot, 'p:clrMap'))
  const slots = Object.fromEntries(SLOTS.map((slot) => [slot, slot.startsWith('accent') ? slot : map[slot]])) as Record<Slot, string>
  const report = emptyReport()
  const ctx: Context = {
    pkg,
    report,
    size: sizeOf(presentation),
    defaults: child(presentation, 'p:defaultTextStyle'),
    theme,
    slots,
    first: masterOf(theme, '', undefined, [], theme),
    masters: new Map(),
    layouts: new Map(),
    pictures: new Map(),
    counted: new Set()
  }
  ctx.first = (firstPath ? await masterAt(ctx, firstPath) : undefined) ?? ctx.first
  const reads: (SlideRead | null)[] = []

  for (const [index, entry] of childrenNamed(child(presentation, 'p:sldIdLst'), 'p:sldId').entries()) {
    try {
      reads.push(await readSlide(ctx, partOf(relationships, attr(entry, 'r:id')), index))
    } catch {
      reads.push(null)
    }
  }

  const { transition, inexact } = deckTransition(reads)
  const dropped: [string, number][] = [
    ['slides that could not be read', reads.filter((read) => !read).length],
    ['animations', reads.filter((read) => read?.animated).length],
    [WHY.transitions, inexact],
    ['automatic slide timings', reads.filter((read) => read?.timed).length],
    ['embedded fonts', childrenNamed(child(presentation, 'p:embeddedFontLst'), 'p:embeddedFont').length],
    ['macros', (await hasMacros(pkg, relationships)) ? 1 : 0],
    ['comments', reads.reduce((sum, read) => sum + (read?.comments ?? 0), 0)],
    ['sections', attempt(() => descendants(child(presentation, 'p:extLst'), 'p14:section').length, 0)],
    ['custom shows', childrenNamed(child(presentation, 'p:custShowLst'), 'p:custShow').length]
  ]

  for (const [what, times] of dropped) {
    if (times) {
      drop(report, what, times)
    }
  }

  const slides = reads.map((read) => read?.slide ?? emptySlide())

  return { deck: { id: newId('deck'), title, size: ctx.size, theme: themeOf(theme, slots), transition, slides: slides.length ? slides : [newSlide('blank', ctx.size)] }, report }
}
