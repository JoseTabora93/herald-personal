import { describe, expect, it } from 'vitest'
import type { Paragraph, TextBody } from './deck.ts'
import { allRuns, effectiveStyle, isBlank, listMarkers, numberLabel, ownStyle, paragraphIndent, plainText, styleAll, textBody, tidyRuns, withParagraph } from './text.ts'

const para = (text: string, extra: Omit<Paragraph, 'runs'> = {}): Paragraph => ({ ...extra, runs: [{ text }] })

describe('list markers', () => {
  it('shows bullets by level and counts numbers on, as PowerPoint does', () => {
    const markers = listMarkers([
      para('a', { list: 'number' }),
      para('b', { list: 'number' }),
      para('b1', { list: 'number', level: 1 }),
      para('b2', { list: 'number', level: 1 }),
      para('c', { list: 'number' }),
      para('d', { list: 'bullet' }),
      para('e', { list: 'number' }),
      para('f', { list: 'bullet', level: 1 }),
      para('plain'),
      para('g', { list: 'number', startAt: 5 }),
      para('h', { list: 'number', startAt: 5 })
    ])

    expect(markers).toEqual(['1.', '2.', 'a.', 'b.', '3.', '•', '1.', '◦', null, '5.', '6.'])
  })

  it('writes numbers in each style', () => {
    expect(numberLabel(4, 'romanUcPeriod')).toBe('IV.')
    expect(numberLabel(14, 'romanLcPeriod')).toBe('xiv.')
    expect(numberLabel(28, 'alphaLcParenR')).toBe('ab)')
    expect(numberLabel(3, 'alphaUcPeriod')).toBe('C.')
    expect(numberLabel(7, 'arabicParenR')).toBe('7)')
  })

  it('indents list paragraphs by level with a hanging marker', () => {
    expect(paragraphIndent(para('x', { list: 'bullet', level: 2 }))).toEqual({ margin: 81, indent: -27 })
    expect(paragraphIndent(para('x'))).toEqual({ margin: 0, indent: 0 })
    expect(paragraphIndent(para('x', { list: 'bullet', margin: 18, indent: -18 }))).toEqual({ margin: 18, indent: -18 })
  })
})

describe('runs and styles', () => {
  const body: TextBody = { ...textBody({ font: '+body', size: 20, color: 'tx1' }), paragraphs: [{ runs: [{ text: 'Hello ', bold: true }, { text: 'world', size: 30 }] }] }

  it('works out what a run looks like from the body', () => {
    expect(effectiveStyle(body.paragraphs[0].runs[1], body)).toMatchObject({ font: '+body', size: 30, color: 'tx1' })
    expect(ownStyle({ text: 'x', size: 20, bold: false, color: 'accent1' }, body)).toEqual({ text: 'x', color: 'accent1' })
  })

  it('joins neighbouring runs that look the same and keeps one empty run', () => {
    expect(tidyRuns([{ text: 'a', bold: true }, { text: 'b', bold: true }, { text: '' }, { text: 'c' }])).toEqual([{ text: 'ab', bold: true }, { text: 'c' }])
    expect(tidyRuns([{ text: '', size: 40 }])).toEqual([{ text: '', size: 40 }])
  })

  it('styles a whole box, clearing what its runs said', () => {
    const big = styleAll(body, { size: 44, bold: true })

    expect(big.style).toMatchObject({ size: 44, bold: true })
    expect(big.paragraphs[0].runs).toEqual([{ text: 'Hello ' }, { text: 'world' }])
    expect(allRuns(big, 'bold', true)).toBe(true)
    expect(allRuns(body, 'bold', true)).toBe(false)
  })

  it('reads text and blankness, and changes paragraph settings', () => {
    const lines = textBody({ font: '+body', size: 18, color: 'tx1' }, { text: 'one\ntwo' })

    expect(plainText(lines)).toBe('one\ntwo')
    expect(isBlank(lines)).toBe(false)
    expect(isBlank(textBody({ font: '+body', size: 18, color: 'tx1' }, { text: '  ' }))).toBe(true)
    expect(withParagraph(para('x', { list: 'bullet', bullet: '–' }), { list: 'number' })).toEqual({ runs: [{ text: 'x' }], list: 'number' })
    expect(withParagraph(para('x', { align: 'center' }), { align: undefined })).toEqual({ runs: [{ text: 'x' }] })
  })
})
