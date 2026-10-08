import { describe, expect, it, vi } from 'vitest'
import { withElements } from './deck.ts'
import { SlidesDocument } from './document.ts'
import * as model from './model.ts'

describe('SlidesDocument', () => {
  it('shows a drag as a preview and keeps it as one step when it ends', () => {
    const edited = vi.fn()
    const deck = model.newDeck('Pitch')
    const doc = new SlidesDocument(deck, edited)
    const box = deck.slides[0].elements[0]
    const moved = (x: number) => withElements(deck, doc.slideId, new Set([box.id]), (element) => ({ ...element, x }))

    doc.show(moved(10))
    doc.show(moved(20))
    expect(doc.deck.slides[0].elements[0].x).toBe(20)
    expect(doc.history.canUndo).toBe(false)
    expect(edited).not.toHaveBeenCalled()

    doc.commit({ deck: doc.preview!, label: 'Move', focus: { selected: [box.id] } })
    expect(doc.preview).toBeNull()
    expect(doc.selected).toEqual([box.id])
    expect(edited).toHaveBeenCalledOnce()
    expect(doc.undo()).toBe('Move')
    expect(doc.deck.slides[0].elements[0].x).toBe(box.x)
  })

  it('goes to a new slide, and back to one that still exists after an undo', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    const first = doc.slideId
    doc.commit(model.addSlide(doc.history.present, { layout: 'blank' }))

    expect(doc.index).toBe(1)
    doc.undo()
    expect(doc.slideId).toBe(first)
    expect(doc.picked).toEqual([first])
  })

  it('drops a selection whose element is gone and stops typing in it', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    const added = model.addShape(doc.history.present, doc.slideId, { shape: 'rect' })
    doc.commit(added)
    doc.edit(added.elementId)

    expect(doc.selected).toEqual([added.elementId])
    expect(doc.editing).toBe(added.elementId)
    doc.undo()
    expect(doc.selected).toEqual([])
    expect(doc.editing).toBeNull()
  })

  it('stops typing when a change selects something else', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    const [title, subtitle] = doc.slide.elements
    doc.edit(title.id)
    doc.commit({ deck: doc.history.present, label: 'Nothing' })
    expect(doc.editing).toBe(title.id)

    doc.commit({ ...model.nudge(doc.history.present, doc.slideId, [subtitle.id], 1, 0), focus: { selected: [subtitle.id] } })
    expect(doc.editing).toBeNull()
  })

  it('picks several slides and keeps the one in front among them', () => {
    let deck = model.newDeck('Pitch')
    deck = model.addSlide(deck).deck
    deck = model.addSlide(deck).deck
    const doc = new SlidesDocument(deck, () => {})
    const [a, b, c] = deck.slides.map((slide) => slide.id)

    doc.goTo(c, true)
    expect(doc.pickedSlides).toEqual([a, c])
    doc.goTo(a, true)
    expect(doc.pickedSlides).toEqual([c])
    expect(doc.slideId).toBe(c)
    doc.goTo(b)
    expect(doc.pickedSlides).toEqual([b])
  })

  it('starts over from a deck loaded from disk', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    doc.commit(model.removeSlides(doc.history.present, [doc.slideId]))
    const loaded = model.newDeck('From disk')
    doc.reset(loaded)

    expect(doc.deck).toBe(loaded)
    expect(doc.history.canUndo).toBe(false)
    expect(doc.slideId).toBe(loaded.slides[0].id)
  })

  it('keeps the zoom within reason', () => {
    const doc = new SlidesDocument(model.newDeck('Pitch'), () => {})
    doc.setZoom(100)
    expect(doc.zoom).toBe(8)
    doc.setZoom('fit')
    expect(doc.zoom).toBe('fit')
  })
})
