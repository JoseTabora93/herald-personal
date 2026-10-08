import { describe, expect, it } from 'vitest'
import type { TextBody } from '../deck.ts'
import { textBody } from '../text.ts'
import { bodyToDoc, paragraphsFromDoc, sameParagraphs } from './rich-text.ts'

const body = (paragraphs: TextBody['paragraphs'], bold = false): TextBody => ({ ...textBody({ font: '+heading', size: 32, color: 'tx1', ...(bold ? { bold: true } : {}) }), paragraphs })

describe('text bodies and the editor’s documents', () => {
  it('turns runs into marks and back without change', () => {
    const source = body([
      { align: 'center', list: 'number', level: 1, startAt: 3, lineSpacing: 1.5, spaceAfter: 6, runs: [{ text: 'Plain ' }, { text: 'bold', bold: true }, { text: ' accent', color: 'accent2', size: 40, font: 'Georgia' }] },
      { runs: [{ text: 'line one\nline two', italic: true, underline: true, strike: true, highlight: '#ffff00' }] },
      { runs: [{ text: '' }] }
    ])
    const doc = bodyToDoc(source)

    expect(doc.content?.[0]).toMatchObject({ type: 'paragraph', attrs: { align: 'center', list: 'number', level: 1, startAt: 3, lineSpacing: 1.5, spaceAfter: 6, bullet: null } })
    expect(doc.content?.[0].content?.[1]).toEqual({ type: 'text', text: 'bold', marks: [{ type: 'bold' }] })
    expect(doc.content?.[0].content?.[2]).toEqual({ type: 'text', text: ' accent', marks: [{ type: 'textStyle', attrs: { font: 'Georgia', size: 40, color: 'accent2' } }] })
    expect(doc.content?.[1].content?.map((node) => node.type)).toEqual(['text', 'hardBreak', 'text'])
    expect(doc.content?.[2].content).toBeUndefined()
    expect(sameParagraphs(paragraphsFromDoc(doc, source), source.paragraphs)).toBe(true)
  })

  it('marks bold everywhere the body is bold, so it can be turned off in places', () => {
    const source = body([{ runs: [{ text: 'Heading ' }, { text: 'light', bold: false }] }], true)
    const doc = bodyToDoc(source)

    expect(doc.content?.[0].content?.[0].marks).toEqual([{ type: 'bold' }])
    expect(doc.content?.[0].content?.[1].marks).toBeUndefined()
    expect(paragraphsFromDoc(doc, source)[0].runs).toEqual([{ text: 'Heading ' }, { text: 'light', bold: false }])
  })

  it('reads what typing leaves: joined runs, a break at a paragraph’s start, and always a paragraph', () => {
    const source = body([{ runs: [{ text: '' }] }])
    const typed = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { list: 'bullet' }, content: [{ type: 'hardBreak' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]
    }

    expect(paragraphsFromDoc(typed, source)).toEqual([{ list: 'bullet', runs: [{ text: '\nab' }] }])
    expect(paragraphsFromDoc({ type: 'doc', content: [] }, source)).toEqual([{ runs: [{ text: '' }] }])
  })

  it('compares paragraphs whatever order their fields are in', () => {
    expect(sameParagraphs([{ align: 'left', runs: [{ text: 'a' }] }], [{ runs: [{ text: 'a' }], align: 'left' }])).toBe(true)
    expect(sameParagraphs([{ runs: [{ text: 'a' }] }], [{ runs: [{ text: 'b' }] }])).toBe(false)
  })
})
