/*
 * The units Word files measure in, against Herald's points (1/72 inch) and CSS pixels (1/96
 * inch): twips (twentieths of a point) for spacing, indents, pages and table grids, half-points
 * for font sizes, and EMUs (914,400 an inch) for pictures. Strict files may also write a measure
 * with its unit ("1.5in", "12pt").
 */

export const TWIPS_PER_POINT = 20
export const TWIPS_PER_PIXEL = 15
export const EMUS_PER_PIXEL = 9525

const UNIT_POINTS: Record<string, number> = { pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, pi: 12 }

/** A measure in points, from a number of units (`pointsPerUnit` points each) or a measure with its unit. */
export function measure(value: string | undefined, pointsPerUnit: number): number | null {
  const match = value === undefined ? null : /^\s*([-+]?\d*\.?\d+)\s*(pt|in|cm|mm|pc|pi)?\s*$/.exec(value)

  if (!match) {
    return null
  }

  return Number(match[1]) * (match[2] ? UNIT_POINTS[match[2]] : pointsPerUnit)
}

export const twipsToPoints = (value: string | undefined): number | null => measure(value, 1 / TWIPS_PER_POINT)

export const halfPointsToPoints = (value: string | undefined): number | null => measure(value, 1 / 2)

export const pointsToTwips = (points: number): number => Math.round(points * TWIPS_PER_POINT)

export const pixelsToTwips = (pixels: number): number => Math.round(pixels * TWIPS_PER_PIXEL)

export const emusToPixels = (emus: number): number => Math.round(emus / EMUS_PER_PIXEL)

export const pointsToPixels = (points: number): number => (points * 96) / 72
