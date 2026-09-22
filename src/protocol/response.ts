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
  return !field.hasText && field.children.length === 0;
}

function parseResults(results: XmlNode | undefined): RawResultSet {
  if (results === undefined) return { columns: [], rows: [] };
  const columns = parseColumns(findChild(results, 'metadata'));
  const data = findChild(results, 'data');
  const rowNodes = data === undefined ? [] : findChildren(data, 'row');

  const rows = rowNodes.map((rowNode) => {
    const row: RawRow = {};
    const timesSeen = new Map<string, number>();
    findChildren(rowNode, 'field').forEach((field, position) => {
      const name = columns[position]?.name || field.attributes.name || `field_${position + 1}`;
      const occurrence = (timesSeen.get(name) ?? 0) + 1;
      timesSeen.set(name, occurrence);
      const key = occurrence === 1 ? name : `${name}_${occurrence}`;
      const nested = findChild(field, 'moca-results');
      row[key] = nested !== undefined ? parseResults(nested) : isNullField(field) ? null : field.text;
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
