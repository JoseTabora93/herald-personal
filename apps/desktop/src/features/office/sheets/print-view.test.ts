import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { formatterFor, printHtml } from './adapter.ts'

const body = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? ''

function report(): WorkbookSnapshot {
  const sheet = newSheet('s', 'Report', {
    0: { 0: { v: 'Quarterly report', s: 'title' } },
    1: { 0: { v: 'Rent', t: CELL_TYPE.string }, 1: { v: 1200.5, t: CELL_TYPE.number, s: 'money' }, 2: { v: 'secret' } },
    2: { 0: { v: 'Paid on', t: CELL_TYPE.string }, 1: { v: 46303, t: CELL_TYPE.number, s: 'date' } },
    3: { 0: { v: 'hidden row' } },
    4: { 0: { v: 'Done', t: CELL_TYPE.string }, 1: { v: 1, t: CELL_TYPE.boolean } }
  })
  sheet.mergeData = [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 2 }]
  sheet.rowData = { 0: { h: 32 }, 3: { hd: 1 } }
  sheet.columnData = { 0: { w: 120 }, 2: { hd: 1 } }

  return {
    ...newWorkbook('b', 'Book', [sheet]),
    styles: { title: { bl: 1, fs: 14, bg: { rgb: '#dbe5f1' }, ht: 2, bd: { b: { s: 8, cl: { rgb: '#1f497d' } } } }, money: { n: { pattern: '#,##0.00' } }, date: { n: { pattern: 'yyyy-mm-dd' } } }
  }
}

describe('the print view', () => {
  it('shows numbers as the sheet does, with Univer’s formatter', () => {
    const format = formatterFor(report())

    expect(format(1200.5, '#,##0.00')).toBe('1,200.50')
    expect(format(46303, 'yyyy-mm-dd')).toBe('2026-10-08')
    expect(formatterFor({ ...report(), dateSystem: 'date1904' })(44841, 'yyyy-mm-dd')).toBe('2026-10-08')
  })

  it('prints styles, merged cells and sizes, and leaves hidden rows and columns out', () => {
    const html = body(printHtml(report(), 'Book').html)

    expect(html).toContain('<td colspan="2" style="font-size:14pt;font-weight:bold;background:#dbe5f1;border-bottom:2px solid #1f497d;text-align:center">Quarterly report</td>')
    expect(html).toContain('<tr style="height:32px">')
    expect(html).toContain('<td class="n">1,200.50</td>')
    expect(html).toContain('<td class="n">2026-10-08</td>')
    expect(html).toContain('<td>TRUE</td>')
    expect(html).not.toContain('secret')
    expect(html).not.toContain('hidden row')
    expect(html).toContain('<col style="width:120px"><col style="width:88px">')
  })

  it('turns the page for a wide sheet, in the page’s own CSS', () => {
    const narrow = printHtml(report(), 'Book')
    const wide = report()
    wide.sheets.s.columnData = { 1: { w: 900 } }

    expect(narrow.landscape).toBe(false)
    expect(narrow.html).toContain('@page { size: A4 portrait;')
    expect(printHtml(wide, 'Book')).toMatchObject({ landscape: true, html: expect.stringContaining('@page { size: A4 landscape;') })
  })

  it('prints on the paper and the way round the sheet’s page setup says', () => {
    const letter = report()
    letter.sheets.s.custom = { herald: { page: { pageSetup: { orientation: 'landscape', paperSize: 1 } } } }
    const unknown = report()
    unknown.sheets.s.custom = { herald: { page: { pageSetup: { paperSize: 70 } } } }

    expect(printHtml(letter, 'Book')).toMatchObject({ landscape: true, html: expect.stringContaining('@page { size: letter landscape;') })
    expect(printHtml(unknown, 'Book')).toMatchObject({ landscape: false, html: expect.stringContaining('@page { size: A4 portrait;') })
  })

  it('prints a sheet whose cells have a key that is not a row, as Univer can leave one', () => {
    const workbook = report()
    Object.assign(workbook.sheets.s.cellData, { NaN: { 9: { v: 'stray' } } })

    expect(body(printHtml(workbook, 'Book').html)).toContain('<td>Rent</td>')
  })
})
