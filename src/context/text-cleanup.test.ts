import { describe, expect, it } from 'vitest';
import { cleanupText } from './text-cleanup.js';

const page = (n: number, body: string): string => `${body}\nACME CONFIDENTIAL   ${n}\n`;

describe('cleanupText', () => {
  it('removes page furniture and the contents block, and turns contents titles into headings', () => {
    const text = [
      page(1, ['Contents', 'Overview ........ 3', '   Naming ........ 4', ''].join('\n')),
      page(2, ['Overview', '', 'The widget guide begins here.', '', '', '', 'More text.', ''].join('\n')),
      page(3, ['   Naming', '', 'Use short names.', ''].join('\n')),
    ].join('\f');
    const out = cleanupText(text);
    expect(out).not.toContain('ACME CONFIDENTIAL');
    expect(out).not.toContain('........');
    expect(out).not.toContain('Contents');
    expect(out).toBe(
      ['# Overview', '', 'The widget guide begins here.', '', 'More text.', '', '## Naming', '', 'Use short names.', ''].join('\n'),
    );
  });

  it('keeps a repeated line that is on at most half the pages', () => {
    const text = [page(1, 'Alpha text.'), 'Beta text.\n', 'Gamma text.\n', 'Delta text.\n'].join('\f');
    expect(cleanupText(text)).toContain('ACME CONFIDENTIAL   1');
  });

  it('needs at least 3 pages to treat a line as furniture', () => {
    const text = ['Alpha text.\nRepeat line\n', 'Beta text.\nRepeat line\n'].join('\f');
    expect(cleanupText(text)).toContain('Repeat line');
  });

  it('treats the whole text as one page without form feeds', () => {
    expect(cleanupText('Same line\n\nSame line\n\nSame line\n')).toContain('Same line');
  });

  it('without a contents block, makes short Title Case lines between blank lines level-2 headings', () => {
    const out = cleanupText(
      ['Intro text here.', '', 'Naming Rules', '', 'This sentence ends with a full stop.', '', 'Another Plain Sentence.', '', 'tail'].join('\n'),
    );
    expect(out).toContain('## Naming Rules');
    expect(out).not.toContain('## This sentence');
    expect(out).not.toContain('## Another Plain Sentence.');
  });

  it('rejects candidate headings that are numbers, too long, end in punctuation or are mostly lower case', () => {
    const long = `Word ${'x'.repeat(80)}`;
    const out = cleanupText(
      ['a', '', '12345', '', 'Heading With Colon:', '', 'Heading With Comma,', '', long, '', 'mostly lower case words here', '', 'z'].join('\n'),
    );
    expect(out).not.toMatch(/^## /m);
  });

  it('does not touch lines that are already Markdown headings', () => {
    expect(cleanupText('# Title\n\nBody.\n')).toBe('# Title\n\nBody.\n');
  });

  it('collapses blank runs and trims trailing spaces', () => {
    expect(cleanupText('one   \n\n\n\n\ntwo \n')).toBe('one\n\ntwo\n');
  });

  it('escapes heading text taken from the document', () => {
    const title = '[x](javascript:alert) <b>';
    const out = cleanupText([`${title} ........ 2`, '', title, '', 'body'].join('\n'));
    expect(out).toContain('# \\[x\\](javascript:alert) &lt;b&gt;');
    expect(out).not.toContain('[x](');
  });

  it('claims each body line once when a contents title repeats', () => {
    const out = cleanupText(['Setup ........ 1', 'Setup ........ 2', '', 'Setup', 'text', 'Setup', 'more'].join('\n'));
    expect(out.match(/^# Setup$/gm)).toHaveLength(2);
  });

  it('returns an empty string for empty text', () => {
    expect(cleanupText('')).toBe('');
    expect(cleanupText('\n \n')).toBe('');
  });

  describe('linear time on hostile input', () => {
    const MB = 1024 * 1024;
    const timed = (text: string): number => {
      const start = performance.now();
      cleanupText(text);
      return performance.now() - start;
    };

    it('handles a 1 MB line of dots', () => {
      expect(timed('.'.repeat(MB) + 'x')).toBeLessThan(2000);
      expect(timed('title ' + '.'.repeat(MB))).toBeLessThan(2000);
    });

    it('handles a 1 MB line of dots and digits', () => {
      expect(timed('a' + '.'.repeat(MB) + ' 1')).toBeLessThan(2000);
      expect(timed('.... 1'.repeat(MB / 6))).toBeLessThan(2000);
    });

    it('handles a 1 MB line of whitespace and words', () => {
      expect(timed(' '.repeat(MB) + 'x')).toBeLessThan(2000);
      expect(timed('Word '.repeat(MB / 5))).toBeLessThan(2000);
    });

    it('handles many pages and many short lines', () => {
      expect(timed('line one\nline 2\n\f'.repeat(50_000))).toBeLessThan(2000);
      expect(timed('Title Case\n\n'.repeat(100_000))).toBeLessThan(2000);
    });
  });
});
