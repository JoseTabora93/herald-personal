import type JSZip from 'jszip'
import type { Background, Color, Deck, LayoutId, Paragraph, PlaceholderRole, Slide, SlideElement, Stroke, TextBody, Theme } from '../deck.ts'
import { EMU_PER_POINT, LAYOUTS, SLIDE_SIZES } from '../deck.ts'
import { coverCrop, describeElement } from '../elements.ts'
import { LAYOUT_NAMES } from '../layouts.ts'
import { isSlot } from '../themes.ts'
import { bulletFor, numberingFor, paragraphIndent } from '../text.ts'
import { placeholderIndex, placeholderNames, placeholderSlots } from './placeholders.ts'
import { child, childrenNamed, descendants, elements, find, parseXml, serializeXml, xml, type XmlElement, type XmlNode } from './xml.ts'

/*
 * What a PowerPoint file needs after PptxGenJS has written it. PptxGenJS repeats a paragraph's
 * settings before each of its runs, takes a placeholder's position and text box settings from its
 * layout whatever the slide says, cannot write gradients, crops, picture outlines or adjust
 * values, and leaves Office's colours in the theme; so each slide's elements get their paragraph
 * and text box settings, positions and geometry from the deck itself, empty placeholders Herald
 * did not have go, and the theme gets the deck's colours.
 */

const emu = (points: number): string => String(Math.round(points * EMU_PER_POINT))

/** A colour element: a theme slot by name or a literal, with its opacity. */
export function colorXml(color: Color, alpha?: number): XmlElement {
  const opacity = alpha !== undefined && alpha < 1 ? [xml('a:alpha', { val: Math.round(Math.max(0, alpha) * 100000) })] : []

  return isSlot(color) ? xml('a:schemeClr', { val: color }, opacity) : xml('a:srgbClr', { val: color.slice(1).toUpperCase() }, opacity)
}

const solid = (color: Color, alpha?: number): XmlElement => xml('a:solidFill', {}, [colorXml(color, alpha)])

const DASH = { solid: 'solid', dash: 'dash', dot: 'sysDot', dashDot: 'dashDot', longDash: 'lgDash' } as const

function lineXml(stroke: Stroke | null): XmlElement {
  if (!stroke || stroke.width <= 0) {
    return xml('a:ln', {}, [xml('a:noFill')])
  }

  return xml('a:ln', { w: emu(stroke.width) }, [solid(stroke.color, stroke.alpha), xml('a:prstDash', { val: DASH[stroke.dash] })])
}

const ALIGN = { left: 'l', center: 'ctr', right: 'r', justify: 'just' } as const

/** A paragraph's settings as PowerPoint reads them, all spelled out so a layout's defaults never apply. */
export function paragraphXml(paragraph: Paragraph): XmlElement {
  const { margin, indent } = paragraphIndent(paragraph)
  const level = paragraph.level ?? 0
  const points = (name: string, value: number | undefined) => xml(name, {}, [xml('a:spcPts', { val: Math.round((value ?? 0) * 100) })])
  const bullet: XmlNode[] =
    paragraph.list === 'bullet'
      ? [xml('a:buClrTx'), xml('a:buSzTx'), xml('a:buFontTx'), xml('a:buChar', { char: paragraph.bullet || bulletFor(level) })]
      : paragraph.list === 'number'
        ? [xml('a:buClrTx'), xml('a:buSzTx'), xml('a:buFontTx'), xml('a:buAutoNum', { type: paragraph.numbering ?? numberingFor(level), startAt: paragraph.startAt && paragraph.startAt !== 1 ? paragraph.startAt : undefined })]
        : [xml('a:buNone')]

  return xml('a:pPr', { marL: emu(margin), indent: emu(indent), algn: ALIGN[paragraph.align ?? 'left'], lvl: level || undefined }, [
    xml('a:lnSpc', {}, [xml('a:spcPct', { val: Math.round((paragraph.lineSpacing ?? 1) * 100000) })]),
    points('a:spcBef', paragraph.spaceBefore),
    points('a:spcAft', paragraph.spaceAfter),
    ...bullet
  ])
}

/** A text box's settings; `shrink` is the factor its text shrinks to, as last drawn (PowerPoint shows it so until the text is edited). */
export function bodyPropertiesXml(body: TextBody, shrink?: number): XmlElement {
  const [left, top, right, bottom] = body.inset
  const scale = shrink !== undefined && shrink < 1 ? Math.round(shrink * 100000) : undefined
  const fit = body.fit === 'shrink' ? [xml('a:normAutofit', { fontScale: scale })] : body.fit === 'grow' ? [xml('a:spAutoFit')] : []

  return xml('a:bodyPr', { wrap: body.wrap ? 'square' : 'none', lIns: emu(left), tIns: emu(top), rIns: emu(right), bIns: emu(bottom), rtlCol: '0', anchor: body.anchor === 'middle' ? 'ctr' : body.anchor === 'bottom' ? 'b' : 't' }, fit)
}

/** A text body's paragraphs with their own settings, and the body's settings, in place of PptxGenJS's. */
function finishText(txBody: XmlElement, body: TextBody, shrink?: number): void {
  const paragraphs = childrenNamed(txBody, 'a:p')

  txBody.children = txBody.children.map((node) => (typeof node !== 'string' && node.name === 'a:bodyPr' ? bodyPropertiesXml(body, shrink) : node))

  paragraphs.forEach((p, index) => {
    const model = body.paragraphs[Math.min(index, body.paragraphs.length - 1)]
    p.children = [paragraphXml(model), ...p.children.filter((node) => typeof node === 'string' || node.name !== 'a:pPr')]
  })
}

function setTransform(spPr: XmlElement, element: SlideElement): void {
  const attrs: Record<string, string | undefined> = { rot: element.rotation ? String(Math.round(element.rotation * 60000)) : undefined, flipH: element.flipH ? '1' : undefined, flipV: element.flipV ? '1' : undefined }
  const transform = xml('a:xfrm', attrs, [xml('a:off', { x: emu(element.x), y: emu(element.y) }), xml('a:ext', { cx: emu(element.width), cy: emu(element.height) })])
  const at = spPr.children.findIndex((node) => typeof node !== 'string' && node.name === 'a:xfrm')

  if (at >= 0) {
    spPr.children[at] = transform
  } else {
    spPr.children.unshift(transform)
  }
}

/** Put `line` in a shape's properties where the schema wants it: after the geometry and the fill. */
function setLine(spPr: XmlElement, line: XmlElement): void {
  const at = spPr.children.findIndex((node) => typeof node !== 'string' && node.name === 'a:ln')

  if (at >= 0) {
    spPr.children[at] = line

    return
  }

  const after = ['a:xfrm', 'a:custGeom', 'a:prstGeom', 'a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill']
  let index = -1
  spPr.children.forEach((node, position) => {
    if (typeof node !== 'string' && after.includes(node.name)) {
      index = position
    }
  })
  spPr.children.splice(index + 1, 0, line)
}

/** How much a text body's text was shrunk to fit when last drawn, when the window knows. */
export type ShrinkOf = (body: TextBody) => number | undefined

function finishElement(node: XmlElement, element: SlideElement, names: Map<string, number>, shrink?: ShrinkOf): void {
  const nv = child(node, node.name === 'p:pic' ? 'p:nvPicPr' : 'p:nvSpPr')
  const cNvPr = child(nv, 'p:cNvPr')

  // PowerPoint's selection pane shows these names; Herald's ids stay in Herald's own copy.
  if (cNvPr) {
    const base = element.name ?? describeElement(element)
    const n = (names.get(base) ?? 0) + 1
    names.set(base, n)
    cNvPr.attrs.name = element.name ?? `${base} ${n}`
  }

  const spPr = child(node, 'p:spPr')

  if (spPr) {
    setTransform(spPr, element)
  }

  if (element.kind === 'shape' && element.adjust && spPr) {
    const list = find(spPr, 'a:prstGeom/a:avLst')

    if (list) {
      list.children = Object.entries(element.adjust).map(([name, value]) => xml('a:gd', { name, fmla: `val ${Math.round(value)}` }))
    }
  }

  if ((element.kind === 'text' || element.kind === 'shape') && spPr) {
    setLine(spPr, lineXml(element.stroke))
  }

  if (element.kind === 'image') {
    if (spPr && element.stroke) {
      setLine(spPr, lineXml(element.stroke))
    }

    const fill = child(node, 'p:blipFill')

    if (fill && element.crop) {
      const crop = element.crop
      const rect = xml('a:srcRect', { l: Math.round(crop.left * 100000), t: Math.round(crop.top * 100000), r: Math.round(crop.right * 100000), b: Math.round(crop.bottom * 100000) })
      fill.children = fill.children.filter((entry) => typeof entry === 'string' || entry.name !== 'a:srcRect')
      const blip = fill.children.findIndex((entry) => typeof entry !== 'string' && entry.name === 'a:blip')
      fill.children.splice(blip + 1, 0, rect)
    }
  }

  const txBody = child(node, 'p:txBody')

  if (txBody && (element.kind === 'text' || element.kind === 'shape')) {
    finishText(txBody, element.body, shrink?.(element.body))
  }
}

function backgroundXml(background: Background & { kind: 'gradient' }): XmlElement {
  const stops = [...background.stops].sort((a, b) => a.at - b.at).map((stop) => xml('a:gs', { pos: Math.round(stop.at * 100000) }, [colorXml(stop.color)]))
  const angle = (((background.angle % 360) + 360) % 360) * 60000

  return xml('p:bg', {}, [xml('p:bgPr', {}, [xml('a:gradFill', { rotWithShape: '1' }, [xml('a:gsLst', {}, stops), xml('a:lin', { ang: Math.round(angle), scaled: '0' })]), xml('a:effectLst')])])
}

function finishBackground(cSld: XmlElement, slide: Slide, deck: Deck): void {
  const background = slide.background

  if (background?.kind === 'gradient') {
    const at = cSld.children.findIndex((node) => typeof node !== 'string' && node.name === 'p:bg')
    const replacement = backgroundXml(background)

    if (at >= 0) {
      cSld.children[at] = replacement
    } else {
      cSld.children.unshift(replacement)
    }
  } else if (background?.kind === 'image') {
    const rect = find(cSld, 'p:bg/p:bgPr/a:blipFill/a:srcRect')
    const crop = coverCrop(background.natural, deck.size)

    if (rect && crop) {
      rect.attrs = { l: String(Math.round(crop.left * 100000)), t: String(Math.round(crop.top * 100000)), r: String(Math.round(crop.right * 100000)), b: String(Math.round(crop.bottom * 100000)) }
    }
  }
}

function finishSlide(root: XmlElement, slide: Slide, deck: Deck, shrink?: ShrinkOf): void {
  const cSld = child(root, 'p:cSld')
  const tree = child(cSld, 'p:spTree')

  if (!cSld || !tree) {
    return
  }

  const names = new Map<string, number>()
  const byId = new Map(slide.elements.map((element) => [element.id, element]))
  const byIndex = new Map([...placeholderSlots(slide)].map(([id, name]) => [String(placeholderIndex(slide.layout, name)), id]))

  tree.children = tree.children.filter((node) => {
    if (typeof node === 'string' || (node.name !== 'p:sp' && node.name !== 'p:pic')) {
      return true
    }

    const nv = child(node, node.name === 'p:pic' ? 'p:nvPicPr' : 'p:nvSpPr')
    const ph = find(nv, 'p:nvPr/p:ph')
    const id = ph ? byIndex.get(ph.attrs.idx ?? '') : child(nv, 'p:cNvPr')?.attrs.name

    // A layout placeholder PptxGenJS added that the slide does not have.
    if (ph && !id) {
      return false
    }

    const element = id ? byId.get(id) : undefined

    if (element) {
      finishElement(node, element, names, shrink)

      if (ph && element.placeholder) {
        ph.attrs.type = placeholderType(slide.layout, element.placeholder.role, ph.attrs.type)
      }
    }

    return true
  })

  finishBackground(cSld, slide, deck)

  root.children = root.children.filter((node) => typeof node === 'string' || node.name !== 'p:transition')

  if (deck.transition !== 'none') {
    const transition = xml('p:transition', { spd: 'med' }, [deck.transition === 'fade' ? xml('p:fade') : xml('p:push', { dir: 'l' })])
    const timing = root.children.findIndex((node) => typeof node !== 'string' && (node.name === 'p:timing' || node.name === 'p:extLst'))
    root.children.splice(timing < 0 ? root.children.length : timing, 0, transition)
  }
}

/** Speaker notes a paragraph a line (PptxGenJS puts them in one). */
function finishNotes(root: XmlElement, notes: string): void {
  for (const sp of elements(find(root, 'p:cSld/p:spTree')).filter((node) => node.name === 'p:sp')) {
    if (find(sp, 'p:nvSpPr/p:nvPr/p:ph')?.attrs.type !== 'body') {
      continue
    }

    const txBody = child(sp, 'p:txBody')

    if (txBody) {
      const lines = notes.split('\n')
      txBody.children = [
        ...txBody.children.filter((node) => typeof node !== 'string' && (node.name === 'a:bodyPr' || node.name === 'a:lstStyle')),
        ...lines.map((line) => (line ? xml('a:p', {}, [xml('a:r', {}, [xml('a:rPr', { lang: 'en-US', dirty: '0' }), xml('a:t', {}, [line])])]) : xml('a:p', {}, [xml('a:endParaRPr', { lang: 'en-US', dirty: '0' })])))
      ]
    }
  }
}

const SCHEME_ORDER: [string, keyof Theme['colors']][] = [
  ['a:dk1', 'tx1'],
  ['a:lt1', 'bg1'],
  ['a:dk2', 'tx2'],
  ['a:lt2', 'bg2'],
  ['a:accent1', 'accent1'],
  ['a:accent2', 'accent2'],
  ['a:accent3', 'accent3'],
  ['a:accent4', 'accent4'],
  ['a:accent5', 'accent5'],
  ['a:accent6', 'accent6'],
  ['a:hlink', 'accent1'],
  ['a:folHlink', 'accent5']
]

/** The theme's colours and name in place of Office's (its fonts PptxGenJS sets itself). */
function finishTheme(root: XmlElement, theme: Theme): void {
  root.attrs.name = theme.name
  const elementsOf = child(root, 'a:themeElements')
  const scheme = xml(
    'a:clrScheme',
    { name: theme.name },
    SCHEME_ORDER.map(([name, slot]) => xml(name, {}, [xml('a:srgbClr', { val: theme.colors[slot].slice(1).toUpperCase() })]))
  )

  if (elementsOf) {
    elementsOf.children = elementsOf.children.map((node) => (typeof node !== 'string' && node.name === 'a:clrScheme' ? scheme : node))
  }
}

async function rewrite(zip: JSZip, name: string, change: (root: XmlElement) => void): Promise<void> {
  const file = zip.file(name)

  if (!file) {
    return
  }

  const root = parseXml(await file.async('string'), { canonical: false })
  change(root)
  zip.file(name, serializeXml(root))
}

/** PresentationML's name for each layout, which tells other apps (and readers) what the layout is for. */
const LAYOUT_TYPES: Record<LayoutId, string> = {
  title: 'title',
  'title-content': 'obj',
  'two-content': 'twoObj',
  section: 'secHead',
  'title-only': 'titleOnly',
  blank: 'blank',
  'picture-caption': 'picTx',
  comparison: 'twoTxTwoObj'
}

/** A title slide's placeholders are a centred title and a subtitle, as PowerPoint's own are; PptxGenJS knows only titles and bodies. */
function placeholderType(layout: LayoutId, role: PlaceholderRole, written: string | undefined): string {
  if (layout === 'title' && role === 'title') {
    return 'ctrTitle'
  }

  if (layout === 'title' && role === 'subtitle') {
    return 'subTitle'
  }

  return written ?? 'body'
}

/** Finish a PowerPoint file PptxGenJS wrote for `deck`. */
export async function finishPresentation(zip: JSZip, deck: Deck, shrink?: ShrinkOf): Promise<void> {
  const byName = new Map(LAYOUTS.map((layout) => [LAYOUT_NAMES[layout], layout]))

  for (const name of Object.keys(zip.files).filter((entry) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(entry))) {
    await rewrite(zip, name, (root) => {
      const layout = byName.get(child(root, 'p:cSld')?.attrs.name ?? '')

      if (!layout) {
        return
      }

      root.attrs.type = LAYOUT_TYPES[layout]
      const roles = new Map(placeholderNames(layout).map((entry) => [String(placeholderIndex(layout, entry.name)), entry.role]))

      for (const ph of descendants(find(root, 'p:cSld/p:spTree'), 'p:ph')) {
        const role = roles.get(ph.attrs.idx ?? '')

        if (role) {
          ph.attrs.type = placeholderType(layout, role, ph.attrs.type)
        }
      }
    })
  }

  for (const [index, slide] of deck.slides.entries()) {
    await rewrite(zip, `ppt/slides/slide${index + 1}.xml`, (root) => finishSlide(root, slide, deck, shrink))

    if (slide.notes) {
      await rewrite(zip, `ppt/notesSlides/notesSlide${index + 1}.xml`, (root) => finishNotes(root, slide.notes))
    }
  }

  await rewrite(zip, 'ppt/theme/theme1.xml', (root) => finishTheme(root, deck.theme))

  const app = zip.file('docProps/app.xml')

  if (app) {
    const format = deck.size.width === SLIDE_SIZES.standard.width && deck.size.height === SLIDE_SIZES.standard.height ? 'On-screen Show (4:3)' : deck.size.width / deck.size.height === 16 / 9 ? 'On-screen Show (16:9)' : 'Custom'
    zip.file('docProps/app.xml', (await app.async('string')).replace(/<PresentationFormat>[^<]*<\/PresentationFormat>/, `<PresentationFormat>${format}</PresentationFormat>`))
  }
}
