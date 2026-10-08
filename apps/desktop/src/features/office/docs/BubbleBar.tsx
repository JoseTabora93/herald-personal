import { IconBold, IconHighlight, IconItalic, IconLink, IconSparkles, IconStrikethrough, IconTextColor, IconUnderline } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { useEffect, useState } from 'react'
import * as act from './actions.ts'
import { anchorIn, clampLeft } from './overlay.ts'
import { ToolButton } from './Toolbar.tsx'

const WIDTH = 348

/**
 * Formatting over a selection of text: the common marks, a link, colour and highlight, and the
 * place where Hermes will take requests about the selection.
 */
export function BubbleBar({ editor, frame, tick }: { editor: Editor; frame: HTMLElement | null; tick: number }) {
  const [pressed, setPressed] = useState(false)
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { selection } = current.state
      const shown = current.isFocused && selection instanceof TextSelection && !selection.empty && !current.isActive('codeBlock')

      return shown
        ? { from: selection.from, to: selection.to, bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'), strike: current.isActive('strike'), link: current.isActive('link') }
        : null
    }
  })

  // Not while the selection is still being dragged out.
  useEffect(() => {
    const element = editor.view.dom
    const down = () => setPressed(true)
    const up = () => setPressed(false)
    element.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up)

    return () => {
      element.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up)
    }
  }, [editor])

  if (!state || pressed) {
    return null
  }

  void tick
  const start = editor.view.coordsAtPos(state.from)
  const end = editor.view.coordsAtPos(state.to)
  const anchor = anchorIn(frame, { left: Math.min(start.left, end.left), right: Math.max(start.left, end.left), top: Math.min(start.top, end.top), bottom: end.bottom })

  if (!anchor || anchor.top < 0) {
    return null
  }

  return (
    <div role="toolbar" aria-label="Selection" className="float menu-surface absolute z-30 flex items-center gap-0.5 rounded-xl p-1 animate-pop" style={{ width: WIDTH, left: clampLeft(frame, anchor.left, WIDTH), top: Math.max(4, anchor.top - 44) }} onMouseDown={(event) => event.preventDefault()}>
      <ToolButton label="Bold" keys="mod+b" active={state.bold} onClick={() => act.toggleMark('bold')}>
        <IconBold />
      </ToolButton>
      <ToolButton label="Italic" keys="mod+i" active={state.italic} onClick={() => act.toggleMark('italic')}>
        <IconItalic />
      </ToolButton>
      <ToolButton label="Underline" keys="mod+u" active={state.underline} onClick={() => act.toggleMark('underline')}>
        <IconUnderline />
      </ToolButton>
      <ToolButton label="Strikethrough" keys="mod+shift+x" active={state.strike} onClick={() => act.toggleMark('strike')}>
        <IconStrikethrough />
      </ToolButton>
      <ToolButton label="Link" keys="mod+k" active={state.link} onClick={act.editLink}>
        <IconLink />
      </ToolButton>
      <ToolButton label="Red text" onClick={() => act.color('#c00000')}>
        <IconTextColor className="text-danger" />
      </ToolButton>
      <ToolButton label="Highlight" onClick={() => act.highlight('#fff27a')}>
        <IconHighlight className="text-warn" />
      </ToolButton>
      <span className="mx-1 h-5 w-px shrink-0 bg-line" />
      <button type="button" disabled title="Hermes rewrites, shortens and explains selections in a coming update" className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-3 disabled:opacity-60">
        <IconSparkles size={14} /> Ask Hermes
      </button>
    </div>
  )
}
