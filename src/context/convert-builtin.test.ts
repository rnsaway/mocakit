// src/context/convert-builtin.test.ts
import { describe, expect, it } from 'vitest';
import { buildZip } from '../../test/helpers/zip-builder.js';
import { BUILTIN_EXTENSIONS, convertBuiltin } from './convert-builtin.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const md = (ext: string, text: string): string => {
  const result = convertBuiltin(ext, enc(text));
  if ('error' in result) throw new Error(result.error);
  return result.markdown;
};

describe('BUILTIN_EXTENSIONS', () => {
  it('lists the formats read without a converter', () => {
    expect([...BUILTIN_EXTENSIONS]).toEqual(['.md', '.txt', '.html', '.htm', '.docx', '.csv']);
  });
  it('reports an unknown extension as an error', () => {
    expect(convertBuiltin('.xyz', enc('x'))).toEqual({ error: expect.stringContaining('.xyz') });
  });
});

describe('md and txt', () => {
  it('uses the text as is, with a BOM and CRLF removed', () => {
    expect(md('.md', '﻿# A\r\n\r\ntext\r\n')).toBe('# A\n\ntext\n');
    expect(md('.txt', 'plain\ntext')).toBe('plain\ntext');
  });
  it('rejects binary content', () => {
    expect(convertBuiltin('.txt', new Uint8Array([65, 0, 66]))).toHaveProperty('error');
  });
});

describe('html', () => {
  const html = [
    '<html><head><title>Ignored</title><style>p { color: red }</style></head><body>',
    '<h1>Guide</h1>',
    '<p>Tom &amp; <b>Jerry</b> read <a href="https://example.test/x">the docs</a>.</p>',
    '<script>alert("x")</script>',
    '<h2>Steps</h2>',
    '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>',
    '<ol><li>first</li><li>second</li></ol>',
    '<pre><code>line 1\n  line 2</code></pre>',
    '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>nut</td><td>2</td></tr></table>',
    '</body></html>',
  ].join('\n');

  it('converts headings, paragraphs, lists, links, pre and tables', () => {
    expect(md('.html', html)).toBe(
      [
        '# Guide',
        '',
        'Tom & **Jerry** read [the docs](https://example.test/x).',
        '',
        '## Steps',
        '',
        '- one',
        '- two',
        '  - nested',
        '',
        '1. first',
        '2. second',
        '',
        '```',
        'line 1',
        '  line 2',
        '```',
        '',
        '| Name | Qty |',
        '|---|---|',
        '| nut | 2 |',
        '',
      ].join('\n'),
    );
  });

  it('accepts the .htm extension', () => {
    expect(md('.htm', '<h1>T</h1>')).toBe('# T\n');
  });

  it('escapes angle brackets so text cannot inject HTML', () => {
    const out = md('.html', '<p>&lt;img src=x onerror=alert(1)&gt; &#60;script&#62; [x](javascript:alert(1))</p>');
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain('&lt;img');
    expect(out).toContain('\\[x\\]');
  });

  it('keeps only http, https and mailto link targets', () => {
    const out = md(
      '.html',
      '<p><a href="javascript:alert(1)">bad</a> <a href=" JaVa\tScript:x">worse</a> <a href="mailto:a@acme.test">mail</a> <a href="http://acme.test/a(b)">ok</a> <a href="page.html">rel</a></p>',
    );
    expect(out).toBe('bad worse [mail](mailto:a@acme.test) [ok](http://acme.test/a%28b%29) rel\n');
  });

  it('drops unknown tags and keeps their inline text', () => {
    expect(md('.html', '<p>a <blink>b</blink> <custom-tag>c</custom-tag></p>')).toBe('a b c\n');
  });

  it('turns inline code into a code span', () => {
    expect(md('.html', '<p>run <code>ls -l</code> now</p>')).toBe('run `ls -l` now\n');
  });

  it('does not let text start a Markdown heading or list', () => {
    expect(md('.html', '<p># not a heading</p><p>- not a list</p>')).toBe('\\# not a heading\n\n\\- not a list\n');
  });

  it('handles nested tables as plain cell text', () => {
    const out = md('.html', '<table><tr><td>a<table><tr><td>inner</td></tr></table></td><td>b</td></tr></table>');
    expect(out).toBe('| a inner | b |\n|---|---|\n');
  });

  it('returns an error when there is no text', () => {
    expect(convertBuiltin('.html', enc('<script>x</script>'))).toHaveProperty('error');
  });

  it('is linear on nested, unclosed and malformed markup', () => {
    const inputs = [
      '<div>'.repeat(200_000),
      '<b><i>'.repeat(100_000) + 'x',
      '<a href=x>'.repeat(100_000) + 'x',
      '<ul><li>'.repeat(50_000) + 'x',
      '<p'.repeat(200_000),
      '<a title="'.repeat(50_000),
      '<!--'.repeat(100_000),
      '<script>'.repeat(100_000),
      '<table><tr><td>'.repeat(50_000) + 'x',
      '< '.repeat(200_000),
      '<p>' + ' '.repeat(2_000_000) + 'x',
    ];
    for (const input of inputs) {
      const started = Date.now();
      const result = convertBuiltin('.html', enc(input));
      expect(result).toBeDefined();
      expect(Date.now() - started).toBeLessThan(3000);
    }
  });
});

describe('docx', () => {
  const doc = (body: string): string =>
    `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:wp="wp"><w:body>${body}</w:body></w:document>`;
  const para = (style: string | null, runs: string, extra = ''): string =>
    `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${runs}</w:p>`;
  const run = (text: string, rpr = ''): string => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const cell = (text: string): string => `<w:tc>${para(null, run(text))}</w:tc>`;
  const zip = (xml: string, deflate = false): Uint8Array => buildZip({ 'word/document.xml': xml }, { deflate });

  const body = [
    para('Heading1', run('Guide')),
    para('Heading2', run('Setup')),
    para(null, run('Plain ') + run('bold', '<w:b/>') + run(' and ') + run('slanted', '<w:i/>') + run(' &amp; &lt;b&gt;')),
    para('ListParagraph', run('first item')),
    para('ListParagraph', run('second item')),
    `<w:tbl><w:tr>${cell('Name')}${cell('Qty')}</w:tr><w:tr>${cell('nut')}${cell('2')}</w:tr></w:tbl>`,
    para(
      null,
      '<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="flow"/><a:t>box text</a:t></wp:inline></w:drawing></w:r>',
    ),
  ].join('');

  it('converts headings, lists, tables, emphasis and drawings', () => {
    const result = convertBuiltin('.docx', zip(doc(body)));
    expect(result).toEqual({
      markdown: [
        '# Guide',
        '',
        '## Setup',
        '',
        'Plain **bold** and *slanted* & &lt;b&gt;',
        '',
        '- first item',
        '- second item',
        '',
        '| Name | Qty |',
        '|---|---|',
        '| nut | 2 |',
        '',
        '\\[image: flow\\]',
        '',
      ].join('\n'),
    });
  });

  it('reads deflated archives', () => {
    expect(convertBuiltin('.docx', zip(doc(para('Title', run('T'))), true))).toEqual({ markdown: '# T\n' });
  });

  it('falls back to the drawing name and ignores bold off', () => {
    const xml = doc(
      para(null, '<w:r><w:drawing><wp:docPr id="1" name="Picture 7"/></w:drawing></w:r>') + para(null, run('x', '<w:b w:val="0"/>')),
    );
    expect(convertBuiltin('.docx', zip(xml))).toEqual({ markdown: '\\[image: Picture 7\\]\n\nx\n' });
  });

  it('returns an error for corrupt bytes, a missing document.xml and an oversize entry', () => {
    expect(convertBuiltin('.docx', enc('not a zip file at all, just text'))).toHaveProperty('error');
    expect(convertBuiltin('.docx', buildZip({ 'other.xml': '<a/>' }))).toHaveProperty('error');
    const big = buildZip({ 'word/document.xml': doc(para(null, run('x'))) });
    const view = new DataView(big.buffer, big.byteOffset, big.byteLength);
    // Declare an uncompressed size over 32 MiB in the central directory.
    for (let i = big.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        const cd = view.getUint32(i + 16, true);
        view.setUint32(cd + 24, 40 * 1024 * 1024, true);
        break;
      }
    }
    expect(convertBuiltin('.docx', big)).toEqual({ error: expect.stringMatching(/large|size/i) });
  });

  it('does not take text from text boxes or alternate content twice', () => {
    const xml = doc(
      '<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><wp:docPr id="1" name="Box"/><w:txbxContent><w:p><w:r><w:t>inside</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:p><w:r><w:t>fallback</w:t></w:r></w:p></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>',
    );
    expect(convertBuiltin('.docx', zip(xml))).toEqual({ markdown: '\\[image: Box\\]\n' });
  });

  it('is linear on deeply nested or unterminated xml', () => {
    const started = Date.now();
    expect(convertBuiltin('.docx', zip(doc('<w:p>'.repeat(100_000))))).toBeDefined();
    expect(convertBuiltin('.docx', zip(doc('<w:tbl>'.repeat(100_000) + '<w:p><w:r><w:t>x')))).toBeDefined();
    expect(convertBuiltin('.docx', zip('<w:t a="' + 'x'.repeat(1_000_000)))).toBeDefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('csv', () => {
  it('parses quoted commas, doubled quotes and newlines in a field', () => {
    const csv = 'name,note\r\n"Smith, Jo","said ""hi"""\r\nplain,"two\nlines"\r\n';
    expect(md('.csv', csv)).toBe(
      ['| name | note |', '|---|---|', '| Smith, Jo | said "hi" |', '| plain | two lines |', ''].join('\n'),
    );
  });

  it('escapes pipes and angle brackets in cells and pads short rows', () => {
    expect(md('.csv', 'a,b\n1|2,<x>\n3\n')).toBe('| a | b |\n|---|---|\n| 1\\|2 | &lt;x&gt; |\n| 3 |  |\n');
  });

  it('keeps 500 data rows and counts the rest', () => {
    const rows = ['h1,h2'];
    for (let i = 1; i <= 502; i++) rows.push(`${i},x`);
    const out = md('.csv', rows.join('\n'));
    const lines = out.split('\n');
    expect(lines.filter((l) => /^\| \d+ \| x \|$/.test(l))).toHaveLength(500);
    expect(out).toContain('| 500 | x |');
    expect(out).not.toContain('| 501 | x |');
    expect(out.trimEnd().endsWith('_2 more rows not shown_')).toBe(true);
  });

  it('keeps the wording for a single extra row', () => {
    const rows = ['h'];
    for (let i = 0; i < 501; i++) rows.push('v');
    expect(md('.csv', rows.join('\n')).trimEnd().endsWith('_1 more rows not shown_')).toBe(true);
  });

  it('refuses input over 10 MiB and empty input', () => {
    expect(convertBuiltin('.csv', new Uint8Array(10 * 1024 * 1024 + 1).fill(97))).toEqual({ error: expect.stringMatching(/10 MiB/) });
    expect(convertBuiltin('.csv', enc('  \n'))).toHaveProperty('error');
  });

  it('accepts an unterminated quote', () => {
    expect(convertBuiltin('.csv', enc('a,b\n"x,y'))).toHaveProperty('markdown');
  });
});

describe('review round 1: inline nesting, image marker, table caps', () => {
  it('does not let misnested inline tags build a live link from source text', () => {
    const out = md('.html', '<p><a href="https://ok.test/">p[<i>t]<i>(javascript:alert(1))</a>R</i></i></p>');
    expect(out).not.toContain('](javascript:');
    expect(out).toContain('p\\[');
    expect(out).toContain('t\\]');
  });

  it('drops a misnested close and closes what is still open at the end of the block', () => {
    expect(md('.html', '<p><b>x<a href="https://ok.test/">y</b>z</a></p>')).toBe('**x[yz](https://ok.test/)**\n');
    expect(md('.html', '<p><b> a </b></p>')).toBe('**a**\n');
    expect(md('.html', '<p><b> </b>x</p>')).toBe('x\n');
  });

  it('wraps 80k closed bold runs and 80k links quickly', () => {
    for (const html of ['<p>' + '<b>x</b> '.repeat(80_000), '<p>' + '<a href="https://ok.test/">x</a> '.repeat(80_000), '<p>' + '<b>'.repeat(80_000) + 'x' + '</b>'.repeat(80_000)]) {
      const started = Date.now();
      expect(convertBuiltin('.html', enc(html))).toHaveProperty('markdown');
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  const docxWith = (text: string): Uint8Array =>
    buildZip({
      'word/document.xml': `<w:document xmlns:w="w" xmlns:wp="wp"><w:body><w:p><w:r><w:drawing><wp:docPr id="1" name="n" descr="flow"/></w:drawing></w:r><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    });

  it('escapes the DOCX image marker so following text cannot make a link or definition', () => {
    for (const tail of ['(javascript:alert(1))', ': javascript:alert(1)']) {
      const result = convertBuiltin('.docx', docxWith(tail));
      if ('error' in result) throw new Error(result.error);
      expect(result.markdown).toBe(`\\[image: flow\\]${tail}\n`);
    }
  });

  it('caps CSV columns and cells', () => {
    const header = Array.from({ length: 10_000 }, () => 'a').join(',');
    const rows = [header, ...Array.from({ length: 400 }, () => header)];
    const started = Date.now();
    const out = md('.csv', rows.join('\n'));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.length).toBeLessThan(200_000);
    expect(out).toContain('_9936 more columns not shown_');
  });

  it('caps HTML table columns and total cells', () => {
    const wide = '<table>' + ('<tr>' + '<td>x</td>'.repeat(20_000) + '</tr>').repeat(20) + '</table>';
    const out = md('.html', wide);
    expect(out.length).toBeLessThan(200_000);
    expect(out).toContain('_19936 more columns not shown_');
    const tall = '<table>' + ('<tr>' + '<td>x</td>'.repeat(64) + '</tr>').repeat(3000) + '</table>';
    const tallOut = md('.html', tall);
    expect(tallOut.split('\n').length).toBeLessThan(1700);
    expect(tallOut).toMatch(/_\d+ more rows not shown_/);
  });

  it('caps DOCX table columns', () => {
    const cells = Array.from({ length: 3000 }, () => '<w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>').join('');
    const xml = `<w:document xmlns:w="w"><w:body><w:tbl>${`<w:tr>${cells}</w:tr>`.repeat(30)}</w:tbl></w:body></w:document>`;
    const result = convertBuiltin('.docx', buildZip({ 'word/document.xml': xml }));
    if ('error' in result) throw new Error(result.error);
    expect(result.markdown.length).toBeLessThan(50_000);
    expect(result.markdown).toContain('_2936 more columns not shown_');
  });

  it('handles very many pre blocks and backtick runs without spreading arrays', () => {
    const out = md('.html', '<pre>' + '`'.repeat(300_000) + '</pre>');
    expect(out.startsWith('`'.repeat(300_001))).toBe(true);
    expect(convertBuiltin('.html', enc('<p><code>' + '` '.repeat(300_000) + '</code></p>'))).toHaveProperty('markdown');
  });
});
