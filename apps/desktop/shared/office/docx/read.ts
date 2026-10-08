import { type DocJSON, type DocMark, type DocNode, HERALD_LOOKS, joinText, type PageSettings, paragraphNode, round, type StyleLook, type StyleLooks, type StyleName, textNode } from '../document.ts'
import { assemble, type Entry, type ListMark } from './blocks.ts'
import { alternative, type Drawn, type Picture, readDrawing, readObject, readVml, type Story } from './drawing.ts'
import { fidelityNotes, type NoteKey, packageNotes } from './fidelity.ts'
import { listKind, numberLabel, type Numbering, readNumbering } from './numbering.ts'
import { NOT_WORD, openPackage, type Relationship, relationshipKind, type WordPackage } from './package.ts'
import {
  borderSides,
  flag,
  heraldStyleOf,
  intOf,
  isOn,
  lineMultiple,
  lookOf,
  mergePara,
  type ParagraphStyle,
  type ParaProps,
  paraProps,
  readStyles,
  resolveRun,
  type RunProps,
  runProps,
  shadingOf,
  type StyleRole,
  type Styles
} from './styles.ts'
import { measure, pointsToPixels, twipsToPoints } from './units.ts'
import { attr, child, children, findAll, textOf, type XmlElement } from './xml.ts'

/*
 * Word documents (.docx) as Herald Docs documents. A paragraph in one of Word's styles Herald has
 * (Title, Subtitle, headings, Quote, code, callouts) takes that style, and other styles become the
 * formatting they give; numbering becomes lists, tables keep their spans, header rows and shading,
 * and pictures come in the line. What Herald Docs cannot show the way Word does (fields, text
 * boxes, footnotes, tracked changes) is shown as near as it can be, and said in the notes.
 */

interface Field {
  instruction: string
  /** Whether the result, what Word last showed for the field, has begun. */
  result: boolean
  link: string | null
}

interface NoteReference {
  kind: 'footnote' | 'endnote'
  id: string
}

interface Reader {
  styles: Styles
  numbering: Numbering
  /** The look the file gives each of Herald's styles. */
  looks: StyleLooks
  found: Set<NoteKey>
  /** Styles Herald Docs does not have, in the order the text uses them. */
  unknown: string[]
  /** Complex fields open at this point of the text, which can span paragraphs. */
  fields: Field[]
  references: NoteReference[]
  sections: XmlElement[]
  /** The page break each section but the last ends with. */
  breaks: Entry[]
}

/** How the runs of one paragraph are read. */
interface Inline {
  look: StyleLook
  paraRun: RunProps
  href: string | null
  /** A code paragraph keeps its text only. */
  code: boolean
}

/** A paragraph's content as read: inline nodes, with null where a page break splits it. */
interface Line {
  nodes: (DocNode | null)[]
  boxes: XmlElement[]
  rule: boolean
}

const append = <T>(out: T[], items: readonly T[]): void => {
  for (const item of items) {
    out.push(item)
  }
}

const remember = (reader: Reader, name: string): void => {
  if (!reader.unknown.includes(name)) {
    reader.unknown.push(name)
  }
}

/** The look a paragraph's runs are measured against: its Herald style's, over Normal's. */
function lookFor(reader: Reader, name: StyleName, style: ParagraphStyle): StyleLook {
  // A heading in a style of the file's own (with an outline level) gives the look when Word's heading style is missing.
  reader.looks[name] ??= lookOf(style, reader.styles, name)

  return { bold: false, italic: false, ...HERALD_LOOKS.normal, ...reader.looks.normal, ...HERALD_LOOKS[name], ...reader.looks[name] }
}

// Links, fields and marks.

const UNSAFE_LINK = /^\s*(javascript|vbscript|data):/i

const safeHref = (href: string | null): string | null => (href && !UNSAFE_LINK.test(href) ? href.trim() || null : null)

/** Colours Word and Google Docs give links, which the editor shows its own way. */
const LINK_COLORS = new Set(['#0563c1', '#0000ff', '#0000ee', '#467886', '#1155cc', '#954f72'])

const unquote = (token: string): string => (token.startsWith('"') && token.endsWith('"') && token.length > 1 ? token.slice(1, -1) : token)

/** A field's kind, and for HYPERLINK its address and the place inside the document it points at. */
function parseField(instruction: string): { kind: string; url: string | null; anchor: string | null } {
  const tokens = instruction.match(/"[^"]*"|\S+/g) ?? []
  let url: string | null = null
  let anchor: string | null = null

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]

    if (token.startsWith('\\')) {
      if (/^\\l$/i.test(token)) {
        anchor = unquote(tokens[++i] ?? '')
      } else if (/^\\[ot]$/i.test(token)) {
        i++
      }
    } else {
      url ??= unquote(token)
    }
  }

  return { kind: (tokens[0] ?? '').toUpperCase(), url: safeHref(url && anchor ? `${url}#${anchor}` : url), anchor }
}

const inFieldResult = (reader: Reader): boolean => reader.fields.some((field) => field.result)

function interpret(field: Field, reader: Reader): void {
  const parsed = parseField(field.instruction)

  if (parsed.kind === 'HYPERLINK') {
    field.link = parsed.url

    // A table of contents' links to its headings are part of the field, which has a note of its own.
    if (!parsed.url && parsed.anchor && !reader.fields.some((other) => other !== field && other.result)) {
      reader.found.add('internalLinks')
    }
  } else if (parsed.kind) {
    reader.found.add('fields')
  }
}

function fieldChar(element: XmlElement, reader: Reader): void {
  const type = attr(element, 'w:fldCharType')

  if (type === 'begin') {
    reader.fields.push({ instruction: '', result: false, link: null })
  } else if (type === 'separate') {
    const field = reader.fields.at(-1)

    if (field && !field.result) {
      field.result = true
      interpret(field, reader)
    }
  } else if (type === 'end') {
    const field = reader.fields.pop()

    if (field && !field.result) {
      interpret(field, reader)
    }
  }
}

function fieldLink(reader: Reader): string | null {
  for (let i = reader.fields.length - 1; i >= 0; i--) {
    if (reader.fields[i].result && reader.fields[i].link) {
      return reader.fields[i].link
    }
  }

  return null
}

/** The marks a run needs for what its formatting adds to the look of its paragraph's style. */
function marksOf(props: RunProps, code: boolean, look: StyleLook, href: string | null): DocMark[] {
  const marks: DocMark[] = href ? [{ type: 'link', attrs: { href } }] : []

  if (code) {
    marks.push({ type: 'code' })

    return marks
  }

  const style: Record<string, string> = {}
  const color = props.color ?? null

  if (color && color !== (look.color ?? '#000000') && !(href && LINK_COLORS.has(color))) {
    style.color = color
  }

  if (props.font && props.font !== look.font) {
    style.fontFamily = props.font
  }

  if (props.size && props.size !== look.size) {
    style.fontSize = `${props.size}pt`
  }

  if (Object.keys(style).length) {
    marks.push({ type: 'textStyle', attrs: style })
  }

  if (props.bold && !look.bold) {
    marks.push({ type: 'bold' })
  }

  if (props.italic && !look.italic) {
    marks.push({ type: 'italic' })
  }

  if (props.underline && !href) {
    marks.push({ type: 'underline' })
  }

  if (props.strike) {
    marks.push({ type: 'strike' })
  }

  // White shading behind a run is how some programs write no shading at all.
  const background = props.highlight ?? (props.shade === '#ffffff' ? null : props.shade)

  if (background) {
    marks.push({ type: 'highlight', attrs: { color: background } })
  }

  if (props.script) {
    marks.push({ type: props.script })
  }

  return marks
}

// Runs.

/** The text of a w:t: whitespace at its ends only counts when it says to keep it, as Word reads it. */
function runText(element: XmlElement): string {
  const raw = textOf(element)

  return attr(element, 'xml:space') === 'preserve' ? raw.replace(/[\r\n]/g, ' ') : raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').replace(/[ \t]*[\r\n]+[ \t]*/g, ' ')
}

const visible = (element: XmlElement): boolean => element.name === 'w:t' || element.name === 'w:drawing' || element.name === 'w:pict' || element.name === 'w:tab'

function drawn(result: Drawn, line: Line, inline: Inline): void {
  if (!inline.code) {
    append(line.nodes, result.images)
  }

  append(line.boxes, result.boxes)
  line.rule ||= result.rule
}

function reference(element: XmlElement, reader: Reader, line: Line): void {
  reader.found.add('notes')
  reader.references.push({ kind: element.name === 'w:footnoteReference' ? 'footnote' : 'endnote', id: attr(element, 'w:id') ?? '' })

  // A note with a mark of its own has the mark as the text after it.
  if (!isOn(attr(element, 'w:customMarkFollows'))) {
    line.nodes.push(textNode(String(reader.references.length), [{ type: 'superscript' }]))
  }
}

function readRunChild(element: XmlElement, reader: Reader, story: Story, inline: Inline, line: Line, marks: () => DocMark[]): void {
  const push = (text: string): void => {
    if (text) {
      line.nodes.push(textNode(text, marks()))
    }
  }

  switch (element.name) {
    case 'w:t':
      push(runText(element))
      break
    case 'w:tab':
    case 'w:ptab':
      push('\t')
      break
    case 'w:br': {
      const type = attr(element, 'w:type')

      if (type === 'page') {
        line.nodes.push(null)
      } else if (type !== 'column') {
        line.nodes.push(inline.code ? textNode('\n') : { type: 'hardBreak' })
      }

      break
    }
    case 'w:cr':
      line.nodes.push(inline.code ? textNode('\n') : { type: 'hardBreak' })
      break
    case 'w:noBreakHyphen':
      push('\u2011')
      break
    case 'w:softHyphen':
      push('\u00ad')
      break
    case 'w:sym': {
      const code = Number.parseInt(attr(element, 'w:char') ?? '', 16)

      if (code > 0) {
        push(String.fromCodePoint(code))
      }

      break
    }
    case 'w:drawing':
      drawn(readDrawing(element, story, reader.found), line, inline)
      break
    case 'w:pict':
      drawn(readVml(element, story, reader.found), line, inline)
      break
    case 'w:object':
      drawn(readObject(element, story, reader.found), line, inline)
      break
    case 'w:footnoteReference':
    case 'w:endnoteReference':
      reference(element, reader, line)
      break
    case 'w:commentReference':
      reader.found.add('comments')
      break
    case 'w:delText':
      reader.found.add('trackedChanges')
      break
    case 'w:ruby':
      readContent(child(element, 'w:rubyBase'), reader, story, inline, line)
      break
    case 'mc:AlternateContent':
      for (const item of children(alternative(element))) {
        readRunChild(item, reader, story, inline, line, marks)
      }

      break
  }
}

function readRun(run: XmlElement, reader: Reader, story: Story, inline: Inline, line: Line): void {
  const rPr = child(run, 'w:rPr')
  const style = reader.styles.character(attr(child(rPr, 'w:rStyle'), 'w:val'))
  const props = resolveRun(reader.styles.defaults.run, inline.paraRun, style?.run ?? null, runProps(rPr, reader.styles.theme))
  const marks = (): DocMark[] => (inline.code ? [] : marksOf(props, style?.role === 'code', inline.look, inline.href ?? fieldLink(reader)))

  if (style?.role === 'custom') {
    remember(reader, style.name)
  }

  if (child(rPr, 'w:rPrChange')) {
    reader.found.add('trackedChanges')
  }

  for (const element of children(run)) {
    if (element.name === 'w:fldChar') {
      fieldChar(element, reader)
    } else if (element.name === 'w:instrText') {
      const field = reader.fields.at(-1)

      if (field && !field.result) {
        field.instruction += textOf(element)
      }
    } else if (element.name !== 'w:rPr' && !reader.fields.some((field) => !field.result)) {
      if (props.hidden) {
        if (visible(element)) {
          reader.found.add('hiddenText')
        }
      } else {
        readRunChild(element, reader, story, inline, line, marks)
      }
    }
  }
}

function readHyperlink(element: XmlElement, reader: Reader, story: Story, inline: Inline, line: Line): void {
  const relationship = story.relationships.get(attr(element, 'r:id') ?? '')
  const anchor = attr(element, 'w:anchor')
  const href = relationship ? safeHref(anchor ? `${relationship.target}#${anchor}` : relationship.target) : null

  if (!relationship && anchor && !inFieldResult(reader)) {
    reader.found.add('internalLinks')
  }

  readContent(element, reader, story, href ? { ...inline, href } : inline, line)
}

function readSimpleField(element: XmlElement, reader: Reader, story: Story, inline: Inline, line: Line): void {
  const field = parseField(attr(element, 'w:instr') ?? '')

  if (field.kind === 'HYPERLINK') {
    if (!field.url && field.anchor && !inFieldResult(reader)) {
      reader.found.add('internalLinks')
    }
  } else if (field.kind) {
    reader.found.add('fields')
  }

  readContent(element, reader, story, field.url ? { ...inline, href: field.url } : inline, line)
}

/** A content control's content; building blocks such as a table of contents are not form controls. */
function controlled(sdt: XmlElement, reader: Reader): XmlElement | undefined {
  if (!child(child(sdt, 'w:sdtPr'), 'w:docPartObj')) {
    reader.found.add('contentControls')
  }

  return child(sdt, 'w:sdtContent')
}

/** What a paragraph (or a hyperlink, field or content control in it) holds. */
function readContent(parent: XmlElement | undefined, reader: Reader, story: Story, inline: Inline, line: Line): void {
  for (const element of children(parent)) {
    switch (element.name) {
      case 'w:r':
        readRun(element, reader, story, inline, line)
        break
      case 'w:hyperlink':
        readHyperlink(element, reader, story, inline, line)
        break
      case 'w:fldSimple':
        readSimpleField(element, reader, story, inline, line)
        break
      case 'w:sdt':
        readContent(controlled(element, reader), reader, story, inline, line)
        break
      case 'w:ins':
      case 'w:moveTo':
        reader.found.add('trackedChanges')
        readContent(element, reader, story, inline, line)
        break
      case 'w:del':
      case 'w:moveFrom':
        reader.found.add('trackedChanges')
        break
      case 'w:smartTag':
      case 'w:customXml':
      case 'w:dir':
      case 'w:bdo':
        readContent(element, reader, story, inline, line)
        break
      case 'm:oMath':
      case 'm:oMathPara': {
        reader.found.add('equations')
        const text = findAll(element, 'm:t').map(textOf).join('')

        if (text) {
          line.nodes.push(textNode(text))
        }

        break
      }
      case 'mc:AlternateContent':
        readContent(alternative(element), reader, story, inline, line)
        break
      case 'w:commentRangeStart':
      case 'w:commentRangeEnd':
        reader.found.add('comments')
        break
    }
  }
}

// Paragraphs.

/** A paragraph's style, made a heading by an outline level of its own. */
function roleOf(style: ParagraphStyle, direct: ParaProps): StyleRole {
  const plain = style.role.kind === 'normal' || style.role.kind === 'custom'

  return plain && direct.outline !== undefined && direct.outline < 9 ? { kind: 'heading', level: direct.outline + 1 } : style.role
}

/** The numbering a paragraph has, directly or from its style; numId 0 takes it away. */
function numberingOf(reader: Reader, style: ParagraphStyle, direct: ParaProps): { numId: string; ilvl: number } | null {
  const numId = direct.numId ?? style.para.numId

  if (!numId || numId === '0') {
    return null
  }

  const ilvl = direct.ilvl ?? style.para.ilvl ?? reader.numbering.levelOfStyle(numId, style.id) ?? 0

  return { numId, ilvl: Math.max(0, Math.min(8, ilvl)) }
}

const BOX = /^[\u2610\u2611\u2612][ \u00a0\t]$/

/** Whether a paragraph starts with a ballot box and a space, as Herald writes checklists; takes the box away. */
function taskBox(nodes: (DocNode | null)[]): boolean | null {
  const texts: DocNode[] = []

  for (const node of nodes) {
    if (node?.type !== 'text') {
      break
    }

    texts.push(node)
  }

  const head = texts
    .map((node) => node.text ?? '')
    .join('')
    .slice(0, 2)

  if (!BOX.test(head)) {
    return null
  }

  let remove = 2

  for (const node of texts) {
    const cut = Math.min(remove, (node.text ?? '').length)
    node.text = (node.text ?? '').slice(cut)
    remove -= cut

    if (!remove) {
      break
    }
  }

  return head[0] !== '\u2610'
}

const hasBottomBorder = (pPr: XmlElement | undefined): boolean => borderSides(child(pPr, 'w:pBdr'))['w:bottom'] === true

const twipsOf = (points: number | undefined): number => Math.round((points ?? 0) * 20)

function blockAttrs(props: ParaProps, look: StyleLook, role: StyleRole, indents: { keep: boolean; base: ParaProps }): Record<string, unknown> {
  const attrs: Record<string, unknown> = {}
  const size = look.size ?? 11

  if (props.align && props.align !== 'left') {
    attrs.textAlign = props.align
  }

  if (role.kind === 'title' || role.kind === 'subtitle') {
    attrs.docStyle = role.kind
  }

  const lineHeight = lineMultiple(props.line, size) ?? 1

  if (lineHeight !== (look.lineHeight ?? 1)) {
    attrs.lineHeight = lineHeight
  }

  if ((props.spaceBefore ?? 0) !== (look.spaceBefore ?? 0)) {
    attrs.spaceBefore = props.spaceBefore ?? 0
  }

  if ((props.spaceAfter ?? 0) !== (look.spaceAfter ?? 0)) {
    attrs.spaceAfter = props.spaceAfter ?? 0
  }

  if (indents.keep) {
    const indent = round((props.indent ?? 0) - (indents.base.indent ?? 0))
    const firstLine = round((props.firstLine ?? 0) - (indents.base.firstLine ?? 0))

    if (indent) {
      attrs.indent = indent
    }

    if (firstLine) {
      attrs.firstLine = firstLine
    }
  }

  return attrs
}

function textBlock(nodes: DocNode[], role: StyleRole, attrs: Record<string, unknown>): DocNode {
  if (role.kind !== 'heading') {
    return paragraphNode(nodes, attrs)
  }

  const heading: DocNode = { type: 'heading', attrs: { level: Math.min(6, role.level), ...attrs } }

  if (nodes.length) {
    heading.content = nodes
  }

  return heading
}

const codeText = (nodes: DocNode[]): string => nodes.map((node) => (node.type === 'text' ? (node.text ?? '') : '')).join('')

/** Splits a paragraph's content at its page breaks, leaving no empty paragraph beside one. */
function pieces(nodes: (DocNode | null)[]): (DocNode[] | null)[] {
  const out: (DocNode[] | null)[] = []
  let current: DocNode[] = []

  for (const node of nodes) {
    if (node === null) {
      out.push(current, null)
      current = []
    } else {
      current.push(node)
    }
  }

  out.push(current)

  return out.length === 1 ? out : out.filter((piece) => piece === null || joinText(piece).length > 0)
}

/**
 * A paragraph's place in a list, from its numbering or a checklist box at its start, and the indent
 * its text starts at. Numbered headings keep their number as text instead.
 */
function listOf(reader: Reader, style: ParagraphStyle, direct: ParaProps, role: StyleRole, line: Line): { mark?: ListMark; indent: number } {
  const numbered = role.kind === 'code' ? null : numberingOf(reader, style, direct)
  const level = numbered ? reader.numbering.level(numbered.numId, numbered.ilvl) : undefined
  let indent = twipsOf(mergePara(reader.styles.defaults.para, style.para, direct).indent)
  let mark: ListMark | undefined

  if (numbered && level) {
    const counts = reader.numbering.count(numbered.numId, numbered.ilvl)
    const kind = listKind(level)

    if (role.kind === 'heading' || role.kind === 'title' || role.kind === 'subtitle') {
      const label = numberLabel(reader.numbering, numbered.numId, numbered.ilvl, counts)

      if (label) {
        reader.found.add('headingNumbers')
        line.nodes.unshift(textNode(`${label} `))
      }
    } else if (kind.kind !== 'none') {
      if (kind.kind === 'ordered' && kind.approximate) {
        reader.found.add('listNumbers')
      }

      mark = { kind: kind.kind, depth: numbered.ilvl, key: numbered.numId, type: kind.kind === 'ordered' ? kind.type : null, value: counts[numbered.ilvl] }
      indent = twipsOf(mergePara(reader.styles.defaults.para, style.para, paraProps(level.pPr), direct).indent)
    }
  }

  const checked = role.kind === 'heading' || role.kind === 'code' ? null : taskBox(line.nodes)

  if (checked !== null) {
    // A checklist item without a number takes its depth from its indent, as Herald writes them.
    mark = { kind: 'task', depth: mark?.depth ?? Math.max(0, Math.round(indent / 720) - 1), key: 'task', checked }
  }

  return { mark, indent }
}

function readParagraph(p: XmlElement, reader: Reader, story: Story): Entry[] {
  const pPr = child(p, 'w:pPr')
  const style = reader.styles.paragraph(attr(child(pPr, 'w:pStyle'), 'w:val'))
  const direct = paraProps(pPr)
  const role = roleOf(style, direct)
  const props = mergePara(reader.styles.defaults.para, style.para, direct)
  const paragraphMark = child(pPr, 'w:rPr')

  if (role.kind === 'custom') {
    remember(reader, style.name)
  }

  if (role.kind === 'heading' && role.level > 6) {
    reader.found.add('deepHeadings')
  }

  if (child(pPr, 'w:pPrChange') || child(paragraphMark, 'w:ins') || child(paragraphMark, 'w:del')) {
    reader.found.add('trackedChanges')
  }

  const look = lookFor(reader, heraldStyleOf(role), style)
  const line: Line = { nodes: [], boxes: [], rule: false }
  readContent(p, reader, story, { look, paraRun: style.run, href: null, code: role.kind === 'code' }, line)

  const entries: Entry[] = []
  const container = role.kind === 'quote' ? 'quote' : role.kind === 'callout' ? role.callout : undefined
  const { mark, indent } = listOf(reader, style, direct, role, line)

  if (props.pageBreakBefore) {
    entries.push({ kind: 'block', node: { type: 'pageBreak' } })
  }

  const parts = pieces(line.nodes)
  const empty = parts.length === 1 && parts[0] !== null && !joinText(parts[0]).length
  const deletedMark = child(paragraphMark, 'w:del') !== undefined
  const base = role.kind === 'quote' || role.kind === 'callout' || role.kind === 'code' ? style.para : {}
  const attrs = blockAttrs(props, look, role, { keep: !mark, base })
  const listParagraph = /^list ?paragraph$/i.test(style.name) || style.id === 'ListParagraph'

  if (line.rule || (empty && hasBottomBorder(pPr) && !mark)) {
    if (!empty) {
      entries.push({ kind: 'text', node: textBlock(joinText(parts[0] ?? []), role, attrs), container })
    }

    entries.push({ kind: 'block', node: { type: 'horizontalRule' }, container })
  } else if (!(empty && deletedMark)) {
    parts.forEach((part, index) => {
      const attached = index > 0

      if (part === null) {
        entries.push({ kind: 'block', node: { type: 'pageBreak' }, container, attached })
      } else if (role.kind === 'code') {
        entries.push({ kind: 'code', line: codeText(joinText(part)), container, indent, attached })
      } else {
        const node = textBlock(joinText(part), role, attrs)
        entries.push({ kind: 'text', node, container, list: attached ? undefined : mark, style: style.id, indent, listParagraph, attached })
      }
    })
  }

  for (const box of line.boxes) {
    append(entries, readBlocks(box, reader, story))
  }

  const section = child(pPr, 'w:sectPr')

  if (section) {
    const pageBreak: Entry = { kind: 'block', node: { type: 'pageBreak' } }
    reader.sections.push(section)
    reader.breaks.push(pageBreak)
    entries.push(pageBreak)
  }

  return entries
}

// Tables.

const pixelsOf = (twips: string | undefined): number | null => {
  const points = twipsToPoints(twips)

  return points && points > 0 ? Math.round(pointsToPixels(points)) : null
}

const emptyCell = (header: boolean, span: number): DocNode => ({ type: header ? 'tableHeader' : 'tableCell', ...(span > 1 ? { attrs: { colspan: span } } : {}), content: [paragraphNode()] })

const TABLE_CHANGES = new Set(['w:ins', 'w:del', 'w:tblPrChange', 'w:tblGridChange', 'w:trPrChange', 'w:tcPrChange', 'w:cellIns', 'w:cellDel', 'w:cellMerge'])

/** Notes tracked changes to a table's, row's or cell's properties, which are shown accepted like the rest. */
function trackTable(properties: XmlElement | undefined, reader: Reader): void {
  if (children(properties).some((element) => TABLE_CHANGES.has(element.name))) {
    reader.found.add('trackedChanges')
  }
}

/** Rows (or cells) of a table, with content controls and custom XML around them unwrapped. */
function unwrapped(parent: XmlElement | undefined, name: string, reader: Reader): XmlElement[] {
  const out: XmlElement[] = []

  for (const element of children(parent)) {
    if (element.name === name) {
      out.push(element)
    } else if (element.name === 'w:sdt') {
      append(out, unwrapped(controlled(element, reader), name, reader))
    } else if (element.name === 'w:customXml') {
      append(out, unwrapped(element, name, reader))
    }
  }

  return out
}

/** Word ends a cell (and a document) that ends with a table with an empty paragraph Herald Docs does not need. */
function withoutClosingParagraph(blocks: DocNode[]): DocNode[] {
  const last = blocks[blocks.length - 1]

  return blocks.length > 1 && last.type === 'paragraph' && !last.content && !last.attrs && blocks[blocks.length - 2].type === 'table' ? blocks.slice(0, -1) : blocks
}

function readCell(cell: XmlElement, header: boolean, span: number, colwidth: number[] | null, reader: Reader, story: Story): DocNode {
  const tcPr = child(cell, 'w:tcPr')
  const attrs: Record<string, unknown> = {}
  const background = shadingOf(child(tcPr, 'w:shd'))
  const content = withoutClosingParagraph(assemble(readBlocks(cell, reader, story)))

  if (span > 1) {
    attrs.colspan = span
  }

  if (colwidth) {
    attrs.colwidth = colwidth
  }

  if (background) {
    attrs.background = background
  }

  return { type: header ? 'tableHeader' : 'tableCell', ...(Object.keys(attrs).length ? { attrs } : {}), content: content.length ? content : [paragraphNode()] }
}

/** Rows made as wide as the table, counting cells that reach down from rows above. */
function padRows(rows: DocNode[], columns: number): void {
  const carried = rows.map(() => 0)

  rows.forEach((row, index) => {
    const cells = row.content ?? []
    let width = carried[index]

    for (const cell of cells) {
      const span = Number(cell.attrs?.colspan ?? 1)
      width += span

      for (let below = 1; below < Number(cell.attrs?.rowspan ?? 1) && index + below < rows.length; below++) {
        carried[index + below] += span
      }
    }

    if (width < columns) {
      row.content = [...cells, emptyCell(cells.length > 0 && cells.every((cell) => cell.type === 'tableHeader'), columns - width)]
    }
  })
}

function readTable(table: XmlElement, reader: Reader, story: Story): DocNode | null {
  const tblPr = child(table, 'w:tblPr')
  const grid = children(child(table, 'w:tblGrid'), 'w:gridCol').map((column) => pixelsOf(attr(column, 'w:w')))
  trackTable(tblPr, reader)
  trackTable(child(table, 'w:tblGrid'), reader)
  const sides = { ...reader.styles.tableBorders(attr(child(tblPr, 'w:tblStyle'), 'w:val')), ...borderSides(child(tblPr, 'w:tblBorders')) }
  let borders = Object.values(sides).some(Boolean)
  const rows: DocNode[] = []
  // The cell each grid column's vertical merge grows, by the column it starts at.
  const merges = new Map<number, DocNode>()
  let columns = grid.length

  const widths = (column: number, span: number, cellWidth: number | null): number[] | null => {
    const known = grid.slice(column, column + span)

    if (known.length === span && known.every((width) => width)) {
      return known as number[]
    }

    return cellWidth ? Array.from({ length: span }, () => Math.round(cellWidth / span)) : null
  }

  for (const row of unwrapped(table, 'w:tr', reader)) {
    const trPr = child(row, 'w:trPr')
    trackTable(trPr, reader)

    if (child(trPr, 'w:del')) {
      continue
    }

    const header = flag(child(trPr, 'w:tblHeader')) === true
    const before = intOf(attr(child(trPr, 'w:gridBefore'), 'w:val')) ?? 0
    const after = intOf(attr(child(trPr, 'w:gridAfter'), 'w:val')) ?? 0
    const cells: DocNode[] = before > 0 ? [emptyCell(header, before)] : []
    let column = before

    for (const cell of unwrapped(row, 'w:tc', reader)) {
      const tcPr = child(cell, 'w:tcPr')
      const span = Math.max(1, intOf(attr(child(tcPr, 'w:gridSpan'), 'w:val')) ?? 1)
      trackTable(tcPr, reader)
      const vMerge = child(tcPr, 'w:vMerge')
      const merge = vMerge ? (attr(vMerge, 'w:val') ?? 'continue') : null
      const above = merges.get(column)

      if (merge === 'continue' && above) {
        above.attrs = { ...above.attrs, rowspan: Number(above.attrs?.rowspan ?? 1) + 1 }
        column += span
        continue
      }

      const tcW = child(tcPr, 'w:tcW')
      const node = readCell(cell, header, span, widths(column, span, (attr(tcW, 'w:type') ?? 'dxa') === 'dxa' ? pixelsOf(attr(tcW, 'w:w')) : null), reader, story)

      if (merge === 'restart') {
        merges.set(column, node)
      } else {
        merges.delete(column)
      }

      borders ||= Object.values(borderSides(child(tcPr, 'w:tcBorders'))).some(Boolean)
      cells.push(node)
      column += span
    }

    if (after > 0) {
      cells.push(emptyCell(header, after))
      column += after
    }

    columns = Math.max(columns, column)
    rows.push({ type: 'tableRow', content: cells })
  }

  if (!rows.length) {
    return null
  }

  padRows(rows, columns)

  return borders ? { type: 'table', content: rows } : { type: 'table', attrs: { borders: false }, content: rows }
}

/** The blocks of a part of the text (the body, a cell, a text box, a note), as entries. */
function readBlocks(parent: XmlElement | undefined, reader: Reader, story: Story): Entry[] {
  const entries: Entry[] = []

  for (const element of children(parent)) {
    switch (element.name) {
      case 'w:p':
        append(entries, readParagraph(element, reader, story))
        break
      case 'w:tbl': {
        const table = readTable(element, reader, story)

        if (table) {
          entries.push({ kind: 'block', node: table })
        }

        break
      }
      case 'w:sdt':
        append(entries, readBlocks(controlled(element, reader), reader, story))
        break
      case 'w:customXml':
        append(entries, readBlocks(element, reader, story))
        break
      case 'w:ins':
      case 'w:moveTo':
        reader.found.add('trackedChanges')
        append(entries, readBlocks(element, reader, story))
        break
      case 'w:del':
      case 'w:moveFrom':
        reader.found.add('trackedChanges')
        break
      case 'mc:AlternateContent':
        append(entries, readBlocks(alternative(element), reader, story))
        break
    }
  }

  return entries
}

// The document.

async function loadStory(pkg: WordPackage, relationships: Map<string, Relationship>): Promise<Story> {
  const pictures = new Map<string, Picture>()
  const images = [...relationships.values()].filter((item) => !item.external && relationshipKind(item) === 'image')

  await Promise.all(
    images.map(async (item) => {
      const bytes = await pkg.bytes(item.target)

      if (bytes) {
        pictures.set(item.id, { path: item.target, bytes })
      }
    })
  )

  return { relationships, pictures, sources: new Map() }
}

interface NotesPart {
  xml: XmlElement
  story: Story
}

async function loadNotes(pkg: WordPackage, path: string | undefined): Promise<NotesPart | null> {
  const [xml, relationships] = path ? await Promise.all([pkg.xml(path), pkg.relationships(path)]) : [null, null]

  return xml && relationships ? { xml, story: await loadStory(pkg, relationships) } : null
}

/** Footnotes and endnotes, numbered in the order the text refers to them, after a rule. */
function notesAppendix(reader: Reader, parts: Record<NoteReference['kind'], NotesPart | null>): DocNode[] {
  const references = [...reader.references]
  const out: DocNode[] = references.length ? [{ type: 'horizontalRule' }] : []

  references.forEach((item, index) => {
    const part = parts[item.kind]
    const note = children(part?.xml, item.kind === 'footnote' ? 'w:footnote' : 'w:endnote').find((element) => attr(element, 'w:id') === item.id)
    const blocks = note && part ? assemble(readBlocks(note, reader, part.story)) : []
    const first = blocks[0]
    const number = textNode(`${index + 1}. `)

    if (first?.type === 'paragraph') {
      const content = first.content ?? []
      const lead = content[0]

      if (lead?.type === 'text') {
        content[0] = { ...lead, text: (lead.text ?? '').trimStart() }
      }

      first.content = joinText([number, ...content])
    } else {
      blocks.unshift(paragraphNode([textNode(`${index + 1}.`)]))
    }

    append(out, blocks)
  })

  return out
}

function pageOf(section: XmlElement | undefined): PageSettings | null {
  if (!section) {
    return null
  }

  const size = child(section, 'w:pgSz')
  const margins = child(section, 'w:pgMar')
  const points = (element: XmlElement | undefined, name: string, fallback: number): number => round(Math.abs(measure(attr(element, name), 1 / 20) ?? fallback))
  const width = points(size, 'w:w', 612)
  const height = points(size, 'w:h', 792)
  // Some programs mark a page landscape but give its sides the portrait way round.
  const turned = attr(size, 'w:orient') === 'landscape' && width < height

  return {
    width: turned ? height : width,
    height: turned ? width : height,
    margins: { top: points(margins, 'w:top', 72), right: points(margins, 'w:right', 72), bottom: points(margins, 'w:bottom', 72), left: points(margins, 'w:left', 72) }
  }
}

/** A section break is a page break unless the section after it starts on the same page. */
function settleBreaks(reader: Reader): void {
  reader.breaks.forEach((pageBreak, index) => {
    const type = attr(child(reader.sections[index + 1], 'w:type'), 'w:val') ?? 'nextPage'
    pageBreak.skip = type === 'continuous' || type === 'nextColumn'
  })
}

/** A Herald Docs document from the bytes of a Word file, with what opening it approximated. */
export async function documentFromDocx(bytes: Uint8Array): Promise<{ doc: DocJSON; notes: string[] }> {
  const pkg = await openPackage(bytes)
  const [document, relationships] = await Promise.all([pkg.xml(pkg.main), pkg.relationships(pkg.main)])
  const body = child(document ?? undefined, 'w:body')

  if (document?.name !== 'w:document' || !body) {
    throw new Error(NOT_WORD)
  }

  const partOf = (kind: string): string | undefined => [...relationships.values()].find((item) => !item.external && relationshipKind(item) === kind)?.target
  const xmlOf = (kind: string): Promise<XmlElement | null> => {
    const path = partOf(kind)

    return path ? pkg.xml(path) : Promise.resolve(null)
  }

  const [stylesXml, numberingXml, themeXml, story, footnotes, endnotes] = await Promise.all([
    xmlOf('styles'),
    xmlOf('numbering'),
    xmlOf('theme'),
    loadStory(pkg, relationships),
    loadNotes(pkg, partOf('footnotes')),
    loadNotes(pkg, partOf('endnotes'))
  ])
  const styles = readStyles(stylesXml, themeXml)
  const looks: StyleLooks = {}

  for (const [name, style] of Object.entries(styles.heraldStyles()) as [StyleName, ParagraphStyle][]) {
    looks[name] = lookOf(style, styles, name)
  }

  const reader: Reader = { styles, numbering: readNumbering(numberingXml, styles.numberingOf), looks, found: new Set(), unknown: [], fields: [], references: [], sections: [], breaks: [] }
  const entries = readBlocks(body, reader, story)
  const lastSection = child(body, 'w:sectPr')

  if (lastSection) {
    reader.sections.push(lastSection)
  }

  settleBreaks(reader)
  const content = withoutClosingParagraph(assemble(entries))

  // Word starts no blank page for a page break before the first paragraph.
  while (content[0]?.type === 'pageBreak') {
    content.shift()
  }

  // A field the body never ends would otherwise hide the notes.
  reader.fields = []
  append(content, notesAppendix(reader, { footnote: footnotes, endnote: endnotes }))

  for (const key of await packageNotes(pkg, relationships, reader.sections)) {
    reader.found.add(key)
  }

  const page = pageOf(lastSection)
  const doc: DocJSON = { type: 'doc', attrs: { ...(page ? { page } : {}), styles: looks }, content: content.length ? content : [paragraphNode()] }

  return { doc, notes: fidelityNotes(reader.found, reader.unknown) }
}
