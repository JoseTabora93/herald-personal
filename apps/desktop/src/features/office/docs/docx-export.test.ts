import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { dataUrl, type DocJSON, type DocMark, type DocNode, looksOf, parseDataUrl, STYLE_NAMES } from '../../../../shared/office/document.ts'
import { png } from '../../../../shared/office/docx/fixtures.ts'
import { resolveTarget } from '../../../../shared/office/docx/package.ts'
import { documentFromDocx } from '../../../../shared/office/docx/read.ts'
import { docxFromDocument } from '../../../../shared/office/docx/write.ts'
import { attr, child, children, findAll, parseXml, wellFormed } from '../../../../shared/office/docx/xml.ts'
import { docsSchema } from './schema.ts'

const text = (value: string, marks?: DocMark[]): DocNode => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value })
const paragraph = (value?: string, attrs?: Record<string, unknown>): DocNode => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), ...(value ? { content: [text(value)] } : {}) })
const item = (value: string): DocNode => ({ type: 'listItem', content: [paragraph(value)] })
const cell = (value: string, colwidth?: number[]): DocNode => ({ type: 'tableCell', ...(colwidth ? { attrs: { colwidth } } : {}), content: [paragraph(value)] })
const link = (href: string): DocMark => ({ type: 'link', attrs: { href } })
const highlight = (color: string): DocMark => ({ type: 'highlight', attrs: { color } })
const textStyle = (attrs: Record<string, string>): DocMark => ({ type: 'textStyle', attrs })
const image = (src: string, attrs: Record<string, unknown> = {}): DocNode => ({ type: 'image', attrs: { src, ...attrs } })

const normalized = (doc: DocJSON) => docsSchema().nodeFromJSON(doc).toJSON()

/** Each style's look as the editor shows it: its own over Normal's, bold and italic either way. */
const effectiveLooks = (doc: DocJSON) => {
  const looks = looksOf(doc)

  return Object.fromEntries(STYLE_NAMES.map((name) => [name, { bold: false, italic: false, ...looks.normal, ...looks[name] }]))
}

const picture = png(6, 3)

const ROUND_TRIP: DocJSON = {
  type: 'doc',
  attrs: { page: { width: 841.9, height: 595.3, margins: { top: 36, right: 48, bottom: 36, left: 48 } }, styles: { normal: { font: 'Georgia', size: 12 }, heading1: { color: '#1f3864' } } },
  content: [
    paragraph('Quarterly plan', { docStyle: 'title' }),
    paragraph('For the team', { docStyle: 'subtitle' }),
    { type: 'heading', attrs: { level: 1 }, content: [text('Goals')] },
    { type: 'heading', attrs: { level: 3, textAlign: 'center' }, content: [text('Smaller')] },
    {
      type: 'paragraph',
      attrs: { textAlign: 'justify', lineHeight: 1.5, spaceBefore: 12, spaceAfter: 4, indent: 36, firstLine: -18 },
      content: [
        text('Bold', [{ type: 'bold' }]),
        text(' italic', [{ type: 'italic' }]),
        text(' under', [{ type: 'underline' }]),
        text(' struck', [{ type: 'strike' }]),
        text('2', [{ type: 'superscript' }]),
        text('o', [{ type: 'subscript' }]),
        text(' red', [textStyle({ color: '#c00000', fontFamily: 'Verdana', fontSize: '14pt' })]),
        text(' yellow', [highlight('#ffff00')]),
        text(' peach', [highlight('#ffcc99')]),
        text(' a\tb', [{ type: 'code' }]),
        { type: 'hardBreak' },
        text('the site', [link('https://example.com/plan')]),
        text(' and '),
        text('mail', [link('mailto:ada@example.com')])
      ]
    },
    paragraph(),
    { type: 'paragraph', content: [text('Logo '), image(dataUrl(picture, 'image/png'), { alt: 'Company logo', title: 'Logo', width: 60, height: 30 })] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph('Milk'), { type: 'orderedList', attrs: { start: 3 }, content: [item('Third'), item('Fourth')] }] },
        { type: 'listItem', content: [paragraph('Bread'), paragraph('Fresh, from the corner shop'), { type: 'codeBlock', content: [text('buy --bread')] }] }
      ]
    },
    { type: 'orderedList', attrs: { type: 'a' }, content: [item('Alpha'), item('Beta')] },
    { type: 'orderedList', attrs: { start: 7, type: 'I' }, content: [item('Seventh')] },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph('Call Ada')] },
        { type: 'taskItem', content: [paragraph('Book the room'), { type: 'taskList', content: [{ type: 'taskItem', content: [paragraph('Ask for a projector')] }] }] }
      ]
    },
    { type: 'blockquote', content: [paragraph('Ada said so'), paragraph('Twice')] },
    { type: 'codeBlock', content: [text('let a = 1\n\n\tlet b = 2')] },
    { type: 'callout', content: [paragraph('For your information')] },
    { type: 'callout', attrs: { kind: 'error' }, content: [paragraph('Do not do this'), { type: 'bulletList', content: [item('Really')] }] },
    { type: 'pageBreak' },
    { type: 'horizontalRule' },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, colwidth: [100, 150] }, content: [paragraph('Team')] }, { type: 'tableHeader', attrs: { colwidth: [120] }, content: [paragraph('Notes')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { rowspan: 2, colwidth: [100], background: '#e2efda' }, content: [paragraph('Ada')] }, cell('Lead', [150]), cell('First', [120])] },
        { type: 'tableRow', content: [cell('Design', [150]), { type: 'tableCell', attrs: { colwidth: [120] }, content: [{ type: 'table', attrs: { borders: false }, content: [{ type: 'tableRow', content: [cell('Inner', [60])] }] }] }] }
      ]
    },
    paragraph('The end')
  ]
}

async function partsOf(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  const read = async (name: string): Promise<string> => (await zip.file(name)?.async('string')) ?? ''

  return { names, read, xml: async (name: string) => parseXml(await read(name)) }
}

describe('docxFromDocument: round trips', () => {
  it('gives back the same document when the file is opened again', async () => {
    docsSchema().nodeFromJSON(ROUND_TRIP).check()
    const { bytes, losses } = await docxFromDocument(ROUND_TRIP)
    const { doc, notes } = await documentFromDocx(bytes)
    docsSchema().nodeFromJSON(doc).check()

    expect(normalized(doc).content).toEqual(normalized(ROUND_TRIP).content)
    expect(doc.attrs?.page).toEqual(ROUND_TRIP.attrs?.page)
    expect(effectiveLooks(doc)).toEqual(effectiveLooks(ROUND_TRIP))
    expect(losses).toEqual(['Checklists are saved as boxes typed before each item.'])
    expect(notes).toEqual([])
  })

  it('keeps pictures’ bytes and sizes, and fits pictures without a size to the text', async () => {
    const wide = png(1500, 4)
    const a4 = { width: 595.3, height: 841.9, margins: { top: 72, right: 72, bottom: 72, left: 72 } }
    const { bytes } = await docxFromDocument({
      type: 'doc',
      attrs: { page: a4, styles: null },
      content: [{ type: 'paragraph', content: [image(dataUrl(picture, 'image/png'), { width: 90, height: 45 }), image(dataUrl(wide, 'image/png'))] }]
    })
    const { doc } = await documentFromDocx(bytes)
    const [kept, fitted] = doc.content[0].content ?? []

    expect(parseDataUrl(kept.attrs?.src)?.bytes).toEqual(picture)
    expect(kept.attrs).toMatchObject({ width: 90, height: 45 })
    expect(parseDataUrl(fitted.attrs?.src)?.bytes).toEqual(wide)
    expect(fitted.attrs).toMatchObject({ width: 602, height: 2 })
  })

  it('writes an empty document as one empty paragraph', async () => {
    const { bytes, losses } = await docxFromDocument({ type: 'doc', content: [] })
    const { doc } = await documentFromDocx(bytes)

    expect(doc.content).toEqual([paragraph()])
    expect(losses).toEqual([])
  })
})

describe('docxFromDocument: the package', () => {
  it('writes well-formed parts, each named in the content types, and relationships to parts that are there', async () => {
    const { bytes } = await docxFromDocument(ROUND_TRIP)
    const { names, read, xml } = await partsOf(bytes)

    for (const name of names.filter((part) => /\.(xml|rels)$/.test(part))) {
      expect(wellFormed(await read(name)), name).toBe(true)
    }

    const types = await xml('[Content_Types].xml')
    const overrides = children(types, 'Override').map((element) => (attr(element, 'PartName') ?? '').slice(1))
    const extensions = new Set(children(types, 'Default').map((element) => (attr(element, 'Extension') ?? '').toLowerCase()))

    expect(overrides).toContain('word/document.xml')
    expect(names.filter((name) => !overrides.includes(name)).every((name) => name === '[Content_Types].xml' || extensions.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase()))).toBe(true)

    for (const part of overrides) {
      expect(names).toContain(part)
    }

    for (const name of names.filter((part) => part.endsWith('.rels'))) {
      const source = name.replace(/(^|\/)_rels\/([^/]*)\.rels$/, '$1$2')

      for (const relationship of children(await xml(name), 'Relationship').filter((element) => attr(element, 'TargetMode') !== 'External')) {
        expect(names).toContain(resolveTarget(source, attr(relationship, 'Target') ?? ''))
      }
    }

    expect(names.some((name) => name.startsWith('word/media/'))).toBe(true)
  })

  it('writes Word’s heading styles with outline levels, Herald’s other styles, and numbering for each list', async () => {
    const { bytes } = await docxFromDocument(ROUND_TRIP)
    const { xml } = await partsOf(bytes)
    const styles = await xml('word/styles.xml')
    const style = (id: string) => children(styles, 'w:style').find((element) => attr(element, 'w:styleId') === id)

    for (const level of [1, 2, 3, 4, 5, 6]) {
      const heading = style(`Heading${level}`)

      expect(attr(child(heading, 'w:name'), 'w:val')).toBe(`heading ${level}`)
      expect(attr(child(child(heading, 'w:pPr'), 'w:outlineLvl'), 'w:val')).toBe(String(level - 1))
    }

    for (const id of ['Normal', 'Title', 'Subtitle', 'Quote', 'SourceCode', 'HeraldCalloutInfo', 'HeraldCalloutNote', 'HeraldCalloutSuccess', 'HeraldCalloutWarning', 'HeraldCalloutError', 'VerbatimChar', 'Hyperlink']) {
      expect(style(id), id).toBeDefined()
    }

    expect(attr(child(child(style('Heading1'), 'w:rPr'), 'w:color'), 'w:val')).toBe('1F3864')
    expect(attr(child(child(style('Normal'), 'w:rPr'), 'w:rFonts'), 'w:ascii')).toBe('Georgia')

    const numbering = await xml('word/numbering.xml')
    const abstracts = new Map(children(numbering, 'w:abstractNum').map((element) => [attr(element, 'w:abstractNumId'), element]))
    const nums = new Map(children(numbering, 'w:num').map((element) => [attr(element, 'w:numId'), attr(child(element, 'w:abstractNumId'), 'w:val')]))
    const used = [...new Set(findAll(await xml('word/document.xml'), 'w:numId').map((element) => attr(element, 'w:val')))]
    const firstLevel = (numId: string | undefined) => children(abstracts.get(nums.get(numId)), 'w:lvl')[0]

    expect(used).toHaveLength(5)
    expect(used.every((numId) => abstracts.has(nums.get(numId)))).toBe(true)
    expect(used.map((numId) => attr(child(firstLevel(numId), 'w:numFmt'), 'w:val'))).toEqual(['bullet', 'decimal', 'lowerLetter', 'upperRoman', 'bullet'])
    expect(attr(child(firstLevel(used[3]), 'w:start'), 'w:val')).toBe('7')
  })

  it('writes spans as gridSpan and vMerge cells, header rows to repeat, shading, highlights and the page', async () => {
    const { bytes } = await docxFromDocument(ROUND_TRIP)
    const { read } = await partsOf(bytes)
    const document = await read('word/document.xml')

    expect(document).toContain('<w:gridSpan w:val="2"/>')
    expect(document).toContain('<w:vMerge w:val="restart"/>')
    expect(document).toContain('<w:vMerge w:val="continue"/>')
    expect(document).toContain('<w:tblHeader/>')
    expect(document).toContain('<w:shd w:fill="E2EFDA" w:color="auto" w:val="clear"/>')
    expect(document).toContain('<w:highlight w:val="yellow"/>')
    expect(document).toContain('<w:shd w:fill="FFCC99" w:color="auto" w:val="clear"/>')
    expect(document).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>')
    expect(document).toContain('<w:pgMar w:top="720" w:right="960" w:bottom="720" w:left="960"')
    expect(document).not.toMatch(/Un-named/)
  })
})

describe('docxFromDocument: losses', () => {
  it('says what a Word document cannot keep, once each and in order', async () => {
    const lossy: DocJSON = {
      type: 'doc',
      content: [
        { type: 'taskList', content: [{ type: 'taskItem', content: [paragraph('Todo')] }] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('let a = 1')] },
        {
          type: 'paragraph',
          content: [
            image('data:image/svg+xml;base64,PHN2Zy8+'),
            image('data:image/webp;base64,UklGRg=='),
            image('data:image/tiff;base64,SUkqAA=='),
            image('https://example.com/picture.png'),
            text('intro', [link('#intro')]),
            text(' call', [link('tel:+441234567890')])
          ]
        },
        { type: 'table', content: [{ type: 'tableRow', content: [cell('A'), cell('B')] }, { type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('Side')] }, cell('C')] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Item'), { type: 'heading', attrs: { level: 2 }, content: [text('Inside')] }] }] },
        { type: 'callout', content: [paragraph('Note'), { type: 'codeBlock', content: [text('inside')] }] }
      ]
    }
    const { bytes, losses } = await docxFromDocument(lossy)

    expect(losses).toEqual([
      'Checklists are saved as boxes typed before each item.',
      'Code block languages are not saved in Word documents.',
      'SVG and WebP pictures are left out of Word documents.',
      'Pictures in formats other than PNG, JPEG, GIF and BMP are left out of Word documents.',
      'Pictures from the web are left out of Word documents.',
      'Links to places inside the document are saved as plain text.',
      'Links that are not web or email addresses are saved as plain text.',
      'Header cells outside the top rows of a table are saved as ordinary cells.',
      'Headings, tables, quotes and callouts inside list items are saved as ordinary blocks.',
      'Headings, code blocks, tables, quotes and callouts inside a quote or callout are saved as ordinary blocks.'
    ])

    const { doc } = await documentFromDocx(bytes)
    docsSchema().nodeFromJSON(doc).check()

    expect(doc.content[2]).toEqual(paragraph('intro call'))
  })

  it('says nothing for a document a Word file keeps whole', async () => {
    const { losses } = await docxFromDocument({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Goals')] },
        { type: 'bulletList', content: [item('One'), item('Two')] },
        { type: 'paragraph', content: [image(dataUrl(picture, 'image/png')), text('the site', [link('https://example.com')])] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('Name')] }] }, { type: 'tableRow', content: [cell('Ada')] }] }
      ]
    })

    expect(losses).toEqual([])
  })
})
