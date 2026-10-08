import { type CalloutKind, HERALD_LOOKS, hexColor, HIGHLIGHT_COLORS, round, type StyleLook, type StyleName } from '../document.ts'
import { halfPointsToPoints, twipsToPoints } from './units.ts'
import { attr, child, children, find, type XmlElement } from './xml.ts'

/*
 * Word's styles as the formatting they give text: the document defaults, paragraph and character
 * styles inherited through their basedOn chains, and the theme's fonts, resolved in Word's order
 * (defaults, the paragraph style, the character style, then the run's own formatting). Also which
 * of Herald's styles a Word style is, and the look each of Herald's styles has in a file.
 */

export interface RunProps {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  hidden?: boolean
  /** "#rrggbb", or null for Word's automatic colour. */
  color?: string | null
  highlight?: string | null
  /** A run's shading, shown as a highlight when it has none. */
  shade?: string | null
  size?: number
  font?: string
  script?: 'superscript' | 'subscript' | null
}

export type Alignment = 'left' | 'center' | 'right' | 'justify'

export interface LineSpacing {
  /** 240ths of a line when the rule is auto, twips otherwise. */
  value: number
  rule: 'auto' | 'exact' | 'atLeast'
}

export interface ParaProps {
  align?: Alignment
  spaceBefore?: number
  spaceAfter?: number
  line?: LineSpacing
  /** Left indent in points. */
  indent?: number
  /** First-line indent in points; negative for a hanging indent. */
  firstLine?: number
  outline?: number
  numId?: string
  ilvl?: number
  pageBreakBefore?: boolean
}

export interface ThemeFonts {
  major?: string
  minor?: string
}

/** What one of a file's styles is in Herald Docs. */
export type StyleRole =
  | { kind: 'normal' }
  | { kind: 'custom' }
  | { kind: 'title' }
  | { kind: 'subtitle' }
  | { kind: 'heading'; level: number }
  | { kind: 'quote' }
  | { kind: 'code' }
  | { kind: 'callout'; callout: CalloutKind }

export interface ParagraphStyle {
  id: string
  /** The name Word shows, capitalised. */
  name: string
  role: StyleRole
  /** The chain's own formatting, without the document defaults. */
  para: ParaProps
  run: RunProps
}

export interface CharacterStyle {
  id: string
  name: string
  role: 'code' | 'quiet' | 'custom'
  run: RunProps
}

export interface Styles {
  defaults: { para: ParaProps; run: RunProps }
  theme: ThemeFonts
  /** A paragraph style by id; the default paragraph style for none or an unknown one. */
  paragraph: (id: string | undefined) => ParagraphStyle
  character: (id: string | undefined) => CharacterStyle | null
  /** Which borders a table style (or the default table style) draws, by side. */
  tableBorders: (id: string | undefined) => Record<string, boolean>
  /** The numbering a numbering style (as abstractNum's numStyleLink names it) uses. */
  numberingOf: (id: string) => string | undefined
  /** The style each of Herald's styles takes its look from in this file. */
  heraldStyles: () => Partial<Record<StyleName, ParagraphStyle>>
}

const OFF = new Set(['0', 'false', 'off'])

/** An on/off attribute as Word writes it ("1", "true", "on"). */
export const isOn = (value: string | undefined): boolean => value !== undefined && !OFF.has(value)

/** A toggle as Word writes it: present means on, unless its value says off. */
export const flag = (element: XmlElement | undefined): boolean | undefined => (element ? isOn(attr(element, 'w:val') ?? 'true') : undefined)

export const intOf = (value: string | undefined): number | undefined => {
  const number = value === undefined ? Number.NaN : Number.parseInt(value, 10)

  return Number.isFinite(number) ? number : undefined
}

const colorOf = (value: string | undefined): string | null | undefined => (value === undefined ? undefined : value === 'auto' ? null : (hexColor(value) ?? undefined))

/** The background a w:shd paints: its fill, or its pattern colour when the pattern is solid. */
export function shadingOf(element: XmlElement | undefined): string | null | undefined {
  if (!element) {
    return undefined
  }

  const pattern = attr(element, 'w:val')

  if (pattern === 'nil') {
    return null
  }

  const solid = pattern === 'solid' ? colorOf(attr(element, 'w:color')) : undefined

  return solid ?? colorOf(attr(element, 'w:fill')) ?? null
}

function fontOf(element: XmlElement, theme: ThemeFonts): string | undefined {
  const themed = attr(element, 'w:asciiTheme') ?? attr(element, 'w:hAnsiTheme')
  const fromTheme = themed ? (themed.startsWith('major') ? theme.major : theme.minor) : undefined

  return fromTheme ?? attr(element, 'w:ascii') ?? attr(element, 'w:hAnsi')
}

/** The formatting a run properties element gives. */
export function runProps(rPr: XmlElement | undefined, theme: ThemeFonts): RunProps {
  const props: RunProps = {}

  for (const element of children(rPr)) {
    const value = attr(element, 'w:val')

    switch (element.name) {
      case 'w:b':
        props.bold = flag(element)
        break
      case 'w:i':
        props.italic = flag(element)
        break
      case 'w:u':
        props.underline = value !== 'none'
        break
      case 'w:strike':
      case 'w:dstrike':
        props.strike = Boolean(props.strike || flag(element))
        break
      case 'w:vanish':
        props.hidden = flag(element)
        break
      case 'w:color': {
        const color = colorOf(value)

        if (color !== undefined) {
          props.color = color
        }

        break
      }
      case 'w:highlight':
        props.highlight = value && value !== 'none' ? (HIGHLIGHT_COLORS[value] ?? null) : null
        break
      case 'w:shd': {
        const shade = shadingOf(element)

        if (shade !== undefined) {
          props.shade = shade
        }

        break
      }
      case 'w:sz': {
        const size = halfPointsToPoints(value)

        if (size !== null && size > 0) {
          props.size = round(size)
        }

        break
      }
      case 'w:rFonts': {
        const font = fontOf(element, theme)

        if (font) {
          props.font = font
        }

        break
      }
      case 'w:vertAlign':
        props.script = value === 'superscript' || value === 'subscript' ? value : null
        break
    }
  }

  return props
}

const ALIGNMENTS: Record<string, Alignment> = {
  left: 'left',
  start: 'left',
  center: 'center',
  right: 'right',
  end: 'right',
  both: 'justify',
  distribute: 'justify',
  lowKashida: 'justify',
  mediumKashida: 'justify',
  highKashida: 'justify',
  thaiDistribute: 'justify'
}

const twips = (element: XmlElement, ...names: string[]): number | undefined => {
  for (const name of names) {
    const points = twipsToPoints(attr(element, name))

    if (points !== null) {
      return round(points)
    }
  }

  return undefined
}

/** The formatting a paragraph properties element gives. */
export function paraProps(pPr: XmlElement | undefined): ParaProps {
  const props: ParaProps = {}

  for (const element of children(pPr)) {
    switch (element.name) {
      case 'w:jc': {
        const align = ALIGNMENTS[attr(element, 'w:val') ?? '']

        if (align) {
          props.align = align
        }

        break
      }
      case 'w:spacing': {
        const before = twips(element, 'w:before')
        const after = twips(element, 'w:after')
        const line = intOf(attr(element, 'w:line'))
        const rule = attr(element, 'w:lineRule')

        if (before !== undefined) {
          props.spaceBefore = before
        }

        if (after !== undefined) {
          props.spaceAfter = after
        }

        if (line !== undefined && line > 0) {
          props.line = { value: line, rule: rule === 'exact' || rule === 'atLeast' ? rule : 'auto' }
        }

        break
      }
      case 'w:ind': {
        const indent = twips(element, 'w:left', 'w:start')
        const firstLine = twips(element, 'w:firstLine')
        const hanging = twips(element, 'w:hanging')

        if (indent !== undefined) {
          props.indent = indent
        }

        if (hanging !== undefined) {
          props.firstLine = -hanging
        } else if (firstLine !== undefined) {
          props.firstLine = firstLine
        }

        break
      }
      case 'w:outlineLvl': {
        const level = intOf(attr(element, 'w:val'))

        if (level !== undefined) {
          props.outline = level
        }

        break
      }
      case 'w:numPr': {
        const numId = attr(child(element, 'w:numId'), 'w:val')
        const ilvl = intOf(attr(child(element, 'w:ilvl'), 'w:val'))

        if (numId !== undefined) {
          props.numId = numId
        }

        if (ilvl !== undefined) {
          props.ilvl = ilvl
        }

        break
      }
      case 'w:pageBreakBefore':
        props.pageBreakBefore = flag(element)
        break
    }
  }

  return props
}

export const mergeRun = (...layers: RunProps[]): RunProps => Object.assign({}, ...layers)

export const mergePara = (...layers: ParaProps[]): ParaProps => Object.assign({}, ...layers)

const TOGGLES = ['bold', 'italic', 'strike', 'hidden'] as const

/**
 * A run's formatting in Word's order. A character style that turns a toggle on (bold, italic)
 * over a paragraph style that has it on turns it off, as Word does with Emphasis in a Quote.
 */
export function resolveRun(defaults: RunProps, paragraph: RunProps, character: RunProps | null, direct: RunProps): RunProps {
  const styled = mergeRun(defaults, paragraph)

  if (!character) {
    return mergeRun(styled, direct)
  }

  const toggled = mergeRun(styled, character)

  for (const key of TOGGLES) {
    if (character[key] === true && styled[key] === true) {
      toggled[key] = false
    }
  }

  return mergeRun(toggled, direct)
}

/** Line spacing as a multiple of single spacing; exact and at-least spacing against the font size. */
export function lineMultiple(line: LineSpacing | undefined, size: number): number | null {
  if (!line) {
    return null
  }

  return line.rule === 'auto' ? round(line.value / 240, 3) : round(line.value / 20 / (size * 1.2), 3)
}

const plainName = (name: string): string => name.toLowerCase().replace(/\s+/g, ' ').trim()

const CODE_STYLES = new Set(['source code', 'html preformatted', 'code', 'sourcecode', 'htmlpreformatted'])

const CODE_CHARACTERS = new Set(['verbatim char', 'html code', 'verbatimchar', 'htmlcode'])

const QUIET_PARAGRAPHS = /^(normal|list paragraph|list|list \d|list (bullet|number|continue)( \d)?|toc \d|toc heading|footnote text|endnote text|header|footer|annotation text|annotation subject|balloon text)$/

const QUIET_CHARACTERS = /^(default paragraph font|hyperlink|followedhyperlink|followed hyperlink|footnote reference|endnote reference|annotation reference|page number|line number|placeholder text)$/

const CALLOUT = /^(?:callout |heraldcallout)(info|note|success|warning|error)$/

function paragraphRole(id: string, name: string, para: ParaProps, isDefault: boolean): StyleRole {
  const plain = plainName(name)
  const key = id.toLowerCase()

  if (plain === 'title' || key === 'title') {
    return { kind: 'title' }
  }

  if (plain === 'subtitle' || key === 'subtitle') {
    return { kind: 'subtitle' }
  }

  const heading = /^heading ?([1-9])$/.exec(plain) ?? /^heading([1-9])$/.exec(key)

  if (heading) {
    return { kind: 'heading', level: Number(heading[1]) }
  }

  if (plain === 'quote' || plain === 'intense quote' || key === 'quote' || key === 'intensequote') {
    return { kind: 'quote' }
  }

  if (CODE_STYLES.has(plain) || CODE_STYLES.has(key)) {
    return { kind: 'code' }
  }

  const callout = CALLOUT.exec(plain) ?? CALLOUT.exec(key)

  if (callout) {
    return { kind: 'callout', callout: callout[1] as CalloutKind }
  }

  if (para.outline !== undefined && para.outline < 9) {
    return { kind: 'heading', level: para.outline + 1 }
  }

  return isDefault || QUIET_PARAGRAPHS.test(plain) ? { kind: 'normal' } : { kind: 'custom' }
}

const displayName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)

interface StyleDef {
  id: string
  type: string
  name: string
  basedOn?: string
  link?: string
  isDefault: boolean
  element: XmlElement
}

const SIDES = ['w:top', 'w:left', 'w:start', 'w:bottom', 'w:right', 'w:end', 'w:insideH', 'w:insideV']

/** Which sides a borders element draws (true) or clears (false). */
export function borderSides(borders: XmlElement | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {}

  for (const side of SIDES) {
    const element = child(borders, side)

    if (element) {
      const value = attr(element, 'w:val') ?? 'none'
      out[side] = value !== 'none' && value !== 'nil'
    }
  }

  return out
}

/** The theme's heading and body fonts, which styles name as majorHAnsi and minorHAnsi. */
export function themeFonts(theme: XmlElement | null): ThemeFonts {
  const scheme = find(theme ?? undefined, 'a:fontScheme')
  const latin = (name: string): string | undefined => attr(child(child(scheme, name), 'a:latin'), 'typeface') || undefined

  return { major: latin('a:majorFont'), minor: latin('a:minorFont') }
}

/** The styles of a file, from its styles part and theme. */
export function readStyles(stylesXml: XmlElement | null, themeXml: XmlElement | null): Styles {
  const theme = themeFonts(themeXml)
  const root = stylesXml ?? undefined
  const docDefaults = child(root, 'w:docDefaults')
  const defaults = {
    para: paraProps(child(child(docDefaults, 'w:pPrDefault'), 'w:pPr')),
    run: runProps(child(child(docDefaults, 'w:rPrDefault'), 'w:rPr'), theme)
  }
  const defs = new Map<string, StyleDef>()
  const order: StyleDef[] = []

  for (const element of children(root, 'w:style')) {
    const id = attr(element, 'w:styleId')

    if (!id || defs.has(id)) {
      continue
    }

    const def: StyleDef = {
      id,
      type: attr(element, 'w:type') ?? 'paragraph',
      name: attr(child(element, 'w:name'), 'w:val') ?? id,
      basedOn: attr(child(element, 'w:basedOn'), 'w:val'),
      link: attr(child(element, 'w:link'), 'w:val'),
      isDefault: isOn(attr(element, 'w:default')),
      element
    }
    defs.set(id, def)
    order.push(def)
  }

  const defaultOf = (type: string): StyleDef | undefined => order.find((def) => def.type === type && def.isDefault) ?? (type === 'paragraph' ? defs.get('Normal') : undefined)
  const defaultParagraph = defaultOf('paragraph')

  /** A style's chain, from the root of its basedOn line down to it. */
  const chainOf = (def: StyleDef): StyleDef[] => {
    const chain: StyleDef[] = []
    const seen = new Set<string>()

    for (let current: StyleDef | undefined = def; current && !seen.has(current.id); current = current.basedOn ? defs.get(current.basedOn) : undefined) {
      if (current.type !== def.type) {
        break
      }

      seen.add(current.id)
      chain.unshift(current)
    }

    return chain
  }

  const paragraphs = new Map<string, ParagraphStyle>()

  const resolveParagraph = (def: StyleDef | undefined): ParagraphStyle => {
    const key = def?.id ?? ''
    const known = paragraphs.get(key)

    if (known) {
      return known
    }

    const chain = def ? chainOf(def) : []
    const para = mergePara(...chain.map((item) => paraProps(child(item.element, 'w:pPr'))))
    const run = mergeRun(...chain.map((item) => runProps(child(item.element, 'w:rPr'), theme)))
    const isDefault = !def || def === defaultParagraph
    const style: ParagraphStyle = { id: def?.id ?? '', name: displayName(def?.name ?? 'Normal'), role: paragraphRole(def?.id ?? '', def?.name ?? '', para, isDefault), para, run }
    paragraphs.set(key, style)

    return style
  }

  const characters = new Map<string, CharacterStyle | null>()

  const character = (id: string | undefined): CharacterStyle | null => {
    if (!id) {
      return null
    }

    const known = characters.get(id)

    if (known !== undefined) {
      return known
    }

    const def = defs.get(id)
    let style: CharacterStyle | null = null

    if (def && def.type === 'character') {
      const plain = plainName(def.name)
      const linked = def.link ? defs.get(def.link) : undefined
      const linkedRole = linked && linked.type === 'paragraph' ? resolveParagraph(linked).role.kind : null
      const quiet = QUIET_CHARACTERS.test(plain) || (linkedRole !== null && linkedRole !== 'custom') || def.isDefault
      const code = CODE_CHARACTERS.has(plain) || CODE_CHARACTERS.has(id.toLowerCase())
      const role = code ? 'code' : quiet ? 'quiet' : 'custom'
      style = { id, name: displayName(def.name), role, run: mergeRun(...chainOf(def).map((item) => runProps(child(item.element, 'w:rPr'), theme))) }
    }

    characters.set(id, style)

    return style
  }

  const paragraph = (id: string | undefined): ParagraphStyle => {
    const def = id ? defs.get(id) : undefined

    return resolveParagraph(def && def.type === 'paragraph' ? def : defaultParagraph)
  }

  const tableBorders = (id: string | undefined): Record<string, boolean> => {
    const def = (id ? defs.get(id) : undefined) ?? defaultOf('table')

    return def && def.type === 'table' ? Object.assign({}, ...chainOf(def).map((item) => borderSides(child(child(item.element, 'w:tblPr'), 'w:tblBorders')))) : {}
  }

  const numberingOf = (id: string): string | undefined => {
    const def = defs.get(id)

    return def?.type === 'numbering' ? attr(child(child(child(def.element, 'w:pPr'), 'w:numPr'), 'w:numId'), 'w:val') : undefined
  }

  const heraldStyles = (): Partial<Record<StyleName, ParagraphStyle>> => {
    const out: Partial<Record<StyleName, ParagraphStyle>> = { normal: resolveParagraph(defaultParagraph) }
    // Of two Word styles for one of Herald's, the plainer one gives the look: Quote over Intense Quote.
    const preferred = (name: StyleName, style: ParagraphStyle, plain: string): void => {
      if (!out[name] || (name === 'quote' && plain === 'quote') || (name === 'code' && plain === 'source code')) {
        out[name] = style
      }
    }

    for (const def of order) {
      if (def.type !== 'paragraph' || def === defaultParagraph) {
        continue
      }

      const style = resolveParagraph(def)
      const plain = plainName(def.name)
      const role = style.role

      if (role.kind === 'title' || role.kind === 'subtitle' || role.kind === 'quote' || role.kind === 'code') {
        preferred(role.kind, style, plain)
      } else if (role.kind === 'heading' && role.level <= 6 && (/^heading ?[1-6]$/.test(plain) || /^heading[1-6]$/i.test(def.id))) {
        preferred(`heading${role.level}` as StyleName, style, plain)
      }
    }

    return out
  }

  return { defaults, theme, paragraph, character, tableBorders, numberingOf, heraldStyles }
}

/** Herald's style for a paragraph in a style with this role. */
export function heraldStyleOf(role: StyleRole): StyleName {
  switch (role.kind) {
    case 'title':
    case 'subtitle':
    case 'quote':
    case 'code':
      return role.kind
    case 'heading':
      return `heading${Math.min(6, role.level)}` as StyleName
    default:
      return 'normal'
  }
}

/**
 * The whole look a style gives in a file, so none of Herald's own looks leak into the document:
 * fonts, sizes and spacing resolved through the defaults, and bold and italic set either way.
 */
export function lookOf(style: ParagraphStyle, styles: Styles, name: StyleName): StyleLook {
  const run = mergeRun(styles.defaults.run, style.run)
  const para = mergePara(styles.defaults.para, style.para)
  const size = run.size ?? 10
  const look: StyleLook = {
    font: run.font ?? 'Times New Roman',
    size,
    bold: run.bold ?? false,
    italic: run.italic ?? false,
    spaceBefore: para.spaceBefore ?? 0,
    spaceAfter: para.spaceAfter ?? 0,
    lineHeight: lineMultiple(para.line, size) ?? 1
  }

  // Herald's Subtitle and Quote are grey; a style in Word's automatic colour is black on the page.
  const color = run.color ?? (HERALD_LOOKS[name].color ? '#000000' : null)

  if (color) {
    look.color = color
  }

  return look
}
