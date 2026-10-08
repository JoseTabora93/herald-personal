import { describe, expect, it } from 'vitest'
import { lineMultiple, lookOf, readStyles, resolveRun, runProps } from './styles.ts'
import { parseXml } from './xml.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const stylesOf = (inner: string, theme: string | null = null) =>
  readStyles(
    parseXml(`<w:styles ${W}>${inner}</w:styles>`),
    theme ? parseXml(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="Office">${theme}</a:fontScheme></a:themeElements></a:theme>`) : null
  )

const DEFAULTS = `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`

const THEME = '<a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont>'

describe('readStyles', () => {
  const styles = stylesOf(
    `${DEFAULTS}
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:sz w:val="26"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Chapter"><w:name w:val="Chapter"/><w:basedOn w:val="Heading1"/></w:style>
    <w:style w:type="paragraph" w:styleId="Loop1"><w:name w:val="Loop one"/><w:basedOn w:val="Loop2"/><w:rPr><w:i/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Loop2"><w:name w:val="Loop two"/><w:basedOn w:val="Loop1"/></w:style>
    <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="QuoteBox"><w:name w:val="Quote Box"/></w:style>
    <w:style w:type="paragraph" w:styleId="HeraldCalloutNote"><w:name w:val="Callout Note"/></w:style>
    <w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/></w:style>
    <w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="Heading1Char"><w:name w:val="Heading 1 Char"/><w:link w:val="Heading1"/><w:rPr><w:sz w:val="32"/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/></w:style>
    <w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>
    <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:insideH w:val="nil"/></w:tblBorders></w:tblPr></w:style>
    <w:style w:type="numbering" w:styleId="Outline"><w:name w:val="Outline"/><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr></w:style>`,
    THEME
  )

  it('resolves basedOn chains and the theme fonts, without the document defaults', () => {
    const heading2 = styles.paragraph('Heading2')

    expect(heading2.run).toEqual({ font: 'Calibri Light', color: '#2f5496', size: 13 })
    expect(heading2.para).toEqual({ spaceBefore: 12, spaceAfter: 0, outline: 1 })
    expect(styles.defaults.run).toEqual({ font: 'Calibri', size: 11 })
    expect(styles.defaults.para).toEqual({ spaceAfter: 8, line: { value: 259, rule: 'auto' } })
  })

  it('gives unknown styles the default paragraph style, and survives a basedOn loop', () => {
    expect(styles.paragraph('Missing').id).toBe('Normal')
    expect(styles.paragraph(undefined).id).toBe('Normal')
    expect(styles.paragraph('Loop1').run).toEqual({ italic: true })
  })

  it('tells which of Herald’s styles each one is', () => {
    expect(styles.paragraph('Normal').role).toEqual({ kind: 'normal' })
    expect(styles.paragraph('Heading2').role).toEqual({ kind: 'heading', level: 2 })
    expect(styles.paragraph('Chapter').role).toEqual({ kind: 'heading', level: 1 })
    expect(styles.paragraph('Subtitle').role).toEqual({ kind: 'subtitle' })
    expect(styles.paragraph('ListParagraph').role).toEqual({ kind: 'normal' })
    expect(styles.paragraph('QuoteBox').role).toEqual({ kind: 'custom' })
    expect(styles.paragraph('HeraldCalloutNote').role).toEqual({ kind: 'callout', callout: 'note' })
    expect(styles.paragraph('SourceCode').role).toEqual({ kind: 'code' })
    expect(styles.character('Strong')?.role).toBe('custom')
    expect(styles.character('Heading1Char')?.role).toBe('quiet')
    expect(styles.character('VerbatimChar')?.role).toBe('code')
    expect(styles.character('Missing')).toBeNull()
  })

  it('finds the style each of Herald’s styles takes its look from', () => {
    const herald = styles.heraldStyles()

    expect(Object.keys(herald).sort()).toEqual(['code', 'heading1', 'heading2', 'normal', 'subtitle'])
    expect(herald.heading1?.id).toBe('Heading1')
  })

  it('merges table borders through the table style chain, and finds numbering styles', () => {
    expect(styles.tableBorders('TableGrid')).toEqual({ 'w:top': true, 'w:insideH': false })
    expect(styles.tableBorders(undefined)).toEqual({})
    expect(styles.numberingOf('Outline')).toBe('7')
    expect(styles.numberingOf('Normal')).toBeUndefined()
  })

  it('gives each style a complete look, so Herald’s own looks do not leak in', () => {
    expect(lookOf(styles.paragraph('Heading2'), styles, 'heading2')).toEqual({ font: 'Calibri Light', size: 13, color: '#2f5496', bold: false, italic: false, spaceBefore: 12, spaceAfter: 0, lineHeight: 1.079 })
    expect(lookOf(styles.paragraph('Subtitle'), styles, 'subtitle')).toEqual({ font: 'Calibri', size: 11, color: '#000000', bold: false, italic: false, spaceBefore: 0, spaceAfter: 8, lineHeight: 1.079 })
    expect(lookOf(stylesOf('').paragraph(undefined), stylesOf(''), 'normal')).toEqual({ font: 'Times New Roman', size: 10, bold: false, italic: false, spaceBefore: 0, spaceAfter: 0, lineHeight: 1 })
  })
})

describe('runProps and resolveRun', () => {
  const props = (inner: string) => runProps(parseXml(`<w:rPr ${W}>${inner}</w:rPr>`), { minor: 'Calibri' })

  it('reads toggles, colours, highlights, shading, sizes, fonts and scripts', () => {
    expect(props('<w:b/><w:i w:val="0"/><w:u w:val="double"/><w:dstrike/><w:color w:val="FF0000"/><w:highlight w:val="yellow"/><w:sz w:val="21"/><w:rFonts w:ascii="Georgia"/><w:vertAlign w:val="superscript"/>')).toEqual({
      bold: true,
      italic: false,
      underline: true,
      strike: true,
      color: '#ff0000',
      highlight: '#ffff00',
      size: 10.5,
      font: 'Georgia',
      script: 'superscript'
    })
    expect(props('<w:u w:val="none"/><w:color w:val="auto"/><w:shd w:val="clear" w:fill="FFCC00"/><w:rFonts w:hAnsiTheme="minorHAnsi" w:ascii="Arial"/>')).toEqual({ underline: false, color: null, shade: '#ffcc00', font: 'Calibri' })
    expect(props('<w:shd w:val="solid" w:color="00FF00" w:fill="auto"/><w:highlight w:val="none"/>')).toEqual({ shade: '#00ff00', highlight: null })
  })

  it('lets a character style turn off a toggle the paragraph style turns on, as Word does', () => {
    expect(resolveRun({ size: 11 }, { bold: true }, { bold: true }, {})).toEqual({ size: 11, bold: false })
    expect(resolveRun({}, { bold: true }, { italic: true }, {})).toEqual({ bold: true, italic: true })
    expect(resolveRun({}, { bold: true }, { bold: true }, { bold: true })).toEqual({ bold: true })
    expect(resolveRun({ font: 'Calibri' }, { font: 'Arial' }, null, { color: '#ff0000' })).toEqual({ font: 'Arial', color: '#ff0000' })
  })
})

describe('lineMultiple', () => {
  it('gives auto spacing in lines, and exact or at-least spacing against the font size', () => {
    expect(lineMultiple({ value: 360, rule: 'auto' }, 11)).toBe(1.5)
    expect(lineMultiple({ value: 360, rule: 'exact' }, 12)).toBe(1.25)
    expect(lineMultiple(undefined, 11)).toBeNull()
  })
})
