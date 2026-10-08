import { describe, expect, it } from 'vitest'
import { SHAPE_KINDS } from './deck.ts'
import { arrowHead, dashArray, shapePath, textArea } from './shapes.ts'

const points = (path: string): number[][] => [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])])

describe('preset shapes', () => {
  it('draws every preset as a closed outline', () => {
    for (const kind of SHAPE_KINDS) {
      expect(shapePath(kind, 200, 100)).toMatch(/^M.*Z$/)
    }
  })

  it('draws arrows with PowerPoint’s default shaft and head', () => {
    expect(points(shapePath('rightArrow', 200, 100))).toEqual([
      [0, 25],
      [150, 25],
      [150, 0],
      [200, 50],
      [150, 100],
      [150, 75],
      [0, 75]
    ])
  })

  it('fits a star’s points to its box as PowerPoint does', () => {
    const star = points(shapePath('star5', 100, 100))

    expect(star[0][1]).toBeCloseTo(0)
    expect(Math.max(...star.map(([x]) => x))).toBeCloseTo(100, 1)
    expect(Math.max(...star.map(([, y]) => y))).toBeCloseTo(100, 1)
  })

  it('puts a callout’s tail on the side it points to', () => {
    const below = points(shapePath('wedgeRectCallout', 200, 100))
    const right = points(shapePath('wedgeRectCallout', 200, 100, { adj1: 80000, adj2: 0 }))

    expect(below.some(([x, y]) => y > 100 && x < 100)).toBe(true)
    expect(right.some(([x]) => x > 200)).toBe(true)
  })

  it('honours adjust values and keeps them in range', () => {
    expect(shapePath('roundRect', 100, 50, { adj: 50000 })).toContain('A25,25')
    expect(shapePath('roundRect', 100, 50, { adj: 90000 })).toContain('A25,25')
    expect(points(shapePath('triangle', 100, 100, { adj: 0 }))[1]).toEqual([0, 0])
  })

  it('lays text inside the shape', () => {
    const area = textArea('ellipse', 200, 100)

    expect(area.x).toBeCloseTo(100 - 100 * Math.SQRT1_2)
    expect(area.height).toBeCloseTo(100 * Math.SQRT1_2)
    expect(textArea('rect', 10, 10)).toEqual({ x: 0, y: 0, width: 10, height: 10 })
  })
})

describe('line details', () => {
  it('draws dashes in multiples of the line’s width', () => {
    expect(dashArray('dash', 2)).toBe('8 6')
    expect(dashArray('solid', 2)).toBeUndefined()
  })

  it('makes heads that point along the line and shorten it where they are solid', () => {
    const head = arrowHead('triangle', [100, 0], [0, 0], 2)!

    expect(head.filled).toBe(true)
    expect(head.inset).toBeGreaterThan(0)
    expect(points(head.d)[0]).toEqual([100, 0])
    expect(arrowHead('none', [1, 1], [0, 0], 1)).toBeNull()
    expect(arrowHead('arrow', [10, 0], [0, 0], 1)!.filled).toBe(false)
  })
})
