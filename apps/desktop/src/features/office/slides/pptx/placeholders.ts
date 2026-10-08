import type { LayoutId, PlaceholderRole, Slide } from '../deck.ts'
import { layoutPlaceholders } from '../layouts.ts'

/*
 * How a slide's placeholders meet its PowerPoint slide layout: each Herald layout's text
 * placeholders get a name and, in the file, an index (PptxGenJS numbers them from 100 in order);
 * a slide's placeholder elements fill them by role, in order. Pictures go in as pictures.
 */

/** The placeholder names a layout's slide layout gets, in order. */
export function placeholderNames(layout: LayoutId): { name: string; role: PlaceholderRole }[] {
  const seen: Partial<Record<PlaceholderRole, number>> = {}

  return layoutPlaceholders(layout)
    .filter((spec) => spec.role !== 'picture')
    .map((spec) => {
      const n = (seen[spec.role] = (seen[spec.role] ?? 0) + 1)

      return { name: n > 1 ? `${spec.role}${n}` : spec.role, role: spec.role }
    })
}

/** The index PptxGenJS gives a layout's placeholder in the file. */
export const placeholderIndex = (layout: LayoutId, name: string): number => 100 + placeholderNames(layout).findIndex((entry) => entry.name === name)

/** Which of a slide's elements fill which of its layout's placeholders (element id to placeholder name). */
export function placeholderSlots(slide: Slide): Map<string, string> {
  const names = placeholderNames(slide.layout)
  const used = new Set<string>()
  const slots = new Map<string, string>()

  for (const element of slide.elements) {
    if (!element.placeholder || element.kind === 'image' || element.kind === 'line') {
      continue
    }

    const free = names.find((entry) => entry.role === element.placeholder?.role && !used.has(entry.name))

    if (free) {
      used.add(free.name)
      slots.set(element.id, free.name)
    }
  }

  return slots
}
