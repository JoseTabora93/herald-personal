import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME } from './themes.ts'
import { imageSource, normalizeDeck } from './normalize.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('normalizeDeck', () => {
  it('refuses what is not a deck at all', () => {
    expect(() => normalizeDeck(null)).toThrow(/not a Herald Slides deck/)
    expect(() => normalizeDeck({ slides: 'many' })).toThrow()
  })

  it('fills in what is missing and repairs what is wrong', () => {
    const deck = normalizeDeck({
      slides: [
        {
          id: 'one',
          layout: 'nonsense',
          elements: [
            { id: 'a', kind: 'text', x: 'left', y: 1e12, width: 100, height: 40, body: { paragraphs: [{ runs: [{ text: 'Hi', size: -4, color: 'chartreuse' }], level: 99, list: 'stars' }], inset: [1, 2] } },
            { id: 'b', kind: 'shape', shape: 'blob', fill: { color: '#ABC', alpha: 4 }, adjust: { adj: 1000, evil: 'x' } }
          ]
        }
      ]
    })
    const [text, shape] = deck.slides[0].elements

    expect(deck.slides[0].layout).toBe('blank')
    expect(deck.theme).toEqual(DEFAULT_THEME)
    expect(text).toMatchObject({ kind: 'text', x: 0, y: 100_000, rotation: 0 })
    expect(text.kind === 'text' && text.body.paragraphs[0]).toEqual({ level: 8, runs: [{ text: 'Hi', size: 1, color: 'tx1' }] })
    expect(text.kind === 'text' && text.body.inset).toEqual([7.2, 3.6, 7.2, 3.6])
    expect(shape).toMatchObject({ kind: 'shape', shape: 'rect', fill: { color: '#aabbcc', alpha: 1 }, adjust: { adj: 1000 } })
  })

  it('drops unknown kinds, pictures that are not image data, and gives repeated ids new ones', () => {
    const deck = normalizeDeck({
      slides: [
        {
          id: 's',
          elements: [
            { id: 'x', kind: 'video' },
            { id: 'p', kind: 'image', src: 'javascript:alert(1)' },
            { id: 'q', kind: 'image', src: PNG, natural: { width: 10, height: 10 } },
            { id: 'q', kind: 'image', src: PNG, natural: { width: 10, height: 10 } },
            { id: 'r', kind: 'image', src: '', placeholder: { role: 'picture' } }
          ]
        },
        { id: 's', elements: [] }
      ]
    })
    const elements = deck.slides[0].elements

    expect(elements.map((element) => element.kind)).toEqual(['image', 'image', 'image'])
    expect(new Set(elements.map((element) => element.id)).size).toBe(3)
    expect(elements[2].placeholder).toEqual({ role: 'picture', prompt: 'Click to add a picture' })
    expect(new Set(deck.slides.map((slide) => slide.id)).size).toBe(2)
  })

  it('takes only image data as a picture', () => {
    expect(imageSource(PNG)).toBe(PNG)
    expect(imageSource('data:text/html;base64,PGgxPg==')).toBe('')
    expect(imageSource('data:image/png;base64,abc"><script>')).toBe('')
    expect(imageSource('https://example.com/a.png')).toBe('')
  })

  it('keeps a theme’s colours only where they are colours, and its fonts as names', () => {
    const deck = normalizeDeck({ slides: [{}], theme: { id: 'mine', name: 'Mine', colors: { accent1: '#FF0000', tx1: 'red' }, fonts: { heading: 'Avenir"; color: red', body: '+heading' } } })

    expect(deck.theme.colors.accent1).toBe('#ff0000')
    expect(deck.theme.colors.tx1).toBe(DEFAULT_THEME.colors.tx1)
    expect(deck.theme.fonts.heading).toBe('Avenir color: red')
    expect(deck.theme.fonts.body).toBe(DEFAULT_THEME.fonts.body)
  })
})
