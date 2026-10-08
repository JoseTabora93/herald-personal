/*
 * A picture's pixel size and type from its first bytes, for the formats a browser shows: PNG, JPEG,
 * GIF, BMP and WebP. Anything else (EMF, WMF, TIFF…) gives null, as Herald cannot show it, and so
 * does a file cut short before its size.
 */

export interface ImageSize {
  width: number
  height: number
  mime: string
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** JPEG's start-of-frame markers, which carry the size (0xc4, 0xc8 and 0xcc share the range but are not frames). */
const FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** The sizes BMP's information header comes in, from OS/2's 12 bytes to version 5's 124. */
const BMP_HEADERS = new Set([12, 16, 40, 52, 56, 64, 108, 124])

const has = (bytes: Uint8Array, at: number, signature: readonly number[]): boolean => bytes.length >= at + signature.length && signature.every((byte, index) => bytes[at + index] === byte)

const word = (bytes: Uint8Array, at: number, text: string): boolean => has(bytes, at, [...text].map((char) => char.charCodeAt(0)))

const u16be = (bytes: Uint8Array, at: number): number => (bytes[at] << 8) | bytes[at + 1]

const u16le = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8)

const u24le = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)

const u32be = (bytes: Uint8Array, at: number): number => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0

const u32le = (bytes: Uint8Array, at: number): number => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0

const i32le = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)

const sized = (width: number, height: number, mime: string): ImageSize | null => (width > 0 && height > 0 ? { width, height, mime } : null)

/** A JPEG's size from its first frame header, stepping over the segments before it. */
function jpeg(bytes: Uint8Array): ImageSize | null {
  let at = 2

  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return null
    }

    const marker = bytes[at + 1]

    if (marker === 0xff) {
      at++
    } else if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
    } else if (marker === 0xd9 || marker === 0xda) {
      // The image ends, or its data starts, before any frame said how big it is.
      return null
    } else if (FRAMES.has(marker)) {
      return at + 9 <= bytes.length ? sized(u16be(bytes, at + 7), u16be(bytes, at + 5), 'image/jpeg') : null
    } else {
      const length = u16be(bytes, at + 2)

      if (length < 2) {
        return null
      }

      at += 2 + length
    }
  }

  return null
}

function bmp(bytes: Uint8Array): ImageSize | null {
  const header = bytes.length >= 26 ? u32le(bytes, 14) : 0

  if (!BMP_HEADERS.has(header)) {
    return null
  }

  // A negative height is a picture stored top down.
  return header === 12 ? sized(u16le(bytes, 18), u16le(bytes, 20), 'image/bmp') : sized(Math.abs(i32le(bytes, 18)), Math.abs(i32le(bytes, 22)), 'image/bmp')
}

/** A WebP's size from its first chunk: lossy (VP8), lossless (VP8L) or extended (VP8X). */
function webp(bytes: Uint8Array): ImageSize | null {
  if (word(bytes, 12, 'VP8 ') && has(bytes, 23, [0x9d, 0x01, 0x2a]) && bytes.length >= 30) {
    return sized(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff, 'image/webp')
  }

  if (word(bytes, 12, 'VP8L') && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = u32le(bytes, 21)

    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'image/webp')
  }

  if (word(bytes, 12, 'VP8X') && bytes.length >= 30) {
    return sized(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1, 'image/webp')
  }

  return null
}

/** A picture's size in pixels and its MIME type, or null when it is not one Herald can show. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (has(bytes, 0, PNG)) {
    return bytes.length >= 24 && word(bytes, 12, 'IHDR') ? sized(u32be(bytes, 16), u32be(bytes, 20), 'image/png') : null
  }

  if (has(bytes, 0, [0xff, 0xd8])) {
    return jpeg(bytes)
  }

  if (word(bytes, 0, 'GIF87a') || word(bytes, 0, 'GIF89a')) {
    return bytes.length >= 10 ? sized(u16le(bytes, 6), u16le(bytes, 8), 'image/gif') : null
  }

  if (word(bytes, 0, 'BM')) {
    return bmp(bytes)
  }

  if (word(bytes, 0, 'RIFF') && word(bytes, 8, 'WEBP')) {
    return webp(bytes)
  }

  return null
}
