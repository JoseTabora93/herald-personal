import { type RefObject, useEffect, useState } from 'react'

/*
 * Popovers over the page (the '/' menu, the selection bar, links, pictures) sit in the editor's
 * frame, not the page, so the page's zoom does not scale them. They are placed from where things
 * are on screen, relative to the frame, and move when the page scrolls.
 */

export interface Anchor {
  left: number
  top: number
  bottom: number
}

/** Where a screen rectangle is inside `frame`, as left, top and bottom. */
export function anchorIn(frame: HTMLElement | null, rect: { left: number; right?: number; top: number; bottom: number } | null): Anchor | null {
  if (!frame || !rect) {
    return null
  }

  const box = frame.getBoundingClientRect()

  return { left: (rect.left + (rect.right ?? rect.left)) / 2 - box.left, top: rect.top - box.top, bottom: rect.bottom - box.top }
}

/** A popover's left edge that keeps a `width`-wide box inside the frame, centred on `x` where it fits. */
export function clampLeft(frame: HTMLElement | null, x: number, width: number): number {
  const room = frame?.clientWidth ?? 0

  return Math.max(8, Math.min(x - width / 2, room - width - 8))
}

/**
 * Scroll only the page's desk to show a part of the document: scrolling into view the browser's
 * way would also move the desktop's own layers, which hide their overflow but still scroll.
 */
export function revealInDesk(view: { dom: HTMLElement; coordsAtPos: (pos: number) => { top: number; bottom: number; left: number; right: number } }, pos: number, margin = 48): boolean {
  const desk = view.dom.closest('.docs-desk')

  if (!(desk instanceof HTMLElement)) {
    return false
  }

  const place = view.coordsAtPos(pos)
  const box = desk.getBoundingClientRect()

  if (place.top < box.top + margin) {
    desk.scrollTop -= box.top + margin - place.top
  } else if (place.bottom > box.bottom - margin) {
    desk.scrollTop += place.bottom - (box.bottom - margin)
  }

  if (place.left < box.left + margin) {
    desk.scrollLeft -= box.left + margin - place.left
  } else if (place.right > box.right - margin) {
    desk.scrollLeft += place.right - (box.right - margin)
  }

  return true
}

/** Keep `item` in view inside the list that scrolls it, and scroll nothing else. */
export function keepInList(list: HTMLElement | null, item: Element | null | undefined): void {
  if (!list || !(item instanceof HTMLElement)) {
    return
  }

  if (item.offsetTop < list.scrollTop) {
    list.scrollTop = item.offsetTop
  } else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight
  }
}

/** A number that changes whenever `element` scrolls, to place popovers again. */
export function useScrollTick(element: RefObject<HTMLElement | null>): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const target = element.current
    let frame = 0

    if (!target) {
      return
    }

    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setTick((value) => value + 1))
    }
    target.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      cancelAnimationFrame(frame)
      target.removeEventListener('scroll', onScroll)
    }
  }, [element])

  return tick
}
