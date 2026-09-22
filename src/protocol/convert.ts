import type { MocaRow, MocaValue } from '../types.js';
import { classifyMocaType } from './moca-types.js';
import { uniqueKeys, type RawResultSet, type RawValue } from './response.js';

// Whole/decimal number, optional sign, optional exponent — no hex, no Infinity/NaN, no stray text.
const NUMERIC_PATTERN = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

function convertText(value: string, type: string | undefined): MocaValue {
  switch (classifyMocaType(type)) {
    case 'number': {
      if (!NUMERIC_PATTERN.test(value)) return value;
      const asNumber = Number(value);
      if (!Number.isFinite(asNumber)) return value;
      // A parsed integer that lost precision (exceeds Number.MAX_SAFE_INTEGER) is kept
      // as the original string rather than silently returning the wrong number.
      if (Number.isInteger(asNumber) && !Number.isSafeInteger(asNumber)) return value;
      return asNumber;
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

/**
 * Assigns `value` at `key` on `row`. See the identical helper in response.ts: plain
 * `row[key] = value` silently drops the value when `key` is `'__proto__'`.
 */
function setRowValue(row: MocaRow, key: string, value: MocaValue): void {
  if (key === '__proto__') {
    Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    row[key] = value;
  }
}

/** Converts a raw result set to plain row objects. Column types are matched by (deduplicated) column name. */
export function toRows(set: RawResultSet, convert: boolean): MocaRow[] {
  const keys = uniqueKeys(set.columns.map((column) => column.name));
  const typeByKey = new Map<string, string | undefined>();
  keys.forEach((key, index) => typeByKey.set(key, set.columns[index]?.type));

  return set.rows.map((raw) => {
    const row: MocaRow = {};
    Object.entries(raw).forEach(([key, value]) => {
      setRowValue(row, key, convertValue(value, typeByKey.get(key), convert));
    });
    return row;
  });
}
