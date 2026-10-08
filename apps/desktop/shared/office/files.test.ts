import { describe, expect, it } from 'vitest'
import { baseName, dialogFilters, extensionOf, formatOf, OFFICE_FORMATS, officeAppFor, openFormats, saveFormats } from './files.ts'

const plain = { libreOffice: false }
const withLibreOffice = { libreOffice: true }

describe('extensionOf and formatOf', () => {
  it('reads the extension in lower case, ignoring the folder', () => {
    expect(extensionOf('/Users/me/Budget.Final.CSV')).toBe('.csv')
    expect(extensionOf('/Users/me/notes')).toBe('')
    expect(extensionOf('/Users/me/v1.2/notes')).toBe('')
    expect(formatOf('/tmp/Report.MD')?.app).toBe('docs')
    expect(formatOf('/tmp/archive.zip')).toBeUndefined()
  })
})

describe('openFormats and saveFormats', () => {
  it('offers only what Herald reads and writes', () => {
    expect(openFormats('docs', plain).map((format) => format.extension)).toEqual(['.md', '.markdown', '.txt'])
    expect(saveFormats('docs', plain).map((format) => format.extension)).toEqual(['.md', '.txt'])
    expect(openFormats('sheets', plain).map((format) => format.extension)).toEqual(['.csv'])
    expect(openFormats('slides', plain).map((format) => format.extension)).toEqual(['.pptx'])
  })

  it('offers an OpenDocument format only with LibreOffice and a reader for the format it converts through', () => {
    const odt = OFFICE_FORMATS.find((format) => format.extension === '.odt')!

    expect(openFormats('docs', withLibreOffice)).not.toContain(odt)
    expect(odt.via).toBe('.docx')
    expect(OFFICE_FORMATS.find((format) => format.extension === odt.via)?.opens).toBe(false)
  })
})

describe('officeAppFor', () => {
  it('names the app that opens a file here', () => {
    expect(officeAppFor('/tmp/a.csv', plain)).toBe('sheets')
    expect(officeAppFor('/tmp/a.txt', plain)).toBe('docs')
    expect(officeAppFor('/tmp/a.docx', plain)).toBeNull()
    expect(officeAppFor('/tmp/a.png', plain)).toBeNull()
  })
})

describe('baseName', () => {
  it('drops the folder and the extension', () => {
    expect(baseName('/Users/me/Q3 plan.xlsx')).toBe('Q3 plan')
    expect(baseName('/Users/me/')).toBe('me')
    expect(baseName('')).toBe('Untitled')
  })
})

describe('dialogFilters', () => {
  it('groups extensions by label and puts all of them first', () => {
    expect(dialogFilters(openFormats('docs', plain))).toEqual([
      { name: 'All supported files', extensions: ['md', 'markdown', 'txt'] },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'Plain text', extensions: ['txt'] }
    ])
    expect(dialogFilters(openFormats('sheets', plain))).toEqual([{ name: 'CSV', extensions: ['csv'] }])
  })
})
