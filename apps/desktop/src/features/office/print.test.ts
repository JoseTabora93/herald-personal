import { describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../shared/office/doc-text.ts'
import { newSheet, newWorkbook } from '../../../shared/office/workbook.ts'
import { printHtml as printDocument } from './docs/adapter.ts'
import { decodeText, escapeHtml } from './print.ts'
import { printHtml as printSheet } from './sheets/adapter.ts'

const body = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? ''

describe('print views', () => {
  it('prints a document with real nested lists, its styles and escaped text', () => {
    const { document } = documentFromMarkdown('# Plan <A&B>\n\n- one\n  - two\n1. first\n\nA **bold** move.\n')

    expect(body(printDocument(document, 'Plan'))).toBe('<div class="doc"><h1>Plan &lt;A&amp;B&gt;</h1><ul><li><p>one</p><ul><li><p>two</p></li></ul></li></ul><ol><li><p>first</p></li></ol><p>A <strong>bold</strong> move.</p></div>')
  })

  it('prints the sheet in front as a table, numbers to the right, wide ones on a landscape page', () => {
    const sheet = newSheet('s', 'Costs', { 0: { 0: { v: 'Rent' }, 1: { v: 1200 } }, 1: { 0: { v: '<b>' }, 9: { v: 'far' } } })
    const workbook = { ...newWorkbook('b', 'Book', [newSheet('t', 'Other', { 0: { 0: { v: 'not this one' } } }), sheet]), activeSheetId: 's' }
    const { html, landscape } = printSheet(workbook, 'Book')

    expect(html).toContain('<h1>Costs</h1>')
    expect(html).toContain('<td>Rent</td><td class="n">1200</td>')
    expect(html).toContain('<td>&lt;b&gt;</td>')
    expect(html).not.toContain('not this one')
    expect(landscape).toBe(true)
  })
})

describe('decodeText and escapeHtml', () => {
  it('reads UTF-8, and an older Windows-1252 file with a note', () => {
    expect(decodeText(new TextEncoder().encode('café'))).toEqual({ text: 'café', notes: [] })
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9])).text).toBe('café')
    expect(decodeText(new Uint8Array([0xe9])).notes).toHaveLength(1)
    expect(escapeHtml('"<&>"')).toBe('&quot;&lt;&amp;&gt;&quot;')
  })
})
