import { describe, expect, it } from 'vitest';
import {
  decodeXmlEntities,
  escapeXmlAttribute,
  escapeXmlText,
  findChild,
  findChildren,
  findDescendant,
  parseXml,
} from './xml.js';

describe('escaping', () => {
  it('escapes text and attributes', () => {
    expect(escapeXmlText(`a & <b> "c"`)).toBe('a &amp; &lt;b&gt; "c"');
    expect(escapeXmlAttribute(`a & "c"`)).toBe('a &amp; &quot;c&quot;');
  });

  it('decodes named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeXmlEntities('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&bogus;')).toBe(`<>&"'AB&bogus;`);
  });

  it('leaves out-of-range code points alone', () => {
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
  });
});

describe('parseXml', () => {
  const doc = parseXml(
    `<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y='q'><b>t&lt;1&#65;</b><c/><d><![CDATA[<raw>&amp;]]></d><b>2</b></a>`,
  );
  const a = findChild(doc, 'a')!;

  it('parses attributes with either quote style and decodes them', () => {
    expect(a.attributes).toEqual({ x: '1 & 2', y: 'q' });
  });

  it('decodes text but keeps CDATA verbatim', () => {
    expect(findChild(a, 'b')!.text).toBe('t<1A');
    expect(findChild(a, 'd')!.text).toBe('<raw>&amp;');
  });

  it('marks self-closing elements as empty', () => {
    const c = findChild(a, 'c')!;
    expect(c.hasText).toBe(false);
    expect(c.children).toEqual([]);
  });

  it('finds children and descendants', () => {
    expect(findChildren(a, 'b').map((n) => n.text)).toEqual(['t<1A', '2']);
    expect(findDescendant(doc, 'c')).toBeDefined();
    expect(findDescendant(doc, 'nope')).toBeUndefined();
  });

  it('tolerates a > inside a quoted attribute', () => {
    const e = findChild(parseXml(`<e v="a>b">x</e>`), 'e')!;
    expect(e.attributes.v).toBe('a>b');
    expect(e.text).toBe('x');
  });
});
