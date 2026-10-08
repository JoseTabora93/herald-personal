import { IconCheck } from '@tabler/icons-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import type { Color, Deck, FontRef, LayoutId, Slide, Theme } from '../deck.ts'
import { LAYOUTS, SLOTS } from '../deck.ts'
import { LAYOUT_NAMES, newSlide, placeholderFor } from '../layouts.ts'
import { COMMON_FONTS, fontStack, isSlot, normalHex, resolveColor, SLOT_NAMES, THEMES } from '../themes.ts'
import { SlideView } from '../view/SlideView.tsx'

/*
 * The formatting bar's pop-up choosers: colours (the theme's slots first, so a colour follows the
 * theme), fonts (the theme's, then the computer's), sizes, layouts and themes, each drawn as it
 * will look. They live inside the bar, so picking from them keeps the text being typed into.
 */

/** A pop-up under its button; closes on Escape and on a press outside both. */
export function Popover({ open, onClose, anchor, children, className, align = 'left' }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; children: ReactNode; className?: string; align?: 'left' | 'right' }) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onDown = (event: PointerEvent) => {
      const target = event.target as Node

      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) {
        onClose()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)

    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchor])

  if (!open) {
    return null
  }

  return (
    <div ref={panel} role="dialog" className={cn('float menu-surface absolute top-full z-40 mt-1 rounded-xl p-2 animate-pop', align === 'right' ? 'right-0' : 'left-0', className)} onMouseDown={(event) => event.preventDefault()}>
      {children}
    </div>
  )
}

/** A bar button that opens a pop-up. */
export function PopoverButton({ label, children, panel, className, active, disabled, align, panelClassName }: { label: string; children: ReactNode; panel: (close: () => void) => ReactNode; className?: string; active?: boolean; disabled?: boolean; align?: 'left' | 'right'; panelClassName?: string }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const close = () => setOpen(false)

  return (
    <div className="relative">
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
        className={cn('flex h-7 items-center gap-1 rounded-md px-1.5 text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40 [&_svg]:size-4', (open || active) && 'bg-white/12 text-fg', className)}
      >
        {children}
      </button>
      <Popover open={open} onClose={close} anchor={anchor} align={align} className={panelClassName}>
        {panel(close)}
      </Popover>
    </div>
  )
}

const STANDARD = ['#000000', '#404040', '#7f7f7f', '#bfbfbf', '#ffffff', '#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0']

export function ColorGrid({ theme, value, onPick, none, noneLabel = 'None' }: { theme: Theme; value: Color | null; onPick: (color: Color | null) => void; none?: boolean; noneLabel?: string }) {
  const custom = useRef<HTMLInputElement>(null)
  const swatch = (color: Color, title: string) => (
    <button
      key={color}
      type="button"
      title={title}
      aria-label={title}
      onClick={() => onPick(color)}
      className={cn('grid size-6 place-items-center rounded-md border border-black/10', value === color && 'ring-2 ring-accent ring-offset-1 ring-offset-transparent')}
      style={{ background: resolveColor(color, theme) }}
    />
  )

  return (
    <div className="flex w-[232px] flex-col gap-2">
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">Theme</div>
      <div className="grid grid-cols-8 gap-1.5">{SLOTS.map((slot) => swatch(slot, `${SLOT_NAMES[slot]} (${theme.name})`))}</div>
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">Standard</div>
      <div className="grid grid-cols-8 gap-1.5">{STANDARD.map((hex) => swatch(hex as Color, hex))}</div>
      <div className="flex items-center gap-2 pt-1">
        {none && (
          <button type="button" onClick={() => onPick(null)} className={cn('h-7 flex-1 rounded-md border border-line text-[12px] text-fg-2 hover:bg-white/8', value === null && 'border-accent text-fg')}>
            {noneLabel}
          </button>
        )}
        <button type="button" onClick={() => custom.current?.click()} className="h-7 flex-1 rounded-md border border-line text-[12px] text-fg-2 hover:bg-white/8">
          Custom…
        </button>
        <input
          ref={custom}
          type="color"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          defaultValue={value && !isSlot(value) ? value : '#2f7dff'}
          onChange={(event) => {
            const hex = normalHex(event.target.value)

            if (hex) {
              onPick(hex)
            }
          }}
        />
      </div>
    </div>
  )
}

let systemFonts: Promise<string[]> | null = null

const loadSystemFonts = (): Promise<string[]> => {
  systemFonts ??= window.heraldOS.fonts
    .list()
    .then((fonts) => [...new Set(fonts)].sort((a, b) => a.localeCompare(b)))
    .catch(() => [])

  return systemFonts
}

export function FontList({ theme, value, onPick }: { theme: Theme; value: FontRef; onPick: (font: FontRef) => void }) {
  const [fonts, setFonts] = useState<string[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void loadSystemFonts().then(setFonts)
  }, [])

  const families = useMemo(() => {
    const all = [...new Set([...COMMON_FONTS, ...fonts])]
    const wanted = filter.trim().toLowerCase()

    return wanted ? all.filter((family) => family.toLowerCase().includes(wanted)) : all
  }, [fonts, filter])

  const row = (font: FontRef, label: string, family: string, hint?: string) => (
    <button key={font} type="button" onClick={() => onPick(font)} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-fg-2 hover:bg-white/8 hover:text-fg">
      <span className="min-w-0 flex-1 truncate" style={{ fontFamily: fontStack(family) }}>
        {label}
      </span>
      {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
      {value === font && <IconCheck size={14} className="text-accent-strong" />}
    </button>
  )

  return (
    <div className="flex w-64 flex-col gap-1">
      <input autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a font" aria-label="Find a font" className="glass-input mb-1 h-7 rounded-md px-2 text-[12px] text-fg outline-none placeholder:text-fg-4" />
      {!filter && (
        <>
          {row('+heading', theme.fonts.heading, theme.fonts.heading, 'Headings')}
          {row('+body', theme.fonts.body, theme.fonts.body, 'Body')}
          <div className="my-1 h-px bg-line" />
        </>
      )}
      <div className="max-h-72 overflow-y-auto">{families.map((family) => row(family, family, family))}</div>
    </div>
  )
}

export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 88, 96, 120]

export function SizeList({ value, onPick }: { value: number; onPick: (size: number) => void }) {
  return (
    <div className="grid w-44 grid-cols-4 gap-1">
      {SIZES.map((size) => (
        <button key={size} type="button" onClick={() => onPick(size)} className={cn('h-7 rounded-md text-[12px] tabular-nums text-fg-2 hover:bg-white/8 hover:text-fg', Math.abs(size - value) < 0.01 && 'bg-white/12 text-fg')}>
          {size}
        </button>
      ))}
    </div>
  )
}

/** A slide's look in miniature, for choosers. */
function Miniature({ deck, slide, width }: { deck: Pick<Deck, 'size' | 'theme'>; slide: Slide; width: number }) {
  return <SlideView deck={deck} slide={slide} scale={width / deck.size.width} mode="edit" className="pointer-events-none rounded-[3px] ring-1 ring-black/10" />
}

export function LayoutGrid({ deck, onPick, current }: { deck: Pick<Deck, 'size' | 'theme'>; onPick: (layout: LayoutId) => void; current?: LayoutId }) {
  const slides = useMemo(() => LAYOUTS.map((layout) => newSlide(layout, deck.size)), [deck.size])

  return (
    <div className="grid w-[452px] grid-cols-4 gap-2">
      {LAYOUTS.map((layout, index) => (
        <button key={layout} type="button" onClick={() => onPick(layout)} className={cn('flex flex-col items-center gap-1 rounded-lg p-1.5 text-[11px] text-fg-2 hover:bg-white/8 hover:text-fg', current === layout && 'bg-white/10 text-fg')}>
          <Miniature deck={deck} slide={slides[index]} width={96} />
          <span className="w-24 truncate text-center">{LAYOUT_NAMES[layout]}</span>
        </button>
      ))}
    </div>
  )
}

/** A sample title slide in a theme: its name on its background, with its accents. */
function themeSample(theme: Theme, size: Deck['size']): Slide {
  const slide = newSlide('title', size)
  const title = placeholderFor(slide, 'title')
  const subtitle = placeholderFor(slide, 'subtitle')

  return {
    ...slide,
    elements: slide.elements.map((element) => {
      if ((element === title || element === subtitle) && (element.kind === 'text' || element.kind === 'shape')) {
        const text = element === title ? theme.name : `${theme.fonts.heading} · ${theme.fonts.body}`

        return { ...element, body: { ...element.body, paragraphs: [{ ...element.body.paragraphs[0], runs: [{ text }] }] } }
      }

      return element
    })
  }
}

export function ThemeGrid({ deck, onPick }: { deck: Pick<Deck, 'size' | 'theme'>; onPick: (theme: Theme) => void }) {
  const choices = useMemo(() => (THEMES.some((entry) => entry.id === deck.theme.id) ? THEMES : [deck.theme, ...THEMES]), [deck.theme])

  return (
    <div className="grid w-[436px] grid-cols-3 gap-2">
      {choices.map((theme) => (
        <button key={theme.id} type="button" onClick={() => onPick(theme)} className={cn('flex flex-col gap-1 rounded-lg p-1.5 text-left text-[11.5px] text-fg-2 hover:bg-white/8 hover:text-fg', deck.theme.id === theme.id && 'bg-white/10 text-fg')}>
          <Miniature deck={{ size: deck.size, theme }} slide={themeSample(theme, deck.size)} width={128} />
          <span className="flex items-center gap-1">
            {SLOTS.slice(4).map((slot) => (
              <span key={slot} className="size-2.5 rounded-full" style={{ background: theme.colors[slot] }} />
            ))}
            <span className="ml-1 truncate">{theme.id === 'imported' ? `${theme.name} (from the file)` : theme.name}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
