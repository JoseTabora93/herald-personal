import { describe, expect, it } from 'vitest'
import { attr, child, children, find, findAll, localName, parseXml, textOf, wellFormed } from './xml.ts'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

describe('parseXml', () => {
  it('reads elements, attributes in either quotes, self-closing tags and text', () => {
    const root = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:p w:rsidR="00A1"><w:r><w:t xml:space='preserve'> Quarterly plan </w:t></w:r><w:r/></w:p>`)

    expect(root.name).toBe('w:p')
    expect(root.attrs).toEqual({ 'w:rsidR': '00A1' })
    expect(children(root).map((element) => element.name)).toEqual(['w:r', 'w:r'])
    expect(attr(find(root, 'w:t'), 'xml:space')).toBe('preserve')
    expect(textOf(root)).toBe(' Quarterly plan ')
  })

  it('decodes the named and numeric entities in text and attributes', () => {
    const root = parseXml('<a title="&quot;Ada&quot; &amp; &apos;Bo&apos;">&lt;b&gt; &#65;&#x42;&#x1F600;</a>')

    expect(attr(root, 'title')).toBe(`"Ada" & 'Bo'`)
    expect(textOf(root)).toBe('<b> AB\u{1F600}')
  })

  it('keeps CDATA as it is, and skips comments, processing instructions, a DOCTYPE and a byte-order mark', () => {
    const root = parseXml('\uFEFF<?xml version="1.0"?><!DOCTYPE note [<!ELEMENT note ANY>]><!-- before --><a>x<![CDATA[<y> & z]]><?pi data?><!-- in -->w</a><!-- after -->')

    expect(root.children).toEqual(['x<y> & zw'])
  })

  it('normalises line ends, and white space in attribute values as XML does', () => {
    const root = parseXml('<a b="one\ttwo\r\nthree">x\r\ny\rz</a>')

    expect(attr(root, 'b')).toBe('one two three')
    expect(textOf(root)).toBe('x\ny\nz')
  })

  it.each([
    ['a tag closed by another', '<a><b></a></b>'],
    ['a tag never closed', '<a><b></b>'],
    ['a closing tag with nothing open', '<a/></b>'],
    ['a stray ampersand', '<a>fish & chips</a>'],
    ['an unknown entity', '<a>&nbsp;</a>'],
    ['an attribute without quotes', '<a b=1/>'],
    ['an attribute without a value', '<a b/>'],
    ['the same attribute twice', '<a b="1" b="2"/>'],
    ['attributes run together', '<a b="1"c="2"/>'],
    ['a "<" in an attribute', '<a b="<"/>'],
    ['two root elements', '<a/><b/>'],
    ['text outside the root', '<a/>tail'],
    ['no root element', '<?xml version="1.0"?>'],
    ['an unclosed comment', '<a><!-- open</a>'],
    ['an unclosed CDATA section', '<a><![CDATA[open</a>'],
    ['a tag without a name', '<a>< b/></a>']
  ])('throws on %s', (_, xml) => {
    expect(() => parseXml(xml)).toThrow(/Malformed XML/)
    expect(wellFormed(xml)).toBe(false)
  })

  it('says on which line the problem is', () => {
    expect(() => parseXml('<a>\n<b>\n</a>')).toThrow('Malformed XML (line 3): <b> closed by </a>')
  })

  it('gives names the prefixes asked for their namespaces, whatever the file declared', () => {
    const xml = `<doc:document xmlns:doc="${W}" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><doc:p doc:rsidR="1"><doc:hyperlink rel:id="rId4"/></doc:p><body xmlns="${W}"><p w:val="x" xmlns:w="${W}"/></body></doc:document>`
    const root = parseXml(xml, { prefixes: { [W]: 'w', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r' } })

    expect(root.name).toBe('w:document')
    expect(child(child(root, 'w:p'), 'w:hyperlink')?.attrs).toEqual({ 'r:id': 'rId4' })
    expect(child(root, 'w:p')?.attrs).toEqual({ 'w:rsidR': '1' })
    expect(child(child(root, 'w:body'), 'w:p')?.attrs).toEqual({ 'w:val': 'x', 'xmlns:w': W })
  })

  it('leaves names as written without prefixes to use, and still checks tags by their written names', () => {
    expect(parseXml(`<x:a xmlns:x="${W}"/>`).name).toBe('x:a')
    expect(() => parseXml(`<x:a xmlns:x="${W}"></w:a>`, { prefixes: { [W]: 'w' } })).toThrow(/closed by/)
  })

  it('parses a part of several megabytes quickly', () => {
    const paragraph = '<w:p><w:pPr><w:pStyle w:val="Normal"/><w:spacing w:after="160"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">Quarterly plan for the team &amp; Ada.</w:t></w:r></w:p>'
    const xml = `<w:document xmlns:w="${W}"><w:body>${paragraph.repeat(30000)}</w:body></w:document>`
    const started = performance.now()
    const root = parseXml(xml, { prefixes: { [W]: 'w' } })
    const elapsed = performance.now() - started

    expect(xml.length).toBeGreaterThan(5_000_000)
    expect(children(child(root, 'w:body'), 'w:p')).toHaveLength(30000)
    expect(elapsed).toBeLessThan(1500)
  })
})

describe('walking the tree', () => {
  const root = parseXml('<w:body><w:p><w:r><w:t>a</w:t></w:r><w:r><w:t>b</w:t><w:tab/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>')

  it('finds children and descendants by name, in document order', () => {
    expect(child(root, 'w:tbl')?.name).toBe('w:tbl')
    expect(child(root, 'w:r')).toBeUndefined()
    expect(children(child(root, 'w:p'), 'w:r')).toHaveLength(2)
    expect(findAll(root, 'w:t').map(textOf)).toEqual(['a', 'b', 'c'])
    expect(find(root, 'w:tab')?.name).toBe('w:tab')
    expect(textOf(root)).toBe('abc')
  })

  it('takes undefined anywhere, so lookups can be chained', () => {
    expect(child(child(undefined, 'w:pPr'), 'w:jc')).toBeUndefined()
    expect(children(undefined)).toEqual([])
    expect(attr(undefined, 'w:val')).toBeUndefined()
    expect(textOf(undefined)).toBe('')
    expect(localName('w:pPr')).toBe('pPr')
    expect(localName('Relationship')).toBe('Relationship')
  })
})

describe('wellFormed', () => {
  it('accepts well-formed documents', () => {
    expect(wellFormed('<?xml version="1.0"?><a b="1"><c/>text</a>')).toBe(true)
  })
})
