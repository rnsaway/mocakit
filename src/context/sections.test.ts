// src/context/sections.test.ts
import { describe, expect, it } from 'vitest';
import { assignDocSlugs, slugify, splitSections } from './sections.js';

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('BY WMS Development Guidelines', 'document')).toBe('by-wms-development-guidelines');
  });
  it('reduces accented letters and drops other characters', () => {
    expect(slugify('Café — Ünïcode', 'document')).toBe('cafe-unicode');
  });
  it('uses the fallback when nothing is left', () => {
    expect(slugify('— — —', 'section')).toBe('section');
    expect(slugify('', 'document')).toBe('document');
  });
});

describe('assignDocSlugs', () => {
  it('numbers collisions in sorted path order', () => {
    const slugs = assignDocSlugs(['guide.pdf', 'guide.docx', 'other/Run Book.txt']);
    expect(slugs.get('guide.docx')).toBe('guide');
    expect(slugs.get('guide.pdf')).toBe('guide-2');
    expect(slugs.get('other/Run Book.txt')).toBe('run-book');
    expect([...slugs.keys()]).toEqual(['guide.docx', 'guide.pdf', 'other/Run Book.txt']);
  });
  it('keeps names that differ only by case apart', () => {
    const slugs = assignDocSlugs(['guide.md', 'Guide.md']);
    expect(slugs.get('Guide.md')).toBe('guide');
    expect(slugs.get('guide.md')).toBe('guide-2');
  });
  it('falls back to document and never repeats a slug', () => {
    const slugs = assignDocSlugs(['guide.md', 'guide-2.md', 'guide.txt', '---.md']);
    expect(new Set(slugs.values()).size).toBe(4);
    expect(slugs.get('---.md')).toBe('document');
  });
  it('uses only the last extension of the base name and ignores directories', () => {
    expect(assignDocSlugs(['a\\b\\Notes.v2.md']).get('a\\b\\Notes.v2.md')).toBe('notes-v2');
  });
});

const opts = { docSlug: 'guide', fileTitle: 'Guide File', maxSectionBytes: 61_440 };
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('splitSections', () => {
  it('splits at ## and takes the lone # as the title', () => {
    const text = '# Guide Title\n\n## Alpha\n\nAlpha text.\n\n## Beta\n\nBeta text.\n\n## Gamma\n\nGamma text.\n';
    const { title, sections } = splitSections(text, opts);
    expect(title).toBe('Guide Title');
    expect(sections.map((s) => s.file)).toEqual(['01-alpha.md', '02-beta.md', '03-gamma.md']);
    expect(sections.map((s) => s.heading)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(sections.map((s) => s.level)).toEqual([2, 2, 2]);
    expect(sections[0]!.markdown).toBe('## Alpha\n\nAlpha text.');
  });

  it('uses the file name as title when there is no lone higher heading', () => {
    const { title, sections } = splitSections('## A\n\nx\n\n## B\n\ny\n', opts);
    expect(title).toBe('Guide File');
    expect(sections).toHaveLength(2);
  });

  it('puts text before the first heading into 00-introduction.md', () => {
    const { sections } = splitSections('# T\n\nIntro words here.\n\n## A\n\nx\n\n## B\n\ny\n', opts);
    expect(sections.map((s) => s.file)).toEqual(['00-introduction.md', '01-a.md', '02-b.md']);
    expect(sections[0]!.heading).toBe('Introduction');
    expect(sections[0]!.markdown).toContain('Intro words here.');
    expect(sections[0]!.markdown.startsWith('#')).toBe(true);
  });

  it('skips an empty introduction', () => {
    const { sections } = splitSections('\n\n## A\n\nx\n\n## B\n\ny\n', opts);
    expect(sections[0]!.file).toBe('01-a.md');
  });

  it('ignores headings inside backtick and tilde fences, honouring fence length', () => {
    const text = [
      '## A', '', '```', '# not a heading', '## nor this', '```', '',
      '~~~~', '## still code', '~~~', '## inner closer is too short', '~~~~', '',
      '````md', '```', '## nested', '```', '````', '',
      '## B', '', 'end',
    ].join('\n');
    const { sections } = splitSections(text, opts);
    expect(sections.map((s) => s.heading)).toEqual(['A', 'B']);
    expect(sections[0]!.markdown).toContain('# not a heading');
    expect(sections[0]!.markdown).toContain('## still code');
  });

  it('does not treat Setext underlines or malformed ATX as headings', () => {
    const text = 'Title\n=====\n\ntext\n\nSub\n---\n\n#nospace\n\n####### seven\n\n## A\n\nx\n\n## B\n\ny\n';
    const { sections } = splitSections(text, opts);
    expect(sections.map((s) => s.file)).toEqual(['00-introduction.md', '01-a.md', '02-b.md']);
  });

  it('makes one file named after the document when there are no headings', () => {
    const { title, sections } = splitSections('just some text\n\nmore text\n', opts);
    expect(title).toBe('Guide File');
    expect(sections.map((s) => s.file)).toEqual(['01-guide.md']);
    expect(sections[0]!.markdown).toContain('just some text');
    expect(sections[0]!.markdown).toContain('more text');
  });

  it('keeps a single-heading document as one section', () => {
    const { sections } = splitSections('# Only\n\nbody\n', opts);
    expect(sections.map((s) => s.file)).toEqual(['01-guide.md']);
  });

  it('numbers with three digits when there are more than 99 sections', () => {
    const text = Array.from({ length: 100 }, (_, i) => `## S${i}\n\nt`).join('\n\n');
    const { sections } = splitSections(text, opts);
    expect(sections[0]!.file).toBe('001-s0.md');
    expect(sections[99]!.file).toBe('100-s99.md');
    const ninety = splitSections(Array.from({ length: 99 }, (_, i) => `## S${i}\n\nt`).join('\n\n'), opts);
    expect(ninety.sections[98]!.file).toBe('99-s98.md');
  });

  it('names a section with an empty slug "section"', () => {
    const { sections } = splitSections('## !!!\n\nx\n\n## ???\n\ny\n', opts);
    expect(sections.map((s) => s.file)).toEqual(['01-section.md', '02-section.md']);
  });

  it('splits a section over the limit at the next heading level', () => {
    const filler = 'word '.repeat(2000);
    const text = `## Big\n\nlead\n\n### One\n\n${filler}\n\n### Two\n\n${filler}\n\n### Three\n\n${filler}\n\n## Small\n\nx\n`;
    const { sections } = splitSections(text, { ...opts, maxSectionBytes: 15_000 });
    expect(sections.map((s) => s.heading)).toEqual(['Big', 'One', 'Two', 'Three', 'Small']);
    expect(sections.map((s) => s.level)).toEqual([2, 3, 3, 3, 2]);
    expect(sections.map((s) => s.file)).toEqual(['01-big.md', '02-one.md', '03-two.md', '04-three.md', '05-small.md']);
  });

  it('splits a 70 KB section with ### children at ###', () => {
    const para = `${'x'.repeat(99)}\n\n`;
    const child = (n: number) => `### Part ${n}\n\n${para.repeat(240)}`;
    const text = `## Big\n\n${child(1)}${child(2)}${child(3)}## Next\n\ntail\n`;
    expect(bytes(text)).toBeGreaterThan(70_000);
    const { sections } = splitSections(text, opts);
    expect(sections.map((s) => s.heading)).toEqual(['Part 1', 'Part 2', 'Part 3', 'Next']);
    for (const s of sections) expect(bytes(s.markdown)).toBeLessThanOrEqual(61_440);
  });

  it('splits a childless 70 KB section into -part-N files under the limit', () => {
    const para = `${'y'.repeat(99)}\n\n`;
    const text = `## Big\n\n${para.repeat(700)}\n## Next\n\ntail\n`;
    const { sections } = splitSections(text, opts);
    const big = sections.filter((s) => s.file.includes('big'));
    expect(big.length).toBeGreaterThanOrEqual(2);
    expect(big[0]!.file).toBe('01-big.md');
    expect(big[1]!.file).toBe('02-big-part-2.md');
    expect(big[1]!.heading).toBe('Big (part 2)');
    for (const s of sections) expect(bytes(s.markdown)).toBeLessThanOrEqual(61_440);
    expect(sections.at(-1)!.heading).toBe('Next');
  });

  it('does not split a paragraph part inside a code fence and still fits the limit', () => {
    const code = '```\n' + 'a\n\nb\n'.repeat(400) + '```';
    const text = `## Big\n\n${code}\n\n## Next\n\nx\n`;
    const { sections } = splitSections(text, { ...opts, maxSectionBytes: 600 });
    for (const s of sections) expect(bytes(s.markdown)).toBeLessThanOrEqual(600);
  });

  it('splits one huge unbroken paragraph under the limit without losing text', () => {
    const text = `## Big\n\n${'z'.repeat(5000)}\n\n## Next\n\nx\n`;
    const { sections } = splitSections(text, { ...opts, maxSectionBytes: 1_000 });
    for (const s of sections) expect(bytes(s.markdown)).toBeLessThanOrEqual(1_000);
    expect(sections.map((s) => s.markdown).join('').split('z').length - 1).toBe(5000);
  });

  it('lists the subheadings one level down', () => {
    const text = '## A\n\n### A1\n\nx\n\n#### deep\n\ny\n\n### A2\n\nz\n\n## B\n\nq\n';
    const { sections } = splitSections(text, opts);
    expect(sections[0]!.subheadings).toEqual(['A1', 'A2']);
    expect(sections[1]!.subheadings).toEqual([]);
  });

  it('derives the first sentence with Markdown stripped and capped at 200 characters', () => {
    const text = [
      '## A', '', 'See **the [guide](http://x.test/g)** for `code` and ![pic](a.png). Second sentence.', '',
      '## B', '', '```', 'not this', '```', '', '- First item text', '- other', '',
      '## C', '', 'w'.repeat(500), '',
      '## D', '', '### only sub', '',
    ].join('\n');
    const { sections } = splitSections(text, opts);
    expect(sections[0]!.firstSentence).toBe('See the guide for code and pic.');
    expect(sections[1]!.firstSentence).toBe('First item text other');
    expect(sections[2]!.firstSentence.length).toBe(200);
    expect(sections[3]!.firstSentence).toBe('');
  });

  it('is deterministic and handles CRLF', () => {
    const text = '## A\r\n\r\nx\r\n\r\n## B\r\n\r\ny\r\n';
    expect(splitSections(text, opts)).toEqual(splitSections(text, opts));
    expect(splitSections(text, opts).sections[0]!.markdown).toBe('## A\n\nx');
  });

  it('is linear on a very long run of spaces and many headings', () => {
    const started = Date.now();
    splitSections(`## A${' '.repeat(1_000_000)}x\n\n## B ${' '.repeat(1_000_000)}\n`, opts);
    splitSections(Array.from({ length: 20_000 }, (_, i) => `## H${i}`).join('\n'), opts);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('review round 1: spreads and regex backtracking', () => {
  it('splits a document with 300,000 inner headings without a RangeError', () => {
    const started = Date.now();
    const { sections } = splitSections('## a\n\n## b\n' + '### h\nxxxxxxxxxx\n'.repeat(300_000), opts);
    expect(sections.length).toBeGreaterThan(1000);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('finishes on a long run of spaces and a long backtick line', () => {
    const started = Date.now();
    splitSections('#' + ' '.repeat(40_000) + ' \n\n## A\n\nx\n\n## B\n\ny\n', opts);
    splitSections('## A\n\n' + '`'.repeat(40_000) + '\n\n## B\n\ny\n', opts);
    splitSections('## A\n\n' + '`'.repeat(40_000) + ' x\n\n## B\n\ny\n', opts);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('finds headings that contain U+2028 and U+2029', () => {
    const { sections } = splitSections('# A\u2028x\n\ntext\n\n# B\u2029y\n\nmore\n\n# C\n', opts);
    expect(sections.map((s) => s.file)).toEqual(['01-a-x.md', '02-b-y.md', '03-c.md']);
  });
});
