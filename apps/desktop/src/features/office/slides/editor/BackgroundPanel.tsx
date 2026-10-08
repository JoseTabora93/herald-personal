import { useRef, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import type { Background, Color, Slot } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { backgroundCss } from '../view/SlideView.tsx'
import * as commands from './commands.ts'
import { ColorGrid } from './pickers.tsx'

/*
 * A slide's background: the theme's, a colour, a gradient between theme colours (so it changes
 * with the theme) or a picture, for the slides picked or for all of them.
 */

const GRADIENTS: [Slot, Slot, number][] = [
  ['bg1', 'bg2', 90],
  ['bg2', 'bg1', 135],
  ['accent1', 'accent2', 135],
  ['accent1', 'accent5', 90],
  ['tx2', 'tx1', 90],
  ['accent2', 'accent3', 45],
  ['accent4', 'accent1', 135],
  ['tx1', 'accent1', 160]
]

export function BackgroundPanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  const [all, setAll] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const theme = doc.deck.theme
  const current = doc.slide.background
  const apply = (background: Background | null) => {
    commands.setBackground(background, all)
    onDone()
  }

  return (
    <div className="flex w-[248px] flex-col gap-3 text-[12px] text-fg-2">
      <button type="button" onClick={() => apply(null)} className={cn('h-8 rounded-md border border-line text-left hover:bg-white/8', !current && 'border-accent text-fg')}>
        <span className="px-2">The theme’s background</span>
      </button>
      <ColorGrid theme={theme} value={current?.kind === 'solid' ? current.color : null} onPick={(color: Color | null) => color && apply({ kind: 'solid', color })} />
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">Gradient</div>
      <div className="grid grid-cols-4 gap-1.5">
        {GRADIENTS.map(([from, to, angle]) => {
          const background: Background = { kind: 'gradient', stops: [{ at: 0, color: from }, { at: 1, color: to }], angle }

          return (
            <button
              key={`${from}-${to}-${angle}`}
              type="button"
              aria-label={`Gradient from ${from} to ${to}`}
              onClick={() => apply(background)}
              className="h-9 rounded-md border border-black/10"
              style={backgroundCss(background, theme)}
            />
          )
        })}
      </div>
      <button type="button" onClick={() => file.current?.click()} className="h-8 rounded-md border border-line hover:bg-white/8">
        Picture…
      </button>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const picked = event.target.files?.[0]
          event.target.value = ''

          if (picked) {
            void commands.readPicture(picked).then(
              (picture) => apply({ kind: 'image', src: picture.src, natural: picture.natural }),
              () => commands.notify('Herald Slides could not read that picture')
            )
          }
        }}
      />
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
        Apply to all slides
      </label>
    </div>
  )
}
