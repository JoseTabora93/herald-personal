import { useEffect, useState } from 'react'
import { Menu, type MenuItemDef } from '../../files/Menu.tsx'
import type { EditorHandle, OfficeDocument } from '../types.ts'
import type { Deck } from './deck.ts'
import { SlidesDocument } from './document.ts'
import { describeElement } from './elements.ts'
import { flushTyping, textSessionOf } from './editor/active.ts'
import * as commands from './editor/commands.ts'
import { Rail } from './editor/Rail.tsx'
import { Stage, stageScales, useDeck } from './editor/Stage.tsx'
import { isEmptyPlaceholder } from './layouts.ts'
import { ALIGN_LABELS, type AlignEdge, ARRANGE_LABELS, setNotes, slideTitle } from './model.ts'
import { decks, slidesSession } from './store.ts'

/*
 * One deck in its window: the slides down the side, the slide in front with its speaker notes
 * under it, and the handle the Office shell saves, reloads and undoes through.
 */

function Notes({ doc }: { doc: SlidesDocument }) {
  useDeck(doc)
  const slide = doc.slide
  const [text, setText] = useState(slide.notes)

  useEffect(() => setText(slide.notes), [slide.id, slide.notes])

  return (
    <textarea
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => commands.change((deck) => setNotes(deck, slide.id, text), doc)}
      onKeyDown={(event) => event.stopPropagation()}
      placeholder="Speaker notes"
      aria-label="Speaker notes"
      spellCheck
      className="glass-input mx-6 mb-3 h-20 shrink-0 resize-none rounded-lg px-3 py-2 text-[12.5px] text-fg outline-none placeholder:text-fg-4"
    />
  )
}

function StageMenu({ doc, at, onClose }: { doc: SlidesDocument; at: { x: number; y: number }; onClose: () => void }) {
  const selection = doc.selection
  const only = selection.length === 1 ? selection[0] : null
  const items: MenuItemDef[] = selection.length
    ? [
        ...(only && (only.kind === 'text' || only.kind === 'shape') ? [{ id: 'edit', label: 'Edit Text', onSelect: () => commands.editSelection('end') }] : []),
        ...(only?.kind === 'image' ? [{ id: 'picture', label: isEmptyPlaceholder(only) ? 'Choose Picture…' : 'Replace Picture…', onSelect: () => commands.pickPictures(doc) }, ...(only.crop ? [{ id: 'crop', label: 'Reset Crop', onSelect: commands.resetCrop }] : [])] : []),
        { id: 'cut', label: 'Cut', onSelect: () => commands.copyToClipboard(true, doc), dividerBefore: Boolean(only && only.kind !== 'line') },
        { id: 'copy', label: 'Copy', onSelect: () => commands.copyToClipboard(false, doc) },
        { id: 'duplicate', label: 'Duplicate', onSelect: commands.duplicateSelection },
        { id: 'delete', label: 'Delete', danger: true, onSelect: commands.deleteSelection },
        ...(['front', 'forward', 'backward', 'back'] as const).map((how, index) => ({ id: how, label: ARRANGE_LABELS[how], onSelect: () => commands.arrange(how), dividerBefore: index === 0 })),
        {
          id: 'align',
          label: selection.length > 1 ? 'Align' : 'Align to Slide',
          onSelect: () => {},
          submenu: (['left', 'center', 'right', 'top', 'middle', 'bottom'] as AlignEdge[]).map((edge) => ({ id: edge, label: ALIGN_LABELS[edge], onSelect: () => commands.alignSelection(edge) }))
        }
      ]
    : [
        { id: 'text', label: 'New Text Box', onSelect: commands.insertText },
        { id: 'picture', label: 'Picture…', onSelect: () => commands.pickPictures(doc) },
        { id: 'select-all', label: 'Select All', onSelect: commands.selectAll, disabled: !doc.slide.elements.length }
      ]

  return (
    <div className="absolute z-40" style={{ left: at.x, top: at.y }}>
      <Menu align="left" onClose={onClose} items={items} />
    </div>
  )
}

export function SlideEditor({ doc: officeDoc }: { doc: OfficeDocument<Deck> }) {
  const [doc] = useState(() => new SlidesDocument(officeDoc.initial, () => slidesSession.changed(officeDoc)))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const handle: EditorHandle<Deck> = {
      snapshot: () => {
        flushTyping(doc)

        return doc.history.present
      },
      load: (deck) => doc.reset(deck),
      undo: () => {
        const session = textSessionOf(doc)

        if (session) {
          session.editor.commands.undo()
        } else {
          doc.undo()
        }
      },
      redo: () => {
        const session = textSessionOf(doc)

        if (session) {
          session.editor.commands.redo()
        } else {
          doc.redo()
        }
      },
      status: () => `Slide ${doc.index + 1} of ${doc.deck.slides.length}`,
      detail: () => {
        const title = slideTitle(doc.slide)
        const selected = doc.selection.map(describeElement)

        return `slide ${doc.index + 1} of ${doc.deck.slides.length}${title ? ` (“${title}”)` : ''}${selected.length ? `, ${selected.join(', ').toLowerCase()} selected` : ''}`
      },
      zoom: (step) => {
        const now = stageScales.get(doc)

        if (step === 'reset' || !now) {
          doc.setZoom('fit')
        } else {
          doc.setZoom(now.scale * (step === 'in' ? 1.25 : 0.8))
        }
      },
      dispose: () => decks.delete(officeDoc.key)
    }
    decks.set(officeDoc.key, doc)
    slidesSession.attach(officeDoc, handle)
    // The status bar shows the slide in front.
    const off = doc.subscribe(() => slidesSession.refresh(officeDoc))

    return () => {
      off()
      // The deck outlives its view (a closed window keeps it until Herald quits).
      officeDoc.initial = doc.history.present

      if (officeDoc.editor === handle) {
        slidesSession.attach(officeDoc, null)
      }

      decks.delete(officeDoc.key)
    }
  }, [officeDoc.key])

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <Rail doc={doc} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <Stage doc={doc} onContextMenu={setMenu} />
        {menu && <StageMenu doc={doc} at={menu} onClose={() => setMenu(null)} />}
        <Notes doc={doc} />
      </div>
    </div>
  )
}
