import { MocaProtocolError } from '../errors.js';
import type { MocaColumn } from '../types.js';
import { findChild, findChildren, findDescendant, parseXml, type XmlNode } from './xml.js';

export type RawValue = string | null | RawResultSet;

export interface RawRow {
  [key: string]: RawValue;
}

export interface RawResultSet {
  columns: MocaColumn[];
  rows: RawRow[];
}

export interface RawResponse extends RawResultSet {
  status: number;
  message: string | null;
}

const SNIPPET_LENGTH = 500;

function parseColumns(metadata: XmlNode | undefined): MocaColumn[] {
  if (metadata === undefined) return [];
  return findChildren(metadata, 'column').map((column) => {
    const parsed: MocaColumn = { name: column.attributes.name ?? '' };
    if (column.attributes.type !== undefined) parsed.type = column.attributes.type;
    const length = Number.parseInt(column.attributes.length ?? '', 10);
    if (!Number.isNaN(length)) parsed.length = length;
    return parsed;
  });
}

function isNullField(field: XmlNode): boolean {
  const flag = (field.attributes.null ?? field.attributes.nil ?? '').toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  // An empty field (no text, no children, including empty CDATA) means NULL by design.
  return !field.hasText && field.children.length === 0;
}

/**
 * Deduplicates a list of names by suffixing collisions `_2`, `_3`, ... upward until an
 * unused key is found. Every original name is reserved up front, so a generated suffix
 * never steals a name that a real (later) entry owns; that later entry still gets its
 * own name when its turn comes. Pure: never mutates its input, and a name that was never
 * a collision target is returned unchanged.
 */
export function uniqueKeys(names: string[]): string[] {
  const reserved = new Set(names);
  const used = new Set<string>();
  return names.map((name) => {
    let key = name;
    if (used.has(key)) {
      let suffix = 2;
      let candidate = `${name}_${suffix}`;
      while (used.has(candidate) || reserved.has(candidate)) {
        suffix += 1;
        candidate = `${name}_${suffix}`;
      }
      key = candidate;
    }
    used.add(key);
    return key;
  });
}

/**
 * Deduplicated key for each column, in metadata order: the column's own name, or a
 * positional `field_N` fallback when it has none, run through `uniqueKeys`. This is the
 * same rule `parseResults` applies per row field (column name || field name attribute ||
 * positional fallback), so the two stay in lockstep whenever a field carries no `name`
 * attribute of its own (the normal case).
 */
export function columnKeys(columns: MocaColumn[]): string[] {
  return uniqueKeys(columns.map((column, index) => column.name || `field_${index + 1}`));
}

/**
 * Assigns `value` at `key` on `row`. A plain `row[key] = value` is unsafe when `key` is
 * `'__proto__'`: bracket assignment with that literal key invokes `Object.prototype`'s
 * `__proto__` setter instead of creating an own property, silently dropping the value
 * (the setter no-ops for non-object, non-null values). `Object.defineProperty` bypasses
 * the setter and creates a real own, enumerable property. Generic so both `RawRow`
 * (this module) and `MocaRow` (convert.ts) can share one implementation.
 */
export function setRowValue<V>(row: Record<string, V>, key: string, value: V): void {
  if (key === '__proto__') {
    Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    row[key] = value;
  }
}

function parseResults(results: XmlNode | undefined): RawResultSet {
  if (results === undefined) return { columns: [], rows: [] };
  const columns = parseColumns(findChild(results, 'metadata'));
  const data = findChild(results, 'data');
  const rowNodes = data === undefined ? [] : findChildren(data, 'row');

  const rows = rowNodes.map((rowNode) => {
    const fields = findChildren(rowNode, 'field');
    const names = fields.map(
      (field, position) => columns[position]?.name || field.attributes.name || `field_${position + 1}`,
    );
    const keys = uniqueKeys(names);

    const row: RawRow = {};
    fields.forEach((field, position) => {
      const key = keys[position] as string;
      const nested = findChild(field, 'moca-results');
      const value = nested !== undefined ? parseResults(nested) : isNullField(field) ? null : field.text;
      setRowValue(row, key, value);
    });
    return row;
  });

  return { columns, rows };
}

export function parseResponse(xml: string): RawResponse {
  const document = parseXml(xml);
  const response = findDescendant(document, 'moca-response');
  const statusNode = response === undefined ? undefined : findChild(response, 'status');
  const statusText = statusNode?.text.trim() ?? '';
  const status = /^-?\d+$/.test(statusText) ? Number.parseInt(statusText, 10) : Number.NaN;

  if (response === undefined || Number.isNaN(status)) {
    throw new MocaProtocolError(
      'The MOCA server response is not a valid moca-response document',
      xml.slice(0, SNIPPET_LENGTH),
    );
  }

  const messageText = findChild(response, 'message')?.text.trim() ?? '';
  const results = findChild(response, 'moca-results') ?? findDescendant(response, 'moca-results');
  return { status, message: messageText === '' ? null : messageText, ...parseResults(results) };
}
