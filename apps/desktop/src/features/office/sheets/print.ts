import { fieldFromCell, type NumberFormatter, patternOf } from '../../../../shared/office/sheet-csv.ts'
import { type CellSnapshot, cellsOf, type SheetSnapshot, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import type { UStyle } from '../../../../shared/office/xlsx/styles.ts'
import { escapeHtml, printPage } from '../print.ts'

/*
 * The print view of the sheet in front: its used range as a table, with the fonts, fills, borders,
 * alignment, merged cells, sizes and number formats it shows; hidden rows and columns left out.
 * It prints on the paper the sheet's page setup asks for, turned the way it says, and landscape
 * when the sheet is wider than the paper.
 */

/** The sheet the window has in front, kept on the snapshot it hands over for saving and printing. */
export const activeSheetOf = (workbook: WorkbookSnapshot): string | undefined => (typeof workbook.activeSheetId === 'string' ? workbook.activeSheetId : undefined)

/** Excel's paper sizes that CSS can name, with their width in inches; any other prints on A4. */
const PAPERS: Record<number, { name: string; width: number }> = { 1: { name: 'letter', width: 8.5 }, 5: { name: 'legal', width: 8.5 }, 8: { name: 'A3', width: 11.69 }, 9: { name: 'A4', width: 8.27 }, 11: { name: 'A5', width: 5.83 } }

const MARGIN_INCHES = 0.5

// The page's size and turn come from its CSS (main prints with the page's own size).
const pageCss = (paper: string, landscape: boolean) => `@page { size: ${paper} ${landscape ? 'landscape' : 'portrait'}; margin: ${MARGIN_INCHES}in; }`

/** The page setup a sheet brought from its file. */
const pageSetupOf = (sheet: SheetSnapshot): { orientation?: string; paperSize?: number } => (sheet.custom as { herald?: { page?: { pageSetup?: { orientation?: string; paperSize?: number } } } } | undefined)?.herald?.page?.pageSetup ?? {}

const CSS = `
body { font: 9pt Arial, Helvetica, sans-serif; color: #000; margin: 0; }
h1 { font-size: 11pt; margin: 0 0 6pt; }
table { border-collapse: collapse; table-layout: fixed; }
td { border: 0.5pt solid #c8ccd4; padding: 1pt 3pt; white-space: nowrap; overflow: hidden; vertical-align: bottom; }
td.n { text-align: right; }
`

const BORDER_CSS = ['none', '1px solid', '1px solid', '1px dotted', '1px dashed', '1px dashed', '1px dotted', '3px double', '2px solid', '2px dashed', '2px dashed', '2px dotted', '2px dashed', '3px solid']
const ALIGN = ['', 'left', 'center', 'right', 'justify', 'justify', 'center']
const VALIGN = ['', 'top', 'middle', 'bottom']

const styleOf = (workbook: WorkbookSnapshot, style: unknown): UStyle | null => (typeof style === 'string' ? ((workbook.styles?.[style] as UStyle | undefined) ?? null) : ((style as UStyle | null) ?? null))

/** A cell's style (over its row's and column's) as CSS. */
function cellCss(style: UStyle | null): string {
  if (!style) {
    return ''
  }

  const css: string[] = []
  const color = (value: { rgb?: string | null } | null | undefined) => (value?.rgb ? value.rgb : null)

  if (style.ff) {
    css.push(`font-family:'${style.ff.replace(/'/g, '')}',sans-serif`)
  }

  if (style.fs) {
    css.push(`font-size:${style.fs}pt`)
  }

  if (style.bl) {
    css.push('font-weight:bold')
  }

  if (style.it) {
    css.push('font-style:italic')
  }

  const lines = [style.ul?.s ? 'underline' : '', style.st?.s ? 'line-through' : ''].filter(Boolean)

  if (lines.length) {
    css.push(`text-decoration:${lines.join(' ')}`)
  }

  if (color(style.cl)) {
    css.push(`color:${color(style.cl)}`)
  }

  if (color(style.bg)) {
    css.push(`background:${color(style.bg)}`)
  }

  for (const [side, name] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']] as const) {
    const border = style.bd?.[side]

    if (border && border.s > 0) {
      css.push(`border-${name}:${BORDER_CSS[border.s] ?? '1px solid'} ${color(border.cl) ?? '#000'}`)
    }
  }

  if (style.ht && ALIGN[style.ht]) {
    css.push(`text-align:${ALIGN[style.ht]}`)
  }

  if (style.vt && VALIGN[style.vt]) {
    css.push(`vertical-align:${VALIGN[style.vt]}`)
  }

  if (style.tb === 3) {
    css.push('white-space:normal;overflow-wrap:anywhere')
  }

  if (style.pd?.l) {
    css.push(`padding-left:${style.pd.l}px`)
  }

  return css.join(';')
}

interface Line {
  size: number
  hidden: boolean
}

function lines(data: unknown, count: number, fallback: number, key: 'h' | 'w'): Line[] {
  const meta = (data ?? {}) as Record<number, { h?: number; w?: number; hd?: number }>

  return Array.from({ length: count }, (_, i) => ({ size: meta[i]?.[key] ?? fallback, hidden: Boolean(meta[i]?.hd) }))
}

/** The part of a sheet with something in it, merged cells included. */
function usedRange(sheet: SheetSnapshot): { rows: number; columns: number } {
  let rows = 0
  let columns = 0

  for (const { row, column, cell } of cellsOf(sheet)) {
    if (fieldFromCell(cell) !== '' || cell.p) {
      rows = Math.max(rows, row + 1)
      columns = Math.max(columns, column + 1)
    }
  }

  for (const merge of (sheet.mergeData ?? []) as { endRow: number; endColumn: number }[]) {
    rows = Math.max(rows, merge.endRow + 1)
    columns = Math.max(columns, merge.endColumn + 1)
  }

  return { rows, columns }
}

const textOf = (cell: CellSnapshot | undefined, pattern: string | null, format: NumberFormatter | undefined): string => {
  const stream = (cell?.p as { body?: { dataStream?: string } } | undefined)?.body?.dataStream

  return stream && cell?.v === undefined ? stream.replace(/\r?\n$/, '').replace(/\r/g, '\n') : fieldFromCell(cell, pattern, format)
}

export function printHtml(workbook: WorkbookSnapshot, title: string, format?: NumberFormatter): { html: string; landscape: boolean } {
  const sheet = workbook.sheets[activeSheetOf(workbook) ?? ''] ?? workbook.sheets[workbook.sheetOrder[0]]

  if (!sheet) {
    return { html: printPage(title, `${pageCss('A4', false)}${CSS}`, ''), landscape: false }
  }

  const { rows, columns } = usedRange(sheet)
  const rowLines = lines(sheet.rowData, rows, typeof sheet.defaultRowHeight === 'number' ? sheet.defaultRowHeight : 24, 'h')
  const columnLines = lines(sheet.columnData, columns, typeof sheet.defaultColumnWidth === 'number' ? sheet.defaultColumnWidth : 88, 'w')
  const covered = new Set<string>()
  const spans = new Map<string, { rows: number; columns: number }>()

  for (const merge of (sheet.mergeData ?? []) as { startRow: number; startColumn: number; endRow: number; endColumn: number }[]) {
    const visible = (from: number, to: number, list: Line[]) => list.slice(from, to + 1).filter((line) => !line.hidden).length
    spans.set(`${merge.startRow}:${merge.startColumn}`, { rows: visible(merge.startRow, merge.endRow, rowLines), columns: visible(merge.startColumn, merge.endColumn, columnLines) })

    for (let row = merge.startRow; row <= merge.endRow; row++) {
      for (let column = merge.startColumn; column <= merge.endColumn; column++) {
        if (row !== merge.startRow || column !== merge.startColumn) {
          covered.add(`${row}:${column}`)
        }
      }
    }
  }

  const rowStyles = (sheet.rowData ?? {}) as Record<number, { s?: unknown }>
  const columnStyles = (sheet.columnData ?? {}) as Record<number, { s?: unknown }>
  const body: string[] = []

  for (let row = 0; row < rows; row++) {
    if (rowLines[row].hidden) {
      continue
    }

    const cells: string[] = []

    for (let column = 0; column < columns; column++) {
      if (columnLines[column].hidden || covered.has(`${row}:${column}`)) {
        continue
      }

      const cell = sheet.cellData[row]?.[column]
      const style = { ...styleOf(workbook, rowStyles[row]?.s), ...styleOf(workbook, columnStyles[column]?.s), ...styleOf(workbook, cell?.s) } as UStyle
      const css = cellCss(Object.keys(style).length ? style : null)
      const span = spans.get(`${row}:${column}`)
      const attributes = [typeof cell?.v === 'number' && cell.t !== 3 ? ' class="n"' : '', span && span.rows > 1 ? ` rowspan="${span.rows}"` : '', span && span.columns > 1 ? ` colspan="${span.columns}"` : '', css ? ` style="${escapeHtml(css)}"` : '']
      cells.push(`<td${attributes.join('')}>${escapeHtml(textOf(cell, patternOf(workbook, sheet, row, column, cell), format)).replace(/\n/g, '<br>')}</td>`)
    }

    const height = rowLines[row].size
    body.push(height && height !== 24 ? `<tr style="height:${height}px">${cells.join('')}</tr>` : `<tr>${cells.join('')}</tr>`)
  }

  const shownColumns = columnLines.filter((line) => !line.hidden)
  const width = shownColumns.reduce((sum, line) => sum + line.size, 0)
  const colgroup = shownColumns.length ? `<colgroup>${shownColumns.map((line) => `<col style="width:${line.size}px">`).join('')}</colgroup>` : ''
  const base = styleOf(workbook, workbook.defaultStyle)
  const bodyCss = base?.ff || base?.fs ? `body { font-family: '${String(base.ff ?? 'Arial').replace(/'/g, '')}', Arial, sans-serif; font-size: ${base.fs ?? 9}pt; }` : ''

  const setup = pageSetupOf(sheet)
  const paper = PAPERS[setup.paperSize ?? 9] ?? PAPERS[9]
  const landscape = setup.orientation === 'landscape' || width > (paper.width - 2 * MARGIN_INCHES) * 96

  return {
    html: printPage(title, `${pageCss(paper.name, landscape)}${CSS}${bodyCss}`, `<h1>${escapeHtml(sheet.name)}</h1><table style="width:${width}px">${colgroup}${body.join('')}</table>`),
    landscape
  }
}
