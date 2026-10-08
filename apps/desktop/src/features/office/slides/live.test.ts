import { describe, expect, it, vi } from 'vitest'
import type { OfficeDocument } from '../types.ts'
import type { Deck } from './deck.ts'
import { SlidesDocument } from './document.ts'
import { makeTargets, type TargetIO } from './live.ts'
import * as model from './model.ts'

function officeDoc(deck: Deck, path: string | null, notes: string[] = []): OfficeDocument<Deck> {
  return { key: `slides-${Math.random()}`, name: 'Deck', path, format: '.pptx', digest: null, modified: false, notes, layout: undefined, accepted: null, autosave: false, initial: deck, editor: null, revision: 0 }
}

function io(overrides: Partial<TargetIO> = {}): TargetIO {
  return {
    documents: () => [],
    active: () => null,
    live: () => undefined,
    changed: vi.fn(),
    read: vi.fn(async (file: string) => ({ path: file, bytes: new Uint8Array([1]) })),
    write: vi.fn(async () => ({})),
    adapter: { read: vi.fn(async () => ({ model: model.newDeck('On disk'), notes: [] })), write: vi.fn(async () => ({ bytes: new Uint8Array([2]), losses: [] })) },
    ...overrides
  }
}

describe('slides targets', () => {
  it('changes the deck open in a window as one step to undo, worked out from the deck as it is then', async () => {
    const deck = model.newDeck('Live')
    const open = officeDoc(deck, '/tmp/live.pptx')
    const doc = new SlidesDocument(deck, () => {})
    const flush = vi.fn()
    const targets = makeTargets(io({ documents: () => [open], active: () => open, live: () => doc, flush }))
    const on = await targets.target()

    // The person adds a slide after the command looked and before it lands.
    doc.commit(model.addSlide(doc.history.present, { layout: 'blank' }))
    await targets.apply(on, (current) => model.setTitle(current, current.slides[0].id, 'From Hermes'))

    expect(doc.history.present.slides).toHaveLength(2)
    expect(model.slideTitle(doc.history.present.slides[0])).toBe('From Hermes')
    expect(doc.undo()).toBe('Title')
    expect(doc.history.present.slides).toHaveLength(2)
    expect(flush).toHaveBeenCalled()
  })

  it('finds an open file by its path, and changes an open deck whose editor is not up', async () => {
    const deck = model.newDeck('Open')
    const open = officeDoc(deck, '/tmp/open.pptx')
    const shared = io({ documents: () => [open] })
    const targets = makeTargets(shared)
    const on = await targets.target('/tmp/open.pptx')

    expect(on.open).toBe(open)
    await targets.apply(on, (current) => model.addSlide(current))
    expect(open.initial.slides).toHaveLength(2)
    expect(shared.changed).toHaveBeenCalledWith(open)
  })

  it('reads a file from disk, changes it and writes it back', async () => {
    const shared = io()
    const targets = makeTargets(shared)
    const on = await targets.target('/tmp/closed.pptx')

    expect(on.doc).toBeNull()
    await targets.apply(on, (current) => model.addSlide(current))
    expect(shared.adapter.write).toHaveBeenCalledOnce()
    expect(shared.write).toHaveBeenCalledWith('/tmp/closed.pptx', new Uint8Array([2]))
  })

  it('does not write over a file whose reading lost something, unless told to', async () => {
    const shared = io({ adapter: { read: vi.fn(async () => ({ model: model.newDeck('Lossy'), notes: ['Left out: 1 chart.'] })), write: vi.fn(async () => ({ bytes: new Uint8Array([3]), losses: [] })) } })
    const targets = makeTargets(shared)
    const on = await targets.target('/tmp/lossy.pptx')

    await expect(targets.apply(on, (current) => model.addSlide(current))).rejects.toThrow(/would lose/)
    expect(shared.write).not.toHaveBeenCalled()
    await targets.apply(on, (current) => model.addSlide(current), { accept: true })
    expect(shared.write).toHaveBeenCalledOnce()
  })

  it('says so when nothing is open', async () => {
    await expect(makeTargets(io()).target()).rejects.toThrow(/No presentation is open/)
  })
})
