import type { MocaRow, MocaValue } from '../types.js';
import { classifyMocaType } from './moca-types.js';
import type { RawResultSet, RawValue } from './response.js';

function convertText(value: string, type: string | undefined): MocaValue {
  switch (classifyMocaType(type)) {
    case 'number': {
      if (value.trim() === '') return value;
      const asNumber = Number(value);
      return Number.isNaN(asNumber) ? value : asNumber;
    }
    case 'boolean': {
      const normalized = value.trim().toLowerCase();
      if (normalized === '1' || normalized === 'true') return true;
      if (normalized === '0' || normalized === 'false') return false;
      return value;
    }
    default:
      // Dates stay as MOCA strings in v1 (see spec §8a).
      return value;
  }
}

function convertValue(value: RawValue, type: string | undefined, convert: boolean): MocaValue {
  if (value === null) return null;
  if (typeof value !== 'string') return toRows(value, convert);
  return convert ? convertText(value, type) : value;
}

/** Converts a raw result set to plain row objects. Column types are matched by field position. */
export function toRows(set: RawResultSet, convert: boolean): MocaRow[] {
  return set.rows.map((raw) => {
    const row: MocaRow = {};
    Object.entries(raw).forEach(([key, value], position) => {
      row[key] = convertValue(value, set.columns[position]?.type, convert);
    });
    return row;
  });
}
