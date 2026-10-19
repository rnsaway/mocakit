// src/codegen/emit-context-docs.test.ts
import { describe, expect, it } from 'vitest';
import type { Section } from '../context/sections.js';
import { DOC_MARKER, PRIVATE_NOTICE } from './docs-writer.js';
import {
  emitContextIndex,
  emitDocReadme,
  emitPending,
  emitSectionFile,
  type ContextDocRecord,
} from './emit-context-docs.js';

const sec = (n: number, heading: string, extra: Partial<Section> = {}): Section => ({
  file: `0${n}-${heading.toLowerCase()}.md`,
  heading,
  level: 2,
  markdown: `## ${heading}\n\nBody of ${heading}.`,
  firstSentence: `Body of ${heading}.`,
  subheadings: [],
  ...extra,
});

const doc: ContextDocRecord = {
  slug: 'a',
  source: 'a.pdf',
  sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  method: 'converter pdftotext',
  size: 4096,
  status: 'ok',
  title: 'Acme Guide',
  sections: [sec(1, 'Intro'), sec(2, 'Setup', { subheadings: ['Install', 'Verify'] }), sec(3, 'Notes')],
  imagesNote: true,
};

describe('emitSectionFile', () => {
  const out = emitSectionFile(doc, 1, '0.6.0');
  const lines = out.split('\n');
  it('starts with the marker and private notice', () => {
    expect(lines[0]!.startsWith(DOC_MARKER)).toBe(true);
    expect(lines[0]).toContain('0.6.0');
    expect(lines[1]).toBe(PRIVATE_NOTICE);
  });
  it('has the breadcrumb, a blank line and the section markdown', () => {
    expect(lines[2]).toBe('Document: Acme Guide · Section 2 of 3 · Source: sources/a.pdf (sha256 0123456789ab…)');
    expect(lines[3]).toBe('');
    expect(lines.slice(4).join('\n')).toBe('## Setup\n\nBody of Setup.\n');
  });
  it('escapes an untrusted title and source path', () => {
    const evil = { ...doc, title: '<img src=x> [a](b)', source: '<b>.pdf' };
    const text = emitSectionFile(evil, 0, '0.6.0');
    expect(text.split('\n')[2]).toBe('Document: &lt;img src=x&gt; \\[a\\](b) · Section 1 of 3 · Source: sources/&lt;b&gt;.pdf (sha256 0123456789ab…)');
  });
});

describe('emitDocReadme', () => {
  const out = emitDocReadme(doc, '0.6.0');
  it('has the header, title and source facts', () => {
    const lines = out.split('\n');
    expect(lines[0]!.startsWith(DOC_MARKER)).toBe(true);
    expect(lines[1]).toBe(PRIVATE_NOTICE);
    expect(out).toContain('# Acme Guide');
    expect(out).toContain('sources/a.pdf');
    expect(out).toContain(doc.sha256);
    expect(out).toContain('converter pdftotext');
    expect(out).toContain('4096 bytes');
  });
  it('lists sections with links, first sentences and subheadings', () => {
    expect(out).toContain('[Intro](01-intro.md)');
    expect(out).toContain('Body of Intro.');
    expect(out).toMatch(/\[Setup\]\(02-setup\.md\)[^\n]*\n\s+- Install\n\s+- Verify/);
  });
  it('shows the PDF images line only when imagesNote is set', () => {
    const line = 'Images in the source were not converted; list it under context.agent for agent conversion.';
    expect(out).toContain(line);
    expect(emitDocReadme({ ...doc, imagesNote: false }, '0.6.0')).not.toContain(line);
  });
  it('percent-encodes link targets', () => {
    const odd = { ...doc, sections: [sec(1, 'Intro', { file: '01-a#b%.md' })] };
    expect(emitDocReadme(odd, '0.6.0')).toContain('(01-a%23b%25.md)');
  });
});

describe('emitContextIndex', () => {
  const other: ContextDocRecord = { ...doc, slug: 'a-old', source: 'z.docx', method: 'built-in .docx', status: 'stale', title: 'Old', imagesNote: false, sections: [sec(1, 'Only')] };
  const out = emitContextIndex([other, doc].reverse(), 2, '0.6.0');
  it('has the header and confidentiality line', () => {
    const lines = out.split('\n');
    expect(lines[0]!.startsWith(DOC_MARKER)).toBe(true);
    expect(lines[1]).toBe(PRIVATE_NOTICE);
    expect(out).toContain('Sources may be confidential; keep this folder in a private repository.');
  });
  it('sorts documents by slug and shows status and section links', () => {
    expect(out.indexOf('Acme Guide')).toBeLessThan(out.indexOf('Old'));
    expect(out).toContain('stale');
    expect(out).toContain('[Setup](docs/a/02-setup.md)');
    expect(out).toContain('[Only](docs/a-old/01-only.md)');
  });
  it('mentions pending documents only when there are some', () => {
    expect(out).toContain('2 documents waiting for agent conversion — see PENDING.md');
    expect(emitContextIndex([doc], 0, '0.6.0')).not.toContain('waiting for agent conversion');
    expect(emitContextIndex([doc], 1, '0.6.0')).toContain('1 documents waiting');
  });
});

describe('emitPending', () => {
  const out = emitPending(
    [
      { slug: 'b', source: 'b.xyz', sha256: 'bb', reason: 'no converter for .xyz' },
      { slug: 'a', source: 'dir/a.pdf', sha256: 'aa', reason: 'converter failed: exit 1\nsecond line <x>' },
    ],
    '0.6.0',
  );
  it('has the header, instructions and per-document facts in slug order', () => {
    const lines = out.split('\n');
    expect(lines[0]!.startsWith(DOC_MARKER)).toBe(true);
    expect(lines[1]).toBe(PRIVATE_NOTICE);
    expect(out).toContain('convert the whole document with real Markdown headings');
    expect(out).toContain('screenshots of code or screens as code blocks or short descriptions');
    expect(out).toContain('drop repeated headers, footers and the table of contents');
    expect(out).toContain('keep tables as pipe tables');
    expect(out).toContain('agent/a.md');
    expect(out).toContain('sources/dir/a.pdf');
    expect(out.indexOf('agent/a.md')).toBeLessThan(out.indexOf('agent/b.md'));
  });
  it('gives the exact sha line to write first', () => {
    expect(out).toContain('<!-- source-sha256: aa -->');
    expect(out).toContain('<!-- source-sha256: bb -->');
  });
  it('keeps the reason on one escaped line', () => {
    expect(out).toContain('converter failed: exit 1 second line &lt;x&gt;');
  });
});
