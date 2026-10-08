import { type Editor, Extension } from '@tiptap/core'
import { applyLive, indent, insertPageBreak } from './model.ts'

/*
 * Keys that work as in Word: Tab types a tab in a paragraph (lists and tables take it first, to
 * indent an item or move to the next cell), ⌘Enter starts a new page, ⌘] and ⌘[ indent and
 * outdent. Tab never moves the focus out of the page.
 */

const INDENT_STEP = 36

const listItemType = (editor: Editor): string | null => (editor.isActive('taskItem') ? 'taskItem' : editor.isActive('listItem') ? 'listItem' : null)

export const WordKeys = Extension.create({
  name: 'wordKeys',
  // Below lists and tables, which handle Tab and Shift-Tab themselves first.
  priority: 50,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.isActive('table')) {
          return false
        }

        return listItemType(this.editor) ? true : this.editor.commands.insertContent('\t')
      },
      'Shift-Tab': () => !this.editor.isActive('table'),
      'Mod-Enter': () => applyLive(this.editor.view, insertPageBreak()),
      'Mod-]': () => {
        const item = listItemType(this.editor)

        return item ? this.editor.commands.sinkListItem(item) : applyLive(this.editor.view, indent(INDENT_STEP))
      },
      'Mod-[': () => {
        const item = listItemType(this.editor)

        return item ? this.editor.commands.liftListItem(item) : applyLive(this.editor.view, indent(-INDENT_STEP))
      }
    }
  }
})
