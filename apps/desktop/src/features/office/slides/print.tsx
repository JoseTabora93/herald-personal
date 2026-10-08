import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { printPage } from '../print.ts'
import type { PrintView } from '../types.ts'
import type { Deck } from './deck.ts'
import { SLIDE_CSS } from './view/slide-css.ts'
import { SlideView } from './view/SlideView.tsx'

/*
 * A deck's print view: each shown slide on a page of its own size, drawn by the slide view itself
 * (laid out in the page off screen, so text that shrinks to fit is measured), then kept as plain
 * HTML, since the print window runs no scripts. Text stays text in the PDF.
 */

/** CSS pixels in a point: 96 to the inch, 72 points to the inch. */
const PRINT_SCALE = 96 / 72

export async function printDeck(deck: Deck, name: string): Promise<PrintView> {
  const host = document.createElement('div')
  host.style.cssText = 'position: fixed; left: -100000px; top: 0; visibility: hidden; pointer-events: none'
  document.body.append(host)
  const root = createRoot(host)
  const slides = deck.slides.filter((slide) => !slide.hidden)
  const shown = slides.length ? slides : deck.slides

  try {
    flushSync(() =>
      root.render(
        <>
          {shown.map((slide) => (
            <div key={slide.id} className="hs-page">
              <SlideView deck={deck} slide={slide} scale={PRINT_SCALE} mode="print" />
            </div>
          ))}
        </>
      )
    )
    // Pictures lay out once decoded; the page is printed as it is now.
    await Promise.all([...host.querySelectorAll('img')].map((image) => image.decode().catch(() => {})))
    const width = deck.size.width / 72
    const height = deck.size.height / 72
    const css = `@page { size: ${width}in ${height}in; margin: 0; } html, body { margin: 0; padding: 0; } .hs-page { position: relative; width: ${width}in; height: ${height}in; overflow: hidden; break-after: page; page-break-after: always; } .hs-page:last-child { break-after: auto; page-break-after: auto; } ${SLIDE_CSS}`

    return { html: printPage(name, css, host.innerHTML), landscape: deck.size.width >= deck.size.height }
  } finally {
    root.unmount()
    host.remove()
  }
}
