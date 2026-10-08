import { describe, expect, it } from 'vitest'
import { DeckHistory, findElement, findSlide, withElements } from './deck.ts'
import { newDeck } from './model.ts'

describe('DeckHistory', () => {
  it('steps back and forward with the labels of the steps', () => {
    const start = newDeck('Pitch')
    const history = new DeckHistory(start)
    const next = { ...start, title: 'Pitch 2' }
    history.commit(next, 'Rename')

    expect(history.undoLabel).toBe('Rename')
    expect(history.undo()).toBe('Rename')
    expect(history.present).toBe(start)
    expect(history.canRedo).toBe(true)
    expect(history.redo()).toBe('Rename')
    expect(history.present).toBe(next)
    expect(history.redo()).toBeNull()
  })

  it('forgets what was undone once something new is done, and ignores a change that changes nothing', () => {
    const start = newDeck('Pitch')
    const history = new DeckHistory(start)
    history.commit({ ...start, title: 'A' }, 'A')
    history.undo()
    history.commit(start, 'Nothing')
    history.commit({ ...start, title: 'B' }, 'B')

    expect(history.canRedo).toBe(false)
    expect(history.undo()).toBe('B')
    expect(history.canUndo).toBe(false)
  })

  it('joins quick changes with the same key into one step, and only those', () => {
    const start = newDeck('Pitch')
    const history = new DeckHistory(start)
    history.commit({ ...start, title: '1' }, 'Nudge', 'nudge:a', 1000)
    history.commit({ ...start, title: '2' }, 'Nudge', 'nudge:a', 1500)
    history.commit({ ...start, title: '3' }, 'Nudge', 'nudge:a', 2000)

    expect(history.present.title).toBe('3')
    expect(history.undo()).toBe('Nudge')
    expect(history.present).toBe(start)

    history.commit({ ...start, title: '4' }, 'Nudge', 'nudge:a', 10_000)
    history.commit({ ...start, title: '5' }, 'Nudge', 'nudge:a', 13_000)
    expect(history.undo()).toBe('Nudge')
    expect(history.present.title).toBe('4')
  })

  it('keeps at most its limit of steps', () => {
    const start = newDeck('Pitch')
    const history = new DeckHistory(start, 3)

    for (let i = 0; i < 6; i++) {
      history.commit({ ...start, title: String(i) }, `Step ${i}`)
    }

    expect([history.undo(), history.undo(), history.undo(), history.undo()]).toEqual(['Step 5', 'Step 4', 'Step 3', null])
  })
})

describe('deck helpers', () => {
  it('changes only the elements asked for, on their slide', () => {
    const deck = newDeck('Pitch')
    const slide = deck.slides[0]
    const [title, subtitle] = slide.elements
    const next = withElements(deck, slide.id, new Set([title.id]), (element) => ({ ...element, x: 1 }))

    expect(findElement(findSlide(next, slide.id), title.id)?.x).toBe(1)
    expect(findElement(findSlide(next, slide.id), subtitle.id)).toBe(subtitle)
  })
})
