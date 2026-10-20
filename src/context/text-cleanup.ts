import { escapeText } from './sections.js';

/** Contents titles and heading candidates longer than this are never treated as headings. */
const MAX_TITLE_LENGTH = 300;
const MAX_HEADING_LENGTH = 80;
const MAX_LEVEL = 6;

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\v' || ch === ' ' || /\s/.test(ch);
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const isBlank = (line: string): boolean => line.trim() === '';

/**
 * Contents entry: `<indent><title> ....<spaces><digits>`. Same shape as `^\s*(.+?)\s*\.{4,}\s*\d+\s*$`,
 * but scanned once from the end so a long run of dots cannot cause backtracking.
 */
function parseContentsLine(line: string): { indent: number; title: string } | null {
  let end = line.length;
  while (end > 0 && isSpace(line[end - 1]!)) end--;
  const digitsEnd = end;
  while (end > 0 && isDigit(line.charCodeAt(end - 1))) end--;
  if (end === digitsEnd) return null;
  while (end > 0 && isSpace(line[end - 1]!)) end--;
  const dotsEnd = end;
  while (end > 0 && line[end - 1] === '.') end--;
  if (dotsEnd - end < 4) return null;
  let start = 0;
  while (start < end && isSpace(line[start]!)) start++;
  let titleEnd = end;
  while (titleEnd > start && isSpace(line[titleEnd - 1]!)) titleEnd--;
  if (titleEnd === start || titleEnd - start > MAX_TITLE_LENGTH) return null;
  return { indent: start, title: line.slice(start, titleEnd) };
}

function startsWithCapital(word: string): boolean {
  const ch = word[0]!;
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

function looksLikeHeading(line: string): boolean {
  const text = line.trim();
  if (text === '' || text.length > MAX_HEADING_LENGTH || text.startsWith('#')) return false;
  if (/[.,:]$/.test(text) || /^\d+$/.test(text)) return false;
  const words = text.split(/\s+/);
  let capitals = 0;
  for (const word of words) if (startsWithCapital(word)) capitals++;
  return capitals * 2 >= words.length;
}

/** Page header/footer lines: same text (digits and spacing ignored) on more than half the pages, and on at least 3. */
function removeFurniture(pages: string[][]): string[] {
  const pageCount = pages.length;
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const keys = new Set<string>();
    for (const line of lines) {
      const key = collapse(line.replace(/\d+/g, ''));
      if (key !== '') keys.add(key);
    }
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const furniture = new Set<string>();
  for (const [key, n] of counts) if (n >= 3 && n * 2 > pageCount) furniture.add(key);
  const out: string[] = [];
  for (const lines of pages) {
    for (const line of lines) {
      if (furniture.size > 0 && furniture.has(collapse(line.replace(/\d+/g, '')))) continue;
      out.push(line);
    }
  }
  return out;
}

const heading = (level: number, text: string): string => `${'#'.repeat(level)} ${escapeText(text.trim())}`;

/** Use the contents entries to turn matching body lines into headings and drop the contents block. */
function applyContents(lines: string[], entries: Array<{ index: number; indent: number; title: string }>): string[] {
  const drop = new Set<number>(entries.map((e) => e.index));
  const first = entries[0]!.index;
  const lastIndex = entries[entries.length - 1]!.index;
  for (let i = first - 1; i >= 0; i--) {
    if (isBlank(lines[i]!)) continue;
    const label = collapse(lines[i]!).toLowerCase();
    if (label === 'contents' || label === 'table of contents') drop.add(i);
    break;
  }

  const levels = new Map<number, number>();
  const bodyByTitle = new Map<string, number[]>();
  for (let i = lastIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > MAX_TITLE_LENGTH * 4) continue;
    const key = collapse(line).toLowerCase();
    if (key === '' || key.length > MAX_TITLE_LENGTH) continue;
    const list = bodyByTitle.get(key);
    if (list) list.push(i);
    else bodyByTitle.set(key, [i]);
  }
  const cursor = new Map<string, number>();
  const replaced = new Map<number, string>();
  for (const entry of entries) {
    let level = levels.get(entry.indent);
    if (level === undefined) {
      level = Math.min(levels.size + 1, MAX_LEVEL);
      levels.set(entry.indent, level);
    }
    const key = collapse(entry.title).toLowerCase();
    const list = bodyByTitle.get(key);
    const at = cursor.get(key) ?? 0;
    if (!list || at >= list.length) continue;
    cursor.set(key, at + 1);
    replaced.set(list[at]!, heading(level, lines[list[at]!]!));
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    out.push(replaced.get(i) ?? lines[i]!);
  }
  return out;
}

function guessHeadings(lines: string[]): string[] {
  return lines.map((line, i) => {
    const prevBlank = i === 0 || isBlank(lines[i - 1]!);
    const nextBlank = i === lines.length - 1 || isBlank(lines[i + 1]!);
    return prevBlank && nextBlank && looksLikeHeading(line) ? heading(2, line) : line;
  });
}

function collapseBlanks(lines: string[]): string {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** Turn plain text from a converter (e.g. a PDF text dump) into Markdown. Deterministic and linear-time. */
export function cleanupText(text: string): string {
  const pages = text.replace(/\r\n?/g, '\n').split('\f').map((page) => page.split('\n'));
  let lines = removeFurniture(pages);

  const entries: Array<{ index: number; indent: number; title: string }> = [];
  lines.forEach((line, index) => {
    const parsed = parseContentsLine(line);
    if (parsed) entries.push({ index, ...parsed });
  });

  lines = entries.length > 0 ? applyContents(lines, entries) : guessHeadings(lines);
  return collapseBlanks(lines);
}
