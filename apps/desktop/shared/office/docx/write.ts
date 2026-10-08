import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  type ILevelsOptions,
  ImageRun,
  type IParagraphOptions,
  type IParagraphStyleOptions,
  type IParagraphStylePropertiesOptions,
  type IRunOptions,
  type IRunStylePropertiesOptions,
  type ISectionPropertiesOptions,
  type IStylesOptions,
  LevelFormat,
  LineRuleType,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Tab,
  Table,
  TableBorders,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType
} from 'docx'
import {
  CALLOUT_KINDS,
  type CalloutKind,
  CODE_FONT,
  type DocJSON,
  type DocMark,
  type DocNode,
  hexColor,
  HIGHLIGHT_COLORS,
  imageSize,
  looksOf,
  type PageSettings,
  pageOf,
  parseDataUrl,
  points,
  type StyleLook,
  type StyleName
} from '../document.ts'
import { pixelsToTwips, pointsToTwips, TWIPS_PER_PIXEL } from './units.ts'

/*
 * Herald Docs documents as Word documents (.docx), written with the docx package. Herald's styles
 * become Word's built-in ones (Normal, Title, Subtitle, Heading 1 to 6, Quote) with the document's
 * looks, plus Source Code, Verbatim Char and a style for each kind of callout; lists get real
 * numbering, tables their spans, header rows and shading, and pictures are embedded. What a Word
 * document cannot hold is left out or written another way, and said in the losses.
 */

type LossKey = 'checklists' | 'codeLanguages' | 'svgWebp' | 'otherPictures' | 'webPictures' | 'internalLinks' | 'otherLinks' | 'headerCells' | 'nestedInLists' | 'nestedInContainers'

/** The sentence for each loss, in the order losses are given. */
const LOSSES: Readonly<Record<LossKey, string>> = {
  checklists: 'Checklists are saved as boxes typed before each item.',
  codeLanguages: 'Code block languages are not saved in Word documents.',
  svgWebp: 'SVG and WebP pictures are left out of Word documents.',
  otherPictures: 'Pictures in formats other than PNG, JPEG, GIF and BMP are left out of Word documents.',
  webPictures: 'Pictures from the web are left out of Word documents.',
  internalLinks: 'Links to places inside the document are saved as plain text.',
  otherLinks: 'Links that are not web or email addresses are saved as plain text.',
  headerCells: 'Header cells outside the top rows of a table are saved as ordinary cells.',
  nestedInLists: 'Headings, tables, quotes and callouts inside list items are saved as ordinary blocks.',
  nestedInContainers: 'Headings, code blocks, tables, quotes and callouts inside a quote or callout are saved as ordinary blocks.'
}

type Block = Paragraph | Table

interface Writer {
  looks: Record<StyleName, StyleLook>
  /** The width text runs across the page, in twips. */
  textWidth: number
  losses: Set<LossKey>
  numbering: { reference: string; levels: ILevelsOptions[] }[]
  bulletLists: number
  pictures: number
}

/** Where blocks are written: in a quote or callout (its paragraph style), and in a list item (its depth, or -1). */
interface Place {
  container?: string
  depth: number
  /** A table cell's alignment, for its paragraphs without one of their own. */
  align?: unknown
}

const LIST_INDENT = 720
const HANGING = 360

/** Where a list item's text starts at each depth, as the numbering and the paragraphs after an item's first share it. */
const levelIndent = (depth: number): number => LIST_INDENT * (depth + 1)

const append = <T>(out: T[], items: readonly T[]): void => {
  for (const item of items) {
    out.push(item)
  }
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const hex = (color: string): string => color.slice(1).toUpperCase()

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

const calloutKind = (kind: unknown): CalloutKind => (CALLOUT_KINDS.includes(kind as CalloutKind) ? (kind as CalloutKind) : 'info')

const calloutStyle = (kind: unknown): string => `HeraldCallout${capitalised(calloutKind(kind))}`

// Numbering.

const BULLETS = ['\u25cf', '\u25cb', '\u25a0']

const DEPTH_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN]

const TYPE_FORMATS: Record<string, (typeof LevelFormat)[keyof typeof LevelFormat]> = {
  '1': LevelFormat.DECIMAL,
  a: LevelFormat.LOWER_LETTER,
  A: LevelFormat.UPPER_LETTER,
  i: LevelFormat.LOWER_ROMAN,
  I: LevelFormat.UPPER_ROMAN
}

const levelStyle = (level: number): ILevelsOptions['style'] => ({ paragraph: { indent: { left: levelIndent(level), hanging: HANGING } } })

const bulletLevels = (): ILevelsOptions[] =>
  Array.from({ length: 9 }, (_, level) => ({ level, format: LevelFormat.BULLET, text: BULLETS[level % BULLETS.length], alignment: AlignmentType.LEFT, style: levelStyle(level) }))

/**
 * An ordered list's numbering: at the list's own depth its type (plain numbers without one, as the
 * editor shows it) and start; deeper levels, for lists indented further in Word, 1, a, i by depth.
 */
const orderedLevels = (depth: number, type: unknown, start: number): ILevelsOptions[] =>
  Array.from({ length: 9 }, (_, level) => ({
    level,
    format: level === depth ? (TYPE_FORMATS[String(type)] ?? LevelFormat.DECIMAL) : DEPTH_FORMATS[level % DEPTH_FORMATS.length],
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    start: level === depth ? start : 1,
    style: levelStyle(level)
  }))

/** The numbering a list's items use; each list gets numbering of its own, so each counts from its start. */
function numberingFor(writer: Writer, list: DocNode, depth: number): { reference: string; instance: number } {
  if (list.type === 'bulletList') {
    if (!writer.numbering.some((config) => config.reference === 'bullets')) {
      writer.numbering.push({ reference: 'bullets', levels: bulletLevels() })
    }

    return { reference: 'bullets', instance: ++writer.bulletLists }
  }

  const start = finite(list.attrs?.start)
  const reference = `numbers${writer.numbering.length}`
  writer.numbering.push({ reference, levels: orderedLevels(depth, list.attrs?.type, Math.max(0, Math.floor(start ?? 1))) })

  return { reference, instance: 0 }
}

// Inline content.

const HIGHLIGHT_NAMES = new Map(Object.entries(HIGHLIGHT_COLORS).map(([name, color]) => [color, name as NonNullable<IRunOptions['highlight']>]))

const PICTURE_TYPES: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' }

/** The first family of a CSS font list, without its quotes. */
const fontName = (value: unknown): string | null =>
  String(value ?? '')
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '') || null

function runOptions(marks: readonly DocMark[], linked: boolean): IRunOptions {
  const has = (type: string): boolean => marks.some((mark) => mark.type === type)

  if (has('code')) {
    return { style: 'VerbatimChar' }
  }

  const style = marks.find((mark) => mark.type === 'textStyle')?.attrs ?? {}
  const color = hexColor(style.color)
  const font = fontName(style.fontFamily)
  const size = style.fontSize ? points(style.fontSize) : null
  const highlight = hexColor(marks.find((mark) => mark.type === 'highlight')?.attrs?.color)
  const named = highlight ? HIGHLIGHT_NAMES.get(highlight) : undefined

  return {
    ...(linked ? { style: 'Hyperlink' } : {}),
    ...(has('bold') ? { bold: true } : {}),
    ...(has('italic') ? { italics: true } : {}),
    ...(has('underline') ? { underline: { type: UnderlineType.SINGLE } } : {}),
    ...(has('strike') ? { strike: true } : {}),
    ...(has('superscript') ? { superScript: true } : has('subscript') ? { subScript: true } : {}),
    ...(color ? { color: hex(color) } : {}),
    ...(font ? { font } : {}),
    ...(size && size > 0 ? { size: Math.round(size * 2) } : {}),
    ...(named ? { highlight: named } : highlight ? { shading: { type: ShadingType.CLEAR, fill: hex(highlight), color: 'auto' } } : {})
  }
}

/** Text with its tabs as Word's tabs. */
const withTabs = (text: string): (string | Tab)[] => text.split('\t').flatMap((part, index) => [...(index ? [new Tab()] : []), ...(part ? [part] : [])])

function pictureSize(attrs: Record<string, unknown>, bytes: Uint8Array, maxWidth: number): { width: number; height: number } {
  const natural = imageSize(bytes) ?? { width: 96, height: 96 }
  const ratio = natural.height / natural.width || 1
  const givenHeight = finite(attrs.height)
  let width = finite(attrs.width) ?? (givenHeight ? givenHeight / ratio : natural.width)
  let height = givenHeight ?? width * ratio

  // A picture wider than the page's text is shown at the text's width in the editor.
  if (width > maxWidth) {
    height *= maxWidth / width
    width = maxWidth
  }

  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
}

function imageRun(writer: Writer, node: DocNode): ImageRun | null {
  const attrs = node.attrs ?? {}
  const parsed = parseDataUrl(attrs.src)

  if (!parsed) {
    writer.losses.add('webPictures')

    return null
  }

  const type = PICTURE_TYPES[parsed.mime]

  if (!type) {
    writer.losses.add(parsed.mime === 'image/svg+xml' || parsed.mime === 'image/webp' ? 'svgWebp' : 'otherPictures')

    return null
  }

  const alt = typeof attrs.alt === 'string' && attrs.alt ? attrs.alt : undefined
  const title = typeof attrs.title === 'string' && attrs.title ? attrs.title : undefined
  writer.pictures++

  return new ImageRun({
    type,
    data: parsed.bytes,
    transformation: pictureSize(attrs, parsed.bytes, writer.textWidth / TWIPS_PER_PIXEL),
    altText: { name: `Picture ${writer.pictures}`, ...(alt ? { description: alt } : {}), ...(title ? { title } : {}) }
  })
}

function inline(writer: Writer, node: DocNode, linked: boolean): ParagraphChild[] {
  if (node.type === 'text') {
    const options = runOptions(node.marks ?? [], linked)

    return (node.text ?? '').split('\n').map((line, index) => new TextRun({ ...options, ...(index ? { break: 1 } : {}), children: withTabs(line) }))
  }

  if (node.type === 'hardBreak') {
    return [new TextRun({ break: 1 })]
  }

  const image = node.type === 'image' ? imageRun(writer, node) : null

  return image ? [image] : []
}

const linkOf = (node: DocNode): string | null => {
  const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href

  return typeof href === 'string' && href ? href : null
}

/** A link Word documents can hold (a web or email address), or null with the loss said. */
function webLink(writer: Writer, href: string): string | null {
  if (/^(https?:|mailto:)/i.test(href.trim())) {
    return href.trim()
  }

  writer.losses.add(href.startsWith('#') ? 'internalLinks' : 'otherLinks')

  return null
}

function inlines(writer: Writer, nodes: readonly DocNode[]): ParagraphChild[] {
  const out: ParagraphChild[] = []
  let start = 0

  while (start < nodes.length) {
    const href = linkOf(nodes[start])
    let end = start + 1

    while (end < nodes.length && linkOf(nodes[end]) === href) {
      end++
    }

    const link = href === null ? null : webLink(writer, href)
    const runs = nodes.slice(start, end).flatMap((node) => inline(writer, node, link !== null))

    if (link) {
      out.push(new ExternalHyperlink({ link, children: runs }))
    } else {
      append(out, runs)
    }

    start = end
  }

  return out
}

// Blocks.

const ALIGNMENTS: Record<string, IParagraphOptions['alignment']> = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED }

function spacingOf(before: number | null, after: number | null, lineHeight: number | null): IParagraphOptions['spacing'] {
  if (before === null && after === null && !lineHeight) {
    return undefined
  }

  return {
    ...(before !== null ? { before: pointsToTwips(before) } : {}),
    ...(after !== null ? { after: pointsToTwips(after) } : {}),
    ...(lineHeight ? { line: Math.round(240 * lineHeight), lineRule: LineRuleType.AUTO } : {})
  }
}

function indentOf(attrs: Record<string, unknown>): IParagraphOptions['indent'] {
  const left = finite(attrs.indent)
  const firstLine = finite(attrs.firstLine)

  if (!left && !firstLine) {
    return undefined
  }

  return {
    ...(left ? { left: pointsToTwips(left) } : {}),
    ...(firstLine && firstLine > 0 ? { firstLine: pointsToTwips(firstLine) } : {}),
    ...(firstLine && firstLine < 0 ? { hanging: pointsToTwips(-firstLine) } : {})
  }
}

/** A paragraph's own layout: alignment, spacing, line height and, outside list items, its indents. */
function layoutOf(node: DocNode, place: Place): Pick<IParagraphOptions, 'alignment' | 'spacing' | 'indent'> {
  const attrs = node.attrs ?? {}

  return {
    alignment: ALIGNMENTS[String(attrs.textAlign ?? place.align ?? '')],
    spacing: spacingOf(finite(attrs.spaceBefore), finite(attrs.spaceAfter), finite(attrs.lineHeight)),
    indent: place.depth >= 0 ? { left: levelIndent(place.depth) } : indentOf(attrs)
  }
}

function paragraph(writer: Writer, node: DocNode, place: Place, options: { style?: string; prefix?: string; numbering?: IParagraphOptions['numbering'] } = {}): Paragraph {
  const docStyle = node.attrs?.docStyle === 'title' ? 'Title' : node.attrs?.docStyle === 'subtitle' ? 'Subtitle' : undefined
  const layout = layoutOf(node, place)

  return new Paragraph({
    ...layout,
    ...(options.numbering ? { numbering: options.numbering, indent: undefined } : {}),
    style: options.style ?? place.container ?? docStyle,
    children: [...(options.prefix ? [new TextRun(options.prefix)] : []), ...inlines(writer, node.content ?? [])]
  })
}

/** A block Herald Docs nests that Word can only write after the list item, quote or callout it is in. */
function flattened(writer: Writer, place: Place): void {
  if (place.depth >= 0) {
    writer.losses.add('nestedInLists')
  }

  if (place.container) {
    writer.losses.add('nestedInContainers')
  }
}

function heading(writer: Writer, node: DocNode, place: Place): Paragraph {
  const level = Math.min(6, Math.max(1, Math.round(Number(node.attrs?.level ?? 1)) || 1))
  flattened(writer, place)

  return new Paragraph({ ...layoutOf(node, { depth: -1, align: place.align }), style: `Heading${level}`, children: inlines(writer, node.content ?? []) })
}

function code(writer: Writer, node: DocNode, place: Place): Paragraph[] {
  const text = (node.content ?? []).map((child) => child.text ?? '').join('')

  if (node.attrs?.language) {
    writer.losses.add('codeLanguages')
  }

  if (place.container) {
    writer.losses.add('nestedInContainers')
  }

  return text.split('\n').map(
    (line) =>
      new Paragraph({
        style: 'SourceCode',
        ...(place.depth >= 0 ? { indent: { left: levelIndent(place.depth) } } : {}),
        children: line ? [new TextRun({ children: withTabs(line) })] : []
      })
  )
}

function list(writer: Writer, node: DocNode, place: Place): Block[] {
  const depth = place.depth + 1
  const inner: Place = { ...place, depth }
  const task = node.type === 'taskList'
  const numbering = task ? null : numberingFor(writer, node, depth)
  const out: Block[] = []

  if (task) {
    writer.losses.add('checklists')
  }

  for (const item of node.content ?? []) {
    const [first, ...rest] = item.content ?? []

    if (first?.type === 'paragraph') {
      out.push(
        numbering
          ? paragraph(writer, first, inner, { style: place.container, numbering: { reference: numbering.reference, instance: numbering.instance, level: depth } })
          : paragraph(writer, first, inner, { style: place.container ?? 'ListParagraph', prefix: item.attrs?.checked ? '\u2612 ' : '\u2610 ' })
      )
    } else if (first) {
      rest.unshift(first)
    }

    for (const child of rest) {
      append(out, block(writer, child, inner))
    }
  }

  return out
}

/** Columns' widths in twips: their cells' widths where they have them, the rest of the page's text width shared out. */
function columnWidths(rows: readonly DocNode[], textWidth: number): number[] {
  const widths: (number | null)[] = []
  const taken = new Set<string>()

  rows.forEach((row, rowIndex) => {
    let column = 0

    for (const cell of row.content ?? []) {
      while (taken.has(`${rowIndex}:${column}`)) {
        column++
      }

      const span = Math.max(1, Number(cell.attrs?.colspan ?? 1) || 1)
      const rowspan = Math.max(1, Number(cell.attrs?.rowspan ?? 1) || 1)
      const colwidth = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs.colwidth as unknown[]) : []

      for (let offset = 0; offset < span; offset++) {
        const width = finite(colwidth[offset])
        widths[column + offset] ??= width && width > 0 ? pixelsToTwips(width) : null

        for (let below = 0; below < rowspan; below++) {
          taken.add(`${rowIndex + below}:${column + offset}`)
        }
      }

      column += span
    }
  })

  const known = widths.reduce<number>((sum, width) => sum + (width ?? 0), 0)
  const missing = widths.filter((width) => width === null).length
  const share = missing ? Math.max(720, Math.round((textWidth - known) / missing)) : 0

  return widths.length ? Array.from(widths, (width) => width ?? share) : [textWidth]
}

function tableCell(writer: Writer, cell: DocNode): TableCell {
  const attrs = cell.attrs ?? {}
  const children = blocks(writer, cell.content ?? [], { depth: -1, align: attrs.align })
  const background = hexColor(attrs.background)
  const colspan = Number(attrs.colspan ?? 1)
  const rowspan = Number(attrs.rowspan ?? 1)

  // Word wants every cell to end with a paragraph.
  if (!children.length || children[children.length - 1] instanceof Table) {
    children.push(new Paragraph({}))
  }

  return new TableCell({
    children,
    ...(colspan > 1 ? { columnSpan: colspan } : {}),
    ...(rowspan > 1 ? { rowSpan: rowspan } : {}),
    ...(background ? { shading: { type: ShadingType.CLEAR, fill: hex(background), color: 'auto' } } : {})
  })
}

function table(writer: Writer, node: DocNode, place: Place): Table {
  const rows = node.content ?? []
  const widths = columnWidths(rows, writer.textWidth)
  const isHeader = (row: DocNode): boolean => Boolean(row.content?.length) && (row.content ?? []).every((cell) => cell.type === 'tableHeader')
  const headerRows = rows.findIndex((row) => !isHeader(row))
  const repeated = headerRows === -1 ? rows.length : headerRows
  flattened(writer, place)

  if (rows.some((row, index) => index >= repeated && row.content?.some((cell) => cell.type === 'tableHeader'))) {
    writer.losses.add('headerCells')
  }

  return new Table({
    rows: rows.map((row, index) => new TableRow({ ...(index < repeated ? { tableHeader: true } : {}), children: (row.content ?? []).map((cell) => tableCell(writer, cell)) })),
    columnWidths: widths,
    width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    ...(node.attrs?.borders === false ? { borders: TableBorders.NONE } : {}),
    ...(place.depth >= 0 ? { indent: { size: levelIndent(place.depth), type: WidthType.DXA } } : {})
  })
}

function container(writer: Writer, node: DocNode, style: string, place: Place): Block[] {
  flattened(writer, place)

  return blocks(writer, node.content ?? [], { container: style, depth: -1, align: place.align })
}

const RULE = { style: BorderStyle.SINGLE, size: 6, color: 'auto', space: 1 }

function block(writer: Writer, node: DocNode, place: Place): Block[] {
  switch (node.type) {
    case 'paragraph':
      // A paragraph in a list item after its first is indented as the item's text, without a number.
      return [paragraph(writer, node, place, place.depth >= 0 ? { style: place.container ?? 'ListParagraph' } : {})]
    case 'heading':
      return [heading(writer, node, place)]
    case 'blockquote':
      return container(writer, node, 'Quote', place)
    case 'callout':
      return container(writer, node, calloutStyle(node.attrs?.kind), place)
    case 'codeBlock':
      return code(writer, node, place)
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return list(writer, node, place)
    case 'table':
      return [table(writer, node, place)]
    case 'horizontalRule':
      return [new Paragraph({ style: place.container, ...(place.depth >= 0 ? { indent: { left: levelIndent(place.depth) } } : {}), border: { bottom: RULE } })]
    case 'pageBreak':
      return [new Paragraph({ style: place.container, children: [new PageBreak()] })]
    default:
      return node.content ? blocks(writer, node.content, place) : []
  }
}

function blocks(writer: Writer, nodes: readonly DocNode[], place: Place): Block[] {
  const out: Block[] = []

  for (const node of nodes) {
    append(out, block(writer, node, place))
  }

  return out
}

// Styles and the page.

const CALLOUT_COLORS: Readonly<Record<CalloutKind, { border: string; fill: string }>> = {
  info: { border: '3B82F6', fill: 'EFF6FF' },
  note: { border: '8B5CF6', fill: 'F5F3FF' },
  success: { border: '22C55E', fill: 'F0FDF4' },
  warning: { border: 'F59E0B', fill: 'FFFBEB' },
  error: { border: 'EF4444', fill: 'FEF2F2' }
}

function runOfLook(look: StyleLook, normal: StyleLook | null): IRunStylePropertiesOptions {
  const color = hexColor(look.color)

  return {
    ...(look.font ? { font: look.font } : {}),
    ...(look.size ? { size: Math.round(look.size * 2) } : {}),
    ...(color ? { color: hex(color) } : {}),
    // Bold and italic are written off only where Normal would give them.
    ...(look.bold || (look.bold === false && normal?.bold) ? { bold: Boolean(look.bold) } : {}),
    ...(look.italic || (look.italic === false && normal?.italic) ? { italics: Boolean(look.italic) } : {})
  }
}

const spacingOfLook = (look: StyleLook): IParagraphOptions['spacing'] => spacingOf(look.spaceBefore ?? null, look.spaceAfter ?? null, look.lineHeight ?? null)

function stylesFor(looks: Record<StyleName, StyleLook>): IStylesOptions {
  const normal = looks.normal

  const style = (id: string, name: string, look: StyleLook, paragraph: IParagraphStylePropertiesOptions = {}): IParagraphStyleOptions => {
    const spacing = spacingOfLook(look)

    return { id, name, basedOn: 'Normal', next: 'Normal', quickFormat: true, run: runOfLook(look, normal), paragraph: { ...paragraph, ...(spacing ? { spacing } : {}) } }
  }

  const headings = [1, 2, 3, 4, 5, 6].map((level) =>
    style(`Heading${level}`, `heading ${level}`, looks[`heading${level}` as StyleName], { outlineLevel: level - 1, keepNext: true, keepLines: true })
  )
  const callouts = CALLOUT_KINDS.map((kind) =>
    style(calloutStyle(kind), `Callout ${capitalised(kind)}`, {}, {
      border: { left: { style: BorderStyle.SINGLE, size: 24, color: CALLOUT_COLORS[kind].border, space: 8 } },
      shading: { type: ShadingType.CLEAR, fill: CALLOUT_COLORS[kind].fill, color: 'auto' }
    })
  )

  return {
    default: { document: { run: runOfLook({ font: normal.font, size: normal.size }, null), paragraph: { spacing: spacingOfLook(normal) } } },
    paragraphStyles: [
      { id: 'Normal', name: 'Normal', quickFormat: true, run: runOfLook(normal, null), paragraph: { spacing: spacingOfLook(normal) } },
      style('Title', 'Title', looks.title),
      style('Subtitle', 'Subtitle', looks.subtitle),
      ...headings,
      // List items sit close together, as the editor shows them.
      { id: 'ListParagraph', name: 'List Paragraph', basedOn: 'Normal', quickFormat: true, paragraph: { contextualSpacing: true } },
      style('Quote', 'Quote', looks.quote, { indent: { left: LIST_INDENT }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'BFBFBF', space: 12 } } }),
      { ...style('SourceCode', 'Source Code', looks.code, { shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } }), next: 'SourceCode' },
      ...callouts
    ],
    characterStyles: [
      { id: 'VerbatimChar', name: 'Verbatim Char', run: { font: looks.code.font ?? CODE_FONT } },
      { id: 'Hyperlink', name: 'Hyperlink', run: { color: '0563C1', underline: { type: UnderlineType.SINGLE } } }
    ]
  }
}

function sectionFor(page: PageSettings): ISectionPropertiesOptions {
  const landscape = page.width > page.height
  // The docx package swaps the two sides of a landscape page itself.
  const size = landscape
    ? { width: pointsToTwips(page.height), height: pointsToTwips(page.width), orientation: PageOrientation.LANDSCAPE }
    : { width: pointsToTwips(page.width), height: pointsToTwips(page.height), orientation: PageOrientation.PORTRAIT }
  const { top, right, bottom, left } = page.margins

  return { page: { size, margin: { top: pointsToTwips(top), right: pointsToTwips(right), bottom: pointsToTwips(bottom), left: pointsToTwips(left) } } }
}

/** A Word file of a Herald Docs document, with what the file cannot keep of it. */
export async function docxFromDocument(doc: DocJSON): Promise<{ bytes: Uint8Array; losses: string[] }> {
  const page = pageOf(doc)
  const writer: Writer = {
    looks: looksOf(doc),
    textWidth: Math.max(1440, pointsToTwips(page.width - page.margins.left - page.margins.right)),
    losses: new Set(),
    numbering: [],
    bulletLists: 0,
    pictures: 0
  }
  const children = blocks(writer, doc.content ?? [], { depth: -1 })

  // Word keeps a paragraph after a table that ends a document.
  if (!children.length || children[children.length - 1] instanceof Table) {
    children.push(new Paragraph({}))
  }

  const file = new Document({
    creator: '',
    lastModifiedBy: '',
    styles: stylesFor(writer.looks),
    numbering: { config: writer.numbering },
    sections: [{ properties: sectionFor(page), children }]
  })
  const bytes = await Packer.pack(file, 'uint8array')

  return { bytes, losses: (Object.keys(LOSSES) as LossKey[]).filter((key) => writer.losses.has(key)).map((key) => LOSSES[key]) }
}
