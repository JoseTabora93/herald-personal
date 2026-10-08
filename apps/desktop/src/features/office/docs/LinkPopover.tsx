import { useStore } from '@nanostores/react'
import { IconExternalLink, IconLinkOff, IconPencil } from '@tabler/icons-react'
import { type Editor, getMarkRange } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { openWebWindow } from '../../../store/web-windows.ts'
import { anchorIn, clampLeft } from './overlay.ts'
import { $linkEdit } from './store.ts'
import { ToolButton } from './Toolbar.tsx'

const WIDTH = 340

/** What people type as a link, as one: a scheme added to a bare address, mailto: to an email address. */
export function normalizeLink(input: string): string | null {
  const text = input.trim()

  if (!text) {
    return null
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('#')) {
    return text
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? `mailto:${text}` : `https://${text}`
}

/** The link at the caret: open it, change it or take it off; ⌘K edits it or makes one of the selection. */
export function LinkPopover({ editor, docKey, frame, tick }: { editor: Editor; docKey: string; frame: HTMLElement | null; tick: number }) {
  const request = useStore($linkEdit)
  const [editing, setEditing] = useState(false)
  const [href, setHref] = useState('')
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { selection } = current.state
      const range = getMarkRange(selection.$from, current.schema.marks.link)
      const at = range && current.state.doc.nodeAt(range.from)?.marks.find((mark) => mark.type.name === 'link')

      return { from: range?.from ?? selection.from, to: range?.to ?? selection.to, href: at ? String(at.attrs.href ?? '') : null, empty: selection.empty, focused: current.isFocused }
    }
  })

  useEffect(() => {
    if (request?.key !== docKey) {
      return
    }

    setHref(state.href ?? '')
    setText('')
    setEditing(true)
    setTimeout(() => input.current?.focus({ preventScroll: true }), 0)
  }, [request?.at])

  // A move away from the link closes the editor.
  useEffect(() => {
    if (editing && !state.href && !request) {
      setEditing(false)
    }
  }, [state.from])

  const close = () => {
    setEditing(false)
    $linkEdit.set(null)
    editor.commands.focus()
  }

  const apply = () => {
    const link = normalizeLink(href)
    const chain = editor.chain().focus()

    if (!link) {
      chain.extendMarkRange('link').unsetLink().run()
    } else if (state.href) {
      chain.extendMarkRange('link').setLink({ href: link }).run()
    } else if (state.empty) {
      chain.insertContent({ type: 'text', text: text.trim() || href.trim(), marks: [{ type: 'link', attrs: { href: link } }] }).run()
    } else {
      chain.setLink({ href: link }).run()
    }

    setEditing(false)
    $linkEdit.set(null)
  }

  if (!editing && (!state.href || !state.focused)) {
    return null
  }

  void tick
  const coords = editor.view.coordsAtPos(state.from)
  const anchor = anchorIn(frame, coords)

  if (!anchor) {
    return null
  }

  return (
    <div className="float menu-surface absolute z-30 rounded-xl p-1.5 animate-pop" style={{ width: WIDTH, left: clampLeft(frame, anchor.left + WIDTH / 2 - 16, WIDTH), top: anchor.bottom + 6 }} onMouseDown={(event) => event.target instanceof HTMLInputElement || event.preventDefault()}>
      {editing ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            apply()
          }}
          onBlur={(event) => {
            // Focus going anywhere but the form's own fields leaves the link as it was.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setEditing(false)
              $linkEdit.set(null)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              close()
            }
          }}
        >
          {state.empty && !state.href && <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Text to show" aria-label="Text to show" className="glass-input h-7 rounded-md px-2 text-[12px] text-fg outline-none" />}
          <div className="flex gap-1.5">
            <input ref={input} value={href} onChange={(event) => setHref(event.target.value)} placeholder="Paste or type a link" aria-label="Link" className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none" />
            <button type="submit" className="h-7 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:bg-accent-strong">
              Apply
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate px-1.5 text-[12px] text-accent-strong" title={state.href ?? ''}>
            {state.href}
          </span>
          <ToolButton label="Open link" disabled={!/^https?:/i.test(state.href ?? '')} onClick={() => state.href && void openWebWindow(state.href)}>
            <IconExternalLink />
          </ToolButton>
          <ToolButton
            label="Edit link"
            onClick={() => {
              setHref(state.href ?? '')
              setEditing(true)
              setTimeout(() => input.current?.focus({ preventScroll: true }), 0)
            }}
          >
            <IconPencil />
          </ToolButton>
          <ToolButton label="Remove link" onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}>
            <IconLinkOff />
          </ToolButton>
        </div>
      )}
    </div>
  )
}
