import type { Color, Slot } from '../deck.ts'
import { SLOTS } from '../deck.ts'
import { isSlot, normalHex } from '../themes.ts'
import { attr, elements, numberAttr, type XmlElement } from './xml.ts'

/*
 * DrawingML colours: a colour element (`a:srgbClr`, `a:schemeClr`…) and the modifiers inside it,
 * resolved against a theme's colour scheme and the colour map in force. A theme colour stays one of
 * the deck theme's slots while at most its opacity changes, so a new theme repaints it; one made
 * lighter, darker or otherwise different becomes literal, as it is no longer the theme's colour.
 */

/** A theme's twelve colours, by the names its colour scheme gives them. */
export const SCHEME_NAMES = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const

/** The Office theme's colours, for what a file's theme leaves out. */
export const OFFICE_SCHEME: Record<string, string> = {
  dk1: '#000000',
  lt1: '#ffffff',
  dk2: '#44546a',
  lt2: '#e7e6e6',
  accent1: '#4472c4',
  accent2: '#ed7d31',
  accent3: '#a5a5a5',
  accent4: '#ffc000',
  accent5: '#5b9bd5',
  accent6: '#70ad47',
  hlink: '#0563c1',
  folHlink: '#954f72'
}

/** PowerPoint's usual colour map: light backgrounds and dark text. */
export const STANDARD_MAP: Record<string, string> = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink'
}

export interface Palette {
  /** The theme's colours by scheme name, as `#rrggbb`. */
  scheme: Record<string, string>
  /** The colour map in force: `bg1`, `tx1`… to the scheme colours they show. */
  map: Record<string, string>
  /** The scheme colour each of the deck theme's slots holds, or null when these colours are not the deck theme's (they become literal). */
  slots: Record<Slot, string> | null
}

export interface Paint {
  color: Color
  /** 0 (clear) to 1 (solid). */
  alpha: number
}

type Rgb = [number, number, number]

type Hsl = [number, number, number]

const COLOR_ELEMENTS: ReadonlySet<string> = new Set(['a:srgbClr', 'a:sysClr', 'a:schemeClr', 'a:prstClr', 'a:scrgbClr', 'a:hslClr'])

/** What Windows' system colours usually are, for a `sysClr` without the last colour it showed. */
const SYSTEM: Record<string, string> = {
  windowText: '#000000',
  window: '#ffffff',
  btnFace: '#f0f0f0',
  btnText: '#000000',
  btnShadow: '#a0a0a0',
  btnHighlight: '#ffffff',
  grayText: '#6d6d6d',
  highlight: '#0078d7',
  highlightText: '#ffffff',
  menu: '#f0f0f0',
  menuText: '#000000',
  captionText: '#000000',
  infoBk: '#ffffe1',
  infoText: '#000000'
}

/** Common preset colour names (`a:prstClr`), PowerPoint's short `dk` and `lt` spellings included. */
const PRESETS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  darkGray: '#a9a9a9',
  dkGray: '#a9a9a9',
  lightGray: '#d3d3d3',
  ltGray: '#d3d3d3',
  silver: '#c0c0c0',
  orange: '#ffa500',
  purple: '#800080',
  brown: '#a52a2a',
  pink: '#ffc0cb',
  navy: '#000080',
  teal: '#008080',
  maroon: '#800000',
  olive: '#808000',
  lime: '#00ff00',
  gold: '#ffd700',
  darkBlue: '#00008b',
  dkBlue: '#00008b',
  darkRed: '#8b0000',
  dkRed: '#8b0000',
  darkGreen: '#006400',
  dkGreen: '#006400',
  lightBlue: '#add8e6',
  ltBlue: '#add8e6',
  skyBlue: '#87ceeb',
  indigo: '#4b0082',
  violet: '#ee82ee',
  coral: '#ff7f50',
  salmon: '#fa8072',
  crimson: '#dc143c',
  tomato: '#ff6347',
  tan: '#d2b48c',
  beige: '#f5f5dc',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  turquoise: '#40e0d0',
  chocolate: '#d2691e'
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value))

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)

  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

const rgbToHex = (rgb: Rgb): `#${string}` => `#${rgb.map((channel) => Math.round(clamp(channel) * 255).toString(16).padStart(2, '0')).join('')}`

const toLinear = (channel: number): number => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)

const toGamma = (channel: number): number => (channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055)

function toHsl([r, g, b]: Rgb): Hsl {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min

  if (!d) {
    return [0, 0, l]
  }

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4

  return [h * 60, s, l]
}

function fromHsl([h, s, l]: Hsl): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360
  const sat = clamp(s)
  const lum = clamp(l)

  if (!sat) {
    return [lum, lum, lum]
  }

  const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat
  const p = 2 * lum - q
  const channel = (offset: number): number => {
    const t = (((hue + offset) % 1) + 1) % 1

    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
  }

  return [channel(1 / 3), channel(0), channel(-1 / 3)]
}

const inHsl = (rgb: Rgb, change: (hsl: Hsl) => Hsl): Rgb => fromHsl(change(toHsl(rgb)))

/** A change made to linear light (as PowerPoint mixes tints and shades), back in sRGB. */
const inLinear = (rgb: Rgb, change: (linear: Rgb) => Rgb): Rgb => change(rgb.map(toLinear) as Rgb).map((channel) => toGamma(clamp(channel))) as Rgb

const grey = (level: number): Rgb => [level, level, level]

/** Modifiers that change the colour itself, given `val` as a fraction (100000 is 1) and as written. */
const MODIFIERS: Record<string, (rgb: Rgb, value: number, raw: number) => Rgb> = {
  'a:lumMod': (rgb, value) => inHsl(rgb, ([h, s, l]) => [h, s, l * value]),
  'a:lumOff': (rgb, value) => inHsl(rgb, ([h, s, l]) => [h, s, l + value]),
  'a:lum': (rgb, value) => inHsl(rgb, ([h, s]) => [h, s, value]),
  'a:satMod': (rgb, value) => inHsl(rgb, ([h, s, l]) => [h, s * value, l]),
  'a:satOff': (rgb, value) => inHsl(rgb, ([h, s, l]) => [h, s + value, l]),
  'a:sat': (rgb, value) => inHsl(rgb, ([h, , l]) => [h, value, l]),
  'a:hueMod': (rgb, value) => inHsl(rgb, ([h, s, l]) => [h * value, s, l]),
  'a:hueOff': (rgb, _value, raw) => inHsl(rgb, ([h, s, l]) => [h + raw / 60000, s, l]),
  'a:hue': (rgb, _value, raw) => inHsl(rgb, ([, s, l]) => [raw / 60000, s, l]),
  'a:comp': (rgb) => inHsl(rgb, ([h, s, l]) => [h + 180, s, l]),
  'a:inv': (rgb) => rgb.map((channel) => 1 - channel) as Rgb,
  'a:gray': ([r, g, b]) => grey(0.3 * r + 0.59 * g + 0.11 * b),
  'a:tint': (rgb, value) => inLinear(rgb, (linear) => linear.map((channel) => channel * value + 1 - value) as Rgb),
  'a:shade': (rgb, value) => inLinear(rgb, (linear) => linear.map((channel) => channel * value) as Rgb),
  'a:red': (rgb, value) => inLinear(rgb, ([, g, b]) => [value, g, b]),
  'a:redMod': (rgb, value) => inLinear(rgb, ([r, g, b]) => [r * value, g, b]),
  'a:redOff': (rgb, value) => inLinear(rgb, ([r, g, b]) => [r + value, g, b]),
  'a:green': (rgb, value) => inLinear(rgb, ([r, , b]) => [r, value, b]),
  'a:greenMod': (rgb, value) => inLinear(rgb, ([r, g, b]) => [r, g * value, b]),
  'a:greenOff': (rgb, value) => inLinear(rgb, ([r, g, b]) => [r, g + value, b]),
  'a:blue': (rgb, value) => inLinear(rgb, ([r, g]) => [r, g, value]),
  'a:blueMod': (rgb, value) => inLinear(rgb, ([r, g, b]) => [r, g, b * value]),
  'a:blueOff': (rgb, value) => inLinear(rgb, ([r, g, b]) => [r, g, b + value])
}

const ALPHAS: Record<string, (alpha: number, value: number) => number> = {
  'a:alpha': (_alpha, value) => value,
  'a:alphaMod': (alpha, value) => alpha * value,
  'a:alphaOff': (alpha, value) => alpha + value
}

/** Whether an element is a colour (`a:srgbClr`, `a:schemeClr`…). */
export const isColorElement = (element: XmlElement): boolean => COLOR_ELEMENTS.has(element.name)

/** The deck theme slot that shows a scheme colour, when these colours are the deck theme's. */
function slotOf(name: string, palette: Palette): Slot | null {
  const slots = palette.slots

  return slots ? (SLOTS.find((slot) => slots[slot] === name) ?? null) : null
}

const hexOf = (color: Color, palette: Palette): string => (isSlot(color) ? (palette.scheme[palette.slots?.[color] ?? ''] ?? '#000000') : color)

function literalOf(element: XmlElement, val: string): string | null {
  if (element.name === 'a:srgbClr') {
    return normalHex(val)
  }

  if (element.name === 'a:sysClr') {
    return normalHex(attr(element, 'lastClr')) ?? SYSTEM[val] ?? null
  }

  if (element.name === 'a:prstClr') {
    return PRESETS[val] ?? null
  }

  if (element.name === 'a:scrgbClr') {
    // scRGB is linear light.
    return rgbToHex(['r', 'g', 'b'].map((name) => toGamma(clamp(numberAttr(element, name, 0) / 100000))) as Rgb)
  }

  if (element.name === 'a:hslClr') {
    return rgbToHex(fromHsl([numberAttr(element, 'hue', 0) / 60000, numberAttr(element, 'sat', 0) / 100000, numberAttr(element, 'lum', 0) / 100000]))
  }

  return null
}

/** The colour an element names before its modifiers: its `#rrggbb`, and the slot it is when it is a theme colour. */
function baseOf(element: XmlElement, palette: Palette, placeholder: Paint | null): { hex: string; slot: Slot | null; alpha: number } | null {
  const val = attr(element, 'val') ?? ''

  if (element.name !== 'a:schemeClr') {
    const hex = literalOf(element, val)

    return hex ? { hex, slot: null, alpha: 1 } : null
  }

  if (val === 'phClr') {
    return placeholder ? { hex: hexOf(placeholder.color, palette), slot: isSlot(placeholder.color) ? placeholder.color : null, alpha: placeholder.alpha } : null
  }

  // bg1, tx1… go through the colour map; dk1, lt1… name scheme colours directly.
  const name = palette.map[val] ?? val
  const hex = palette.scheme[name]

  return hex ? { hex, slot: val === 'hlink' || val === 'folHlink' ? null : slotOf(name, palette), alpha: 1 } : null
}

/**
 * A colour element with its modifiers applied, in document order; null when it names no colour.
 * `placeholder` is what `phClr` stands for: the colour of the style reference being resolved.
 */
export function readColor(element: XmlElement, palette: Palette, placeholder: Paint | null = null): Paint | null {
  const base = baseOf(element, palette, placeholder)

  if (!base) {
    return null
  }

  let rgb = hexToRgb(base.hex)
  let alpha = base.alpha

  for (const modifier of elements(element)) {
    const raw = numberAttr(modifier, 'val', 0)
    const change = MODIFIERS[modifier.name]
    const fade = ALPHAS[modifier.name]

    if (change) {
      rgb = change(rgb, raw / 100000, raw)
    } else if (fade) {
      alpha = fade(alpha, raw / 100000)
    }
  }

  const hex = rgbToHex(rgb)

  return { color: base.slot && hex === base.hex ? base.slot : hex, alpha: clamp(alpha) }
}

/** The colour inside an element that holds one (a fill, a gradient stop, a style reference…). */
export function colorIn(parent: XmlElement | undefined, palette: Palette, placeholder: Paint | null = null): Paint | null {
  const element = elements(parent).find(isColorElement)

  return element ? readColor(element, palette, placeholder) : null
}

/** A scheme colour by name (`tx1`, `accent2`…), as `a:schemeClr` would give it. */
export const themeColor = (name: string, palette: Palette): Paint | null => readColor({ name: 'a:schemeClr', attrs: { val: name }, children: [] }, palette)

/** A theme's colour scheme (`a:clrScheme`) as `#rrggbb` by scheme name, the Office theme's where it says nothing. */
export function readScheme(scheme: XmlElement | undefined): Record<string, string> {
  const out = { ...OFFICE_SCHEME }
  const literal: Palette = { scheme: OFFICE_SCHEME, map: STANDARD_MAP, slots: null }

  for (const entry of elements(scheme)) {
    const name = entry.name.replace(/^a:/, '')
    const paint = colorIn(entry, literal)

    if (paint && name in OFFICE_SCHEME) {
      out[name] = paint.color
    }
  }

  return out
}

/** A colour map (`p:clrMap`, `a:overrideClrMapping`) laid over `base`. */
export function readColorMap(element: XmlElement | undefined, base: Record<string, string> = STANDARD_MAP): Record<string, string> {
  const map = { ...base }

  for (const key of Object.keys(STANDARD_MAP)) {
    const value = attr(element, key)

    if (value && value in OFFICE_SCHEME) {
      map[key] = value
    }
  }

  return map
}
