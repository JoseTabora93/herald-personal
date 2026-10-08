import { atom } from 'nanostores'
import { createSession } from '../session.ts'
import { slidesAdapter } from './adapter.ts'
import type { SlidesDocument } from './document.ts'

/** Herald Slides' open decks in this window. */
export const slidesSession = createSession(slidesAdapter)

/** The live deck of each open document, by its key, while its editor is mounted. */
export const decks = new Map<string, SlidesDocument>()

/** The deck being presented, and from which slide. */
export const $presenting = atom<{ key: string; index: number } | null>(null)
