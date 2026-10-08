import { IconEyeOff, IconPlus } from '@tabler/icons-react'
import { memo, useMemo, useRef, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import { Menu } from '../../../files/Menu.tsx'
import type { Deck, Slide } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { SlideView } from '../view/SlideView.tsx'
import * as commands from './commands.ts'
import { useDeck } from './Stage.tsx'

/*
 * The slides down the side, each drawn by the slide view at a small scale. A click brings a slide
 * to the front (with ⇧ or ⌘ it is picked as well); dragging picked slides moves them; hidden slides
 * are dimmed. Picked slides are what Duplicate, Delete and Hide work on.
 */

const THUMB = 152

const Thumbnail = memo(function Thumbnail({ deck, slide }: { deck: Pick<Deck, 'size' | 'theme'>; slide: Slide }) {
  return <SlideView deck={deck} slide={slide} scale={THUMB / deck.size.width} mode="thumb" className="pointer-events-none" />
})

export function Rail({ doc }: { doc: SlidesDocument }) {
  useDeck(doc)
  const deck = doc.deck
  const view = useMemo(() => ({ size: deck.size, theme: deck.theme }), [deck.size, deck.theme])
  const list = useRef<HTMLDivElement>(null)
  const press = useRef<{ id: string; y: number; dragging: boolean } | null>(null)
  const [drop, setDrop] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const picked = new Set(doc.picked)

  /** Where dragged slides would go for a pointer at `y`: before the slide whose middle is below it. */
  const dropIndex = (y: number): number => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[data-rail-slide]') ?? [])]
    const index = items.findIndex((item) => {
      const rect = item.getBoundingClientRect()

      return y < rect.top + rect.height / 2
    })

    return index < 0 ? items.length : index
  }

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Slides"
      aria-multiselectable="true"
      tabIndex={0}
      className="relative flex w-[196px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-line p-3 outline-none"
      onKeyDown={(event) => {
        const index = doc.index

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const next = deck.slides[Math.max(0, Math.min(deck.slides.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
          doc.goTo(next.id, event.shiftKey)
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
          commands.deleteSlides()
        } else if (event.key === 'Home' || event.key === 'End') {
          doc.goTo(deck.slides[event.key === 'Home' ? 0 : deck.slides.length - 1].id)
        } else {
          return
        }

        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerMove={(event) => {
        const now = press.current

        if (!now) {
          return
        }

        if (!now.dragging && Math.abs(event.clientY - now.y) > 5) {
          now.dragging = true

          if (!doc.picked.includes(now.id)) {
            doc.goTo(now.id)
          }
        }

        if (now.dragging) {
          setDrop(dropIndex(event.clientY))
        }
      }}
      onPointerUp={(event) => {
        const now = press.current
        press.current = null

        if (now?.dragging && drop !== null) {
          const moving = doc.pickedSlides
          const before = deck.slides.slice(0, drop).filter((slide) => !moving.includes(slide.id)).length
          commands.moveSlidesTo(moving, before)
        } else if (now && !now.dragging) {
          doc.goTo(now.id, event.shiftKey || event.metaKey)
        }

        setDrop(null)
      }}
      onPointerCancel={() => {
        press.current = null
        setDrop(null)
      }}
    >
      {deck.slides.map((slide, index) => (
        <div key={slide.id} data-rail-slide="" className="relative">
          {drop === index && <span className="absolute -top-[7px] right-0 left-5 h-[3px] rounded-full bg-accent" />}
          <button
            type="button"
            role="option"
            aria-selected={picked.has(slide.id)}
            aria-label={`Slide ${index + 1}${slide.hidden ? ', hidden' : ''}`}
            onPointerDown={(event) => {
              if (event.button === 0) {
                press.current = { id: slide.id, y: event.clientY, dragging: false }
                list.current?.setPointerCapture(event.pointerId)
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault()

              if (!picked.has(slide.id)) {
                doc.goTo(slide.id)
              }

              const rect = list.current?.getBoundingClientRect()
              setMenu({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) + (list.current?.scrollTop ?? 0) })
            }}
            className="flex w-full items-start gap-2 text-left"
          >
            <span className="flex w-4 shrink-0 flex-col items-end gap-1 pt-0.5 text-[11px] text-fg-3 tabular-nums">
              {index + 1}
              {slide.hidden && <IconEyeOff size={11} />}
            </span>
            <span className={cn('overflow-hidden rounded-[3px] ring-2 ring-offset-0', slide.id === doc.slide.id ? 'ring-accent' : picked.has(slide.id) ? 'ring-accent/50' : 'ring-transparent hover:ring-line-strong', slide.hidden && 'opacity-45')}>
              <Thumbnail deck={view} slide={slide} />
            </span>
          </button>
        </div>
      ))}
      {drop === deck.slides.length && <span className="-mt-[7px] ml-5 h-[3px] shrink-0 rounded-full bg-accent" />}
      <button
        type="button"
        onClick={() => commands.newSlide(doc.slide.layout === 'title' ? 'title-content' : doc.slide.layout)}
        className="ml-6 flex shrink-0 items-center justify-center rounded-[3px] border border-dashed border-line text-fg-3 hover:border-line-strong hover:text-fg"
        style={{ width: THUMB, height: (THUMB * deck.size.height) / deck.size.width }}
        aria-label="New slide"
      >
        <IconPlus size={18} />
      </button>
      {menu && (
        <div className="absolute z-40" style={{ left: Math.min(menu.x, 60), top: menu.y }}>
          <Menu
            align="left"
            onClose={() => setMenu(null)}
            items={[
              { id: 'new', label: 'New Slide', onSelect: () => commands.newSlide() },
              { id: 'duplicate', label: doc.picked.length > 1 ? 'Duplicate Slides' : 'Duplicate Slide', onSelect: commands.duplicateSlides },
              { id: 'hide', label: doc.pickedSlides.every((id) => deck.slides.find((slide) => slide.id === id)?.hidden) ? 'Show Slide' : 'Hide Slide', onSelect: commands.toggleHidden },
              { id: 'up', label: 'Move Up', disabled: doc.index === 0, onSelect: () => commands.moveSlidesBy(-1), dividerBefore: true },
              { id: 'down', label: 'Move Down', disabled: doc.index >= deck.slides.length - 1, onSelect: () => commands.moveSlidesBy(1) },
              { id: 'delete', label: doc.picked.length > 1 ? 'Delete Slides' : 'Delete Slide', danger: true, onSelect: commands.deleteSlides, dividerBefore: true }
            ]}
          />
        </div>
      )}
    </div>
  )
}
