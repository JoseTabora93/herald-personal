import { describe, expect, it } from 'vitest'
import { formatNumber, listKind, numberLabel, readNumbering } from './numbering.ts'
import { parseXml } from './xml.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const level = (ilvl: number, format: string, text: string, extra = '') => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`

const NUMBERING = `<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">${level(0, 'decimal', '%1.')}${level(1, 'lowerLetter', '%1.%2.')}${level(2, 'lowerRoman', '%3)', '<w:lvlRestart w:val="0"/>')}</w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="Outline"/></w:abstractNum>
  <w:abstractNum w:abstractNumId="2"><w:styleLink w:val="Outline"/>${level(0, 'upperRoman', '%1.', '<w:pStyle w:val="Heading1"/>')}</w:abstractNum>
  <w:abstractNum w:abstractNumId="3">${level(0, 'bullet', '\u2022')}<w:lvl w:ilvl="1"><w:numFmt w:val="decimalZero"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="4"><w:abstractNumId w:val="3"/><w:lvlOverride w:ilvl="0">${level(0, 'upperLetter', '%1)')}</w:lvlOverride></w:num>
</w:numbering>`

describe('readNumbering', () => {
  const numbering = () => readNumbering(parseXml(NUMBERING), () => undefined)

  it('reads levels, with start overrides, whole-level overrides and numbering styles', () => {
    const lists = numbering()

    expect(lists.level('1', 1)).toMatchObject({ format: 'lowerLetter', text: '%1.%2.', start: 1 })
    expect(lists.level('2', 0)).toMatchObject({ format: 'decimal', start: 5 })
    expect(lists.level('3', 0)).toMatchObject({ format: 'upperRoman', style: 'Heading1' })
    expect(lists.level('4', 0)).toMatchObject({ format: 'upperLetter', text: '%1)' })
    expect(lists.level('4', 1)).toMatchObject({ format: 'decimalZero', start: 1 })
    expect(lists.level('9', 0)).toBeUndefined()
    expect(lists.levelOfStyle('3', 'Heading1')).toBe(0)
  })

  it('counts as Word does: on across other paragraphs, again after a higher level, never for lvlRestart 0', () => {
    const lists = numbering()

    expect(lists.count('1', 0)[0]).toBe(1)
    expect(lists.count('1', 1)[1]).toBe(1)
    expect(lists.count('1', 1)[1]).toBe(2)
    expect(lists.count('1', 2)[2]).toBe(1)
    expect(lists.count('1', 0)[0]).toBe(2)
    expect(lists.count('1', 1)[1]).toBe(1)
    expect(lists.count('1', 2)[2]).toBe(2)
    expect(lists.count('2', 0)[0]).toBe(5)
    expect(lists.count('2', 0)[0]).toBe(6)
  })

  it('writes labels such as 2.1. with each level’s format', () => {
    const lists = numbering()
    lists.count('1', 0)
    lists.count('1', 0)

    expect(numberLabel(lists, '1', 1, lists.count('1', 1))).toBe('2.a.')
    expect(numberLabel(lists, '4', 0, lists.count('4', 0))).toBe('A)')
  })

  it('finds a numbering style’s definition through its style when no definition links to it', () => {
    const lists = readNumbering(parseXml(NUMBERING.replace('<w:styleLink w:val="Outline"/>', '')), (id) => (id === 'Outline' ? '4' : undefined))

    expect(lists.level('3', 0)).toMatchObject({ format: 'bullet', text: '\u2022' })
  })
})

describe('listKind and formatNumber', () => {
  it('tells bullets, numbers Herald shows as they are, and numbers it shows plainly', () => {
    expect(listKind({ format: 'bullet', text: '\u2022', start: 1, legal: false })).toEqual({ kind: 'bullet' })
    expect(listKind({ format: 'lowerRoman', text: '%1.', start: 1, legal: false })).toEqual({ kind: 'ordered', type: 'i', approximate: false })
    expect(listKind({ format: 'decimalZero', text: '%1.', start: 1, legal: false })).toEqual({ kind: 'ordered', type: '1', approximate: true })
    expect(listKind({ format: 'decimal', text: '%1.%2.', start: 1, legal: false })).toEqual({ kind: 'ordered', type: '1', approximate: true })
    expect(listKind({ format: 'none', text: '', start: 1, legal: false })).toEqual({ kind: 'none' })
  })

  it('writes letters and Roman numerals as Word does', () => {
    expect([1, 26, 27, 53].map((value) => formatNumber(value, 'lowerLetter'))).toEqual(['a', 'z', 'aa', 'aaa'])
    expect([4, 9, 14, 1994].map((value) => formatNumber(value, 'upperRoman'))).toEqual(['IV', 'IX', 'XIV', 'MCMXCIV'])
    expect(formatNumber(7, 'decimalZero')).toBe('07')
    expect(formatNumber(3, 'ordinalText')).toBe('3')
  })
})
