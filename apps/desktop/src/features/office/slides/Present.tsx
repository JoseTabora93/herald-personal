import { useStore } from '@nanostores/react'
import { IconChevronLeft, IconChevronRight, IconX } from '@tabler/icons-react'
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { $env } from '../../../store/backend.ts'
import { isPanels } from '../../../store/shell.ts'
import type { Deck, Slide } from './deck.ts'
import type { SlidesDocument } from './document.ts'
import { useDeck } from './editor/Stage.tsx'
import { $presenting, decks } from './store.ts'
import { SlideView } from './view/SlideView.tsx'

/*
 * Presenting: the deck's shown slides one at a time over everything, fitted to the window, with the
 * deck's transition between them and an end screen after the last. Arrows, Space, Enter, Page keys
 * and clicks move on; typing a number and Enter jumps; B and W blank the screen; Escape ends.
 */

const TRANSITION_MS = 450

/** Start presenting: called from the click or key that asks, since the system grants full screen only then. */
export function startPresenting(key: string, index: number): void {
  $presenting.set({ key, index })
  // Herald's own window fills the screen already, and the developer's window is presented in;
  // a window of its own (panels) goes full screen.
  const own = isPanels || (!$env.get()?.isDev && (window.outerWidth < screen.width || window.outerHeight < screen.height))

  if (own) {
    document.documentElement.requestFullscreen?.().catch(() => {})
  }
}

function stop(): void {
  $presenting.set(null)

  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
  }
}

function layerStyle(deck: Deck, kind: 'in' | 'out', direction: 1 | -1): CSSProperties {
  if (deck.transition === 'fade') {
    return kind === 'in' ? { animation: `hs-fade-in ${TRANSITION_MS}ms ease both` } : {}
  }

  if (deck.transition === 'push') {
    const name = kind === 'in' ? (direction > 0 ? 'hs-push-in' : 'hs-push-in-back') : direction > 0 ? 'hs-push-out' : 'hs-push-out-back'

    return { animation: `${name} ${TRANSITION_MS}ms cubic-bezier(.3,.7,.2,1) both` }
  }

  return {}
}

function Show({ doc, start }: { doc: SlidesDocument; start: number }) {
  useDeck(doc)
  const deck = doc.history.present
  const shown = useMemo(() => {
    const visible = deck.slides.filter((slide) => !slide.hidden)

    return visible.length ? visible : deck.slides
  }, [deck.slides])
  const [at, setAt] = useState(() => {
    const wanted = deck.slides.slice(start).find((slide) => shown.includes(slide))

    return Math.max(0, wanted ? shown.indexOf(wanted) : shown.length - 1)
  })
  const [leaving, setLeaving] = useState<{ slide: Slide | null; direction: 1 | -1 } | null>(null)
  const [blank, setBlank] = useState<'black' | 'white' | null>(null)
  const [idle, setIdle] = useState(false)
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  const typed = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const atRef = useRef(at)
  atRef.current = Math.min(at, shown.length)

  const go = (next: number) => {
    const now = atRef.current

    // Moving on from the end screen ends the presentation.
    if (now >= shown.length && next > now) {
      stop()

      return
    }

    const target = Math.max(0, Math.min(shown.length, next))

    if (target === now) {
      return
    }

    setBlank(null)
    setLeaving(deck.transition === 'none' ? null : { slide: shown[now] ?? null, direction: target > now ? 1 : -1 })
    setAt(target)
  }

  useEffect(() => {
    if (!leaving) {
      return
    }

    const done = setTimeout(() => setLeaving(null), TRANSITION_MS + 30)

    return () => clearTimeout(done)
  }, [leaving])

  useLayoutEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)

    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key
      const now = atRef.current

      if (/^\d$/.test(key)) {
        typed.current = (typed.current + key).slice(-4)
      } else if (key === 'Escape') {
        stop()
      } else if (key === 'Enter' && typed.current) {
        go(Number(typed.current) - 1)
        typed.current = ''
      } else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(key)) {
        go(now + 1)
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(key)) {
        go(now - 1)
      } else if (key === 'Home') {
        go(0)
      } else if (key === 'End') {
        go(shown.length - 1)
      } else if (key === 'b' || key === 'B' || key === '.') {
        setBlank((value) => (value === 'black' ? null : 'black'))
      } else if (key === 'w' || key === 'W' || key === ',') {
        setBlank((value) => (value === 'white' ? null : 'white'))
      } else {
        return
      }

      if (!/^\d$/.test(key) && key !== 'Enter') {
        typed.current = ''
      }

      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  })

  const wake = () => {
    setIdle(false)

    if (timer.current) {
      clearTimeout(timer.current)
    }

    timer.current = setTimeout(() => setIdle(true), 2500)
  }

  useEffect(() => {
    wake()

    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [])

  const scale = Math.min(size.width / deck.size.width, size.height / deck.size.height)
  const width = deck.size.width * scale
  const height = deck.size.height * scale
  const view = { size: deck.size, theme: deck.theme }
  const current = Math.min(at, shown.length)
  const ended = current >= shown.length
  const frame: CSSProperties = { position: 'absolute', inset: 0 }

  return (
    <div
      role="dialog"
      aria-label={ended ? 'End of the presentation' : `Presenting slide ${current + 1} of ${shown.length}`}
      className="fixed inset-0 z-[2147483000] overflow-hidden bg-black select-none"
      style={{ cursor: idle ? 'none' : 'default' }}
      onMouseMove={wake}
      onClick={() => go(current + 1)}
      onContextMenu={(event) => {
        event.preventDefault()
        go(current - 1)
      }}
    >
      <div className="absolute overflow-hidden" style={{ left: (size.width - width) / 2, top: (size.height - height) / 2, width, height }}>
        {leaving?.slide && (
          <div key={`out-${leaving.slide.id}`} style={{ ...frame, ...layerStyle(deck, 'out', leaving.direction) }}>
            <SlideView deck={view} slide={leaving.slide} scale={scale} mode="present" />
          </div>
        )}
        {ended ? (
          <div key="end" className="grid place-items-center bg-black text-center" style={{ ...frame, ...layerStyle(deck, 'in', 1) }}>
            <div className="text-[15px] text-white/70">
              End of the presentation
              <div className="mt-1 text-[12px] text-white/40">Click or press Escape to go back</div>
            </div>
          </div>
        ) : (
          <div key={`in-${shown[current].id}`} style={{ ...frame, ...(leaving ? layerStyle(deck, 'in', leaving.direction) : {}) }}>
            <SlideView deck={view} slide={shown[current]} scale={scale} mode="present" />
          </div>
        )}
      </div>
      {blank && <div className="absolute inset-0" style={{ background: blank }} />}
      <div
        className="absolute bottom-5 left-5 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-1 text-[12px] text-white/80 backdrop-blur transition-opacity duration-300"
        style={{ opacity: idle ? 0 : 1, pointerEvents: idle ? 'none' : 'auto' }}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" aria-label="Previous slide" onClick={() => go(current - 1)} className="grid size-7 place-items-center rounded-full hover:bg-white/15">
          <IconChevronLeft size={16} />
        </button>
        <span className="min-w-14 text-center tabular-nums">{ended ? 'End' : `${current + 1} / ${shown.length}`}</span>
        <button type="button" aria-label="Next slide" onClick={() => go(current + 1)} className="grid size-7 place-items-center rounded-full hover:bg-white/15">
          <IconChevronRight size={16} />
        </button>
        <button type="button" aria-label="End the presentation" onClick={stop} className="ml-1 grid size-7 place-items-center rounded-full hover:bg-white/15">
          <IconX size={15} />
        </button>
      </div>
    </div>
  )
}

/** The deck being presented, drawn on the page itself rather than in the window, whose frame would hold it to its own size. */
export function Present() {
  const presenting = useStore($presenting)
  const doc = presenting ? decks.get(presenting.key) : undefined

  useEffect(() => {
    if (presenting && !doc) {
      $presenting.set(null)
    }
  }, [presenting, doc])

  if (!presenting || !doc) {
    return null
  }

  return createPortal(<Show key={`${presenting.key}:${presenting.index}`} doc={doc} start={presenting.index} />, document.body)
}
