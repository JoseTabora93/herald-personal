import type { OfficeAdapter } from '../types.ts'
import type { Deck } from './deck.ts'
import { newDeck } from './model.ts'

/*
 * Herald Slides' files. Decks open and save as PowerPoint files once the format converters come;
 * until then a deck is exported as a PDF, one slide a page, drawn by the slide view itself.
 */

export const slidesAdapter: OfficeAdapter<Deck> = {
  app: 'slides',
  defaultFormat: '.pptx',
  blank: (name) => newDeck(name),
  read: async () => {
    throw new Error('Herald Slides opens PowerPoint files once the format converters come')
  },
  write: async () => {
    throw new Error('Herald Slides saves PowerPoint files once the format converters come')
  },
  print: async (model, name) => {
    const { printDeck } = await import('./print.tsx')

    return printDeck(model, name)
  }
}
