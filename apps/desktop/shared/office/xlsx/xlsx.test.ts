import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook, type WorkbookSnapshot } from '../workbook.ts'
import { featureWorkbook, handmadePackage, normalized } from './fixtures.ts'
import { workbookFromXlsx } from './read.ts'
import { readResource, RESOURCES } from './rules.ts'
import { excelSheetNames, xlsxFromWorkbook } from './write.ts'

type Json = Record<string, unknown>

const sheetNamed = (workbook: WorkbookSnapshot, name: string) => Object.values(workbook.sheets).find((sheet) => sheet.name === name)!

async function roundTrip(bytes: Uint8Array) {
  const first = await workbookFromXlsx(bytes, { id: 'book', name: 'Book' })
  const written = await xlsxFromWorkbook(first.workbook)
  const second = await workbookFromXlsx(written.bytes, { id: 'book', name: 'Book' })

  return { first, written, second }
}

const partOf = async (bytes: Uint8Array, path: string) => (await JSZip.loadAsync(bytes)).file(path)?.async('string') ?? ''

describe('xlsx import', () => {
  it('reads values, formulas and their last results', async () => {
    const { workbook } = await workbookFromXlsx(await featureWorkbook(), { id: 'book', name: 'Features' })
    const cells = sheetNamed(workbook, 'Data').cellData

    expect(cells[1][0]).toEqual({ v: 'Rent', t: CELL_TYPE.string })
    expect(cells[2][0]).toEqual({ v: '007', t: CELL_TYPE.text })
    expect(cells[2][1]).toEqual({ v: 1, t: CELL_TYPE.boolean })
    expect(cells[3][0].v).toBeCloseTo(46303.520833, 5)
    expect(cells[3][1]).toEqual({ v: '#DIV/0!', t: CELL_TYPE.string })
    expect(cells[5][0]).toEqual({ f: '=B2*2', v: 2401, t: CELL_TYPE.number })
    expect(cells[5][2].f).toBe('=XLOOKUP(A2,A2:A3,B2:B3)')
    expect(cells[6][0]).toEqual({ f: '=B7+1', si: 'sheet-1!A7', v: 2402, t: CELL_TYPE.number })
    expect(cells[7][0]).toEqual({ si: 'sheet-1!A7', v: 3, t: CELL_TYPE.number })
    // An array formula is worked out again; its other cells wait for it.
    expect(cells[6][1]).toEqual({ f: '=B2:B3*2', ft: 2, ref: 'B7:B8' })
    expect(cells[7][1]).toBeUndefined()
  })

  it('reads styles: fonts, theme fills, number formats, borders and alignment', async () => {
    const { workbook, notes } = await workbookFromXlsx(await featureWorkbook(), { id: 'book', name: 'Features' })
    const sheet = sheetNamed(workbook, 'Data')
    const style = (row: number, column: number) => workbook.styles[sheet.cellData[row][column].s as string] as Json

    expect(workbook.defaultStyle).toEqual({ ff: 'Calibri', fs: 11 })
    expect(style(0, 0)).toEqual({ ff: 'Arial', fs: 14, bl: 1, cl: { rgb: '#ffffff' }, bg: { rgb: '#95b3d7' } })
    expect(style(1, 1)).toEqual({ n: { pattern: '#,##0.00' } })
    expect(style(1, 4)).toEqual({ ff: 'Georgia', fs: 9, ul: { s: 1, t: 10 }, st: { s: 1 }, cl: { rgb: '#c0504d' } })
    expect(style(2, 4)).toEqual({ bg: { rgb: '#404040' } })
    expect(style(3, 4)).toEqual({ bd: { t: { s: 1, cl: { rgb: '#ff0000' } }, r: { s: 13, cl: { rgb: '#000000' } }, b: { s: 7, cl: { rgb: '#0000ff' } }, l: { s: 4, cl: { rgb: '#000000' } } } })
    expect(style(4, 4)).toEqual({ bd: { bl_tr: { s: 1, cl: { rgb: '#00ff00' } } } })
    expect(style(3, 3)).toEqual({ ht: 2, vt: 1, tb: 3 })
    expect(style(4, 3)).toEqual({ pd: { l: 20 } })
    expect([style(5, 3), style(6, 3), style(7, 3)]).toEqual([{ tr: { a: -45 } }, { tr: { a: 90 } }, { tr: { a: 0, v: 1 } }])
    expect(style(1, 6)).toEqual({ va: 3 })
    expect(style(2, 6)).toEqual({ stf: 1 })
    expect(notes).toContain('Patterned cell fills are shown as solid colours.')
  })

  it('reads the layout: sizes, hidden rows and columns, merges, freezing and the sheets', async () => {
    const { workbook } = await workbookFromXlsx(await featureWorkbook(), { id: 'book', name: 'Features' })
    const sheet = sheetNamed(workbook, 'Data')

    expect(sheet.columnData).toMatchObject({ 0: { w: 140 }, 1: { w: 84 }, 2: { w: 64, hd: 1 }, 3: { w: 210 } })
    expect(sheet.rowData).toMatchObject({ 0: { h: 40 } })
    expect(sheet.mergeData).toEqual([{ startRow: 6, startColumn: 4, endRow: 7, endColumn: 5 }])
    expect(sheet.freeze).toEqual({ xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 })
    expect(sheet).toMatchObject({ tabColor: '#00b050', zoomRatio: 1.25, defaultColumnWidth: 64, defaultRowHeight: 20, hidden: 0 })
    expect(workbook.sheetOrder.map((id) => [workbook.sheets[id].name, workbook.sheets[id].hidden])).toEqual([['Data', 0], ['Other Sheet', 0], ['Hidden', 1], ['Secret', 2]])
    expect(workbook.activeSheetId).toBe('sheet-1')
    expect(sheetNamed(workbook, 'Other Sheet').custom).toEqual({ herald: { page: { pageSetup: { fitToPage: true, paperSize: 9, orientation: 'landscape', fitToHeight: 0 }, headerFooter: { oddFooter: '&LConfidential&RPage &P' } } } })
    expect(workbook.custom).toMatchObject({ herald: { properties: { creator: 'Fixture', title: 'Features' } } })
  })

  it('reads rich text and links to the web and into the workbook', async () => {
    const { workbook } = await workbookFromXlsx(await featureWorkbook(), { id: 'book', name: 'Features' })
    const cells = sheetNamed(workbook, 'Data').cellData
    const body = (row: number, column: number) => (cells[row][column].p as { body: Json }).body

    expect(body(1, 3)).toMatchObject({ dataStream: 'Bold and red\r\n', textRuns: [{ st: 0, ed: 4, ts: { bl: 1 } }, { st: 9, ed: 12, ts: { it: 1, cl: { rgb: '#ff0000' } } }] })
    expect(body(2, 3).customRanges).toMatchObject([{ startIndex: 0, endIndex: 6, rangeType: 0, properties: { url: 'https://example.com/a?b=1&c=2', tooltip: 'Opens the site' } }])
    expect(body(1, 5).customRanges).toMatchObject([{ properties: { url: '#gid=sheet-2&range=B1' } }])
  })

  it('reads validation, conditional formats, the filter with its condition, and defined names', async () => {
    const { workbook } = await workbookFromXlsx(await featureWorkbook(), { id: 'book', name: 'Features' })
    const validations = readResource<Record<string, Json[]>>(workbook.resources, RESOURCES.validation)!['sheet-1']
    const conditional = readResource<Record<string, { rule: Json }[]>>(workbook.resources, RESOURCES.conditional)!['sheet-1']

    expect(validations).toMatchObject([
      { type: 'list', formula1: '["Yes","No","Maybe"]', errorStyle: 2, error: 'Pick one', showErrorMessage: true, showDropDown: true, ranges: [{ startRow: 1, startColumn: 7 }] },
      { type: 'whole', operator: 'between', formula1: '1', formula2: '10', prompt: 'One to ten', showInputMessage: true },
      { type: 'list', formula1: "='Other Sheet'!$A$1:$A$3" }
    ])
    expect(conditional.map((entry) => entry.rule.type === 'highlightCell' ? entry.rule.subType : entry.rule.type)).toEqual(['number', 'formula', 'text', 'dataBar', 'colorScale', 'iconSet', 'rank'])
    expect(conditional[0].rule).toMatchObject({ operator: 'greaterThan', value: 1000, style: { bl: 1, cl: { rgb: '#9c0006' }, bg: { rgb: '#ffc7ce' } } })
    expect(conditional[2].rule).toMatchObject({ operator: 'containsText', value: 'Ren' })
    expect(conditional[5].rule).toMatchObject({ config: [{ value: { type: 'percent', value: 67 }, iconId: '0' }, { value: { value: 33 }, iconId: '1' }, { iconId: '2' }] })
    expect(conditional[6].rule).toMatchObject({ subType: 'rank', isBottom: true, value: 3 })
    expect(readResource(workbook.resources, RESOURCES.filter)).toEqual({
      'sheet-1': { ref: { startRow: 0, startColumn: 0, endRow: 8, endColumn: 3, rangeType: 0 }, filterColumns: [{ colId: 1, customFilters: { customFilters: [{ val: 100, operator: 'greaterThan' }] } }], cachedFilteredOut: [4] }
    })
    expect(Object.values(readResource<Record<string, Json>>(workbook.resources, RESOURCES.definedNames)!)).toMatchObject([{ name: 'Choices', formulaOrRefString: "'Other Sheet'!$A$1:$A$3", localSheetId: 'AllDefaultWorkbook' }])
  })

  it('reads a package another app wrote: shared strings, its own formats, theme and indexed colours, 1904 dates', async () => {
    const { workbook, notes } = await workbookFromXlsx(await handmadePackage(), { id: 'hand', name: 'Hand' })
    const sheet = sheetNamed(workbook, 'Hand Made')
    const cells = sheet.cellData
    const style = (row: number, column: number) => workbook.styles[cells[row][column].s as string] as Json

    expect(notes).toEqual([])
    expect(workbook.dateSystem).toBe('date1904')
    expect(workbook.defaultStyle).toEqual({ ff: 'Verdana', fs: 10 })
    expect(sheet).toMatchObject({ defaultColumnWidth: 80, defaultRowHeight: 17, showGridlines: 0, columnData: { 1: { w: 108 } }, rowData: { 5: { h: 32 } } })
    expect(cells[0][1]).toEqual({ v: ' padded ', t: CELL_TYPE.string })
    expect((cells[0][2].p as { body: Json }).body.textRuns).toEqual([{ st: 0, ed: 4, ts: { fs: 12, bl: 1, cl: { rgb: '#006400' } } }])
    expect(style(1, 1)).toEqual({ bl: 1, cl: { rgb: '#004b00' }, bg: { rgb: '#e3d1f1' }, bd: { b: { s: 2, cl: { rgb: '#000000' } }, l: { s: 8, cl: { rgb: '#0000ff' } } }, n: { pattern: '"$"#,##0.00;[Red]\\-"$"#,##0.00' } })
    expect(style(1, 2)).toEqual({ it: 1, cl: { rgb: '#ff0000' }, n: { pattern: 'dd/mm/yyyy' } })
    expect(style(3, 2)).toEqual({ n: { pattern: 'm/d/yyyy' } })
    expect(cells[2][1]).toEqual({ f: '=A3*2', si: 'sheet-1!B3', v: 40, t: CELL_TYPE.number })
    expect(cells[4][1]).toEqual({ si: 'sheet-1!B3', v: 80, t: CELL_TYPE.number })
    expect(cells[5]).toEqual({ 0: { v: '#N/A', t: CELL_TYPE.string }, 1: { f: '="x"&A2', v: 'x10', t: CELL_TYPE.string }, 2: { v: 'inline', t: CELL_TYPE.string } })
  })

  it('says why a file is not a workbook', async () => {
    await expect(workbookFromXlsx(new TextEncoder().encode('a,b\n1,2'), { id: 'x', name: 'x' })).rejects.toThrow(/not a zip package/)
    const zip = new JSZip()
    zip.file('word/document.xml', '<w:document/>')
    await expect(workbookFromXlsx(await zip.generateAsync({ type: 'uint8array' }), { id: 'x', name: 'x' })).rejects.toThrow(/Word or PowerPoint/)
  })
})

describe('xlsx round trips', () => {
  it('reads back what it wrote of every mapped feature', async () => {
    const { first, second, written } = await roundTrip(await featureWorkbook())

    expect(written.losses).toEqual([])
    expect(normalized(second.workbook)).toEqual(normalized(first.workbook))
  })

  it('reads back a package another app wrote', async () => {
    const { first, second } = await roundTrip(await handmadePackage())

    expect(normalized(second.workbook)).toEqual(normalized(first.workbook))
  })

  it('reads back a workbook made in Herald, in Univer’s own font', async () => {
    const sheet = newSheet('s1', 'Budget', { 0: { 0: { v: 'Rent' }, 1: { v: 1200, t: CELL_TYPE.number } }, 1: { 1: { f: '=B1*12' } } })
    const workbook = { ...newWorkbook('new', 'Budget', [sheet]), styles: { bold: { bl: 1 } } }
    workbook.sheets.s1.cellData[0][0].s = 'bold'
    const { bytes, losses } = await xlsxFromWorkbook(workbook)
    const back = await workbookFromXlsx(bytes, { id: 'new', name: 'Budget' })
    const cells = back.workbook.sheets[back.workbook.sheetOrder[0]].cellData

    expect(losses).toEqual([])
    expect(back.workbook.defaultStyle).toEqual({ ff: 'Arial', fs: 11 })
    expect(back.workbook.styles[cells[0][0].s as string]).toEqual({ bl: 1 })
    expect(cells[1][1]).toEqual({ f: '=B1*12' })
    expect(await partOf(bytes, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"')
  })
})

describe('xlsx export', () => {
  it('gives sheets names a file can hold, and says so', async () => {
    const long = 'A very long sheet name that goes past the limit'
    const workbook = newWorkbook('names', 'Names', [newSheet('a', 'Q1/Q2 [draft]'), newSheet('b', long), newSheet('c', `${long} too`), newSheet('d', 'History')])
    const { bytes, losses } = await xlsxFromWorkbook(workbook)
    const back = await workbookFromXlsx(bytes, { id: 'names', name: 'Names' })

    expect(excelSheetNames(['Fine', 'fine'])).toEqual(['Fine', 'fine (2)'])
    expect(back.workbook.sheetOrder.map((id) => back.workbook.sheets[id].name)).toEqual(['Q1-Q2 -draft-', 'A very long sheet name that goe', 'A very long sheet name that (2)', 'History 1'])
    expect(losses).toEqual(['Sheet names Excel does not allow (more than 31 characters, or any of [ ] : * ? / \\) are shortened or changed.'])
  })

  it('writes what ExcelJS cannot: the Normal font, validation, links, defined names and filter conditions', async () => {
    const { written } = await roundTrip(await featureWorkbook())
    const sheet = await partOf(written.bytes, 'xl/worksheets/sheet1.xml')
    const rels = await partOf(written.bytes, 'xl/worksheets/_rels/sheet1.xml.rels')

    expect(sheet).toContain('<dataValidation type="list" errorStyle="warning" allowBlank="1" showErrorMessage="1" error="Pick one" sqref="H2"><formula1>&quot;Yes,No,Maybe&quot;</formula1></dataValidation>')
    expect(sheet).toContain('<formula1>\'Other Sheet\'!$A$1:$A$3</formula1>')
    expect(sheet).toMatch(/<hyperlink ref="D3" r:id="rIdLink1" tooltip="Opens the site"\/>/)
    expect(sheet).toContain('<hyperlink ref="F2" location="\'Other Sheet\'!B1"/>')
    expect(rels).toContain('Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"')
    expect(sheet).toContain('<autoFilter ref="A1:D9"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="100"/></customFilters></filterColumn></autoFilter>')
    expect(sheet).toMatch(/<f t="shared" ref="A7:A9" si="0">B7\+1<\/f>/)
    expect(sheet).toMatch(/<f t="array" ref="B7:B8">B2:B3\*2<\/f>/)
    expect(sheet).toContain('_xlfn.XLOOKUP(A2,A2:A3,B2:B3)')
    expect(sheet.indexOf('<dataValidations')).toBeLessThan(sheet.indexOf('<hyperlinks'))
    expect(sheet.indexOf('<hyperlinks')).toBeLessThan(sheet.indexOf('<pageMargins'))
    expect(await partOf(written.bytes, 'xl/workbook.xml')).toContain('<definedNames><definedName name="Choices">\'Other Sheet\'!$A$1:$A$3</definedName></definedNames>')
  })

  it('keeps the Normal font and the date system of the file', async () => {
    const { written } = await roundTrip(await handmadePackage())

    expect(await partOf(written.bytes, 'xl/styles.xml')).toMatch(/<fonts[^>]*><font><sz val="10"\/><color theme="1"\/><name val="Verdana"\/>/)
    expect(await partOf(written.bytes, 'xl/workbook.xml')).toContain('date1904="1"')
  })

  it('opens in ExcelJS as Excel would read it', async () => {
    const { written } = await roundTrip(await featureWorkbook())
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(written.bytes as unknown as ArrayBuffer)
    const data = book.getWorksheet('Data')!

    expect(data.getCell('B2').numFmt).toBe('#,##0.00')
    expect(data.getCell('A1').font).toMatchObject({ name: 'Arial', size: 14, bold: true })
    expect(data.getCell('E7').isMerged).toBe(true)
    expect(data.getColumn(3).hidden).toBe(true)
    expect(book.getWorksheet('Secret')!.state).toBe('veryHidden')
    expect(data.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 })
  })
})
