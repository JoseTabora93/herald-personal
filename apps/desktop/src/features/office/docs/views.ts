import type { NodeViewRenderer } from '@tiptap/core'
import { TableView } from '@tiptap/extension-table'
import type { Node as PMNode } from '@tiptap/pm/model'

/*
 * How the editor draws pictures and tables. A picture has corner handles that resize it with its
 * proportions kept, measured against the page's zoom, never wider than the text area. A table
 * without borders shows faint guides on screen (not on paper).
 */

const MIN_SIZE = 24
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

export const imageView: NodeViewRenderer = ({ node: initial, getPos, editor }) => {
  let node: PMNode = initial
  const dom = document.createElement('span')
  dom.className = 'docs-image'
  dom.contentEditable = 'false'
  const img = document.createElement('img')
  img.draggable = false
  dom.append(img)

  const show = () => {
    const { src, alt, title, width, height } = node.attrs
    img.src = typeof src === 'string' ? src : ''
    img.alt = typeof alt === 'string' ? alt : ''
    img.title = typeof title === 'string' ? title : ''
    img.style.width = typeof width === 'number' ? `${width}px` : ''
    img.style.height = typeof width === 'number' && typeof height === 'number' ? `${height}px` : ''
  }

  show()

  for (const corner of CORNERS) {
    const handle = document.createElement('span')
    handle.className = 'docs-image-handle'
    handle.dataset.corner = corner
    handle.addEventListener('pointerdown', (event) => {
      if (!editor.isEditable) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      handle.setPointerCapture(event.pointerId)
      // The page may be zoomed: pointer moves are in screen pixels, sizes in the page's.
      const scale = img.getBoundingClientRect().width / (img.offsetWidth || 1) || 1
      const startX = event.clientX
      const startWidth = img.offsetWidth
      const ratio = img.offsetHeight / (img.offsetWidth || 1) || 1
      const limit = (dom.closest('.tiptap') as HTMLElement | null)?.clientWidth ?? Number.POSITIVE_INFINITY
      const direction = corner.endsWith('left') ? -1 : 1
      let width = startWidth

      const move = (moved: PointerEvent) => {
        width = Math.round(Math.max(MIN_SIZE, Math.min(limit, startWidth + ((moved.clientX - startX) / scale) * direction)))
        img.style.width = `${width}px`
        img.style.height = `${Math.round(width * ratio)}px`
      }
      const end = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', end)
        handle.removeEventListener('pointercancel', end)
        dom.classList.remove('is-resizing')
        const pos = getPos()

        if (typeof pos === 'number' && width !== startWidth) {
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width, height: Math.round(width * ratio) }))
        }
      }

      dom.classList.add('is-resizing')
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
    })
    dom.append(handle)
  }

  return {
    dom,
    update: (next) => {
      if (next.type !== node.type) {
        return false
      }

      node = next
      show()

      return true
    },
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    stopEvent: (event) => event.target instanceof HTMLElement && event.target.classList.contains('docs-image-handle'),
    ignoreMutation: () => true
  }
}

/** Tables as TipTap draws them, marked when their borders are off. */
export class DocsTableView extends TableView {
  constructor(node: PMNode, cellMinWidth: number) {
    super(node, cellMinWidth)
    this.mark(node)
  }

  update(node: PMNode): boolean {
    const updated = super.update(node)

    if (updated) {
      this.mark(node)
    }

    return updated
  }

  private mark(node: PMNode): void {
    if (node.attrs.borders === false) {
      this.table.dataset.borders = 'none'
    } else {
      delete this.table.dataset.borders
    }
  }
}
