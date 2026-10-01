import { commandKey } from './names.js';

function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let j = start + 1;
  while (j < text.length) {
    if (text[j] === quote) {
      if (text[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

/** End index (after the closing `]]`) of a Groovy block whose body starts at `start`; skips strings, tracks `[ ]` depth. */
function skipGroovy(text: string, start: number): number {
  let depth = 0;
  let j = start;
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === "'" || ch === '"') {
      j = skipQuoted(text, j);
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      if (depth === 0 && text[j + 1] === ']') return j + 2;
      if (depth > 0) depth--;
    }
    j++;
  }
  return text.length;
}

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

function readSqlBlock(text: string, start: number): { body: string; next: number } {
  let body = '';
  let depth = 0;
  let j = start;
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(text, j);
      body += '?' + blank(text.slice(j + 1, end));
      j = end;
      continue;
    }
    if (ch === '-' && text[j + 1] === '-') {
      const nl = text.indexOf('\n', j);
      const end = nl < 0 ? text.length : nl;
      body += blank(text.slice(j, end));
      j = end;
      continue;
    }
    if (ch === '/' && text[j + 1] === '*') {
      const close = text.indexOf('*/', j + 2);
      const end = close < 0 ? text.length : close + 2;
      body += blank(text.slice(j, end));
      j = end;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') {
      if (depth === 0) return { body, next: j + 1 };
      depth--;
    }
    body += ch;
    j++;
  }
  return { body, next: text.length };
}

/**
 * Splits MOCA source into SQL blocks (`[ … ]`, with strings and comments blanked) and the remaining MOCA text
 * (strings, comments, SQL and Groovy `[[ … ]]` blocks replaced by a space). Never throws.
 */
export function splitSource(text: string): { sql: string[]; moca: string } {
  const sql: string[] = [];
  let moca = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      moca += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i);
      moca += ' ';
      continue;
    }
    if (ch === '[' && text[i + 1] === '[') {
      i = skipGroovy(text, i + 2);
      moca += ' ';
      continue;
    }
    if (ch === '[') {
      const { body, next } = readSqlBlock(text, i + 1);
      sql.push(body);
      i = next;
      moca += ' ';
      continue;
    }
    moca += ch;
    i++;
  }
  return { sql, moca };
}

const IDENT = /^[a-z_][a-z0-9_$#]*(\.[a-z_][a-z0-9_$#]*)*$/;
const STOP = new Set([
  'where', 'group', 'order', 'having', 'union', 'on', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer',
  'set', 'values', 'select', 'connect', 'start', 'with', 'for', 'minus', 'except', 'intersect', 'when', 'then',
  'else', 'end', 'into', 'using', 'pivot', 'unpivot', 'fetch', 'offset', 'limit', 'as', 'from', 'natural',
]);

const isName = (token: string | undefined): token is string => token !== undefined && IDENT.test(token) && !STOP.has(token);
const baseName = (token: string): string => token.split('.').pop() ?? token;

/** Reads `name [as] [alias]` at `k`; returns the table name (if any) and the index after it. */
function readItem(tokens: string[], k: number): { name?: string; next: number } {
  const token = tokens[k];
  if (!isName(token)) return { next: k };
  let next = k + 1;
  if (tokens[next] === 'as') next++;
  if (isName(tokens[next])) next++;
  return { name: baseName(token), next };
}

/** Table names read and written by one SQL statement block (lowercased, sorted, de-duplicated). */
export function sqlTables(sql: string): { reads: string[]; writes: string[] } {
  const tokens = sql.toLowerCase().match(/@[+\-?*%]?[a-z0-9_$#.]*|#[a-z0-9_$#.]*|[a-z_][a-z0-9_$#.]*|[(),;?]/g) ?? [];
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    const previous = tokens[k - 1];
    if (token === 'from' || token === 'join') {
      const target = previous === 'delete' ? writes : reads;
      let item = readItem(tokens, k + 1);
      if (item.name !== undefined) target.add(item.name);
      while (token === 'from' && item.name !== undefined && tokens[item.next] === ',') {
        item = readItem(tokens, item.next + 1);
        if (item.name !== undefined) reads.add(item.name);
      }
    } else if (token === 'using') {
      // `merge into t using s on (...)`; `join ... using (col)` starts with '(' and yields no name.
      const item = readItem(tokens, k + 1);
      if (item.name !== undefined) reads.add(item.name);
    } else if (token === 'into' && (previous === 'insert' || previous === 'merge')) {
      const item = readItem(tokens, k + 1);
      if (item.name !== undefined) writes.add(item.name);
    } else if (token === 'update' && previous !== 'for') {
      const item = readItem(tokens, k + 1);
      if (item.name !== undefined) writes.add(item.name);
    } else if (token === 'delete' && tokens[k + 1] !== 'from') {
      const item = readItem(tokens, k + 1);
      if (item.name !== undefined) writes.add(item.name);
    } else if (token === 'table' && previous === 'truncate') {
      const item = readItem(tokens, k + 1);
      if (item.name !== undefined) writes.add(item.name);
    }
  }
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

interface TrieNode {
  children: Map<string, TrieNode>;
  /** Command key ending at this node. */
  name?: string;
}

export interface CommandTrie {
  root: TrieNode;
}

export function buildCommandTrie(names: string[]): CommandTrie {
  const root: TrieNode = { children: new Map() };
  for (const name of names) {
    const key = commandKey(name);
    let node = root;
    for (const word of key.split(' ')) {
      let child = node.children.get(word);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(word, child);
      }
      node = child;
    }
    node.name = key;
  }
  return { root };
}

const SEPARATORS = new Set(['|', ';', '&', '{', '}', '^']);
const STATEMENT_KEYWORDS = new Set(['if', 'else', 'try', 'catch', 'finally']);
const WORD = /^[a-z0-9_][a-z0-9_.-]*$/;

/** Command keys called at statement starts in MOCA text (longest match), sorted and de-duplicated. */
export function commandCalls(moca: string, trie: CommandTrie): string[] {
  const tokens = moca.toLowerCase().match(/@[+\-?*%]?[a-z0-9_.]*|[a-z0-9_][a-z0-9_.-]*|[^\s]/g) ?? [];
  const calls = new Set<string>();
  let atStart = true;
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (SEPARATORS.has(token) || STATEMENT_KEYWORDS.has(token)) {
      atStart = true;
      continue;
    }
    if (!atStart) continue;
    atStart = false;
    let node: TrieNode | undefined = trie.root;
    let found: string | undefined;
    for (let j = k; j < tokens.length && WORD.test(tokens[j]!); j++) {
      node = node.children.get(tokens[j]!);
      if (node === undefined) break;
      if (node.name !== undefined) found = node.name;
    }
    if (found !== undefined) calls.add(found);
  }
  return [...calls].sort();
}

/** Tables (only those in `tables`; none when `tables` is null) and command calls in one source text. */
export function scanSource(
  text: string,
  options: { trie: CommandTrie; tables: ReadonlySet<string> | null },
): { reads: string[]; writes: string[]; calls: string[] } {
  const { sql, moca } = splitSource(text);
  const reads = new Set<string>();
  const writes = new Set<string>();
  if (options.tables !== null) {
    for (const block of sql) {
      const found = sqlTables(block);
      for (const t of found.reads) if (options.tables.has(t)) reads.add(t);
      for (const t of found.writes) if (options.tables.has(t)) writes.add(t);
    }
  }
  return { reads: [...reads].sort(), writes: [...writes].sort(), calls: commandCalls(moca, options.trie) };
}
