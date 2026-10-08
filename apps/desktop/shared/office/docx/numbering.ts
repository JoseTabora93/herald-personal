import { flag, intOf } from './styles.ts'
import { attr, child, children, type XmlElement } from './xml.ts'

/*
 * Word's list numbering: definitions (abstractNum) with a level for each depth, the numbers (num)
 * paragraphs point at with their overrides, and the counting Word does, where a list keeps its
 * count across the paragraphs between its items and a level starts again after a higher one.
 */

export interface Level {
  format: string
  text: string
  start: number
  /** The level (counted from 1) after which this one starts again; undefined for any higher level, 0 for never. */
  restart?: number
  legal: boolean
  /** The paragraph style that brings this level. */
  style?: string
  /** The level's paragraph properties, such as its indents. */
  pPr?: XmlElement
}

export interface Numbering {
  level: (numId: string, ilvl: number) => Level | undefined
  /** The level a paragraph style holds in a numbering, for styles that bring their own numbering. */
  levelOfStyle: (numId: string, styleId: string) => number | undefined
  /** Counts one more item at a level, and gives the count of every level of the list. */
  count: (numId: string, ilvl: number) => readonly (number | undefined)[]
}

export type ListType = '1' | 'a' | 'A' | 'i' | 'I'

export type ListKind = { kind: 'bullet' } | { kind: 'ordered'; type: ListType; approximate: boolean } | { kind: 'none' }

const ilvlOf = (element: XmlElement): number | undefined => intOf(attr(element, 'w:ilvl'))

/** The level's number format, from the choice Word offers newer readers when it gives one. */
function formatOf(level: XmlElement): XmlElement | undefined {
  return child(level, 'w:numFmt') ?? child(child(child(level, 'mc:AlternateContent'), 'mc:Choice'), 'w:numFmt')
}

function parseLevel(element: XmlElement, startOverride: number | undefined): Level {
  const format = formatOf(element)

  return {
    format: attr(format, 'w:val') ?? 'decimal',
    text: attr(child(element, 'w:lvlText'), 'w:val') ?? '',
    start: startOverride ?? intOf(attr(child(element, 'w:start'), 'w:val')) ?? 1,
    restart: intOf(attr(child(element, 'w:lvlRestart'), 'w:val')),
    legal: flag(child(element, 'w:isLgl')) ?? false,
    style: attr(child(element, 'w:pStyle'), 'w:val'),
    pPr: child(element, 'w:pPr')
  }
}

/** The numbering of a file, from its numbering part; `numberingOf` finds the numbering a numbering style uses. */
export function readNumbering(xml: XmlElement | null, numberingOf: (styleId: string) => string | undefined): Numbering {
  const root = xml ?? undefined
  const abstracts = new Map<string, XmlElement>()
  const byStyle = new Map<string, XmlElement>()
  const nums = new Map<string, XmlElement>()

  for (const abstract of children(root, 'w:abstractNum')) {
    const id = attr(abstract, 'w:abstractNumId')
    const link = attr(child(abstract, 'w:styleLink'), 'w:val')

    if (id !== undefined) {
      abstracts.set(id, abstract)
    }

    if (link) {
      byStyle.set(link, abstract)
    }
  }

  for (const num of children(root, 'w:num')) {
    const id = attr(num, 'w:numId')

    if (id !== undefined) {
      nums.set(id, num)
    }
  }

  // A definition can stand for a numbering style, whose own definition has the levels.
  const abstractOf = (numId: string, depth = 0): XmlElement | undefined => {
    const abstract = abstracts.get(attr(child(nums.get(numId), 'w:abstractNumId'), 'w:val') ?? '')
    const link = attr(child(abstract, 'w:numStyleLink'), 'w:val')

    if (!link) {
      return abstract
    }

    const linked = byStyle.get(link)
    const styleNum = linked ? undefined : numberingOf(link)

    return linked ?? (styleNum && styleNum !== numId && depth < 4 ? abstractOf(styleNum, depth + 1) : abstract)
  }

  const levels = new Map<string, Level | undefined>()

  const level = (numId: string, ilvl: number): Level | undefined => {
    const key = `${numId}:${ilvl}`

    if (levels.has(key)) {
      return levels.get(key)
    }

    const override = children(nums.get(numId), 'w:lvlOverride').find((item) => ilvlOf(item) === ilvl)
    const element = child(override, 'w:lvl') ?? children(abstractOf(numId), 'w:lvl').find((item) => ilvlOf(item) === ilvl)
    const parsed = element ? parseLevel(element, intOf(attr(child(override, 'w:startOverride'), 'w:val'))) : undefined
    levels.set(key, parsed)

    return parsed
  }

  const levelOfStyle = (numId: string, styleId: string): number | undefined => {
    const found = children(abstractOf(numId), 'w:lvl').find((item) => attr(child(item, 'w:pStyle'), 'w:val') === styleId)

    return found ? ilvlOf(found) : undefined
  }

  const counts = new Map<string, (number | undefined)[]>()

  const count = (numId: string, ilvl: number): readonly (number | undefined)[] => {
    const values = counts.get(numId) ?? []
    const current = values[ilvl]
    values[ilvl] = current === undefined ? (level(numId, ilvl)?.start ?? 1) : current + 1

    for (let deeper = ilvl + 1; deeper < 9; deeper++) {
      const restart = level(numId, deeper)?.restart

      if (restart === undefined || (restart > 0 && ilvl <= restart - 1)) {
        values[deeper] = undefined
      }
    }

    counts.set(numId, values)

    return values
  }

  return { level, levelOfStyle, count }
}

const TYPES: Record<string, ListType> = { decimal: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' }

/** What a level shows: bullets, numbers Herald can show as they are, or nothing. */
export function listKind(level: Level): ListKind {
  if (level.format === 'bullet') {
    return { kind: 'bullet' }
  }

  if (level.format === 'none' || !level.text) {
    return { kind: 'none' }
  }

  const type = TYPES[level.format]
  const places = level.text.match(/%[1-9]/g)?.length ?? 0

  return { kind: 'ordered', type: type ?? '1', approximate: !type || places > 1 }
}

const ROMAN: readonly [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i']
]

function roman(value: number): string {
  let out = ''
  let rest = value

  for (const [amount, letters] of ROMAN) {
    while (rest >= amount) {
      out += letters
      rest -= amount
    }
  }

  return out
}

/** Word's letters go a…z, then aa, bb, cc. */
const letters = (value: number): string => String.fromCharCode(97 + ((value - 1) % 26)).repeat(Math.floor((value - 1) / 26) + 1)

/** A number as a level's format writes it; formats Herald has no way to show come out as plain numbers. */
export function formatNumber(value: number, format: string): string {
  if (value < 1) {
    return String(value)
  }

  switch (format) {
    case 'lowerLetter':
      return letters(value)
    case 'upperLetter':
      return letters(value).toUpperCase()
    case 'lowerRoman':
      return roman(value)
    case 'upperRoman':
      return roman(value).toUpperCase()
    case 'decimalZero':
      return String(value).padStart(2, '0')
    default:
      return String(value)
  }
}

/** The label Word shows before an item, such as "2.1." for a level with the text "%1.%2.". */
export function numberLabel(numbering: Numbering, numId: string, ilvl: number, counts: readonly (number | undefined)[]): string {
  const level = numbering.level(numId, ilvl)

  if (!level || level.format === 'bullet' || level.format === 'none') {
    return ''
  }

  return level.text.replace(/%([1-9])/g, (_, digit: string) => {
    const index = Number(digit) - 1
    const other = numbering.level(numId, index)

    return formatNumber(counts[index] ?? other?.start ?? 1, level.legal ? 'decimal' : (other?.format ?? 'decimal'))
  })
}
