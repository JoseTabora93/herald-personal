import { type CalloutKind, cssLineHeight, type DocJSON, type DocMark, type DocNode, looksOf, pageOf, round, type StyleLook, type StyleName } from './document.ts'

/*
 * A Herald Docs document as HTML and CSS: the print view main turns into a PDF, and the styles the
 * editor's page uses, so that what prints is what the page shows. Pages are paper whatever the
 * theme: black text on white.
 */

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const SERIF = /times|georgia|garamond|cambria|caladea|book|palatino|baskerville|serif|minion|charter|didot|bodoni|merriweather|lora|playfair|tinos/i
const MONO = /mono|consol|courier|menlo|monaco|code|cousine|inconsolata/i

/** Faces that measure like Word's, for a machine without Word's fonts (Linux, mostly). */
const LOOKALIKES: Record<string, string[]> = {
  calibri: ['Carlito'],
  cambria: ['Caladea'],
  arial: ['Liberation Sans', 'Arimo'],
  helvetica: ['Liberation Sans', 'Arimo'],
  'times new roman': ['Liberation Serif', 'Tinos'],
  'courier new': ['Liberation Mono', 'Cousine'],
  aptos: ['Calibri', 'Carlito']
}

const quoted = (name: string): string => (/^[\w-]+$/.test(name) && !/^\d/.test(name) ? name : `"${name.replace(/["\\]/g, '')}"`)

/** A font name with what to fall back on: faces that measure alike, then faces of the same kind. */
export function fontStack(name: string | null | undefined): string {
  const font = (name ?? '').trim()
  const fallback = MONO.test(font) ? ['Menlo', 'Consolas', 'DejaVu Sans Mono', 'monospace'] : SERIF.test(font) ? ['Georgia', 'Times New Roman', 'Liberation Serif', 'serif'] : ['Helvetica Neue', 'Arial', 'Liberation Sans', 'sans-serif']
  const names = [...(font ? [font] : []), ...(LOOKALIKES[font.toLowerCase()] ?? []), ...fallback]

  return [...new Set(names)].map((entry) => (['serif', 'sans-serif', 'monospace'].includes(entry) ? entry : quoted(entry))).join(', ')
}

function lookRules(look: StyleLook, inherited?: StyleLook): string {
  const rules: string[] = []

  if (look.font && look.font !== inherited?.font) {
    rules.push(`font-family: ${fontStack(look.font)}`)
  }

  if (look.size) {
    rules.push(`font-size: ${look.size}pt`)
  }

  if (look.color) {
    rules.push(`color: ${look.color}`)
  }

  if (look.bold !== undefined) {
    rules.push(`font-weight: ${look.bold ? 700 : 400}`)
  }

  if (look.italic !== undefined) {
    rules.push(`font-style: ${look.italic ? 'italic' : 'normal'}`)
  }

  if (look.lineHeight) {
    rules.push(`line-height: ${cssLineHeight(look.lineHeight)}`)
  }

  if (look.spaceBefore !== undefined || look.spaceAfter !== undefined) {
    rules.push(`margin: ${round(look.spaceBefore ?? 0)}pt 0 ${round(look.spaceAfter ?? 0)}pt`)
  }

  return rules.join('; ')
}

const HEADING_SELECTORS: [StyleName, string][] = [1, 2, 3, 4, 5, 6].map((level) => [`heading${level}` as StyleName, `h${level}`])

/** The document's own typography, under `scope`: its styles' fonts, sizes, colours and spacing. */
export function looksCss(doc: DocNode, scope: string): string {
  const looks = looksOf(doc)
  const normal = looks.normal
  const rule = (selector: string, body: string) => (body ? `${selector.split(',').map((part) => `${scope} ${part.trim()}`).join(', ')} { ${body} }` : '')

  return [
    `${scope} { ${lookRules({ ...normal, font: normal.font ?? 'Arial', spaceBefore: undefined, spaceAfter: undefined })} }`,
    rule('p', lookRules({ spaceBefore: normal.spaceBefore ?? 0, spaceAfter: normal.spaceAfter ?? 0 })),
    rule('p[data-style="title"]', lookRules(looks.title, normal)),
    rule('p[data-style="subtitle"]', lookRules(looks.subtitle, normal)),
    ...HEADING_SELECTORS.map(([name, selector]) => rule(selector, lookRules(looks[name], normal))),
    rule('blockquote', lookRules({ ...looks.quote, spaceBefore: undefined, spaceAfter: undefined }, normal)),
    rule('pre', lookRules({ ...looks.code, bold: undefined, italic: undefined, spaceBefore: undefined, spaceAfter: undefined }, normal)),
    rule('code', `font-family: ${fontStack(looks.code.font)}`)
  ]
    .filter(Boolean)
    .join('\n')
}

const CALLOUT_COLORS: Record<CalloutKind, [string, string]> = {
  info: ['#2f7dff', '#eaf2ff'],
  note: ['#7c5cff', '#f1edff'],
  success: ['#1f9d55', '#e8f6ee'],
  warning: ['#d99a00', '#fff5dc'],
  error: ['#e5484d', '#fdeceb']
}

/** How content looks under `scope` on the page and on paper: lists, tables, callouts, pictures, code. */
export function contentCss(scope: string, medium: 'screen' | 'print'): string {
  const s = (selector: string) =>
    selector
      .split(',')
      .map((part) => `${scope} ${part.trim()}`)
      .join(', ')

  return [
    `${s('p:empty::before')} { content: ''; display: inline-block }`,
    `${s('h1, h2, h3, h4, h5, h6')} { page-break-after: avoid; break-after: avoid }`,
    `${s('ul, ol')} { margin: 0 0 6pt; padding-left: 24pt }`,
    `${s('ul')} { list-style: disc }`,
    `${s('ul ul')} { list-style: circle }`,
    `${s('ul ul ul')} { list-style: square }`,
    `${s('ol')} { list-style: decimal }`,
    `${s('ol[type="a"]')} { list-style-type: lower-alpha }`,
    `${s('ol[type="A"]')} { list-style-type: upper-alpha }`,
    `${s('ol[type="i"]')} { list-style-type: lower-roman }`,
    `${s('ol[type="I"]')} { list-style-type: upper-roman }`,
    `${s('li > p')} { margin-top: 0; margin-bottom: 0 }`,
    `${s('li + li')} { margin-top: 2pt }`,
    `${s('li > ul, li > ol')} { margin-bottom: 0 }`,
    `${s('ul[data-type="taskList"]')} { list-style: none; padding-left: 4pt }`,
    `${s('ul[data-type="taskList"] > li')} { display: flex; gap: 6pt; align-items: flex-start }`,
    `${s('ul[data-type="taskList"] > li > label')} { flex: none; user-select: none; line-height: inherit }`,
    `${s('ul[data-type="taskList"] > li > div')} { flex: 1; min-width: 0 }`,
    `${s('ul[data-type="taskList"] > li[data-checked="true"] > div')} { color: #6b7280; text-decoration: line-through }`,
    `${s('blockquote')} { margin: 6pt 0; padding: 2pt 0 2pt 12pt; border-left: 3pt solid #c8ced8 }`,
    `${s('pre')} { margin: 6pt 0; background: #f4f5f7; border-radius: 4pt; padding: 6pt 8pt; white-space: pre-wrap; overflow-wrap: anywhere }`,
    `${s('pre code')} { font-size: inherit; background: none; padding: 0 }`,
    `${s(':not(pre) > code')} { background: #f1f2f4; border-radius: 3pt; padding: 0 2pt; font-size: 0.92em }`,
    `${s('a')} { color: #1155cc; text-decoration: underline }`,
    `${s('mark')} { background-color: #fff27a; color: inherit }`,
    `${s('hr')} { border: 0; border-top: 1pt solid #c8ced8; margin: 10pt 0 }`,
    `${s('img')} { max-width: 100%; height: auto; vertical-align: bottom }`,
    `${s('table')} { border-collapse: collapse; margin: 6pt 0; max-width: 100% }`,
    `${s('td, th')} { border: 0.75pt solid #9aa3b2; padding: 3pt 6pt; vertical-align: top; text-align: left; min-width: 1em; position: relative }`,
    `${s('th')} { background: #f2f4f7; font-weight: 700 }`,
    `${s('td > :first-child, th > :first-child')} { margin-top: 0 }`,
    `${s('td > :last-child, th > :last-child')} { margin-bottom: 0 }`,
    `${s('table[data-borders="none"] td, table[data-borders="none"] th')} { border: ${medium === 'screen' ? '0.75pt dashed #d5dae2' : '0'} }`,
    `${s('table[data-borders="none"] th')} { background: none }`,
    `${s('.doc-callout')} { margin: 8pt 0; padding: 6pt 10pt; border-left: 4pt solid; border-radius: 4pt }`,
    ...Object.entries(CALLOUT_COLORS).map(([kind, [line, fill]]) => `${s(`.doc-callout[data-callout="${kind}"]`)} { border-color: ${line}; background: ${fill} }`),
    `${s('.doc-callout > :first-child')} { margin-top: 0 }`,
    `${s('.doc-callout > :last-child')} { margin-bottom: 0 }`,
    medium === 'print'
      ? `${s('.doc-page-break')} { break-after: page; page-break-after: always; height: 0; margin: 0; border: 0 }`
      : `${s('.doc-page-break')} { position: relative; height: 0; margin: 14pt 0; border-top: 1px dashed #b8c0cc } ${s('.doc-page-break')}::after { content: 'Page break'; position: absolute; left: 50%; top: -0.7em; transform: translateX(-50%); padding: 0 6px; background: #fff; color: #8b94a3; font: 500 10px/1.4 system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase }`,
    ...(medium === 'print' ? [`${s('tr, img, li, .doc-callout, pre')} { break-inside: avoid }`] : [])
  ].join('\n')
}

// The print view.

const style = (rules: (string | false | null | undefined)[]): string => {
  const kept = rules.filter(Boolean)

  return kept.length ? ` style="${escapeHtml(kept.join('; '))}"` : ''
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function blockStyle(node: DocNode): string {
  const attrs = node.attrs ?? {}
  const align = typeof attrs.textAlign === 'string' && attrs.textAlign !== 'left' ? attrs.textAlign : null

  return style([
    align && `text-align: ${align}`,
    num(attrs.lineHeight) !== null && `line-height: ${cssLineHeight(num(attrs.lineHeight)!)}`,
    num(attrs.spaceBefore) !== null && `margin-top: ${attrs.spaceBefore}pt`,
    num(attrs.spaceAfter) !== null && `margin-bottom: ${attrs.spaceAfter}pt`,
    num(attrs.indent) !== null && `margin-left: ${attrs.indent}pt`,
    num(attrs.firstLine) !== null && `text-indent: ${attrs.firstLine}pt`
  ])
}

const SAFE_LINK = /^(https?:|mailto:|tel:|#)/i

function wrapMark(mark: DocMark, html: string): string {
  const attrs = mark.attrs ?? {}

  switch (mark.type) {
    case 'bold':
      return `<strong>${html}</strong>`
    case 'italic':
      return `<em>${html}</em>`
    case 'underline':
      return `<u>${html}</u>`
    case 'strike':
      return `<s>${html}</s>`
    case 'superscript':
      return `<sup>${html}</sup>`
    case 'subscript':
      return `<sub>${html}</sub>`
    case 'code':
      return `<code>${html}</code>`
    case 'highlight':
      return `<mark${style([typeof attrs.color === 'string' && `background-color: ${attrs.color}`])}>${html}</mark>`
    case 'link': {
      const href = String(attrs.href ?? '')

      return SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}">${html}</a>` : html
    }
    case 'textStyle': {
      const rules = style([
        typeof attrs.color === 'string' && `color: ${attrs.color}`,
        typeof attrs.fontFamily === 'string' && `font-family: ${fontStack(attrs.fontFamily)}`,
        typeof attrs.fontSize === 'string' && `font-size: ${attrs.fontSize}`
      ])

      return rules ? `<span${rules}>${html}</span>` : html
    }
    default:
      return html
  }
}

/** Marks from the outside in, so a link holds the formatting inside it. */
const MARK_ORDER = ['link', 'textStyle', 'highlight', 'bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'code']

function inlineHtml(node: DocNode): string {
  if (node.type === 'hardBreak') {
    return '<br>'
  }

  if (node.type === 'image') {
    const attrs = node.attrs ?? {}
    const src = String(attrs.src ?? '')

    if (!/^(data:image\/|https?:)/i.test(src)) {
      return ''
    }

    const width = num(attrs.width)
    const height = num(attrs.height)

    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(String(attrs.alt ?? ''))}"${width ? ` width="${Math.round(width)}"` : ''}${height ? ` height="${Math.round(height)}"` : ''}>`
  }

  const marks = [...(node.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type))

  return marks.reduce((html, mark) => wrapMark(mark, html), escapeHtml(node.text ?? ''))
}

const inline = (node: DocNode): string => (node.content ?? []).map(inlineHtml).join('') || '<br>'

function cellHtml(cell: DocNode): string {
  const attrs = cell.attrs ?? {}
  const tag = cell.type === 'tableHeader' ? 'th' : 'td'
  const colspan = Number(attrs.colspan ?? 1)
  const rowspan = Number(attrs.rowspan ?? 1)

  return `<${tag}${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${style([typeof attrs.background === 'string' && `background-color: ${attrs.background}`, typeof attrs.align === 'string' && `text-align: ${attrs.align}`])}>${blocksHtml(cell.content)}</${tag}>`
}

function tableHtml(table: DocNode): string {
  const first = table.content?.[0]?.content ?? []
  const widths = first.flatMap((cell) => {
    const spans = Math.max(1, Number(cell.attrs?.colspan ?? 1))
    const given = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs.colwidth as unknown[]) : []

    return Array.from({ length: spans }, (_, index) => num(given[index]))
  })
  const fixed = widths.length > 0 && widths.every((width) => width !== null)
  const columns = widths.map((width) => `<col${width ? ` style="width: ${width}px"` : ''}>`).join('')
  const rows = (table.content ?? []).map((row) => `<tr>${(row.content ?? []).map(cellHtml).join('')}</tr>`).join('')

  return `<table${table.attrs?.borders === false ? ' data-borders="none"' : ''}${fixed ? ' style="table-layout: fixed"' : ''}><colgroup>${columns}</colgroup><tbody>${rows}</tbody></table>`
}

function blockHtml(node: DocNode): string {
  const attrs = node.attrs ?? {}

  switch (node.type) {
    case 'paragraph': {
      const docStyle = attrs.docStyle === 'title' || attrs.docStyle === 'subtitle' ? ` data-style="${attrs.docStyle}"` : ''

      return `<p${docStyle}${blockStyle(node)}>${inline(node)}</p>`
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attrs.level ?? 1)))

      return `<h${level}${blockStyle(node)}>${inline(node)}</h${level}>`
    }
    case 'blockquote':
      return `<blockquote>${blocksHtml(node.content)}</blockquote>`
    case 'callout':
      return `<div class="doc-callout" data-callout="${escapeHtml(String(attrs.kind ?? 'info'))}">${blocksHtml(node.content)}</div>`
    case 'codeBlock':
      return `<pre><code>${escapeHtml((node.content ?? []).map((child) => child.text ?? '').join(''))}</code></pre>`
    case 'bulletList':
      return `<ul>${blocksHtml(node.content)}</ul>`
    case 'orderedList': {
      const start = Number(attrs.start ?? 1)
      const type = typeof attrs.type === 'string' && /^[1aAiI]$/.test(attrs.type) ? ` type="${attrs.type}"` : ''

      return `<ol${start !== 1 ? ` start="${start}"` : ''}${type}>${blocksHtml(node.content)}</ol>`
    }
    case 'listItem':
      return `<li>${blocksHtml(node.content)}</li>`
    case 'taskList':
      return `<ul data-type="taskList">${blocksHtml(node.content)}</ul>`
    case 'taskItem': {
      const checked = attrs.checked === true

      return `<li data-type="taskItem" data-checked="${checked}"><label>${checked ? '☑' : '☐'}</label><div>${blocksHtml(node.content)}</div></li>`
    }
    case 'table':
      return tableHtml(node)
    case 'horizontalRule':
      return '<hr>'
    case 'pageBreak':
      return '<div class="doc-page-break"></div>'
    default:
      return blocksHtml(node.content)
  }
}

const blocksHtml = (nodes: DocNode[] = []): string => nodes.map(blockHtml).join('')

/** The document's content as HTML (no page around it). */
export const htmlFromDocument = (doc: DocJSON): string => blocksHtml(doc.content)

/** A self-contained page main prints to PDF: the document's page size and margins, no chrome. */
export function printView(doc: DocJSON, title: string): string {
  const page = pageOf(doc)
  const { margins } = page
  const css = [
    `@page { size: ${page.width}pt ${page.height}pt; margin: ${margins.top}pt ${margins.right}pt ${margins.bottom}pt ${margins.left}pt }`,
    'html, body { margin: 0; padding: 0; background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact }',
    '.doc { overflow-wrap: break-word; white-space: pre-wrap; tab-size: 36pt }',
    looksCss(doc, '.doc'),
    contentCss('.doc', 'print')
  ].join('\n')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><div class="doc">${htmlFromDocument(doc)}</div></body></html>`
}
