/*
 * A small XML parser for the parts of Office files: elements with their attributes and children,
 * text with its entities decoded, and the declaration, processing instructions, comments and a
 * DOCTYPE skipped. It throws on what is not well-formed (a tag closed by another, one never
 * closed, a stray ampersand), scans with indexOf so parts of several megabytes parse quickly, and
 * needs no DOM, so it runs in Node as in the app. Given the prefixes to use for namespaces, it
 * writes every element and attribute name with those, whatever prefixes the file declared.
 */

export interface XmlElement {
  /** The qualified name, as written ("w:p"), or with the prefix asked for its namespace. */
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}

export type XmlNode = XmlElement | string

export interface ParseOptions {
  /** The prefix to give each namespace (by URI), whatever prefix the file declares it with; '' for none. */
  prefixes?: Readonly<Record<string, string>>
}

const GT = 62
const SLASH = 47
const BANG = 33
const QUESTION = 63
const EQUALS = 61
const QUOTE = 34
const APOSTROPHE = 39

const isSpace = (code: number): boolean => code === 32 || code === 10 || code === 9 || code === 13

const isNameStart = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 58 || code > 127

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

const isXmlChar = (code: number): boolean => code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)

function fail(xml: string, at: number, problem: string): never {
  let line = 1

  for (let i = xml.indexOf('\n'); i !== -1 && i < at; i = xml.indexOf('\n', i + 1)) {
    line++
  }

  throw new Error(`Malformed XML (line ${line}): ${problem}`)
}

function decode(raw: string, xml: string, at: number): string {
  let amp = raw.indexOf('&')

  if (amp === -1) {
    return raw
  }

  let out = ''
  let last = 0

  while (amp !== -1) {
    const semicolon = raw.indexOf(';', amp + 1)

    if (semicolon === -1 || semicolon - amp > 12) {
      fail(xml, at, 'an ampersand that does not start an entity')
    }

    const name = raw.slice(amp + 1, semicolon)
    let char = ENTITIES[name]

    if (char === undefined) {
      const hex = /^#x([0-9a-fA-F]+)$/.exec(name)
      const decimal = hex ? null : /^#([0-9]+)$/.exec(name)
      const code = hex ? Number.parseInt(hex[1], 16) : decimal ? Number.parseInt(decimal[1], 10) : Number.NaN

      if (!isXmlChar(code)) {
        fail(xml, at, `an unknown entity &${name};`)
      }

      char = String.fromCodePoint(code)
    }

    out += raw.slice(last, amp) + char
    last = semicolon + 1
    amp = raw.indexOf('&', last)
  }

  return out + raw.slice(last)
}

const lineEnds = (raw: string): string => (raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw)

/** An attribute's value as XML gives it: line breaks and tabs as spaces, then entities decoded. */
const attributeValue = (raw: string, xml: string, at: number): string => decode(/[\t\n\r]/.test(raw) ? lineEnds(raw).replace(/[\t\n]/g, ' ') : raw, xml, at)

interface Scope {
  uris: Map<string, string>
  names: Map<string, string>
}

function declare(parent: Scope, attrs: Record<string, string>): Scope {
  const uris = new Map(parent.uris)

  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'xmlns') {
      uris.set('', value)
    } else if (name.startsWith('xmlns:')) {
      uris.set(name.slice(6), value)
    }
  }

  return { uris, names: new Map() }
}

function rename(name: string, scope: Scope, prefixes: Readonly<Record<string, string>>, attribute: boolean): string {
  const key = attribute ? `@${name}` : name
  const known = scope.names.get(key)

  if (known !== undefined) {
    return known
  }

  const colon = name.indexOf(':')
  const prefix = colon === -1 ? '' : name.slice(0, colon)
  // Attributes without a prefix are in no namespace, and xmlns and xml are not namespaces of the file's.
  const uri = (attribute && colon === -1) || prefix === 'xmlns' || prefix === 'xml' || name === 'xmlns' ? undefined : scope.uris.get(prefix)
  const wanted = uri === undefined ? undefined : prefixes[uri]
  const local = name.slice(colon + 1)
  const renamed = wanted === undefined || wanted === prefix ? name : wanted ? `${wanted}:${local}` : local
  scope.names.set(key, renamed)

  return renamed
}

function renameAttributes(attrs: Record<string, string>, scope: Scope, prefixes: Readonly<Record<string, string>>): Record<string, string> {
  const keys = Object.keys(attrs)

  if (keys.every((key) => rename(key, scope, prefixes, true) === key)) {
    return attrs
  }

  return Object.fromEntries(keys.map((key) => [rename(key, scope, prefixes, true), attrs[key]]))
}

/** The root element of an XML document; throws when the document is not well-formed. */
export function parseXml(xml: string, options: ParseOptions = {}): XmlElement {
  const prefixes = options.prefixes
  const top: XmlElement = { name: '', attrs: {}, children: [] }
  const open: XmlElement[] = [top]
  const written: string[] = ['']
  const scopes: Scope[] = [{ uris: new Map(), names: new Map() }]
  const length = xml.length
  let root: XmlElement | null = null
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0

  const addText = (text: string, at: number): void => {
    const parent = open[open.length - 1]

    if (parent === top) {
      if (text.trim()) {
        fail(xml, at, 'text outside the root element')
      }

      return
    }

    const last = parent.children.length - 1

    if (last >= 0 && typeof parent.children[last] === 'string') {
      parent.children[last] += text
    } else {
      parent.children.push(text)
    }
  }

  const startTag = (lt: number): number => {
    let p = lt + 1

    while (p < length) {
      const code = xml.charCodeAt(p)

      if (isSpace(code) || code === GT || code === SLASH) {
        break
      }

      p++
    }

    const name = xml.slice(lt + 1, p)

    if (!name || !isNameStart(name.charCodeAt(0))) {
      fail(xml, lt, 'a tag without a proper name')
    }

    const attrs: Record<string, string> = {}
    let declares = false
    let prefixed = false

    for (;;) {
      const before = p

      while (p < length && isSpace(xml.charCodeAt(p))) {
        p++
      }

      if (p >= length) {
        fail(xml, lt, `<${name}> is not closed`)
      }

      const code = xml.charCodeAt(p)
      const closes = code === SLASH

      if (code === GT || closes) {
        if (closes && xml.charCodeAt(p + 1) !== GT) {
          fail(xml, p, `a stray slash in <${name}>`)
        }

        const parent = open[open.length - 1]
        const scope = declares ? declare(scopes[scopes.length - 1], attrs) : scopes[scopes.length - 1]
        const element: XmlElement = { name, attrs, children: [] }

        if (prefixes) {
          element.name = rename(name, scope, prefixes, false)

          if (prefixed) {
            element.attrs = renameAttributes(attrs, scope, prefixes)
          }
        }

        if (parent === top) {
          if (root) {
            fail(xml, lt, 'more than one root element')
          }

          root = element
        } else {
          parent.children.push(element)
        }

        if (!closes) {
          open.push(element)
          written.push(name)
          scopes.push(scope)
        }

        return p + (closes ? 2 : 1)
      }

      if (p === before) {
        fail(xml, p, `attributes in <${name}> not separated by spaces`)
      }

      const nameStart = p

      while (p < length) {
        const char = xml.charCodeAt(p)

        if (char === EQUALS || isSpace(char) || char === GT || char === SLASH) {
          break
        }

        p++
      }

      const key = xml.slice(nameStart, p)

      while (p < length && isSpace(xml.charCodeAt(p))) {
        p++
      }

      if (!key || xml.charCodeAt(p) !== EQUALS) {
        fail(xml, p, `the attribute ${key || '?'} in <${name}> has no value`)
      }

      p++

      while (p < length && isSpace(xml.charCodeAt(p))) {
        p++
      }

      const quote = xml.charCodeAt(p)

      if (quote !== QUOTE && quote !== APOSTROPHE) {
        fail(xml, p, `the value of ${key} in <${name}> is not quoted`)
      }

      const end = xml.indexOf(quote === QUOTE ? '"' : "'", p + 1)

      if (end === -1) {
        fail(xml, p, `the value of ${key} in <${name}> is not closed`)
      }

      const raw = xml.slice(p + 1, end)

      if (raw.includes('<')) {
        fail(xml, p, `a "<" in the value of ${key}`)
      }

      if (Object.hasOwn(attrs, key)) {
        fail(xml, p, `${key} twice in <${name}>`)
      }

      attrs[key] = attributeValue(raw, xml, p)
      declares ||= key === 'xmlns' || key.startsWith('xmlns:')
      prefixed ||= key.includes(':')
      p = end + 1
    }
  }

  while (i < length) {
    const lt = xml.indexOf('<', i)
    const textEnd = lt === -1 ? length : lt

    if (textEnd > i) {
      const raw = xml.slice(i, textEnd)
      addText(raw.includes('&') || raw.includes('\r') ? decode(lineEnds(raw), xml, i) : raw, i)
    }

    if (lt === -1) {
      break
    }

    const next = xml.charCodeAt(lt + 1)

    if (next === SLASH) {
      const gt = xml.indexOf('>', lt + 2)

      if (gt === -1) {
        fail(xml, lt, 'a closing tag without ">"')
      }

      const name = xml.slice(lt + 2, gt).trimEnd()
      const depth = open.length - 1

      if (depth === 0) {
        fail(xml, lt, `</${name}> closes nothing`)
      }

      if (written[depth] !== name) {
        fail(xml, lt, `<${written[depth]}> closed by </${name}>`)
      }

      open.pop()
      written.pop()
      scopes.pop()
      i = gt + 1
    } else if (next === BANG) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4)

        if (end === -1) {
          fail(xml, lt, 'a comment that is not closed')
        }

        i = end + 3
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9)

        if (end === -1) {
          fail(xml, lt, 'a CDATA section that is not closed')
        }

        if (open.length === 1) {
          fail(xml, lt, 'a CDATA section outside the root element')
        }

        addText(lineEnds(xml.slice(lt + 9, end)), lt)
        i = end + 3
      } else if (xml.startsWith('<!DOCTYPE', lt) && !root) {
        const bracket = xml.indexOf('[', lt)
        let close = xml.indexOf('>', lt)

        // An internal subset can hold ">" of its own, so the DOCTYPE ends after its "]".
        if (bracket !== -1 && close !== -1 && bracket < close) {
          const subsetEnd = xml.indexOf(']', bracket)
          close = subsetEnd === -1 ? -1 : xml.indexOf('>', subsetEnd)
        }

        if (close === -1) {
          fail(xml, lt, 'a DOCTYPE that is not closed')
        }

        i = close + 1
      } else {
        fail(xml, lt, 'markup that is not a comment, CDATA or DOCTYPE')
      }
    } else if (next === QUESTION) {
      const end = xml.indexOf('?>', lt + 2)

      if (end === -1) {
        fail(xml, lt, 'a processing instruction that is not closed')
      }

      i = end + 2
    } else {
      i = startTag(lt)
    }
  }

  if (open.length > 1) {
    fail(xml, length, `<${written[open.length - 1]}> is never closed`)
  }

  if (!root) {
    fail(xml, length, 'no root element')
  }

  return root
}

/** Whether a document is well-formed XML. */
export function wellFormed(xml: string): boolean {
  try {
    parseXml(xml)

    return true
  } catch {
    return false
  }
}

// Walking the tree.

export const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

export const attr = (element: XmlElement | undefined, name: string): string | undefined => element?.attrs[name]

/** The first child element with this name. */
export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  for (const node of element?.children ?? []) {
    if (typeof node !== 'string' && node.name === name) {
      return node
    }
  }

  return undefined
}

/** The child elements, all of them or those with this name. */
export function children(element: XmlElement | undefined, name?: string): XmlElement[] {
  const out: XmlElement[] = []

  for (const node of element?.children ?? []) {
    if (typeof node !== 'string' && (name === undefined || node.name === name)) {
      out.push(node)
    }
  }

  return out
}

/** The first element with this name under `element`, depth first. */
export function find(element: XmlElement | undefined, name: string): XmlElement | undefined {
  for (const node of element?.children ?? []) {
    if (typeof node !== 'string') {
      const found = node.name === name ? node : find(node, name)

      if (found) {
        return found
      }
    }
  }

  return undefined
}

/** Every element with this name under `element`, in document order. */
export function findAll(element: XmlElement | undefined, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const node of element?.children ?? []) {
    if (typeof node !== 'string') {
      if (node.name === name) {
        out.push(node)
      }

      findAll(node, name, out)
    }
  }

  return out
}

/** All the text under a node, in document order. */
export function textOf(node: XmlNode | undefined): string {
  if (node === undefined) {
    return ''
  }

  if (typeof node === 'string') {
    return node
  }

  let out = ''

  for (const item of node.children) {
    out += typeof item === 'string' ? item : textOf(item)
  }

  return out
}
