import { describe, expect, it } from 'vitest'
import { attr, child, descendants, find, flagAttr, numberAttr, parseXml, serializeXml, textOf, xml } from './xml.ts'

describe('the XML reader', () => {
  it('gives names in known namespaces their usual prefixes, whatever the file chose', () => {
    const root = parseXml('<?xml version="1.0"?><x:sld xmlns:x="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:q="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:cSld><d:blip q:embed="rId3"/></x:cSld></x:sld>')

    expect(root.name).toBe('p:sld')
    expect(attr(find(root, 'p:cSld/a:blip'), 'r:embed')).toBe('rId3')
  })

  it('reads a default namespace and the strict one alike', () => {
    const root = parseXml('<sld xmlns="http://purl.oclc.org/ooxml/presentationml/main"><cSld name="x"/></sld>')

    expect(root.name).toBe('p:sld')
    expect(child(root, 'p:cSld')?.attrs.name).toBe('x')
  })

  it('keeps text as it is, entities decoded, CDATA and white space kept', () => {
    const root = parseXml('<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t> Tom &amp; Jerry &#x2022; &#8212; &lt;3 </a:t></a:r><a:r><a:t><![CDATA[<raw>]]></a:t></a:r><!-- a comment --></a:p>')

    expect(descendants(root, 'a:t').map(textOf)).toEqual([' Tom & Jerry • — <3 ', '<raw>'])
  })

  it('reads numbers and switches with fallbacks', () => {
    const root = parseXml('<x a="12" b="nope" c="1" d="false"/>')

    expect(numberAttr(root, 'a', 0)).toBe(12)
    expect(numberAttr(root, 'b', 5)).toBe(5)
    expect(numberAttr(root, 'missing')).toBeUndefined()
    expect([flagAttr(root, 'c'), flagAttr(root, 'd'), flagAttr(root, 'e')]).toEqual([true, false, undefined])
  })

  it('takes a > inside a quoted value and refuses broken documents', () => {
    expect(parseXml('<x title="a > b"/>').attrs.title).toBe('a > b')
    expect(() => parseXml('<a><b></a>')).toThrow()
    expect(() => parseXml('<a>')).toThrow()
    expect(() => parseXml('just text')).toThrow()
  })

  it('writes back what it read, as written, when asked not to rename', () => {
    const source = '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld name="A &amp; B"><a:t> x </a:t><a:br/></p:cSld></p:sld>'
    const root = parseXml(source, { canonical: false })

    expect(serializeXml(root, false)).toBe(source)
    expect(serializeXml(xml('a:t', { val: 'q"\n' }, ['1 < 2']), false)).toBe('<a:t val="q&quot;&#10;">1 &lt; 2</a:t>')
  })
})
