import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { findText, type Match, type SearchOptions } from './model.ts'
import { revealInDesk } from './overlay.ts'

/*
 * Find and replace: every match of the query is marked in the page, the current one more
 * strongly, and the marks follow edits. The selection stays where the person left it until they
 * close the bar on a match.
 */

export interface FindState {
  query: string
  options: SearchOptions
  matches: Match[]
  current: number
  decorations: DecorationSet
}

export const findKey = new PluginKey<FindState>('docsFind')

const EMPTY: FindState = { query: '', options: {}, matches: [], current: 0, decorations: DecorationSet.empty }

function search(doc: PMNode, query: string, options: SearchOptions, current: number): FindState {
  const matches = query ? findText(doc, query, options) : []
  const index = matches.length ? Math.max(0, Math.min(current, matches.length - 1)) : 0
  const decorations = DecorationSet.create(
    doc,
    matches.map((match, i) => Decoration.inline(match.from, match.to, { class: i === index ? 'docs-find docs-find-current' : 'docs-find' }))
  )

  return { query, options, matches, current: index, decorations }
}

export const FindHighlight = Extension.create({
  name: 'findHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply(tr, value) {
            const meta = tr.getMeta(findKey) as Partial<Pick<FindState, 'query' | 'options' | 'current'>> | undefined

            if (meta) {
              return search(tr.doc, meta.query ?? value.query, meta.options ?? value.options, meta.current ?? value.current)
            }

            return tr.docChanged && value.query ? search(tr.doc, value.query, value.options, value.current) : value
          }
        },
        props: {
          decorations: (state) => findKey.getState(state)?.decorations
        }
      })
    ]
  }
})

export const findStateOf = (state: EditorState): FindState => findKey.getState(state) ?? EMPTY

/** Search for `query` (empty clears the marks), keeping the current match where it can. */
export function setFind(view: EditorView, query: string, options: SearchOptions, current?: number): void {
  view.dispatch(view.state.tr.setMeta(findKey, { query, options, ...(current === undefined ? {} : { current }) }).setMeta('addToHistory', false))
}

/** Bring the current match into view. */
export function revealMatch(view: EditorView): void {
  const { matches, current } = findStateOf(view.state)
  const match = matches[current]

  if (match) {
    revealInDesk(view, match.from, 96)
  }
}

/** Move to the next or previous match, round the end. */
export function stepMatch(view: EditorView, step: 1 | -1): void {
  const state = findStateOf(view.state)

  if (state.matches.length) {
    setFind(view, state.query, state.options, (state.current + step + state.matches.length) % state.matches.length)
    revealMatch(view)
  }
}

/** Select the current match (when the bar closes), so the person carries on from it. */
export function selectMatch(view: EditorView): void {
  const { matches, current } = findStateOf(view.state)
  const match = matches[current]

  if (match) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView())
  }
}
