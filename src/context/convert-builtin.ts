// src/context/convert-builtin.ts
// Converters for formats mocakit reads itself. Documents are untrusted: no converter throws, all scans are
// linear, and source text is escaped so it cannot inject raw HTML or links into the Markdown.
import { codeSpan } from '../codegen/emit-java-docs.js';
import { listZip, readZipEntry } from '../util/zip.js';
import { escapeText } from './sections.js';

export const BUILTIN_EXTENSIONS: readonly string[] = ['.md', '.txt', '.html', '.htm', '.docx', '.csv'];

export type ConvertResult = { markdown: string } | { error: string };

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_CSV_ROWS = 500;
const MAX_DOCX_XML = 32 * 1024 * 1024;
const MAX_INDENT = 6;

export function convertBuiltin(ext: string, bytes: Uint8Array): ConvertResult {
  const extension = ext.toLowerCase();
  try {
    switch (extension) {
      case '.md':
      case '.txt':
        return convertText(bytes);
      case '.html':
      case '.htm':
        return nonEmpty(htmlToMarkdown(decode(bytes)), 'the HTML has no text content');
      case '.docx':
        return convertDocx(bytes);
      case '.csv':
        return convertCsv(bytes);
      default:
        return { error: `no built-in converter for ${extension}` };
    }
  } catch (error) {
    return { error: `could not convert ${extension}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

function nonEmpty(markdown: string, message: string): ConvertResult {
  return markdown.trim() === '' ? { error: message } : { markdown };
}

function convertText(bytes: Uint8Array): ConvertResult {
  if (bytes.includes(0)) return { error: 'the file is not text (it contains NUL bytes)' };
  return { markdown: decode(bytes).split('\r\n').join('\n').split('\r').join('\n') };
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', laquo: '«',
  raquo: '»', times: '×', deg: '°', plusmn: '±',
};

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (match, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? match;
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Keep text that begins like Markdown structure (heading, list, rule, fence) from becoming structure. */
function escapeLeading(text: string): string {
  if (/^(?:#{1,6}(?:\s|$)|[-+*](?:\s|$)|[-=_*~]{3,})/.test(text)) return `\\${text}`;
  const numbered = /^(\d{1,9})([.)])(?:\s|$)/.exec(text);
  if (numbered) return `${numbered[1]}\\${text.slice(numbered[1]!.length)}`;
  return text;
}

class MdWriter {
  readonly lines: string[] = [];
  private last: 'none' | 'block' | 'list' = 'none';

  private gap(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.lines.push('');
  }
  block(text: string): void {
    this.gap();
    for (const line of text.split('\n')) this.lines.push(line);
    this.last = 'block';
  }
  item(text: string): void {
    if (this.last !== 'list') this.gap();
    this.lines.push(text);
    this.last = 'list';
  }
  /** The next block is not part of the list that just ended. */
  endList(): void {
    this.last = 'block';
  }
  toString(): string {
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`;
  }
}

const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_CELLS = 100_000;

/**
 * Pipe table from already-escaped cell text; the first row is the header. Shows at most 64 columns and 100,000
 * cells, with a note for what was left out. `naturalWidth` is the widest row before rows were cut to 64 cells and
 * `moreRows` counts rows the caller already left out.
 */
function renderTable(rows: string[][], naturalWidth = 0, moreRows = 0): string {
  let natural = naturalWidth;
  for (const row of rows) if (row.length > natural) natural = row.length;
  if (natural === 0) return '';
  const width = Math.min(natural, MAX_TABLE_COLUMNS);
  const shown = Math.min(rows.length, Math.max(1, Math.floor(MAX_TABLE_CELLS / width)));
  const cell = (text: string | undefined): string => collapse(text ?? '').split('|').join('\\|');
  const line = (row: string[]): string => `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(' | ')} |`;
  const out = [line(rows[0]!), `|${'---|'.repeat(width)}`];
  for (let i = 1; i < shown; i++) out.push(line(rows[i]!));
  const parts = [out.join('\n')];
  if (natural > width) parts.push(`_${natural - width} more columns not shown_`);
  const hidden = moreRows + rows.length - shown;
  if (hidden > 0) parts.push(`_${hidden} more rows not shown_`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------------------------------------------
// HTML

const BLOCK_TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'blockquote', 'figure', 'figcaption',
  'form', 'address', 'details', 'summary', 'dl', 'dt', 'dd', 'fieldset', 'hr', 'center', 'caption',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea']);
const HEAD_TAGS = new Set(['head', 'title', 'meta', 'link', 'base', 'style', 'script', 'noscript', 'template']);

const isAlpha = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isNameChar = (code: number): boolean => isAlpha(code) || (code >= 48 && code <= 57) || code === 45 || code === 58 || code === 95;

function safeHref(raw: string | null): string | null {
  if (raw === null) return null;
  const href = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!/^(?:https?|mailto):/i.test(href)) return null;
  return href.replace(/[()<>\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function hrefOf(attrs: string): string | null {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

// Private-use characters stand in for emphasis and link markers while a block is collected; they are
// resolved (whitespace moved outside, empty spans dropped, unclosed spans closed) in one pass by renderInline.
const OPEN_STRONG = '';
const OPEN_EM = '';
const OPEN_LINK = '';
const CLOSE_MARK = '';
const MARKERS = /[-]/g;

interface OpenSpan {
  kind: string;
  href: string;
  emitted: boolean;
}

/** Join the chunks of one block, resolving the marker characters. Linear in the size of the chunks. */
function renderInline(chunks: string[], hrefs: string[]): string {
  const joinedText = chunks.join('');
  const out: string[] = [];
  const stack: OpenSpan[] = [];
  let firstPending = 0;
  let pendingSpace = '';
  let nextHref = 0;
  const closer = (span: OpenSpan): string => (span.kind === OPEN_STRONG ? '**' : span.kind === OPEN_EM ? '*' : `](${span.href})`);
  const opener = (span: OpenSpan): string => (span.kind === OPEN_STRONG ? '**' : span.kind === OPEN_EM ? '*' : '[');

  const content = (segment: string): void => {
    const trimmedStart = segment.trimStart();
    if (trimmedStart === '') {
      pendingSpace += segment;
      return;
    }
    const core = trimmedStart.trimEnd();
    pendingSpace += segment.slice(0, segment.length - trimmedStart.length);
    out.push(pendingSpace);
    for (let i = firstPending; i < stack.length; i++) {
      stack[i]!.emitted = true;
      out.push(opener(stack[i]!));
    }
    firstPending = stack.length;
    out.push(core);
    pendingSpace = trimmedStart.slice(core.length);
  };

  let last = 0;
  MARKERS.lastIndex = 0;
  for (let m = MARKERS.exec(joinedText); m !== null; m = MARKERS.exec(joinedText)) {
    if (m.index > last) content(joinedText.slice(last, m.index));
    last = m.index + 1;
    if (m[0] === CLOSE_MARK) {
      const span = stack.pop();
      if (span) {
        if (span.emitted) out.push(closer(span));
        firstPending = Math.min(firstPending, stack.length);
      }
    } else {
      stack.push({ kind: m[0], href: m[0] === OPEN_LINK ? (hrefs[nextHref++] ?? '') : '', emitted: false });
    }
  }
  if (last < joinedText.length) content(joinedText.slice(last));
  while (stack.length > 0) {
    const span = stack.pop()!;
    if (span.emitted) out.push(closer(span));
  }
  out.push(pendingSpace);
  return out.join('');
}

class HtmlConverter {
  private readonly out = new MdWriter();
  private chunks: string[] = [];
  private hrefs: string[] = [];
  /** Open inline tags of the current block: only a close tag that matches the top is honoured. */
  private spans: { tag: string; marker: boolean }[] = [];
  private inHead = false;
  private inPre = false;
  private pre = '';
  private codeBuf: string | null = null;
  private heading = 0;
  private readonly lists: { ordered: boolean; count: number; prefix: string | null; used: boolean }[] = [];
  private tableDepth = 0;
  private rows: string[][] = [];
  private row: string[] | null = null;
  private cellCount = 0;
  private widest = 0;
  private cellOpen = false;

  convert(html: string): string {
    const n = html.length;
    let i = 0;
    while (i < n) {
      const lt = html.indexOf('<', i);
      if (lt === -1) {
        this.text(html.slice(i));
        break;
      }
      if (lt > i) this.text(html.slice(i, lt));
      i = lt;
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      const next = html[i + 1];
      if (next === '!' || next === '?') {
        const end = html.indexOf('>', i + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      const closing = next === '/';
      const nameStart = closing ? i + 2 : i + 1;
      if (nameStart >= n || !isAlpha(html.charCodeAt(nameStart))) {
        this.text('<');
        i += 1;
        continue;
      }
      let nameEnd = nameStart;
      while (nameEnd < n && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
      const name = html.slice(nameStart, nameEnd).toLowerCase();

      // Find the end of the tag. A quote only opens a value right after `=`.
      let j = nameEnd;
      let end = -1;
      let prev = '';
      while (j < n) {
        const c = html[j]!;
        if (c === '>') {
          end = j;
          break;
        }
        if ((c === '"' || c === "'") && prev === '=') {
          const close = html.indexOf(c, j + 1);
          if (close === -1) break;
          j = close + 1;
          prev = c;
          continue;
        }
        if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prev = c;
        j++;
      }
      if (end === -1) break;
      const attrs = html.slice(nameEnd, end);
      i = end + 1;
      if (closing) {
        this.close(name);
        continue;
      }
      this.open(name, attrs);
      if (RAW_TEXT_TAGS.has(name) && !attrs.endsWith('/')) i = this.skipRaw(html, i, name);
    }
    this.finish();
    return this.out.toString();
  }

  /** Index just after the closing tag of a raw-text element, or the end of the input. */
  private skipRaw(html: string, from: number, name: string): number {
    let k = html.indexOf('</', from);
    while (k !== -1) {
      if (html.slice(k + 2, k + 2 + name.length).toLowerCase() === name && !isNameChar(html.charCodeAt(k + 2 + name.length) || 0)) {
        const end = html.indexOf('>', k);
        return end === -1 ? html.length : end + 1;
      }
      k = html.indexOf('</', k + 2);
    }
    return html.length;
  }

  private text(raw: string): void {
    if (this.inHead) return;
    const text = decodeEntities(raw).replace(MARKERS, '');
    if (this.inPre) this.pre += text.split(' ').join(' ');
    else if (this.codeBuf !== null) this.codeBuf += text;
    else this.chunks.push(escapeText(text.replace(/\s+/g, ' ')));
  }

  /** The collected inline text of the current block, with markers resolved; resets the block. */
  private takeInline(): string {
    const text = renderInline(this.chunks, this.hrefs);
    this.chunks = [];
    this.hrefs = [];
    this.spans = [];
    return text;
  }

  /** Emit the pending inline text as a paragraph or list line (inside a table cell it becomes a space). */
  private flush(): void {
    if (this.cellOpen) {
      this.chunks.push(' ');
      return;
    }
    const text = escapeLeading(collapse(this.takeInline()));
    if (text === '') return;
    const list = this.lists[this.lists.length - 1];
    if (list && list.prefix !== null) {
      this.out.item(list.used ? `${' '.repeat(list.prefix.length)}${text}` : `${list.prefix}${text}`);
      list.used = true;
    } else this.out.block(text);
  }

  private closeHeading(): void {
    const level = this.heading;
    this.heading = 0;
    const text = collapse(this.takeInline());
    if (this.cellOpen) this.chunks.push(`${text} `);
    else if (text !== '') this.out.block(`${'#'.repeat(level)} ${text}`);
  }

  private breakBlock(): void {
    if (this.heading > 0) this.closeHeading();
    else this.flush();
  }

  private openSpan(tag: string, marker: string | null): void {
    this.spans.push({ tag, marker: marker !== null });
    if (marker !== null) this.chunks.push(marker);
  }

  private closeSpan(tag: string): void {
    const top = this.spans[this.spans.length - 1];
    if (!top || top.tag !== tag) return;
    this.spans.pop();
    if (top.marker) this.chunks.push(CLOSE_MARK);
  }

  private open(name: string, attrs: string): void {
    if (this.inHead) {
      if (name === 'body' || !HEAD_TAGS.has(name)) this.inHead = false;
      else return;
    }
    if (name === 'head') {
      this.inHead = true;
      return;
    }
    if (this.inPre) {
      if (name === 'br') this.pre += '\n';
      return;
    }
    if (this.codeBuf !== null) return;
    switch (name) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        this.breakBlock();
        this.heading = Number(name[1]);
        return;
      case 'ul': case 'ol':
        this.breakBlock();
        this.lists.push({ ordered: name === 'ol', count: 0, prefix: null, used: false });
        return;
      case 'li': {
        this.breakBlock();
        if (this.lists.length === 0) this.lists.push({ ordered: false, count: 0, prefix: null, used: false });
        const list = this.lists[this.lists.length - 1]!;
        list.count++;
        list.prefix = `${'  '.repeat(Math.min(this.lists.length - 1, MAX_INDENT))}${list.ordered ? `${list.count}. ` : '- '}`;
        list.used = false;
        return;
      }
      case 'pre':
        this.breakBlock();
        this.inPre = true;
        this.pre = '';
        return;
      case 'code':
        this.codeBuf = '';
        return;
      case 'a': {
        const href = safeHref(hrefOf(attrs));
        if (href !== null) this.hrefs.push(href);
        this.openSpan('a', href !== null ? OPEN_LINK : null);
        return;
      }
      case 'b': case 'strong':
        this.openSpan(name, OPEN_STRONG);
        return;
      case 'i': case 'em':
        this.openSpan(name, OPEN_EM);
        return;
      case 'br':
        this.chunks.push(' ');
        return;
      case 'table':
        if (this.tableDepth === 0) {
          this.breakBlock();
          this.rows = [];
          this.row = null;
          this.cellOpen = false;
        } else this.chunks.push(' ');
        this.tableDepth++;
        return;
      case 'tr':
        if (this.tableDepth === 1) {
          this.endRow();
          this.row = [];
        } else this.chunks.push(' ');
        return;
      case 'td': case 'th':
        if (this.tableDepth === 1) {
          this.endCell();
          if (!this.row) this.row = [];
          this.cellOpen = true;
          this.takeInline();
        } else this.chunks.push(' ');
        return;
      default:
        if (name === 'p' || BLOCK_TAGS.has(name)) this.breakBlock();
    }
  }

  private close(name: string): void {
    if (this.inHead) {
      if (name === 'head') this.inHead = false;
      return;
    }
    if (this.inPre) {
      if (name === 'pre') this.endPre();
      return;
    }
    if (this.codeBuf !== null) {
      if (name === 'code') this.endCode();
      return;
    }
    switch (name) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (this.heading > 0) this.closeHeading();
        return;
      case 'ul': case 'ol':
        this.breakBlock();
        this.lists.pop();
        if (this.lists.length === 0) this.out.endList();
        return;
      case 'li': {
        this.breakBlock();
        const list = this.lists[this.lists.length - 1];
        if (list) list.prefix = null;
        return;
      }
      case 'a':
        this.closeSpan('a');
        return;
      case 'b': case 'strong': case 'i': case 'em':
        this.closeSpan(name);
        return;
      case 'table':
        if (this.tableDepth === 0) return;
        this.tableDepth--;
        if (this.tableDepth === 0) this.endTable();
        else this.chunks.push(' ');
        return;
      case 'tr':
        if (this.tableDepth === 1) this.endRow();
        else this.chunks.push(' ');
        return;
      case 'td': case 'th':
        if (this.tableDepth === 1) this.endCell();
        else this.chunks.push(' ');
        return;
      default:
        if (name === 'p' || BLOCK_TAGS.has(name)) this.breakBlock();
    }
  }

  private endCode(): void {
    const code = this.codeBuf ?? '';
    this.codeBuf = null;
    if (code.trim() !== '') this.chunks.push(codeSpan(code));
  }

  private endCell(): void {
    if (!this.cellOpen) return;
    this.cellOpen = false;
    const text = collapse(this.takeInline());
    this.cellCount++;
    if (this.row && this.row.length < MAX_TABLE_COLUMNS) this.row.push(text);
  }

  private endRow(): void {
    this.endCell();
    if (this.row && this.row.length > 0) this.rows.push(this.row);
    if (this.cellCount > this.widest) this.widest = this.cellCount;
    this.cellCount = 0;
    this.row = null;
  }

  private endTable(): void {
    this.endRow();
    const rows = this.rows;
    const widest = this.widest;
    this.rows = [];
    this.widest = 0;
    this.takeInline();
    const table = renderTable(rows, widest);
    if (table !== '') this.out.block(table);
  }

  private endPre(): void {
    this.inPre = false;
    const body = this.pre.replace(/^\n/, '').replace(/\n+$/, '');
    this.pre = '';
    if (body.trim() === '') return;
    if (this.cellOpen) {
      this.chunks.push(`${codeSpan(body)} `);
      return;
    }
    let longest = 0;
    for (const run of body.match(/`+/g) ?? []) if (run.length > longest) longest = run.length;
    const fence = '`'.repeat(Math.max(3, longest + 1));
    this.out.block(`${fence}\n${body}\n${fence}`);
  }

  private finish(): void {
    if (this.inPre) this.endPre();
    if (this.codeBuf !== null) this.endCode();
    if (this.tableDepth > 0) {
      this.tableDepth = 0;
      this.endTable();
    }
    this.breakBlock();
  }
}

export function htmlToMarkdown(html: string): string {
  return new HtmlConverter().convert(html);
}

// ---------------------------------------------------------------------------------------------------------------
// DOCX

const SKIPPED_XML = new Set(['drawing', 'pict', 'Fallback', 'object']);
const attrPatterns = new Map<string, RegExp>();

function xmlAttr(attrs: string, name: string): string | null {
  let pattern = attrPatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrPatterns.set(name, pattern);
  }
  const m = pattern.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : null;
}

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Already-formed Markdown (an image marker): neither escaped nor emphasised. */
  literal: boolean;
}

function renderSegments(segments: Segment[], plain: boolean): string {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && !last.literal && !segment.literal && last.bold === segment.bold && last.italic === segment.italic) last.text += segment.text;
    else merged.push({ ...segment });
  }
  const text = merged
    .map((segment) => {
      if (segment.literal) return segment.text;
      const escaped = escapeText(segment.text);
      if (plain || (!segment.bold && !segment.italic)) return escaped;
      const core = escaped.trim();
      if (core === '') return escaped;
      const lead = escaped.slice(0, escaped.length - escaped.trimStart().length);
      const trail = escaped.slice(escaped.trimEnd().length);
      const mark = segment.bold && segment.italic ? '***' : segment.bold ? '**' : '*';
      return `${lead}${mark}${core}${mark}${trail}`;
    })
    .join('');
  return collapse(text);
}

class DocxConverter {
  private readonly out = new MdWriter();
  private skipName: string | null = null;
  private skipDepth = 0;
  private imageLabel: string | null = null;
  private inParagraph = false;
  private inPPr = false;
  private style = '';
  private listLevel = -1;
  private segments: Segment[] = [];
  private inRun = false;
  private inRPr = false;
  private bold = false;
  private italic = false;
  private runText = '';
  private inText = false;
  private tableDepth = 0;
  private rows: string[][] = [];
  private row: string[] = [];
  private rowWidth = 0;
  private widest = 0;
  private cell: string[] = [];

  convert(xml: string): string {
    const n = xml.length;
    let i = 0;
    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt === -1) break;
      if (lt > i && this.inText && this.skipName === null) this.runText += decodeEntities(xml.slice(i, lt));
      i = lt;
      if (xml.startsWith('<!--', i)) {
        const end = xml.indexOf('-->', i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', i)) {
        const end = xml.indexOf(']]>', i + 9);
        if (this.inText && this.skipName === null) this.runText += xml.slice(i + 9, end === -1 ? n : end);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml[i + 1] === '?' || xml[i + 1] === '!') {
        const end = xml.indexOf('>', i + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      const closing = xml[i + 1] === '/';
      const nameStart = closing ? i + 2 : i + 1;
      let nameEnd = nameStart;
      while (nameEnd < n && !/[\s/>]/.test(xml[nameEnd]!)) nameEnd++;
      let j = nameEnd;
      while (j < n && xml[j] !== '>') {
        const c = xml[j]!;
        if (c === '"' || c === "'") {
          const close = xml.indexOf(c, j + 1);
          if (close === -1) {
            j = n;
            break;
          }
          j = close + 1;
        } else j++;
      }
      if (j >= n) break;
      const qualified = xml.slice(nameStart, nameEnd);
      const local = qualified.slice(qualified.indexOf(':') + 1);
      const attrs = xml.slice(nameEnd, j);
      const selfClosing = xml[j - 1] === '/';
      i = j + 1;
      if (closing) this.close(local);
      else {
        this.open(local, attrs, selfClosing);
        if (selfClosing && !(this.skipName !== null && local === this.skipName)) this.close(local);
      }
    }
    return this.out.toString();
  }

  private open(name: string, attrs: string, selfClosing: boolean): void {
    if (this.skipName !== null) {
      if (name === this.skipName && !selfClosing) this.skipDepth++;
      else if (this.skipName === 'drawing' && name === 'docPr' && this.imageLabel === null) {
        this.imageLabel = xmlAttr(attrs, 'descr')?.trim() || xmlAttr(attrs, 'name')?.trim() || '';
      }
      return;
    }
    if (SKIPPED_XML.has(name)) {
      if (!selfClosing) {
        this.skipName = name;
        this.skipDepth = 1;
        this.imageLabel = null;
      } else if (name === 'drawing') this.addImage('');
      return;
    }
    switch (name) {
      case 'tbl':
        if (this.tableDepth++ === 0) this.rows = [];
        return;
      case 'tr':
        if (this.tableDepth === 1) this.row = [];
        return;
      case 'tc':
        if (this.tableDepth === 1) this.cell = [];
        return;
      case 'p':
        this.inParagraph = true;
        this.style = '';
        this.listLevel = -1;
        this.segments = [];
        return;
      case 'pPr':
        this.inPPr = true;
        return;
      case 'pStyle':
        if (this.inPPr) this.style = xmlAttr(attrs, 'val') ?? '';
        return;
      case 'numPr':
        if (this.inPPr && this.listLevel < 0) this.listLevel = 0;
        return;
      case 'ilvl':
        if (this.inPPr) this.listLevel = Math.max(0, Number.parseInt(xmlAttr(attrs, 'val') ?? '0', 10) || 0);
        return;
      case 'r':
        this.inRun = true;
        this.bold = false;
        this.italic = false;
        this.runText = '';
        return;
      case 'rPr':
        this.inRPr = this.inRun;
        return;
      case 'b':
      case 'i': {
        if (!this.inRPr) return;
        const val = xmlAttr(attrs, 'val');
        const on = val === null || !['0', 'false', 'off'].includes(val.toLowerCase());
        if (name === 'b') this.bold = on;
        else this.italic = on;
        return;
      }
      case 't':
        if (this.inRun) this.inText = true;
        return;
      case 'tab':
      case 'br':
      case 'cr':
        if (this.inRun) this.runText += ' ';
        return;
      case 'noBreakHyphen':
        if (this.inRun) this.runText += '-';
        return;
      default:
    }
  }

  private close(name: string): void {
    if (this.skipName !== null) {
      if (name === this.skipName && --this.skipDepth === 0) {
        const wasDrawing = this.skipName === 'drawing';
        this.skipName = null;
        if (wasDrawing) this.addImage(this.imageLabel ?? '');
        this.imageLabel = null;
      }
      return;
    }
    switch (name) {
      case 'pPr':
        this.inPPr = false;
        return;
      case 'rPr':
        this.inRPr = false;
        return;
      case 't':
        this.inText = false;
        return;
      case 'r':
        if (this.inRun && this.runText !== '') {
          this.segments.push({ text: this.runText, bold: this.bold, italic: this.italic, literal: false });
        }
        this.inRun = false;
        this.inText = false;
        this.runText = '';
        return;
      case 'p':
        this.endParagraph();
        return;
      case 'tc':
        if (this.tableDepth === 1) {
          this.rowWidth++;
          if (this.row.length < MAX_TABLE_COLUMNS) this.row.push(this.cell.join(' '));
        }
        return;
      case 'tr':
        if (this.tableDepth === 1 && this.row.length > 0) this.rows.push(this.row);
        if (this.tableDepth === 1) {
          this.widest = Math.max(this.widest, this.rowWidth);
          this.rowWidth = 0;
          this.row = [];
        }
        return;
      case 'tbl':
        if (this.tableDepth === 0) return;
        if (--this.tableDepth === 0) {
          const table = renderTable(this.rows, this.widest);
          this.rows = [];
          this.widest = 0;
          if (table !== '') this.out.block(table);
        }
        return;
      default:
    }
  }

  private addImage(label: string): void {
    if (!this.inParagraph) return;
    // A run that holds the drawing may also hold text; keep what came first.
    if (this.runText !== '') {
      this.segments.push({ text: this.runText, bold: this.bold, italic: this.italic, literal: false });
      this.runText = '';
    }
    const text = label === '' ? '\\[image\\]' : `\\[image: ${escapeText(label)}\\]`;
    this.segments.push({ text, bold: false, italic: false, literal: true });
  }

  private endParagraph(): void {
    if (!this.inParagraph) return;
    this.inParagraph = false;
    const level = /^heading\s*([1-6])$/i.exec(this.style)?.[1];
    const heading = level ? Number(level) : /^title$/i.test(this.style) ? 1 : 0;
    const text = renderSegments(this.segments, heading > 0);
    this.segments = [];
    if (text === '') return;
    if (this.tableDepth > 0) this.cell.push(text);
    else if (heading > 0) this.out.block(`${'#'.repeat(heading)} ${text}`);
    else if (this.listLevel >= 0 || /^list/i.test(this.style)) {
      this.out.item(`${'  '.repeat(Math.min(Math.max(this.listLevel, 0), MAX_INDENT))}- ${text}`);
    } else this.out.block(escapeLeading(text));
  }
}

function convertDocx(bytes: Uint8Array): ConvertResult {
  let xml: string;
  try {
    const entry = listZip(bytes).find((e) => e.name === 'word/document.xml');
    if (!entry) return { error: 'the docx has no word/document.xml' };
    xml = decode(readZipEntry(bytes, entry, { maxEntrySize: MAX_DOCX_XML }));
  } catch (error) {
    return { error: `unreadable docx: ${error instanceof Error ? error.message : String(error)}` };
  }
  return nonEmpty(new DocxConverter().convert(xml), 'the docx has no text content');
}

// ---------------------------------------------------------------------------------------------------------------
// CSV

/** RFC 4180 parsing. Keeps the header and at most `keep` data rows, and counts the rest. */
function parseCsv(text: string, keep: number): { rows: string[][]; extra: number } {
  const rows: string[][] = [];
  let extra = 0;
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;
  const endRow = (): void => {
    row.push(field);
    const blank = row.length === 1 && field === '' && !started;
    if (!blank) {
      if (rows.length < keep + 1) rows.push(row);
      else extra++;
    }
    row = [];
    field = '';
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
      started = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== '') endRow();
  return { rows, extra };
}

function convertCsv(bytes: Uint8Array): ConvertResult {
  if (bytes.length > MAX_CSV_BYTES) return { error: 'the CSV is larger than 10 MiB; it was not parsed' };
  const { rows, extra } = parseCsv(decode(bytes), MAX_CSV_ROWS);
  if (!rows.some((row) => row.some((cell) => cell.trim() !== ''))) return { error: 'the CSV has no content' };
  let widest = 0;
  for (const row of rows) if (row.length > widest) widest = row.length;
  const table = renderTable(rows.map((row) => row.slice(0, MAX_TABLE_COLUMNS).map(escapeText)), widest, extra);
  return { markdown: `${table}\n` };
}
