import { type Relationship, relationshipKind, type WordPackage } from './package.ts'
import { intOf } from './styles.ts'
import { attr, child, children, find, textOf, type XmlElement } from './xml.ts'

/*
 * What opening a Word file approximates or leaves out, as sentences for the person opening it:
 * what reading the text finds (hidden text, fields, floating pictures) and what the package holds
 * beside it (comments, headers and footers, sections, columns, macros). Each is said once, only
 * when the file has it, and always in the same order.
 */

export type NoteKey =
  | 'deepHeadings'
  | 'headingNumbers'
  | 'listNumbers'
  | 'hiddenText'
  | 'internalLinks'
  | 'fields'
  | 'floatingPictures'
  | 'unshownPictures'
  | 'linkedPictures'
  | 'charts'
  | 'textBoxes'
  | 'equations'
  | 'notes'
  | 'trackedChanges'
  | 'comments'
  | 'headersFooters'
  | 'contentControls'
  | 'sections'
  | 'columns'
  | 'objects'
  | 'macros'

/** The sentence for each note, in the order notes are given. */
export const NOTES: Readonly<Record<NoteKey, string>> = {
  deepHeadings: 'Headings below level 6 are shown as level 6 headings.',
  headingNumbers: 'Numbered headings keep their numbers as text.',
  listNumbers: 'Some list numbering (such as 01 or First) is shown as plain numbers.',
  hiddenText: 'Hidden text is left out.',
  internalLinks: 'Links to places inside the document are kept as plain text.',
  fields: 'Fields (a table of contents, page numbers, dates) are shown as their last result and no longer update.',
  floatingPictures: 'Pictures placed beside the text are shown in line with it.',
  unshownPictures: 'Pictures in formats Herald Docs cannot show (EMF, WMF or TIFF) are left out.',
  linkedPictures: 'Pictures linked from outside the file are left out.',
  charts: 'Charts and SmartArt are shown as pictures, or left out when the file has no picture of them.',
  textBoxes: 'Text boxes are shown as ordinary paragraphs after the text they were in, and shapes are left out.',
  equations: 'Equations are shown as plain text.',
  notes: 'Footnotes and endnotes are shown as numbered notes at the end.',
  trackedChanges: 'Tracked changes are shown accepted, and saving keeps them that way.',
  comments: 'Comments are left out, and saving does not keep them.',
  headersFooters: 'Headers and footers are not shown, and saving does not keep them.',
  contentControls: 'Content controls (form fields, checkboxes) are shown as their text.',
  sections: 'Section breaks are shown as page breaks; the page size and margins are those of the last section.',
  columns: 'Text in columns is shown in one column.',
  objects: 'Embedded objects (such as spreadsheets) are shown as their pictures and are not kept.',
  macros: 'Macros are not kept: Herald Docs saves Word documents without them.'
}

/** The note for styles Herald Docs has no style of its own for, naming up to three. */
export function stylesNote(names: readonly string[]): string {
  const listed = names.slice(0, 3).join(', ')

  return `Styles Herald Docs does not have (${names.length > 3 ? `${listed} and others` : listed}) are kept as the formatting they give the text.`
}

/** The notes for what was found, styles first, then in the order of NOTES. */
export function fidelityNotes(found: ReadonlySet<NoteKey>, unknownStyles: readonly string[]): string[] {
  const notes = unknownStyles.length ? [stylesNote(unknownStyles)] : []

  for (const key of Object.keys(NOTES) as NoteKey[]) {
    if (found.has(key)) {
      notes.push(NOTES[key])
    }
  }

  return notes
}

const hasContent = (part: XmlElement | null): boolean =>
  Boolean(part && (textOf(part).trim() || find(part, 'w:drawing') || find(part, 'w:pict') || find(part, 'w:fldSimple') || find(part, 'w:fldChar')))

const columned = (section: XmlElement): boolean => {
  const columns = child(section, 'w:cols')

  return (intOf(attr(columns, 'w:num')) ?? 1) > 1 || children(columns, 'w:col').length > 1
}

/**
 * Notes for what a package holds beside its text: comments, headers and footers with something in
 * them, more than one section, columns, and macros. `sections` are all the document's w:sectPr.
 */
export async function packageNotes(pkg: WordPackage, relationships: Map<string, Relationship>, sections: readonly XmlElement[]): Promise<NoteKey[]> {
  const found: NoteKey[] = []
  const internal = [...relationships.values()].filter((item) => !item.external)
  const comments = internal.find((item) => relationshipKind(item) === 'comments')

  if (comments && find((await pkg.xml(comments.target)) ?? undefined, 'w:comment')) {
    found.push('comments')
  }

  const references = sections.flatMap((section) => [...children(section, 'w:headerReference'), ...children(section, 'w:footerReference')])
  const parts = new Set(references.map((reference) => relationships.get(attr(reference, 'r:id') ?? '')?.target).filter((target): target is string => Boolean(target)))
  const contents = await Promise.all([...parts].map((part) => pkg.xml(part)))

  if (contents.some(hasContent)) {
    found.push('headersFooters')
  }

  if (sections.some((section) => child(section, 'w:sectPrChange'))) {
    found.push('trackedChanges')
  }

  if (sections.length > 1) {
    found.push('sections')
  }

  if (sections.some(columned)) {
    found.push('columns')
  }

  if (pkg.macros) {
    found.push('macros')
  }

  return found
}
