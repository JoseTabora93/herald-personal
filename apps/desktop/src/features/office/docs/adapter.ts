import { printView } from '../../../../shared/office/doc-html.ts'
import { documentFromMarkdown, documentFromText, markdownFromDocument, textFromDocument, type TextLayout } from '../../../../shared/office/doc-text.ts'
import { blankDocument, type DocJSON } from '../../../../shared/office/document.ts'
import { decodeText, encodeText } from '../print.ts'
import type { OfficeAdapter } from '../types.ts'

/*
 * Herald Docs' files: Markdown and plain text for now (Word documents come with the format
 * converters), and the print view main turns into a PDF.
 */

export const printHtml = (document: DocJSON, title: string): string => printView(document, title)

export const docsAdapter: OfficeAdapter<DocJSON> = {
  app: 'docs',
  defaultFormat: '.md',
  blank: () => blankDocument(),
  read: async (bytes, extension) => {
    const { text, notes } = decodeText(bytes)
    const result = extension === '.txt' ? documentFromText(text) : documentFromMarkdown(text)

    return { model: result.document, notes: [...notes, ...result.notes], layout: result.layout }
  },
  write: async (model, extension, layout) => {
    const textLayout = (layout ?? {}) as Partial<TextLayout>
    const result = extension === '.txt' ? textFromDocument(model, textLayout) : markdownFromDocument(model, textLayout)

    return { bytes: encodeText(result.text), losses: result.losses }
  },
  print: async (model, name) => ({ html: printHtml(model, name) })
}
