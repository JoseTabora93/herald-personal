import { type SnapLine, linesOf, nearest, smartGuides, snapBox, type GuideLine } from '../../../canvas/engine/snapping.ts'
import type { Box, SlideElement, SlideSize } from '../deck.ts'
import { boundsOf, boxAround, center, corners, lineEnds, type Point, rotatePoint, withBox } from '../elements.ts'

/*
 * The arithmetic of dragging on a slide: moving with snapping and smart guides, resizing from any
 * handle (rotated boxes keep the opposite side still), rotating, line ends and the selection
 * rectangle. Pure, in points; the stage turns the pointer into points and draws what comes back.
 */

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** A handle's direction from the box's centre: -1, 0 or 1 each way. */
export const handleDirection = (handle: Handle): Point => [handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0, handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0]

export { type GuideLine, type SnapLine }

/** What things on a slide snap to: its edges and centre, and the other elements' edges and centres. */
export function snapLines(size: SlideSize, others: readonly SlideElement[]): SnapLine[] {
  return linesOf(size, [], others.map(boundsOf))
}

export interface Moved {
  dx: number
  dy: number
  guides: GuideLine[]
}

/**
 * How far a selection moves for a drag of (dx, dy): pulled onto a line within `reach` when one is
 * near, held to one axis with `axis`, with the guides that show what it lines up with.
 */
export function moveWithSnapping(bounds: Box, dx: number, dy: number, options: { lines: readonly SnapLine[]; reach: number; others: readonly Box[]; size: SlideSize; axis?: boolean; snap?: boolean }): Moved {
  let moveX = dx
  let moveY = dy

  if (options.axis) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      moveY = 0
    } else {
      moveX = 0
    }
  }

  const box = { ...bounds, x: bounds.x + moveX, y: bounds.y + moveY }

  if (options.snap === false) {
    return { dx: moveX, dy: moveY, guides: [] }
  }

  const snapped = snapBox(box, options.lines, options.reach)
  const sx = options.axis && moveX === 0 ? 0 : snapped.delta[0]
  const sy = options.axis && moveY === 0 ? 0 : snapped.delta[1]
  const landed = { ...box, x: box.x + sx, y: box.y + sy }
  const { lines } = smartGuides(landed, options.others, { x: 0, y: 0, width: options.size.width, height: options.size.height }, 0.25)

  return { dx: moveX + sx, dy: moveY + sy, guides: lines }
}

/**
 * A box resized by dragging `handle` by (dx, dy) in slide space, for a box rotated `rotation`
 * degrees: the side or corner opposite stays where it is (the centre does with `fromCenter`), and
 * `keepRatio` holds its proportions. Sides never go below `least`.
 */
export function resizeBox(box: Box, rotation: number, handle: Handle, dx: number, dy: number, options: { keepRatio?: boolean; fromCenter?: boolean; least?: number } = {}): Box {
  const least = options.least ?? 4
  const [hx, hy] = handleDirection(handle)
  const [lx, ly] = rotatePoint([dx, dy], [0, 0], -rotation)
  const factor = options.fromCenter ? 2 : 1
  let width = hx ? box.width + hx * lx * factor : box.width
  let height = hy ? box.height + hy * ly * factor : box.height

  if (options.keepRatio && box.width > 0 && box.height > 0) {
    const ratio = box.width / box.height

    if (hx && hy) {
      const scale = Math.max(width / box.width, height / box.height)
      width = box.width * scale
      height = box.height * scale
    } else if (hx) {
      height = width / ratio
    } else {
      width = height * ratio
    }
  }

  width = Math.max(least, width)
  height = Math.max(least, height)

  const middle = center(box)

  if (options.fromCenter) {
    return { x: middle[0] - width / 2, y: middle[1] - height / 2, width, height }
  }

  // The opposite corner (or the opposite side's middle) stays where it is in slide space.
  const fixed = rotatePoint([middle[0] - (hx * box.width) / 2, middle[1] - (hy * box.height) / 2], middle, rotation)
  const offset = rotatePoint([(hx * width) / 2, (hy * height) / 2], [0, 0], rotation)
  const next: Point = [fixed[0] + offset[0], fixed[1] + offset[1]]

  return { x: next[0] - width / 2, y: next[1] - height / 2, width, height }
}

/** Snap a resized upright box's moving sides onto lines within reach; with the lines landed on. */
export function snapResize(box: Box, handle: Handle, lines: readonly SnapLine[], reach: number): { box: Box; landed: SnapLine[] } {
  const [hx, hy] = handleDirection(handle)
  const out = { ...box }
  const landed: SnapLine[] = []

  if (hx) {
    const edge = hx > 0 ? box.x + box.width : box.x
    const found = nearest(
      [edge],
      lines.filter((line) => line.axis === 'x'),
      reach
    )

    if (found) {
      landed.push(found.line)

      if (hx > 0) {
        out.width += found.delta
      } else {
        out.x += found.delta
        out.width -= found.delta
      }
    }
  }

  if (hy) {
    const edge = hy > 0 ? box.y + box.height : box.y
    const found = nearest(
      [edge],
      lines.filter((line) => line.axis === 'y'),
      reach
    )

    if (found) {
      landed.push(found.line)

      if (hy > 0) {
        out.height += found.delta
      } else {
        out.y += found.delta
        out.height -= found.delta
      }
    }
  }

  return { box: out, landed }
}

/** Elements fitted into a new box for their whole group, each keeping its place and size in proportion. */
export function scaleGroup(elements: readonly SlideElement[], from: Box, to: Box): SlideElement[] {
  const sx = from.width ? to.width / from.width : 1
  const sy = from.height ? to.height / from.height : 1

  return elements.map((element) => {
    const middle = center(element)
    const moved: Point = [to.x + (middle[0] - from.x) * sx, to.y + (middle[1] - from.y) * sy]
    const width = element.width * sx
    const height = element.height * sy

    return withBox(element, { x: moved[0] - width / 2, y: moved[1] - height / 2, width, height })
  })
}

/** The rotation for a pointer at `point` around `about`, started at `from` with `start` degrees. */
export function rotationFor(about: Point, from: Point, point: Point, start: number, options: { step?: boolean } = {}): number {
  const angle = (target: Point) => (Math.atan2(target[1] - about[1], target[0] - about[0]) * 180) / Math.PI
  let turned = start + angle(point) - angle(from)

  if (options.step) {
    turned = Math.round(turned / 15) * 15
  } else {
    const square = Math.round(turned / 90) * 90

    // Square angles pull from a few degrees away, so upright is easy to land on.
    if (Math.abs(turned - square) < 4) {
      turned = square
    }
  }

  return ((turned % 360) + 360) % 360
}

/** A line end dragged to `point`, held to steps of 45 degrees from the other end with `step`. */
export function moveLineEnd(element: SlideElement, end: 'from' | 'to', point: Point, step = false): { from: Point; to: Point } {
  const ends = lineEnds(element)
  const fixed = end === 'from' ? ends.to : ends.from
  let moved = point

  if (step) {
    const length = Math.hypot(point[0] - fixed[0], point[1] - fixed[1])
    const angle = Math.round(Math.atan2(point[1] - fixed[1], point[0] - fixed[0]) / (Math.PI / 4)) * (Math.PI / 4)
    moved = [fixed[0] + Math.cos(angle) * length, fixed[1] + Math.sin(angle) * length]
  }

  return end === 'from' ? { from: moved, to: fixed } : { from: fixed, to: moved }
}

/** The rectangle between two points. */
export const spanBox = (a: Point, b: Point): Box => boxAround([a, b])

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** The elements a selection rectangle touches (a line counts when its box does). */
export function marqueeHits(elements: readonly SlideElement[], area: Box): string[] {
  return elements.filter((element) => overlaps(area, { ...boundsOf(element), width: Math.max(1, boundsOf(element).width), height: Math.max(1, boundsOf(element).height) })).map((element) => element.id)
}

/** A box's corners in screen space, for drawing its outline once rotated. */
export const screenCorners = (box: Box, rotation: number, scale: number): Point[] => corners(box, rotation).map(([x, y]) => [x * scale, y * scale])
