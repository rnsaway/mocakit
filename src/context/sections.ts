// src/context/sections.ts
// Slugs and section splitting for agent-context documents. Pure and deterministic.

export interface Section {
  /** File name inside the document's folder, e.g. `01-setup.md`. */
  file: string;
  heading: string;
  level: number;
  /** Section Markdown, starting with its heading, without a trailing newline. */
  markdown: string;
  firstSentence: string;
  /** Headings one level down, in order. */
  subheadings: string[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

const MAX_DOC_SLUG = 80;
const MAX_SECTION_SLUG = 60;

/** NFKD, marks dropped, lowercase, runs of anything but [a-z0-9] become `-`, trimmed. */
export function slugify(text: string, fallback: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? fallback : slug;
}

function capSlug(slug: string, max: number, fallback: string): string {
  return slug.length <= max ? slug : slugify(slug.slice(0, max), fallback);
}

/** Document slugs by source path, assigned in sorted path order; collisions get `-2`, `-3`, ... */
export function assignDocSlugs(sourcePaths: string[]): Map<string, string> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const path of [...new Set(sourcePaths)].sort(compare)) {
    const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const slug = capSlug(slugify(stem, 'document'), MAX_DOC_SLUG, 'document');
    let candidate = slug;
    for (let n = 2; used.has(candidate); n++) candidate = `${slug}-${n}`;
    used.add(candidate);
    result.set(path, candidate);
  }
  return result;
}

/** Escape text taken from an untrusted document so it renders as plain text and cannot form HTML or links. */
export function escapeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '[' || ch === ']' || ch === '`') out += `\\${ch}`;
    else if (ch === '\\') {
      const next = text[i + 1];
      out += next === undefined || /[!-/:-@[-`{-~]/.test(next) ? '\\\\' : '\\';
    } else if (ch === '&' && /^#?[A-Za-z0-9]{1,32};/.test(text.slice(i + 1, i + 35))) out += '&amp;';
    else out += ch;
  }
  return out;
}

interface Heading {
  line: number;
  level: number;
  text: string;
}

interface Scan {
  headings: Heading[];
  /** True for fence opener, content and closer lines. */
  inFence: boolean[];
}

/** ATX headings outside fenced code (``` and ~~~, closing fence at least as long as the opener). */
function scan(lines: string[]): Scan {
  const headings: Heading[] = [];
  const inFence: boolean[] = new Array<boolean>(lines.length).fill(false);
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      inFence[i] = true;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      inFence[i] = true;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (atx) {
      let text = atx[2]!.trimEnd();
      let end = text.length;
      while (end > 0 && text[end - 1] === '#') end--;
      if (end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trimEnd();
      headings.push({ line: i, level: atx[1]!.length, text: text.trim() });
    }
  }
  return { headings, inFence };
}

const GFM_PUNCT = /\\([!-/:-@[-`{-~])/g;

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^<>]*>/g, '')
    .replace(/`+/g, '')
    .replace(/\*\*|__|\*|~~/g, '')
    .replace(GFM_PUNCT, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First sentence of the section body (Markdown stripped, at most 200 characters). */
function firstSentenceOf(lines: string[], fences: boolean[]): string {
  let i = 1;
  const paragraph: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const skip = fences[i] || /^ {0,3}#{1,6}[ \t]/.test(line) || /^\s*\|/.test(line) || /^\s*<!--/.test(line);
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    if (skip) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.replace(/^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,9}[.)])\s+)?/, ''));
    if (paragraph.join(' ').length > 2000) break;
  }
  const text = stripMarkdown(paragraph.join(' ').slice(0, 2000));
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return sentence.length <= 200 ? sentence : `${sentence.slice(0, 199)}…`;
}

interface Piece {
  heading: string;
  level: number;
  /** Starts with the heading line. */
  lines: string[];
  base: string;
  part: number;
  intro: boolean;
}

const sectionBase = (heading: string): string => capSlug(slugify(heading, 'section'), MAX_SECTION_SLUG, 'section');
const joined = (lines: string[]): string => lines.join('\n').trim();

/** Split an oversize piece at the next heading level inside it, else at paragraph boundaries. */
function refine(piece: Piece, max: number): Piece[] {
  if (bytes(joined(piece.lines)) <= max) return [piece];
  const { headings } = scan(piece.lines);
  const inner = headings.filter((h) => h.line > 0 && h.level > piece.level);
  if (inner.length === 0) return partSplit(piece, max);

  const childLevel = Math.min(...inner.map((h) => h.level));
  const starts = inner.filter((h) => h.level === childLevel);
  const result: Piece[] = [];
  const lead = piece.lines.slice(0, starts[0]!.line);
  if (joined(lead.slice(1)) !== '') result.push(...refine({ ...piece, lines: lead }, max));
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]!.line : piece.lines.length;
    result.push(
      ...refine(
        { heading: start.text, level: childLevel, lines: piece.lines.slice(start.line, end), base: sectionBase(start.text), part: 1, intro: false },
        max,
      ),
    );
  });
  return result;
}

const utf8Length = (codePoint: number): number => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);

/** Cut text into chunks of at most `budget` bytes, at line edges where possible, else at character edges. */
function hardSplit(text: string, budget: number): string[] {
  const chunks: string[] = [];
  let lines: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (lines.length > 0) chunks.push(lines.join('\n'));
    lines = [];
    size = 0;
  };
  for (const line of text.split('\n')) {
    const length = bytes(line);
    if (length <= budget) {
      if (lines.length > 0 && size + 1 + length > budget) flush();
      size += (lines.length > 0 ? 1 : 0) + length;
      lines.push(line);
      continue;
    }
    flush();
    let rest = '';
    let restSize = 0;
    for (const ch of line) {
      const width = utf8Length(ch.codePointAt(0)!);
      if (restSize + width > budget) {
        chunks.push(rest);
        rest = '';
        restSize = 0;
      }
      rest += ch;
      restSize += width;
    }
    if (rest !== '') chunks.push(rest);
  }
  flush();
  return chunks;
}

function partSplit(piece: Piece, max: number): Piece[] {
  const { inFence } = scan(piece.lines);
  const paragraphs: string[] = [];
  let current: string[] = [];
  piece.lines.forEach((line, i) => {
    if (line.trim() === '' && !inFence[i]) {
      if (current.length > 0) paragraphs.push(current.join('\n'));
      current = [];
    } else current.push(line);
  });
  if (current.length > 0) paragraphs.push(current.join('\n'));

  // The label is shortened so a very long heading cannot eat the whole size budget.
  const label = piece.heading.slice(0, Math.min(80, Math.floor(max / 4)));
  const continuation = (part: number): string => `${'#'.repeat(piece.level)} ${label} (part ${part})`;
  const budgetFor = (part: number): number => (part === 1 ? max : Math.max(1, max - bytes(continuation(part)) - 2));

  const parts: string[][] = [[]];
  let size = 0;
  const flushPart = (): void => {
    parts.push([]);
    size = 0;
  };
  for (const paragraph of paragraphs) {
    const budget = budgetFor(parts.length);
    const pieces = bytes(paragraph) <= budget ? [paragraph] : hardSplit(paragraph, Math.max(1, budgetFor(parts.length + 1)));
    for (const text of pieces) {
      const current = parts[parts.length - 1]!;
      const cost = bytes(text) + (current.length > 0 ? 2 : 0);
      if (current.length > 0 && size + cost > budgetFor(parts.length)) {
        flushPart();
        parts[parts.length - 1]!.push(text);
        size = bytes(text);
      } else {
        current.push(text);
        size += cost;
      }
    }
  }
  const nonEmpty = parts.filter((p) => p.length > 0);
  return nonEmpty.map((paras, k) => {
    const part = k + 1;
    const body = part === 1 ? paras : [continuation(part), ...paras];
    return {
      heading: part === 1 ? piece.heading : `${piece.heading} (part ${part})`,
      level: piece.level,
      lines: body.join('\n\n').split('\n'),
      base: piece.base,
      part,
      intro: piece.intro && part === 1,
    };
  });
}

function toSection(piece: Piece, file: string): Section {
  const lines = joined(piece.lines).split('\n');
  const { headings, inFence } = scan(lines);
  return {
    file,
    heading: piece.heading,
    level: piece.level,
    markdown: lines.join('\n'),
    firstSentence: firstSentenceOf(lines, inFence),
    subheadings: headings.filter((h) => h.line > 0 && h.level === piece.level + 1).map((h) => h.text),
  };
}

export function splitSections(
  markdown: string,
  opts: { docSlug: string; fileTitle: string; maxSectionBytes: number },
): { title: string; sections: Section[] } {
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const lines = text.split(/\r\n?|\n/);
  const { headings } = scan(lines);
  const max = Math.max(1, opts.maxSectionBytes);

  const count = new Array<number>(7).fill(0);
  for (const h of headings) count[h.level]!++;
  let splitLevel = 0;
  for (let level = 1; level <= 6 && splitLevel === 0; level++) if (count[level]! >= 2) splitLevel = level;

  let title = opts.fileTitle;
  let pieces: Piece[];

  if (splitLevel === 0) {
    // One section: the whole document, under a heading of its own.
    const first = lines.findIndex((l) => l.trim() !== '');
    const head = first >= 0 ? headings.find((h) => h.line === first) : undefined;
    const body = head ? lines : [`# ${escapeText(opts.fileTitle)}`, '', ...lines];
    pieces = refine(
      { heading: head ? head.text : opts.fileTitle, level: head ? head.level : 1, lines: body, base: capSlug(opts.docSlug, MAX_DOC_SLUG, 'document'), part: 1, intro: false },
      max,
    );
  } else {
    const higher = headings.filter((h) => h.level < splitLevel);
    let introStart = 0;
    if (higher.length === 1 && higher[0] === headings[0]) {
      title = higher[0]!.text;
      introStart = higher[0]!.line + 1;
    }
    const starts = headings.filter((h) => h.level === splitLevel);
    pieces = [];
    const introLines = lines.slice(introStart, starts[0]!.line);
    if (joined(introLines) !== '') {
      pieces.push(
        ...refine(
          { heading: 'Introduction', level: splitLevel, lines: [`${'#'.repeat(splitLevel)} Introduction`, '', ...introLines], base: 'introduction', part: 1, intro: true },
          max,
        ),
      );
    }
    starts.forEach((start, k) => {
      const end = k + 1 < starts.length ? starts[k + 1]!.line : lines.length;
      pieces.push(
        ...refine({ heading: start.text, level: splitLevel, lines: lines.slice(start.line, end), base: sectionBase(start.text), part: 1, intro: false }, max),
      );
    });
  }

  const hasIntro = pieces[0]?.intro === true;
  const highest = pieces.length - (hasIntro ? 1 : 0);
  const width = highest > 99 ? 3 : 2;
  const sections = pieces.map((piece, i) => {
    const number = hasIntro ? i : i + 1;
    const suffix = piece.part > 1 ? `-part-${piece.part}` : '';
    return toSection(piece, `${String(number).padStart(width, '0')}-${piece.base}${suffix}.md`);
  });
  return { title, sections };
}
