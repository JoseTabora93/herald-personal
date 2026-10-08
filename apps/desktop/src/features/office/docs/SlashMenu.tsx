import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'
import { cn } from '../../../lib/cn.ts'
import { anchorIn, clampLeft, keepInList } from './overlay.ts'
import { $slash } from './slash.ts'

const WIDTH = 264
const HEIGHT = 320

/** The '/' menu under the caret, grouped, with the chosen item kept in view. */
export function SlashMenu({ frame }: { frame: HTMLElement | null }) {
  const slash = useStore($slash)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => keepInList(list.current, list.current?.querySelector('[data-chosen="true"]')?.parentElement), [slash?.index])

  const anchor = anchorIn(frame, slash?.rect ?? null)

  if (!slash || !anchor) {
    return null
  }

  const below = anchor.bottom + 6 + HEIGHT < (frame?.clientHeight ?? 0) || anchor.top < HEIGHT + 12
  let group = ''

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Insert"
      className="float menu-surface absolute z-40 max-h-80 overflow-y-auto rounded-xl p-1 animate-pop"
      style={{ width: WIDTH, left: clampLeft(frame, anchor.left + WIDTH / 2 - 12, WIDTH), ...(below ? { top: anchor.bottom + 6 } : { bottom: (frame?.clientHeight ?? 0) - anchor.top + 6 }) }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {slash.items.length === 0 && <div className="px-3 py-2 text-[12px] text-fg-3">Nothing matches</div>}
      {slash.items.map((item, index) => {
        const heading = item.group !== group ? item.group : null
        group = item.group

        return (
          <div key={item.id}>
            {heading && <div className="px-2.5 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-fg-4 uppercase">{heading}</div>}
            <button
              type="button"
              role="option"
              aria-selected={index === slash.index}
              data-chosen={index === slash.index}
              onMouseEnter={() => $slash.set({ ...slash, index })}
              onClick={() => slash.choose(item)}
              className={cn('flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left', index === slash.index ? 'bg-white/10 text-fg' : 'text-fg-2')}
            >
              <span className="text-[12.5px]">{item.label}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-fg-4">{item.hint}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
