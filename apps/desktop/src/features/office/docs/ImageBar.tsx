import { IconArrowBackUp, IconTrash } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { imageSize, parseDataUrl } from '../../../../shared/office/document.ts'
import { textWidth } from './editor.ts'
import { anchorIn, clampLeft } from './overlay.ts'
import { ToolButton } from './Toolbar.tsx'

const WIDTH = 300

/** A selected picture: its description for people who cannot see it, its own size back, or out. */
export function ImageBar({ editor, frame, tick }: { editor: Editor; frame: HTMLElement | null; tick: number }) {
  const picture = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { selection } = current.state

      return selection instanceof NodeSelection && selection.node.type.name === 'image' ? { pos: selection.from, alt: String(selection.node.attrs.alt ?? ''), src: String(selection.node.attrs.src ?? '') } : null
    }
  })
  const [alt, setAlt] = useState('')

  useEffect(() => setAlt(picture?.alt ?? ''), [picture?.pos, picture?.alt])

  if (!picture) {
    return null
  }

  const setAttrs = (attrs: Record<string, unknown>) => {
    const node = editor.state.doc.nodeAt(picture.pos)

    if (node?.type.name === 'image') {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(picture.pos, undefined, { ...node.attrs, ...attrs }))
    }
  }

  const resetSize = () => {
    const data = parseDataUrl(picture.src)
    const natural = data ? imageSize(data.bytes) : null

    if (natural) {
      const scale = Math.min(1, textWidth(editor.view) / natural.width)
      setAttrs({ width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) })
    } else {
      setAttrs({ width: null, height: null })
    }
  }

  void tick
  const element = editor.view.nodeDOM(picture.pos)
  const anchor = anchorIn(frame, element instanceof HTMLElement ? element.getBoundingClientRect() : null)

  if (!anchor) {
    return null
  }

  return (
    <div className="float menu-surface absolute z-30 flex items-center gap-1 rounded-xl p-1.5 animate-pop" style={{ width: WIDTH, left: clampLeft(frame, anchor.left, WIDTH), top: anchor.bottom + 8 }}>
      <input
        value={alt}
        onChange={(event) => setAlt(event.target.value)}
        onBlur={() => alt !== picture.alt && setAttrs({ alt: alt || null })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            setAttrs({ alt: alt || null })
            editor.commands.focus()
          }
        }}
        placeholder="Describe the picture (alt text)"
        aria-label="Alt text"
        className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none"
      />
      <ToolButton label="Original size" onClick={resetSize}>
        <IconArrowBackUp />
      </ToolButton>
      <ToolButton label="Remove picture" onClick={() => editor.chain().focus().deleteSelection().run()}>
        <IconTrash />
      </ToolButton>
    </div>
  )
}
