/*
 * A small XML reader and writer for Office files, the same in the window and in Node (where tests
 * run without a DOM). Reading gives plain objects; names in the namespaces PowerPoint uses get the
 * prefixes PowerPoint gives them (`p:`, `a:`, `r:`…), whatever prefix a file chose, so code matches
 * names as written in the specification. Text is kept as it is, white space included, and entities
 * other than XML's own are not expanded.
 */

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}

export type XmlNode = XmlElement | string

/** Namespace URIs and the prefix their names get, transitional and strict alike. */
const PREFIXES: Record<string, string> = {
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://schemas.microsoft.com/office/powerpoint/2010/main': 'p14',
  'http://schemas.microsoft.com/office/powerpoint/2012/main': 'p15',
  'http://schemas.microsoft.com/office/powerpoint/2018/8/main': 'p188',
  'http://schemas.microsoft.com/office/drawing/2010/main': 'a14',
  'http://schemas.microsoft.com/office/drawing/2016/SVG/main': 'asvg',
  'http://schemas.openxmlformats.org/package/2006/relationships': '',
  'http://schemas.openxmlformats.org/package/2006/content-types': ''
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text: string): string {
  if (!text.includes('&')) {
    return text
  }

  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)

      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }

    return ENTITIES[name] ?? whole
  })
}

interface Scope {
  [prefix: string]: string
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g

/**
 * Parse a document into its root element. With `canonical` (the default) names in known
 * namespaces get their usual prefixes; without, names stay as the file wrote them (for rewriting a
 * file and writing it back).
 */
export function parseXml(source: string, options: { canonical?: boolean } = {}): XmlElement {
  const canonical = options.canonical ?? true
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const root: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack: { element: XmlElement; scope: Scope; raw: string }[] = [{ element: root, scope: { xml: 'http://www.w3.org/XML/1998/namespace' }, raw: '' }]
  let at = 0

  const rename = (raw: string, scope: Scope, isAttribute: boolean): string => {
    if (!canonical) {
      return raw
    }

    const colon = raw.indexOf(':')

    if (colon < 0) {
      // Attributes without a prefix are in no namespace; elements are in the default one.
      if (isAttribute || scope[''] === undefined) {
        return raw
      }

      const prefix = PREFIXES[scope['']]

      return prefix ? `${prefix}:${raw}` : raw
    }

    const prefix = raw.slice(0, colon)

    if (prefix === 'xmlns' || prefix === 'xml') {
      return raw
    }

    const uri = scope[prefix]
    const known = uri === undefined ? undefined : PREFIXES[uri]

    return known === undefined ? raw : known ? `${known}:${raw.slice(colon + 1)}` : raw.slice(colon + 1)
  }

  while (at < text.length) {
    const open = text.indexOf('<', at)
    const parent = stack[stack.length - 1]

    if (open < 0) {
      const rest = text.slice(at)

      if (rest.trim()) {
        parent.element.children.push(decode(rest))
      }

      break
    }

    if (open > at) {
      parent.element.children.push(decode(text.slice(at, open)))
    }

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4)
      at = end < 0 ? text.length : end + 3
    } else if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9)

      if (end < 0) {
        throw new Error('XML: an unclosed CDATA section')
      }

      parent.element.children.push(text.slice(open + 9, end))
      at = end + 3
    } else if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2)
      at = end < 0 ? text.length : end + 2
    } else if (text.startsWith('<!', open)) {
      // A DOCTYPE: Office files have none, and whatever it declares is not used.
      let depth = 0
      let end = open + 2

      for (; end < text.length; end++) {
        const char = text[end]

        if (char === '[') {
          depth++
        } else if (char === ']') {
          depth--
        } else if (char === '>' && depth <= 0) {
          break
        }
      }

      at = end + 1
    } else if (text[open + 1] === '/') {
      const end = text.indexOf('>', open)
      const raw = text.slice(open + 2, end).trim()

      if (end < 0 || stack.length < 2 || stack[stack.length - 1].raw !== raw) {
        throw new Error(`XML: </${raw}> does not close what is open`)
      }

      stack.pop()
      at = end + 1
    } else {
      // A start tag; `>` may appear inside quoted attribute values.
      let end = open + 1
      let quote = ''

      for (; end < text.length; end++) {
        const char = text[end]

        if (quote) {
          if (char === quote) {
            quote = ''
          }
        } else if (char === '"' || char === "'") {
          quote = char
        } else if (char === '>') {
          break
        }
      }

      if (end >= text.length) {
        throw new Error('XML: an unclosed tag')
      }

      const selfClosing = text[end - 1] === '/'
      const inner = text.slice(open + 1, selfClosing ? end - 1 : end)
      const nameEnd = inner.search(/[\s/]|$/)
      const raw = inner.slice(0, nameEnd)
      const scope: Scope = { ...parent.scope }
      const written: [string, string][] = []

      for (const match of inner.slice(nameEnd).matchAll(ATTRIBUTE)) {
        const name = match[1]
        const value = decode(match[3] ?? match[4] ?? '')
        written.push([name, value])

        if (name === 'xmlns') {
          scope[''] = value
        } else if (name.startsWith('xmlns:')) {
          scope[name.slice(6)] = value
        }
      }

      const attrs: Record<string, string> = {}

      for (const [name, value] of written) {
        attrs[rename(name, scope, true)] = value
      }

      const element: XmlElement = { name: rename(raw, scope, false), attrs, children: [] }
      parent.element.children.push(element)

      if (!selfClosing) {
        stack.push({ element, scope, raw })
      }

      at = end + 1
    }
  }

  if (stack.length > 1) {
    throw new Error(`XML: <${stack[stack.length - 1].raw}> is never closed`)
  }

  const first = root.children.find((node): node is XmlElement => typeof node !== 'string')

  if (!first) {
    throw new Error('XML: no root element')
  }

  return first
}

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const escapeAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')

function write(node: XmlNode, out: string[]): void {
  if (typeof node === 'string') {
    out.push(escapeText(node))

    return
  }

  out.push(`<${node.name}`)

  for (const [name, value] of Object.entries(node.attrs)) {
    out.push(` ${name}="${escapeAttribute(value)}"`)
  }

  if (!node.children.length) {
    out.push('/>')

    return
  }

  out.push('>')

  for (const child of node.children) {
    write(child, out)
  }

  out.push(`</${node.name}>`)
}

/** An element as XML text, with the standard declaration first unless asked not to. */
export function serializeXml(root: XmlElement, declaration = true): string {
  const out: string[] = declaration ? ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'] : []
  write(root, out)

  return out.join('')
}

export const xml = (name: string, attrs: Record<string, string | number | undefined> = {}, children: XmlNode[] = []): XmlElement => ({
  name,
  attrs: Object.fromEntries(Object.entries(attrs).filter((entry): entry is [string, string | number] => entry[1] !== undefined).map(([key, value]) => [key, String(value)])),
  children
})

export const elements = (element: XmlElement | undefined): XmlElement[] => (element ? element.children.filter((node): node is XmlElement => typeof node !== 'string') : [])

export const child = (element: XmlElement | undefined, name: string): XmlElement | undefined => elements(element).find((node) => node.name === name)

export const childrenNamed = (element: XmlElement | undefined, name: string): XmlElement[] => elements(element).filter((node) => node.name === name)

/** The element at a path of child names (`p:cSld/p:spTree`). */
export function find(element: XmlElement | undefined, path: string): XmlElement | undefined {
  let at = element

  for (const name of path.split('/')) {
    at = child(at, name)

    if (!at) {
      return undefined
    }
  }

  return at
}

/** Every element of a name below `element`, in document order (walked without recursion, however deep a file nests). */
export function descendants(element: XmlElement | undefined, name: string): XmlElement[] {
  const out: XmlElement[] = []
  const stack: XmlElement[] = element ? [...elements(element)].reverse() : []

  while (stack.length) {
    const node = stack.pop()!

    if (node.name === name) {
      out.push(node)
    }

    for (let i = node.children.length - 1; i >= 0; i--) {
      const entry = node.children[i]

      if (typeof entry !== 'string') {
        stack.push(entry)
      }
    }
  }

  return out
}

export const attr = (element: XmlElement | undefined, name: string): string | undefined => element?.attrs[name]

/** An attribute as a number, or `fallback` when it is missing or not one. */
export function numberAttr(element: XmlElement | undefined, name: string, fallback: number): number
export function numberAttr(element: XmlElement | undefined, name: string): number | undefined
export function numberAttr(element: XmlElement | undefined, name: string, fallback?: number): number | undefined {
  const value = element?.attrs[name]
  const parsed = value === undefined ? Number.NaN : Number(value)

  return Number.isFinite(parsed) ? parsed : fallback
}

/** An OOXML on/off attribute: `1`, `true` and `on` are on. */
export function flagAttr(element: XmlElement | undefined, name: string): boolean | undefined {
  const value = element?.attrs[name]

  return value === undefined ? undefined : value === '1' || value === 'true' || value === 'on'
}

/** The text inside an element, all of it. */
export function textOf(element: XmlElement | undefined): string {
  const out: string[] = []
  const stack: XmlNode[] = element ? [...element.children].reverse() : []

  while (stack.length) {
    const node = stack.pop()!

    if (typeof node === 'string') {
      out.push(node)
    } else {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i])
      }
    }
  }

  return out.join('')
}
