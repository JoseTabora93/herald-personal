import type { Editor } from '@tiptap/core'
import { CellSelection } from '@tiptap/pm/tables'
import type { MenuItemDef } from '../../files/Menu.tsx'

/* What can be done to the table at the selection: rows, columns, merging, the header row, borders. */

export interface TableAction {
  id: string
  label: string
  enabled: (editor: Editor) => boolean
  checked?: (editor: Editor) => boolean
  run: (editor: Editor) => void
  dividerBefore?: boolean
}

const firstRowIsHeader = (editor: Editor): boolean => {
  const { $from } = editor.state.selection

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)

    if (node.type.name === 'table') {
      const row = node.firstChild

      return Boolean(row && row.childCount && [...Array(row.childCount).keys()].every((index) => row.child(index).type.name === 'tableHeader'))
    }
  }

  return false
}

const bordersOn = (editor: Editor): boolean => editor.getAttributes('table').borders !== false

export const TABLE_ACTIONS: readonly TableAction[] = [
  { id: 'row-above', label: 'Insert Row Above', enabled: (editor) => editor.can().addRowBefore(), run: (editor) => editor.chain().focus().addRowBefore().run() },
  { id: 'row-below', label: 'Insert Row Below', enabled: (editor) => editor.can().addRowAfter(), run: (editor) => editor.chain().focus().addRowAfter().run() },
  { id: 'col-left', label: 'Insert Column Left', enabled: (editor) => editor.can().addColumnBefore(), run: (editor) => editor.chain().focus().addColumnBefore().run() },
  { id: 'col-right', label: 'Insert Column Right', enabled: (editor) => editor.can().addColumnAfter(), run: (editor) => editor.chain().focus().addColumnAfter().run() },
  { id: 'delete-row', label: 'Delete Row', enabled: (editor) => editor.can().deleteRow(), run: (editor) => editor.chain().focus().deleteRow().run(), dividerBefore: true },
  { id: 'delete-col', label: 'Delete Column', enabled: (editor) => editor.can().deleteColumn(), run: (editor) => editor.chain().focus().deleteColumn().run() },
  { id: 'merge', label: 'Merge Cells', enabled: (editor) => editor.state.selection instanceof CellSelection && editor.can().mergeCells(), run: (editor) => editor.chain().focus().mergeCells().run(), dividerBefore: true },
  { id: 'split', label: 'Split Cell', enabled: (editor) => editor.can().splitCell(), run: (editor) => editor.chain().focus().splitCell().run() },
  { id: 'header', label: 'Header Row', enabled: (editor) => editor.can().toggleHeaderRow(), checked: firstRowIsHeader, run: (editor) => editor.chain().focus().toggleHeaderRow().run(), dividerBefore: true },
  { id: 'borders', label: 'Borders', enabled: (editor) => editor.isActive('table'), checked: bordersOn, run: (editor) => editor.chain().focus().updateAttributes('table', { borders: !bordersOn(editor) }).run() },
  { id: 'delete-table', label: 'Delete Table', enabled: (editor) => editor.can().deleteTable(), run: (editor) => editor.chain().focus().deleteTable().run(), dividerBefore: true }
]

export const tableMenu = (editor: Editor): MenuItemDef[] =>
  TABLE_ACTIONS.map((action) => ({ id: action.id, label: action.label, disabled: !action.enabled(editor), checked: action.checked?.(editor), dividerBefore: action.dividerBefore, onSelect: () => action.run(editor) }))
