import { describe, expect, it } from 'vitest'
import { corners, lineElement, rotatePoint, shapeElement } from '../elements.ts'
import { marqueeHits, moveLineEnd, moveWithSnapping, resizeBox, rotationFor, scaleGroup, snapLines, snapResize } from './gestures.ts'

const SIZE = { width: 960, height: 540 }
const box = { x: 100, y: 100, width: 200, height: 100 }
const close = (a: number[], b: number[]) => a.forEach((value, index) => expect(value).toBeCloseTo(b[index], 6))

describe('resizing', () => {
  it('moves only the dragged side or corner of an upright box', () => {
    expect(resizeBox(box, 0, 'se', 50, 20)).toEqual({ x: 100, y: 100, width: 250, height: 120 })
    expect(resizeBox(box, 0, 'w', 30, 999)).toEqual({ x: 130, y: 100, width: 170, height: 100 })
    expect(resizeBox(box, 0, 'n', 0, 300)).toEqual({ x: 100, y: 196, width: 200, height: 4 })
  })

  it('keeps proportions and resizes about the centre when asked', () => {
    expect(resizeBox(box, 0, 'se', 100, 0, { keepRatio: true })).toEqual({ x: 100, y: 100, width: 300, height: 150 })
    expect(resizeBox(box, 0, 'e', 20, 0, { fromCenter: true })).toEqual({ x: 80, y: 100, width: 240, height: 100 })
  })

  it('keeps the opposite corner of a rotated box where it was', () => {
    const before = corners(box, 30)
    const after = resizeBox(box, 30, 'se', ...(rotatePoint([40, 10], [0, 0], 30) as [number, number]))

    expect(after.width).toBeCloseTo(240)
    expect(after.height).toBeCloseTo(110)
    close(corners(after, 30)[0], before[0])
  })

  it('pulls a dragged side onto a line close by', () => {
    const lines = snapLines(SIZE, [shapeElement('rect', { x: 400, y: 0, width: 50, height: 50 })])
    const snapped = snapResize({ ...box, width: 297 }, 'e', lines, 6)

    expect(snapped.box.width).toBe(300)
    expect(snapped.landed[0]).toMatchObject({ axis: 'x', value: 400 })
  })

  it('scales a group into a new box in proportion', () => {
    const a = shapeElement('rect', { x: 0, y: 0, width: 100, height: 100 })
    const b = shapeElement('rect', { x: 100, y: 100, width: 100, height: 100 })
    const [na, nb] = scaleGroup([a, b], { x: 0, y: 0, width: 200, height: 200 }, { x: 0, y: 0, width: 400, height: 200 })

    expect([na.x, na.y, na.width, na.height]).toEqual([0, 0, 200, 100])
    expect([nb.x, nb.y, nb.width, nb.height]).toEqual([200, 100, 200, 100])
  })
})

describe('moving', () => {
  it('snaps to the slide’s centre and shows what it lines up with', () => {
    const moved = moveWithSnapping({ x: 0, y: 0, width: 100, height: 100 }, 427, 3, { lines: snapLines(SIZE, []), reach: 6, others: [], size: SIZE })

    expect(moved.dx).toBe(430)
    expect(moved.dy).toBe(0)
    expect(moved.guides.some((guide) => guide.axis === 'x' && guide.at === 480)).toBe(true)
  })

  it('holds to one axis, and does not snap when told not to', () => {
    expect(moveWithSnapping(box, 40, 7, { lines: [], reach: 6, others: [], size: SIZE, axis: true })).toMatchObject({ dx: 40, dy: 0 })
    expect(moveWithSnapping(box, 3, 3, { lines: snapLines(SIZE, []), reach: 6, others: [], size: SIZE, snap: false })).toMatchObject({ dx: 3, dy: 3, guides: [] })
  })
})

describe('rotating, lines and selecting', () => {
  it('turns with the pointer, in steps of 15 degrees with Shift, and lands on square angles', () => {
    expect(rotationFor([0, 0], [10, 0], [0, 10], 0)).toBeCloseTo(90)
    expect(rotationFor([0, 0], [10, 0], [10, 3.4], 0, { step: true })).toBe(15)
    expect(rotationFor([0, 0], [10, 0], [10, -0.5], 0)).toBe(0)
    expect(rotationFor([0, 0], [10, 0], [-10, 0.01], 0)).toBe(180)
  })

  it('moves one end of a line, in steps of 45 degrees with Shift', () => {
    const line = lineElement([0, 0], [100, 0])

    expect(moveLineEnd(line, 'to', [50, 60])).toEqual({ from: [0, 0], to: [50, 60] })
    const stepped = moveLineEnd(line, 'to', [100, 90], true)
    expect(stepped.to[0]).toBeCloseTo(stepped.to[1])
  })

  it('selects what a rectangle touches, flat lines included', () => {
    const a = shapeElement('rect', { x: 0, y: 0, width: 50, height: 50 })
    const b = shapeElement('rect', { x: 300, y: 300, width: 50, height: 50 })
    const flat = lineElement([0, 200], [400, 200])

    expect(marqueeHits([a, b, flat], { x: 40, y: 40, width: 200, height: 200 }).sort()).toEqual([a.id, flat.id].sort())
  })
})
