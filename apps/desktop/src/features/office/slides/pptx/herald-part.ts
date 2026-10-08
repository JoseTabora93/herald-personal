import type JSZip from 'jszip'
import type { Deck } from '../deck.ts'
import { normalizeDeck } from '../normalize.ts'
import { attr, childrenNamed, parseXml, serializeXml, xml } from './xml.ts'

/*
 * Herald's own copy of a deck inside a PowerPoint file it saved: `herald/deck.json`, a part with
 * its content type and a package relationship of its own, which PowerPoint, Keynote and LibreOffice
 * pass over. Reading it gives the deck back exactly. Pictures are not stored twice: the copy names
 * the media part PowerPoint's slides use. It also records a fingerprint of the slides as written,
 * so a file changed by another app since is read from its slides instead.
 */

export const HERALD_PART = 'herald/deck.json'
export const HERALD_CONTENT_TYPE = 'application/vnd.herald-os.slides+json'
export const HERALD_RELATIONSHIP = 'urn:herald-os:slides:deck'
const FORMAT = 'herald-slides'
const VERSION = 1

/** A quick 53-bit hash, enough to notice a part that changed. */
function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const slideNumber = (name: string): number => Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0)

/** The slides' XML as written, in order, as one fingerprint. */
export async function slidesFingerprint(zip: JSZip): Promise<string> {
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const parts = await Promise.all(names.map((name) => zip.file(name)!.async('string')))

  return `${names.length}:${hash(parts.join('\u0000'))}`
}

const MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }

type Visit = (src: string) => string

/** The deck with every picture source passed through `visit` (elements and backgrounds). */
function mapSources(deck: Deck, visit: Visit): Deck {
  return {
    ...deck,
    slides: deck.slides.map((slide) => ({
      ...slide,
      background: slide.background?.kind === 'image' ? { ...slide.background, src: visit(slide.background.src) } : slide.background,
      elements: slide.elements.map((element) => (element.kind === 'image' && element.src ? { ...element, src: visit(element.src) } : element))
    }))
  }
}

/** Add Herald's copy of `deck` to a PowerPoint file just written. */
export async function embedDeck(zip: JSZip, deck: Deck): Promise<void> {
  // Pictures already in the file are named by their part instead of copied.
  const media = new Map<string, string>()

  for (const name of Object.keys(zip.files).filter((entry) => entry.startsWith('ppt/media/') && !zip.files[entry].dir)) {
    const base64 = await zip.file(name)!.async('base64')
    media.set(base64, name)
  }

  const light = mapSources(deck, (src) => {
    const payload = src.slice(src.indexOf(',') + 1).replace(/\s+/g, '')
    const part = media.get(payload)

    return part ? `part:/${part}` : src
  })
  const fingerprint = await slidesFingerprint(zip)
  zip.file(HERALD_PART, JSON.stringify({ format: FORMAT, version: VERSION, fingerprint, deck: light }))

  const types = parseXml((await zip.file('[Content_Types].xml')?.async('string')) ?? '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', { canonical: false })
  types.children = types.children.filter((node) => typeof node === 'string' || attr(node, 'PartName') !== `/${HERALD_PART}`)
  types.children.push(xml('Override', { PartName: `/${HERALD_PART}`, ContentType: HERALD_CONTENT_TYPE }))
  zip.file('[Content_Types].xml', serializeXml(types))

  const rels = parseXml((await zip.file('_rels/.rels')?.async('string')) ?? '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', { canonical: false })
  rels.children = rels.children.filter((node) => typeof node === 'string' || attr(node, 'Type') !== HERALD_RELATIONSHIP)
  const taken = new Set(childrenNamed(rels, 'Relationship').map((node) => attr(node, 'Id')))
  let id = 1

  while (taken.has(`rIdHerald${id}`)) {
    id++
  }

  rels.children.push(xml('Relationship', { Id: `rIdHerald${id}`, Type: HERALD_RELATIONSHIP, Target: HERALD_PART }))
  zip.file('_rels/.rels', serializeXml(rels))
}

export type EmbeddedRead = { deck: Deck } | { stale: true } | null

/**
 * Herald's copy of the deck in a file, made safe: null when there is none (or it is not one this
 * version reads), `stale` when the slides changed after Herald wrote it.
 */
export async function readEmbeddedDeck(zip: JSZip, title: string): Promise<EmbeddedRead> {
  const part = zip.file(HERALD_PART)

  if (!part) {
    return null
  }

  let parsed: { format?: unknown; version?: unknown; fingerprint?: unknown; deck?: unknown }

  try {
    parsed = JSON.parse(await part.async('string'))
  } catch {
    return null
  }

  if (parsed.format !== FORMAT || typeof parsed.version !== 'number' || parsed.version > VERSION) {
    return null
  }

  if (parsed.fingerprint !== (await slidesFingerprint(zip))) {
    return { stale: true }
  }

  const sources = new Map<string, string>()

  for (const name of new Set(JSON.stringify(parsed.deck ?? null).match(/part:\/[\w./-]+/g) ?? [])) {
    const file = zip.file(name.slice('part:/'.length))
    const mime = MIME_BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? '']

    if (file && mime) {
      sources.set(name, `data:${mime};base64,${await file.async('base64')}`)
    }
  }

  const resolved = JSON.parse(JSON.stringify(parsed.deck ?? null), (key, value) => (key === 'src' && typeof value === 'string' && value.startsWith('part:/') ? (sources.get(value) ?? '') : value))

  try {
    return { deck: normalizeDeck(resolved, title) }
  } catch {
    return null
  }
}
