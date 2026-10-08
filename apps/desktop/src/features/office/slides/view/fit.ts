import type { TextBody } from '../deck.ts'

/*
 * Text that shrinks to fit its box, as PowerPoint's "shrink text on overflow": the largest factor,
 * in steps of 2.5%, at which a box's paragraphs fit its height, set as `--hs-shrink` on the text.
 */

const MIN_SHRINK = 0.25

/** The factor each text body that shrinks to fit was last drawn at (bodies are never changed, only replaced), for files to say. */
export const shrinkFactors = new WeakMap<TextBody, number>()

export function fitText(flow: HTMLElement, available: number): number {
  const fits = (factor: number) => {
    flow.style.setProperty('--hs-shrink', String(factor))

    return flow.offsetHeight <= available + 0.5
  }

  if (fits(1)) {
    return 1
  }

  let low = MIN_SHRINK
  let high = 1

  for (let i = 0; i < 7; i++) {
    const middle = (low + high) / 2

    if (fits(middle)) {
      low = middle
    } else {
      high = middle
    }
  }

  const factor = Math.max(MIN_SHRINK, Math.floor(low * 40) / 40)
  flow.style.setProperty('--hs-shrink', String(factor))

  return factor
}
