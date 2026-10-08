/*
 * Pictures made in code for the Word converters' tests, so they need no file: a PNG of one colour,
 * its pixels in a single stored (uncompressed) deflate block, which keeps the encoder small.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index

  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }

  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(Array.from(type, (char) => char.charCodeAt(0)), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))

  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

/** A PNG of one colour; a stored deflate block holds at most 65,535 bytes, so keep it small. */
export function png(width: number, height: number, color: readonly [number, number, number] = [200, 60, 40]): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = 2
  const row = 1 + width * 3
  const pixels = new Uint8Array(height * row)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set(color, y * row + 1 + x * 3)
    }
  }

  const zlib = new Uint8Array(11 + pixels.length)
  zlib.set([0x78, 0x01, 0x01, pixels.length & 0xff, pixels.length >> 8, ~pixels.length & 0xff, (~pixels.length >> 8) & 0xff])
  zlib.set(pixels, 7)
  let a = 1
  let b = 0

  for (const byte of pixels) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }

  new DataView(zlib.buffer).setUint32(7 + pixels.length, ((b << 16) | a) >>> 0)

  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib), chunk('IEND', new Uint8Array())])
}
