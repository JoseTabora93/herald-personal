import type { BlockContent, DefinitionContent, Heading, Html, List, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table, TableCell, TableRow } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfm } from 'micromark-extension-gfm'
import { type CalloutKind, type DocJSON, type DocMark, type DocNode, imageSize, joinText, type MarkName, markOf, paragraphNode, parseDataUrl, sameMarks, textNode, textOf, walk } from './document.ts'

/*
 * Plain text and Markdown as Herald Docs documents and back. Plain text keeps its lines as
 * paragraphs. Markdown is read as CommonMark with GitHub's tables, task lists, strikethrough and
 * autolinks: headings, emphasis, lists, links, pictures, tables, code blocks with their language,
 * quotes and rules. GitHub's alerts (> [!NOTE]) are Herald's callouts; underline, superscript,
 * subscript and highlight go through the HTML tags Markdown allows; a page break is an empty
 * marked div. What Markdown cannot hold is listed when saving.
 */

export interface TextLayout {
  eol: '\n' | '\r\n'
  bom: boolean
}

export interface ReadResult {
  document: DocJSON
  layout: TextLayout
  /** What opening the file approximated. */
  notes: string[]
}

export interface WriteResult {
  text: string
  /** What the format cannot keep of this document. */
  losses: string[]
}

function layoutOf(input: string): { text: string; layout: TextLayout } {
  const bom = input.startsWith('\uFEFF')
  const text = bom ? input.slice(1) : input

  return { text, layout: { eol: /\r\n/.test(text) ? '\r\n' : '\n', bom } }
}

const lines = (text: string): string[] => {
  const all = text.split(/\r\n?|\n/)

  return all.length > 1 && all[all.length - 1] === '' ? all.slice(0, -1) : all
}

const write = (rows: string[], layout: Partial<TextLayout>): string => {
  const eol = layout.eol ?? '\n'

  return `${layout.bom ? '\uFEFF' : ''}${rows.join(eol)}${rows.length ? eol : ''}`
}

const documentOf = (content: DocNode[]): DocJSON => ({ type: 'doc', attrs: { page: null, styles: null }, content: content.length ? content : [paragraphNode()] })

// Plain text.

export function documentFromText(input: string): ReadResult {
  const { text, layout } = layoutOf(input)

  return { document: documentOf(lines(text).map((line) => paragraphNode(line ? [textNode(line)] : []))), layout, notes: [] }
}

const PLAIN_FORMATTING = 'Formatting (headings, lists, bold, italic and fonts) is not saved in plain text.'
const PLAIN_PICTURES = 'Pictures are not saved in plain text.'

/** Lines of a block: its text, line breaks starting new lines, a table's cells separated by tabs. */
function textLines(node: DocNode): string[] {
  if (node.type === 'table') {
    return (node.content ?? []).map((row) => (row.content ?? []).map((cell) => textOf(cell).replace(/\n/g, ' ')).join('\t'))
  }

  if (node.type === 'horizontalRule' || node.type === 'pageBreak') {
    return []
  }

  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') {
    return textOf(node).split('\n')
  }

  return (node.content ?? []).flatMap(textLines)
}

const hasAttrs = (node: DocNode): boolean => Object.values(node.attrs ?? {}).some((value) => value !== null && value !== undefined)

export function textFromDocument(document: DocJSON, layout: Partial<TextLayout> = {}): WriteResult {
  let styled = false
  let pictures = false

  walk(document, (node) => {
    if (node.type === 'image') {
      pictures = true
    } else if (node.type === 'text') {
      styled ||= Boolean(node.marks?.length)
    } else if (node.type === 'paragraph') {
      styled ||= hasAttrs(node)
    } else if (node.type !== 'doc' && node.type !== 'hardBreak') {
      styled = true
    }
  })

  return { text: write(document.content.flatMap(textLines), layout), losses: [...(styled ? [PLAIN_FORMATTING] : []), ...(pictures ? [PLAIN_PICTURES] : [])] }
}

// Markdown: reading.

/** GitHub's alert kinds and Herald's callouts, each way. */
const ALERTS: Record<string, CalloutKind> = { NOTE: 'info', TIP: 'success', IMPORTANT: 'note', WARNING: 'warning', CAUTION: 'error' }
const ALERT_OF: Record<CalloutKind, string> = { info: 'NOTE', success: 'TIP', note: 'IMPORTANT', warning: 'WARNING', error: 'CAUTION' }
const ALERT_START = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i

/** HTML tags that stand for marks Markdown has no syntax of its own for. */
const HTML_MARKS: Record<string, MarkName> = { u: 'underline', ins: 'underline', sup: 'superscript', sub: 'subscript', mark: 'highlight' }

const PAGE_BREAK_HTML = '<div data-page-break></div>'
const isPageBreakHtml = (html: string): boolean => /^<div\s+data-page-break(?:=["'][^"']*["'])?\s*>\s*<\/div>$/i.test(html.trim())

const NOTE = {
  joined: 'Lines of a paragraph that were broken in the file are joined.',
  html: 'HTML in the file is shown as its source.',
  references: 'Reference-style links are saved as inline links.',
  footnotes: 'Footnotes are shown as their Markdown text.',
  beside: 'Pictures stored beside the file are not shown yet; saving keeps their links.'
} as const

interface Reader {
  notes: Set<string>
  definitions: Map<string, { url: string; title: string | null }>
}

const isLocalPicture = (url: string): boolean => !/^(data:|https?:|blob:)/i.test(url)

function inlineFrom(nodes: readonly PhrasingContent[], marks: DocMark[], reader: Reader): DocNode[] {
  const out: DocNode[] = []
  let extra: DocMark[] = []
  const all = () => [...marks, ...extra]

  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        if (/\n/.test(node.value)) {
          reader.notes.add(NOTE.joined)
        }

        out.push(textNode(node.value.replace(/[ \t]*\n[ \t]*/g, ' '), all()))
        break
      }
      case 'strong':
        out.push(...inlineFrom(node.children, [...all(), { type: 'bold' }], reader))
        break
      case 'emphasis':
        out.push(...inlineFrom(node.children, [...all(), { type: 'italic' }], reader))
        break
      case 'delete':
        out.push(...inlineFrom(node.children, [...all(), { type: 'strike' }], reader))
        break
      case 'inlineCode':
        out.push(textNode(node.value, [...all().filter((mark) => mark.type === 'link'), { type: 'code' }]))
        break
      case 'break':
        out.push({ type: 'hardBreak' })
        break
      case 'link':
        out.push(...inlineFrom(node.children, [...all(), linkMark(node.url, node.title)], reader))
        break
      case 'linkReference': {
        const target = reader.definitions.get(node.identifier.toLowerCase())

        if (target) {
          reader.notes.add(NOTE.references)
          out.push(...inlineFrom(node.children, [...all(), linkMark(target.url, target.title)], reader))
        } else {
          out.push(textNode('[', all()), ...inlineFrom(node.children, all(), reader), textNode(']', all()))
        }

        break
      }
      case 'image':
      case 'imageReference': {
        const target = node.type === 'image' ? { url: node.url, title: node.title ?? null } : reader.definitions.get(node.identifier.toLowerCase())

        if (!target) {
          out.push(textNode(`![${node.alt ?? ''}]`, all()))
          break
        }

        if (node.type === 'imageReference') {
          reader.notes.add(NOTE.references)
        }

        if (isLocalPicture(target.url)) {
          reader.notes.add(NOTE.beside)
        }

        out.push({ type: 'image', attrs: { src: target.url, ...(node.alt ? { alt: node.alt } : {}), ...(target.title ? { title: target.title } : {}) } })
        break
      }
      case 'html': {
        const tag = /^<(\/?)([a-z]+)\s*\/?>$/i.exec(node.value.trim())
        const name = tag?.[2].toLowerCase() ?? ''

        if (name === 'br') {
          out.push({ type: 'hardBreak' })
        } else if (tag && HTML_MARKS[name]) {
          const type = HTML_MARKS[name]
          extra = tag[1] ? extra.filter((mark) => mark.type !== type) : [...extra, { type }]
        } else {
          reader.notes.add(NOTE.html)
          out.push(textNode(node.value, all()))
        }

        break
      }
      case 'footnoteReference':
        reader.notes.add(NOTE.footnotes)
        out.push(textNode(`[^${node.label ?? node.identifier}]`, all()))
        break
    }
  }

  return joinText(out)
}

const linkMark = (href: string, title?: string | null): DocMark => ({ type: 'link', attrs: { href, ...(title ? { title } : {}) } })

/** A list item's blocks, starting with the paragraph ProseMirror wants first. */
const itemContent = (blocks: DocNode[]): DocNode[] => (blocks[0]?.type === 'paragraph' ? blocks : [paragraphNode(), ...blocks])

function listFrom(list: List, reader: Reader): DocNode {
  const task = list.children.some((item) => typeof item.checked === 'boolean')
  const type = task ? 'taskList' : list.ordered ? 'orderedList' : 'bulletList'
  const start = list.ordered && typeof list.start === 'number' && list.start !== 1 && !task ? { start: list.start } : undefined

  return {
    type,
    ...(start ? { attrs: start } : {}),
    content: list.children.map((item) => ({
      type: task ? 'taskItem' : 'listItem',
      ...(task ? { attrs: { checked: Boolean(item.checked) } } : {}),
      content: itemContent(blocksFrom(item.children, reader))
    }))
  }
}

function tableFrom(table: Table, reader: Reader): DocNode {
  const width = Math.max(...table.children.map((row) => row.children.length), 1)

  return {
    type: 'table',
    content: table.children.map((row, index) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_, column) => {
        const cell = row.children[column]
        const align = table.align?.[column]

        return { type: index === 0 ? 'tableHeader' : 'tableCell', ...(align ? { attrs: { align } } : {}), content: [paragraphNode(cell ? inlineFrom(cell.children, [], reader) : [])] }
      })
    }))
  }
}

function calloutFrom(quote: { children: (BlockContent | DefinitionContent)[] }, reader: Reader): DocNode | null {
  const [first, ...rest] = quote.children

  if (first?.type !== 'paragraph' || first.children[0]?.type !== 'text') {
    return null
  }

  const head = first.children[0]
  const match = ALERT_START.exec(head.value)

  if (!match) {
    return null
  }

  const remaining = head.value.slice(match[0].length)
  const inline = [...(remaining ? [{ ...head, value: remaining }] : []), ...first.children.slice(1)]
  const content = [...(inline.length ? [paragraphNode(inlineFrom(inline, [], reader))] : []), ...blocksFrom(rest, reader)]

  return { type: 'callout', attrs: { kind: ALERTS[match[1].toUpperCase()] }, content: content.length ? content : [paragraphNode()] }
}

function blocksFrom(nodes: readonly RootContent[], reader: Reader): DocNode[] {
  return nodes.flatMap((node): DocNode[] => {
    switch (node.type) {
      case 'paragraph':
        return [paragraphNode(inlineFrom(node.children, [], reader))]
      case 'heading': {
        const content = inlineFrom(node.children, [], reader)

        return [{ type: 'heading', attrs: { level: node.depth }, ...(content.length ? { content } : {}) }]
      }
      case 'thematicBreak':
        return [{ type: 'horizontalRule' }]
      case 'blockquote': {
        const callout = calloutFrom(node, reader)

        if (callout) {
          return [callout]
        }

        const content = blocksFrom(node.children, reader)

        return [{ type: 'blockquote', content: content.length ? content : [paragraphNode()] }]
      }
      case 'list':
        return [listFrom(node, reader)]
      case 'code':
        return [{ type: 'codeBlock', ...(node.lang ? { attrs: { language: node.lang } } : {}), ...(node.value ? { content: [textNode(node.value)] } : {}) }]
      case 'html':
        if (isPageBreakHtml(node.value)) {
          return [{ type: 'pageBreak' }]
        }

        reader.notes.add(NOTE.html)

        return [paragraphNode(node.value.split('\n').flatMap((line, index) => [...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [textNode(line)] : [])]))]
      case 'table':
        return [tableFrom(node, reader)]
      case 'definition':
        reader.notes.add(NOTE.references)

        return []
      case 'footnoteDefinition': {
        reader.notes.add(NOTE.footnotes)
        const [first, ...rest] = blocksFrom(node.children, reader)
        const label = textNode(`[^${node.label ?? node.identifier}]: `)

        return [first?.type === 'paragraph' ? { ...first, content: joinText([label, ...(first.content ?? [])]) } : paragraphNode([label]), ...(first && first.type !== 'paragraph' ? [first] : []), ...rest]
      }
      default:
        return []
    }
  })
}

export function documentFromMarkdown(input: string): ReadResult {
  const { text, layout } = layoutOf(input)
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const reader: Reader = { notes: new Set(), definitions: new Map() }

  const collect = (nodes: readonly RootContent[]) => {
    for (const node of nodes) {
      if (node.type === 'definition') {
        reader.definitions.set(node.identifier.toLowerCase(), { url: node.url, title: node.title ?? null })
      } else if ('children' in node) {
        collect(node.children as RootContent[])
      }
    }
  }
  collect(tree.children)

  const document = documentOf(blocksFrom(tree.children, reader))
  const order = Object.values(NOTE)

  return { document, layout, notes: order.filter((note) => reader.notes.has(note)) }
}

// Markdown: writing.

const LOSS = {
  titles: 'Titles and subtitles are saved as headings in Markdown.',
  fonts: 'Font sizes, colours and other fonts are not saved in Markdown.',
  paragraph: 'Paragraph alignment, indents and spacing are not saved in Markdown.',
  styles: "The document's own fonts and heading styles are not saved in Markdown.",
  numbering: 'Lettered and Roman numbered lists are saved as numbers in Markdown.',
  merged: 'Merged table cells are split in Markdown.',
  header: 'The first row of each table is saved as its header row.',
  cells: 'Lists, code and other blocks inside table cells are saved as plain text in Markdown.',
  shading: 'Table borders and cell shading are not saved in Markdown.',
  data: 'Pictures are saved inside the Markdown file as data, which some Markdown viewers do not show.',
  sizes: 'Picture sizes are not saved in Markdown.'
} as const

type Loss = keyof typeof LOSS

const LAYOUT_ATTRS = ['lineHeight', 'spaceBefore', 'spaceAfter', 'indent', 'firstLine'] as const

/** Marks from the outside in: a link holds bold text, never the other way round. */
const MARK_ORDER: readonly MarkName[] = ['link', 'bold', 'italic', 'strike', 'underline', 'superscript', 'subscript', 'highlight']
const HTML_TAG: Partial<Record<MarkName, string>> = { underline: 'u', superscript: 'sup', subscript: 'sub', highlight: 'mark' }

/** Footnote markers Herald shows as text go back as they were written, not escaped. */
const FOOTNOTE = /\[\^[^\]\s]+\](?::)?/g

const raw = (value: string): Html => ({ type: 'html', value })

class Writer {
  readonly losses = new Set<Loss>()

  blocks(nodes: readonly DocNode[] = []): RootContent[] {
    return nodes.flatMap((node) => this.block(node))
  }

  block(node: DocNode): RootContent[] {
    switch (node.type) {
      case 'paragraph':
        return this.paragraph(node)
      case 'heading':
        this.layout(node)

        return [{ type: 'heading', depth: Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))) as Heading['depth'], children: this.inline(node.content) }]
      case 'blockquote':
        return [{ type: 'blockquote', children: this.blocks(node.content) as BlockContent[] }]
      case 'callout': {
        const marker = raw(`[!${ALERT_OF[(node.attrs?.kind as CalloutKind) ?? 'info'] ?? 'NOTE'}]`)
        const [first, ...rest] = this.blocks(node.content) as BlockContent[]
        const head: Paragraph = first?.type === 'paragraph' ? { type: 'paragraph', children: [marker, { type: 'text', value: '\n' }, ...first.children] } : { type: 'paragraph', children: [marker] }

        return [{ type: 'blockquote', children: first?.type === 'paragraph' ? [head, ...rest] : [head, ...(first ? [first] : []), ...rest] }]
      }
      case 'codeBlock':
        return [{ type: 'code', lang: typeof node.attrs?.language === 'string' && node.attrs.language ? node.attrs.language : null, value: textOf(node) }]
      case 'horizontalRule':
        return [{ type: 'thematicBreak' }]
      case 'pageBreak':
        return [raw(PAGE_BREAK_HTML)]
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return [this.list(node)]
      case 'table':
        return [this.table(node)]
      default:
        return node.content ? this.blocks(node.content) : []
    }
  }

  layout(node: DocNode): void {
    const attrs = node.attrs ?? {}

    if ((attrs.textAlign && attrs.textAlign !== 'left') || LAYOUT_ATTRS.some((name) => attrs[name] !== null && attrs[name] !== undefined)) {
      this.losses.add('paragraph')
    }
  }

  paragraph(node: DocNode): RootContent[] {
    const content = node.content ?? []

    // Markdown has no empty paragraph: an empty one only separates the blocks around it.
    if (!content.some((child) => child.type !== 'text' || child.text?.trim())) {
      return []
    }

    this.layout(node)
    const text = textOf(node)

    // A paragraph that was HTML in the file goes back as HTML.
    if (content.every((child) => child.type === 'hardBreak' || (child.type === 'text' && !child.marks?.length)) && /^<[a-z/!][\s\S]*>$/i.test(text.trim())) {
      return [raw(text)]
    }

    const style = node.attrs?.docStyle

    if (style === 'title' || style === 'subtitle') {
      this.losses.add('titles')

      return [{ type: 'heading', depth: style === 'title' ? 1 : 2, children: this.inline(content) }]
    }

    return [{ type: 'paragraph', children: this.inline(content) }]
  }

  list(node: DocNode): List {
    const ordered = node.type === 'orderedList'
    const task = node.type === 'taskList'

    if (ordered && node.attrs?.type && node.attrs.type !== '1') {
      this.losses.add('numbering')
    }

    return {
      type: 'list',
      ordered,
      start: ordered ? Number(node.attrs?.start ?? 1) : null,
      spread: false,
      children: (node.content ?? []).map((item): ListItem => ({ type: 'listItem', spread: false, checked: task ? Boolean(item.attrs?.checked) : null, children: this.blocks(item.content) as BlockContent[] }))
    }
  }

  table(node: DocNode): Table {
    const rows = node.content ?? []
    // Every position of the grid, spans spread out: what each row holds, column by column.
    const grid: (DocNode | null)[][] = rows.map(() => [])

    rows.forEach((row, r) => {
      let column = 0

      for (const cell of row.content ?? []) {
        while (grid[r][column] !== undefined) {
          column++
        }

        const colspan = Math.max(1, Number(cell.attrs?.colspan ?? 1))
        const rowspan = Math.max(1, Number(cell.attrs?.rowspan ?? 1))

        if (colspan > 1 || rowspan > 1) {
          this.losses.add('merged')
        }

        if (cell.attrs?.background || node.attrs?.borders === false) {
          this.losses.add('shading')
        }

        for (let dr = 0; dr < rowspan && r + dr < rows.length; dr++) {
          for (let dc = 0; dc < colspan; dc++) {
            grid[r + dr][column + dc] = dr === 0 && dc === 0 ? cell : null
          }
        }

        column += colspan
      }
    })

    if (rows[0]?.content?.some((cell) => cell.type !== 'tableHeader')) {
      this.losses.add('header')
    }

    const width = Math.max(1, ...grid.map((row) => row.length))
    const align = Array.from({ length: width }, (_, column) => {
      const value = grid[0]?.[column]?.attrs?.align

      return value === 'left' || value === 'center' || value === 'right' ? value : null
    })

    return {
      type: 'table',
      align,
      children: grid.map((row): TableRow => ({ type: 'tableRow', children: Array.from({ length: width }, (_, column): TableCell => ({ type: 'tableCell', children: row[column] ? this.cell(row[column]!) : [] })) }))
    }
  }

  /** A cell's blocks on one line: paragraphs and headings joined with line breaks, other blocks as their text. */
  cell(cell: DocNode): PhrasingContent[] {
    const out: PhrasingContent[] = []

    for (const block of cell.content ?? []) {
      const inline = block.type === 'paragraph' || block.type === 'heading' ? this.inline(block.content) : textOf(block) ? [{ type: 'text' as const, value: textOf(block).replace(/\n/g, ' ') }] : []

      if (block.type !== 'paragraph' && block.type !== 'heading' && textOf(block)) {
        this.losses.add('cells')
      }

      if (inline.length) {
        out.push(...(out.length ? [raw('<br>')] : []), ...inline)
      }
    }

    return out
  }

  inline(nodes: readonly DocNode[] = []): PhrasingContent[] {
    if (nodes.some((node) => node.marks?.some((mark) => mark.type === 'textStyle' && Object.values(mark.attrs ?? {}).some((value) => value !== null)))) {
      this.losses.add('fonts')
    }

    return this.wrap(nodes, 0)
  }

  wrap(nodes: readonly DocNode[], depth: number): PhrasingContent[] {
    if (depth === MARK_ORDER.length) {
      return nodes.flatMap((node) => this.leaf(node))
    }

    const type = MARK_ORDER[depth]
    const out: PhrasingContent[] = []
    let i = 0

    while (i < nodes.length) {
      const mark = markOf(nodes[i], type)
      const same = (node: DocNode) => {
        const other = markOf(node, type)

        return mark ? Boolean(other) && sameMarks([mark], [other!]) : !other
      }
      let j = i + 1

      while (j < nodes.length && same(nodes[j])) {
        j++
      }

      const inner = this.wrap(nodes.slice(i, j), depth + 1)
      out.push(...(mark ? this.wrapped(type, mark, inner) : inner))
      i = j
    }

    return out
  }

  wrapped(type: MarkName, mark: DocMark, inner: PhrasingContent[]): PhrasingContent[] {
    if (type === 'link') {
      return [{ type: 'link', url: String(mark.attrs?.href ?? ''), title: typeof mark.attrs?.title === 'string' && mark.attrs.title ? mark.attrs.title : null, children: inner }]
    }

    const tag = HTML_TAG[type]

    if (tag) {
      return [raw(`<${tag}>`), ...inner, raw(`</${tag}>`)]
    }

    // Spaces stay outside emphasis, where Markdown needs them.
    const children = [...inner]
    const before = children[0]?.type === 'text' ? /^\s+/.exec(children[0].value)?.[0] : undefined
    const last = children[children.length - 1]
    const after = last?.type === 'text' ? /\s+$/.exec(last.value)?.[0] : undefined

    if (before && children[0].type === 'text') {
      children[0] = { ...children[0], value: children[0].value.slice(before.length) }
    }

    const end = children[children.length - 1]

    if (after && end?.type === 'text') {
      children[children.length - 1] = { ...end, value: end.value.slice(0, end.value.length - after.length) }
    }

    const kept = children.filter((child) => child.type !== 'text' || child.value)
    const node: PhrasingContent = type === 'bold' ? { type: 'strong', children: kept } : type === 'italic' ? { type: 'emphasis', children: kept } : { type: 'delete', children: kept }

    return [...(before ? [{ type: 'text' as const, value: before }] : []), ...(kept.length ? [node] : []), ...(after ? [{ type: 'text' as const, value: after }] : [])]
  }

  leaf(node: DocNode): PhrasingContent[] {
    if (node.type === 'hardBreak') {
      return [{ type: 'break' }]
    }

    if (node.type === 'image') {
      const src = String(node.attrs?.src ?? '')
      const picture = parseDataUrl(src)

      if (picture) {
        this.losses.add('data')
        const natural = imageSize(picture.bytes)
        const width = Number(node.attrs?.width ?? 0)

        if (natural && width && Math.abs(natural.width - width) > 1) {
          this.losses.add('sizes')
        }
      }

      return [{ type: 'image', url: src, alt: typeof node.attrs?.alt === 'string' ? node.attrs.alt : null, title: typeof node.attrs?.title === 'string' && node.attrs.title ? node.attrs.title : null }]
    }

    if (node.type !== 'text' || !node.text) {
      return []
    }

    if (markOf(node, 'code')) {
      return [{ type: 'inlineCode', value: node.text }]
    }

    const out: PhrasingContent[] = []
    let last = 0

    for (const match of node.text.matchAll(FOOTNOTE)) {
      if (match.index > last) {
        out.push({ type: 'text', value: node.text.slice(last, match.index) })
      }

      out.push(raw(match[0]))
      last = match.index + match[0].length
    }

    if (last < node.text.length) {
      out.push({ type: 'text', value: node.text.slice(last) })
    }

    return out
  }
}

export function markdownFromDocument(document: DocJSON, layout: Partial<TextLayout> = {}): WriteResult {
  const writer = new Writer()
  const root: Root = { type: 'root', children: writer.blocks(document.content) }

  if (document.attrs?.styles) {
    writer.losses.add('styles')
  }

  const text = root.children.length
    ? toMarkdown(root, { extensions: [gfmToMarkdown()], bullet: '-', bulletOther: '*', emphasis: '*', strong: '*', rule: '-', fence: '`', fences: true, listItemIndent: 'one', incrementListMarker: true, setext: false, resourceLink: false, ruleSpaces: false })
    : ''

  return { text: write(text ? lines(text) : [], layout), losses: (Object.keys(LOSS) as Loss[]).filter((loss) => writer.losses.has(loss)).map((loss) => LOSS[loss]) }
}
