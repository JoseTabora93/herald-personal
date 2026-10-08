import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { useLayoutEffect, useRef } from 'react'
import type { Deck, SlideElement, TextBody, Theme } from '../deck.ts'
import { findElement, findSlide, withElements } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { fitText } from '../view/SlideView.tsx'
import { flowCss, styleText } from '../view/text-style.ts'
import { $textRevision, $textSession, takeEditStart, type TextSession } from './active.ts'
import { bodyToDoc, paragraphsFromDoc, sameParagraphs } from './rich-text.ts'
import { slideTextExtensions } from './tiptap.ts'

/*
 * Typing into an element: a TipTap editor laid into the element's own text area, styled as the
 * slide draws the text, so nothing moves when editing starts. What is typed shows in the deck as a
 * preview straight away (the slide list follows along) and becomes one step when editing ends.
 */

/** What takes clicks without ending the typing: the formatting bar and the menus, which format the words picked. */
export const KEEPS_EDITING = '[data-slides-keep-editing], [role="menubar"]'

const SWITCHES = ['bold', 'italic', 'underline', 'strike'] as const

/** The editor's own style: the body's font, size and colour; bold and the like come from marks only. */
function editorCss(body: TextBody, theme: Theme): string {
  const plain = { ...body, style: { ...body.style } }

  for (const key of SWITCHES) {
    delete plain.style[key]
  }

  return styleText(flowCss(plain, theme))
}

/** Put the caret under a point on screen, or select the word there. */
export function selectWordAt(editor: Editor, x: number, y: number, word = true): void {
  const at = editor.view.posAtCoords({ left: x, top: y })?.pos

  if (at === undefined) {
    return
  }

  const { state } = editor
  const $at = state.doc.resolve(at)

  if (!word || !$at.parent.isTextblock) {
    editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)))

    return
  }

  const text = $at.parent.textContent
  const offset = $at.parentOffset
  const from = offset - (/[\p{L}\p{N}_]*$/u.exec(text.slice(0, offset))?.[0].length ?? 0)
  const to = offset + (/^[\p{L}\p{N}_]*/u.exec(text.slice(offset))?.[0].length ?? 0)
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $at.start() + from, $at.start() + to)))
}

function withText(deck: Deck, slideId: string, elementId: string, paragraphs: TextBody['paragraphs'], height: number | null): Deck {
  return withElements(deck, slideId, new Set([elementId]), (element): SlideElement => {
    if (element.kind !== 'text' && element.kind !== 'shape') {
      return element
    }

    const sized = height !== null ? { ...element, height } : element

    return { ...sized, body: { ...element.body, paragraphs } }
  })
}

export function TextEditor({ doc, slideId, elementId, body, theme }: { doc: SlidesDocument; slideId: string; elementId: string; body: TextBody; theme: Theme }) {
  const host = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const mount = host.current

    if (!mount) {
      return
    }

    const start = takeEditStart(elementId)
    const content = bodyToDoc(body)
    let baseline = paragraphsFromDoc(content, body)
    let done = false
    const editor = new Editor({
      element: mount,
      extensions: slideTextExtensions(theme, body),
      content,
      injectCSS: false,
      editorProps: {
        attributes: { class: 'hs-flow', spellcheck: 'true', style: editorCss(body, theme), 'aria-label': 'Text', ...(body.wrap ? {} : { 'data-wrap': 'false' }) },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            session.finish()

            return true
          }

          return false
        }
      }
    })
    const root = editor.view.dom as HTMLElement
    const [, top, , bottom] = body.inset

    /** The element as it would be with what is typed: its paragraphs, and its height when it grows with its text. */
    const current = (): { paragraphs: TextBody['paragraphs']; height: number | null } => {
      const element = findElement(findSlide(doc.history.present, slideId), elementId)
      const paragraphs = paragraphsFromDoc(editor.getJSON(), body)
      const height = element && body.fit === 'grow' ? Math.max(root.offsetHeight + top + bottom, 8) : null

      return { paragraphs, height: height !== null && element && Math.abs(height - element.height) > 0.5 ? height : null }
    }

    const fit = () => {
      if (body.fit === 'shrink') {
        const element = findElement(findSlide(doc.deck, slideId), elementId)

        if (element) {
          fitText(root, Math.max(1, element.height - top - bottom))
        }
      }
    }

    const preview = () => {
      const { paragraphs, height } = current()
      doc.show(withText(doc.history.present, slideId, elementId, paragraphs, height))
    }

    /** Record the typing so far as one step. */
    const record = () => {
      const { paragraphs, height } = current()

      if (!findElement(findSlide(doc.history.present, slideId), elementId)) {
        doc.show(null)

        return
      }

      if (sameParagraphs(paragraphs, baseline) && height === null) {
        if (doc.preview) {
          doc.show(null)
        }

        return
      }

      baseline = paragraphs
      doc.commit({ deck: withText(doc.history.present, slideId, elementId, paragraphs, height), label: 'Typing' })
    }

    const session: TextSession = {
      editor,
      doc,
      elementId,
      flush: record,
      finish: () => {
        if (done) {
          return
        }

        done = true
        record()

        if (doc.editing === elementId) {
          doc.edit(null)
        }
      }
    }

    editor.on('update', () => {
      fit()
      preview()
    })
    editor.on('transaction', () => $textRevision.set($textRevision.get() + 1))
    editor.on('blur', ({ event }) => {
      const next = event.relatedTarget as Element | null

      // Focus leaving the window (another app) or going to the formatting bar keeps the typing open.
      if (next && !next.closest(KEEPS_EDITING) && !mount.contains(next)) {
        session.finish()
      }
    })
    $textSession.set(session)
    fit()

    if (start?.select === 'all') {
      editor.commands.selectAll()
    } else if (start?.point) {
      selectWordAt(editor, start.point.x, start.point.y, start.select === 'word')
    } else {
      editor.commands.setTextSelection(editor.state.doc.content.size)
    }

    editor.commands.focus(undefined, { scrollIntoView: false })

    return () => {
      session.finish()

      if ($textSession.get() === session) {
        $textSession.set(null)
      }

      editor.destroy()
    }
  }, [elementId])

  return <div ref={host} className="hs-editor-host" style={{ minWidth: 1 }} onPointerDown={(event) => event.stopPropagation()} />
}
