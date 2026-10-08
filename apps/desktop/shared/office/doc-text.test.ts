import { describe, expect, it } from 'vitest'
import { documentFromMarkdown, documentFromText, markdownFromDocument, textFromDocument } from './doc-text.ts'
import { type DocJSON, type DocNode, dataUrl, paragraphNode, textNode, textOf } from './document.ts'

const doc = (...content: DocNode[]): DocJSON => ({ type: 'doc', attrs: { page: null, styles: null }, content })
const blocks = (markdown: string) => documentFromMarkdown(markdown).document.content

/** A 2 by 1 PNG, enough for its size to be read. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0])

describe('plain text', () => {
  it('round-trips lines, empty ones included, with the line endings and BOM of the file', () => {
    const input = '\uFEFFDear Jo,\r\n\r\nSee you\tsoon.\r\n'
    const { document, layout } = documentFromText(input)

    expect(document.content.map(textOf)).toEqual(['Dear Jo,', '', 'See you\tsoon.'])
    expect(textFromDocument(document, layout)).toEqual({ text: input, losses: [] })
  })

  it('writes tables as tab-separated rows and says what plain text does not keep', () => {
    const table: DocNode = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraphNode([textNode('a')])] }, { type: 'tableCell', content: [paragraphNode([textNode('b')])] }] }] }
    const picture = paragraphNode([{ type: 'image', attrs: { src: 'data:image/png;base64,AA==' } }])

    expect(textFromDocument(doc({ type: 'heading', attrs: { level: 1 }, content: [textNode('Plan')] }, table, picture))).toEqual({
      text: 'Plan\na\tb\n\n',
      losses: ['Formatting (headings, lists, bold, italic and fonts) is not saved in plain text.', 'Pictures are not saved in plain text.']
    })
  })
})

describe('Markdown: reading', () => {
  it('reads headings, emphasis, lists, code blocks with their language, and joins broken lines', () => {
    const { document, notes } = documentFromMarkdown('# Plan\n\nWe **ship** on\nFriday.\n\n- one\n  - two\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] to do\n\n```ts\nconst a = 1\n```\n')
    const [heading, paragraph, bullets, numbers, tasks, code] = document.content

    expect(heading).toEqual({ type: 'heading', attrs: { level: 1 }, content: [textNode('Plan')] })
    expect(paragraph).toEqual(paragraphNode([textNode('We '), textNode('ship', [{ type: 'bold' }]), textNode(' on Friday.')]))
    expect(bullets.type).toBe('bulletList')
    expect(bullets.content?.[0].content?.[1].type).toBe('bulletList')
    expect(numbers).toMatchObject({ type: 'orderedList', attrs: { start: 3 } })
    expect(tasks.content?.map((item) => [item.type, item.attrs?.checked, textOf(item)])).toEqual([
      ['taskItem', true, 'done'],
      ['taskItem', false, 'to do']
    ])
    expect(code).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [textNode('const a = 1')] })
    expect(notes).toEqual(['Lines of a paragraph that were broken in the file are joined.'])
  })

  it('reads links, pictures, tables with alignment, quotes, rules, alerts and page breaks', () => {
    const [links, table, quote, rule, callout, pageBreak] = blocks(
      'See [the site](https://example.com "Home") and ![a cat](https://example.com/cat.png).\n\n| Name | Cost |\n| :--- | ---: |\n| Rent | 1200 |\n\n> quoted\n\n---\n\n> [!WARNING]\n> Mind the gap.\n\n<div data-page-break></div>\n'
    )

    expect(links.content?.[1]).toEqual(textNode('the site', [{ type: 'link', attrs: { href: 'https://example.com', title: 'Home' } }]))
    expect(links.content?.[3]).toEqual({ type: 'image', attrs: { src: 'https://example.com/cat.png', alt: 'a cat' } })
    expect(table.content?.map((row) => row.content?.map((cell) => [cell.type, cell.attrs?.align, textOf(cell)]))).toEqual([
      [
        ['tableHeader', 'left', 'Name'],
        ['tableHeader', 'right', 'Cost']
      ],
      [
        ['tableCell', 'left', 'Rent'],
        ['tableCell', 'right', '1200']
      ]
    ])
    expect(quote).toEqual({ type: 'blockquote', content: [paragraphNode([textNode('quoted')])] })
    expect(rule).toEqual({ type: 'horizontalRule' })
    expect(callout).toEqual({ type: 'callout', attrs: { kind: 'warning' }, content: [paragraphNode([textNode('Mind the gap.')])] })
    expect(pageBreak).toEqual({ type: 'pageBreak' })
  })

  it('turns underline, superscript, subscript and highlight tags into formatting', () => {
    const [paragraph] = blocks('H<sub>2</sub>O, x<sup>2</sup>, <u>under</u> and <mark>marked</mark><br>next\n')

    expect(paragraph.content).toEqual([
      textNode('H'),
      textNode('2', [{ type: 'subscript' }]),
      textNode('O, x'),
      textNode('2', [{ type: 'superscript' }]),
      textNode(', '),
      textNode('under', [{ type: 'underline' }]),
      textNode(' and '),
      textNode('marked', [{ type: 'highlight' }]),
      { type: 'hardBreak' },
      textNode('next')
    ])
  })

  it('keeps code inside a link, and says what it shows differently', () => {
    const { document, notes } = documentFromMarkdown('Run [`npm test`][run] or see<span>this</span>.\n\n[run]: https://example.com/run\n\n![map](images/map.png)\n\nA note.[^1]\n\n[^1]: The note.\n')

    expect(document.content[0].content?.[1]).toEqual(textNode('npm test', [{ type: 'link', attrs: { href: 'https://example.com/run' } }, { type: 'code' }]))
    expect(notes).toEqual(['HTML in the file is shown as its source.', 'Reference-style links are saved as inline links.', 'Footnotes are shown as their Markdown text.', 'Pictures stored beside the file are not shown yet; saving keeps their links.'])
  })
})

describe('Markdown: writing', () => {
  it('writes the same Markdown back', () => {
    const input = [
      '# Plan',
      '',
      'We **ship** *soon*, `npm run build`, ~~never~~ and [**the site**](https://example.com).',
      '',
      '- one',
      '  - two',
      '- three',
      '',
      '1. first',
      '2. second',
      '',
      '- [x] done',
      '- [ ] to do',
      '',
      '5. fifth',
      '',
      '| a  |  b |',
      '| :- | -: |',
      '| 1  |  2 |',
      '',
      '> quoted',
      '',
      '> [!TIP]',
      '> Save often.',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      '---',
      '',
      'H<sub>2</sub>O and <u>this</u>.\\',
      'A new line with ![a picture](https://example.com/a.png "A").',
      '',
      '<div data-page-break></div>',
      '',
      '<details><summary>More</summary>',
      '</details>',
      ''
    ].join('\n')
    const { document, layout, notes } = documentFromMarkdown(input)

    expect(notes).toEqual(['HTML in the file is shown as its source.'])
    expect(markdownFromDocument(document, layout)).toEqual({ text: input, losses: [] })
  })

  it('keeps the line endings and BOM, and writes nothing for an empty document', () => {
    const { document, layout } = documentFromMarkdown('\uFEFF# A\r\n\r\nB\r\n')

    expect(markdownFromDocument(document, layout).text).toBe('\uFEFF# A\r\n\r\nB\r\n')
    expect(markdownFromDocument(doc(paragraphNode())).text).toBe('')
  })

  it('writes callouts as alerts and leaves spaces outside emphasis', () => {
    const callout: DocNode = { type: 'callout', attrs: { kind: 'error' }, content: [paragraphNode([textNode('Stop '), textNode(' here ', [{ type: 'bold' }]), textNode('now.')])] }

    expect(markdownFromDocument(doc(callout)).text).toBe('> [!CAUTION]\n> Stop  **here** now.\n')
  })

  it('lists what Markdown cannot hold', () => {
    const merged: DocNode = {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2, background: '#eeeeee' }, content: [paragraphNode([textNode('wide')]), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraphNode([textNode('item')])] }] }] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraphNode([textNode('a')])] }, { type: 'tableCell', content: [paragraphNode([textNode('b')])] }] }
      ]
    }
    const document: DocJSON = {
      type: 'doc',
      attrs: { page: null, styles: { normal: { font: 'Georgia' } } },
      content: [
        paragraphNode([textNode('Title')], { docStyle: 'title' }),
        paragraphNode([textNode('Red', [{ type: 'textStyle', attrs: { color: '#ff0000' } }])], { textAlign: 'center' }),
        { type: 'orderedList', attrs: { type: 'a' }, content: [{ type: 'listItem', content: [paragraphNode([textNode('x')])] }] },
        merged,
        paragraphNode([{ type: 'image', attrs: { src: dataUrl(PNG, 'image/png'), width: 40, height: 20 } }])
      ]
    }
    const { text, losses } = markdownFromDocument(document)

    expect(text).toBe(`# Title\n\nRed\n\n1. x\n\n| wide<br>item |   |\n| ------------ | - |\n| a            | b |\n\n![](${dataUrl(PNG, 'image/png')})\n`)
    expect(losses).toEqual([
      'Titles and subtitles are saved as headings in Markdown.',
      'Font sizes, colours and other fonts are not saved in Markdown.',
      'Paragraph alignment, indents and spacing are not saved in Markdown.',
      "The document's own fonts and heading styles are not saved in Markdown.",
      'Lettered and Roman numbered lists are saved as numbers in Markdown.',
      'Merged table cells are split in Markdown.',
      'The first row of each table is saved as its header row.',
      'Lists, code and other blocks inside table cells are saved as plain text in Markdown.',
      'Table borders and cell shading are not saved in Markdown.',
      'Pictures are saved inside the Markdown file as data, which some Markdown viewers do not show.',
      'Picture sizes are not saved in Markdown.'
    ])
  })
})
