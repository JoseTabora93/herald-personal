/*
 * Which files Herald Docs, Sheets and Slides open and save. Main builds its dialogs from this, the
 * windows pick their reader and writer from it, and Files offers "Edit in" only for what an app
 * opens, so a format is switched on here once Herald can read or write it.
 */

export type OfficeApp = 'docs' | 'sheets' | 'slides'

export const OFFICE_APPS: readonly OfficeApp[] = ['docs', 'sheets', 'slides']

export const OFFICE_APP_NAMES: Record<OfficeApp, string> = { docs: 'Herald Docs', sheets: 'Herald Sheets', slides: 'Herald Slides' }

/** What each app calls one of its files, for dialogs and messages. */
export const OFFICE_NOUNS: Record<OfficeApp, string> = { docs: 'document', sheets: 'spreadsheet', slides: 'presentation' }

export interface OfficeFormat {
  extension: string
  app: OfficeApp
  label: string
  /** `office`: the Office format itself; `text`: text only (CSV, Markdown); `converted`: through LibreOffice. */
  kind: 'office' | 'text' | 'converted'
  opens: boolean
  saves: boolean
  /** For a converted format, the format LibreOffice turns it into (and back from). */
  via?: string
}

export const OFFICE_FORMATS: readonly OfficeFormat[] = [
  { extension: '.docx', app: 'docs', label: 'Word document', kind: 'office', opens: true, saves: true },
  // Opened without its macros; saved as .docx.
  { extension: '.docm', app: 'docs', label: 'Word document', kind: 'office', opens: true, saves: false },
  { extension: '.md', app: 'docs', label: 'Markdown', kind: 'text', opens: true, saves: true },
  { extension: '.markdown', app: 'docs', label: 'Markdown', kind: 'text', opens: true, saves: false },
  { extension: '.txt', app: 'docs', label: 'Plain text', kind: 'text', opens: true, saves: true },
  // Off until opening and saving go through LibreOffice: Herald reads only the .docx it converts to.
  { extension: '.odt', app: 'docs', label: 'OpenDocument text', kind: 'converted', opens: false, saves: false, via: '.docx' },
  { extension: '.xlsx', app: 'sheets', label: 'Excel workbook', kind: 'office', opens: false, saves: false },
  { extension: '.csv', app: 'sheets', label: 'CSV', kind: 'text', opens: true, saves: true },
  { extension: '.ods', app: 'sheets', label: 'OpenDocument spreadsheet', kind: 'converted', opens: true, saves: true, via: '.xlsx' },
  { extension: '.pptx', app: 'slides', label: 'PowerPoint presentation', kind: 'office', opens: false, saves: false },
  { extension: '.odp', app: 'slides', label: 'OpenDocument presentation', kind: 'converted', opens: true, saves: true, via: '.pptx' }
]

/** What the machine adds: LibreOffice for the converted formats. */
export interface OfficeAbilities {
  libreOffice: boolean
}

export const extensionOf = (file: string): string => {
  const match = /(\.[^./\\]+)$/.exec(file.replace(/[/\\]+$/, ''))

  return match ? match[1].toLowerCase() : ''
}

export const formatOf = (file: string): OfficeFormat | undefined => OFFICE_FORMATS.find((format) => format.extension === extensionOf(file))

export const byExtension = (extension: string): OfficeFormat | undefined => OFFICE_FORMATS.find((format) => format.extension === extension)

/** A converted format works when LibreOffice is here and Herald handles the format it converts through. */
function available(format: OfficeFormat, direction: 'opens' | 'saves', abilities: OfficeAbilities): boolean {
  if (!format[direction]) {
    return false
  }

  if (format.kind !== 'converted') {
    return true
  }

  const target = format.via ? byExtension(format.via) : undefined

  return abilities.libreOffice && Boolean(target?.[direction])
}

/** The formats `app` opens here. */
export function openFormats(app: OfficeApp, abilities: OfficeAbilities): OfficeFormat[] {
  return OFFICE_FORMATS.filter((format) => format.app === app && available(format, 'opens', abilities))
}

/** The formats `app` saves here, its own first. */
export function saveFormats(app: OfficeApp, abilities: OfficeAbilities): OfficeFormat[] {
  return OFFICE_FORMATS.filter((format) => format.app === app && available(format, 'saves', abilities))
}

/** The app that opens `file` here, if any. */
export function officeAppFor(file: string, abilities: OfficeAbilities): OfficeApp | null {
  const format = formatOf(file)

  return format && available(format, 'opens', abilities) ? format.app : null
}

/** A file name without its folder and extension, for titles and suggested names. */
export function baseName(file: string): string {
  const name = file.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''

  return name.replace(/\.[^.]+$/, '') || 'Untitled'
}

/** Dialog filters: one per format, then all of them together first when there are several. */
export function dialogFilters(formats: readonly OfficeFormat[]): { name: string; extensions: string[] }[] {
  const named = new Map<string, string[]>()

  for (const format of formats) {
    named.set(format.label, [...(named.get(format.label) ?? []), format.extension.slice(1)])
  }

  const each = [...named].map(([name, extensions]) => ({ name, extensions }))

  return each.length > 1 ? [{ name: 'All supported files', extensions: each.flatMap((filter) => filter.extensions) }, ...each] : each
}
