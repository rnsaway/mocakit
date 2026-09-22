import { describe, expect, it } from 'vitest';
import { toRows } from './convert.js';
import { classifyMocaType } from './moca-types.js';

describe('classifyMocaType', () => {
  it('classifies codes case-insensitively and falls back to string', () => {
    expect(['I', 'f', 'L', 'N', 'J', 'integer', 'FLOAT', 'DOUBLE', 'NUMBER'].map(classifyMocaType)).toEqual(
      Array(9).fill('number'),
    );
    expect(['O', 'boolean'].map(classifyMocaType)).toEqual(['boolean', 'boolean']);
    expect(['D', 'DATETIME'].map(classifyMocaType)).toEqual(['date', 'date']);
    expect(['S', 'Z', undefined].map(classifyMocaType)).toEqual(['string', 'string', 'string']);
  });
});

describe('toRows', () => {
  const set = {
    columns: [
      { name: 'qty', type: 'I' },
      { name: 'flg', type: 'O' },
      { name: 'dte', type: 'D' },
      { name: 'txt', type: 'S' },
      { name: 'bad', type: 'F' },
      { name: 'nested', type: 'R' },
      { name: 'none' },
    ],
    rows: [
      {
        qty: '5',
        flg: '1',
        dte: '20260922140509',
        txt: '007',
        bad: 'n/a',
        nested: { columns: [{ name: 'ln', type: 'I' }], rows: [{ ln: '2' }] },
        none: null,
      },
    ],
  };

  it('converts by column type, recursively', () => {
    expect(toRows(set, true)).toEqual([
      { qty: 5, flg: true, dte: '20260922140509', txt: '007', bad: 'n/a', nested: [{ ln: 2 }], none: null },
    ]);
  });

  it('leaves strings alone when convert is false, but still flattens nested sets', () => {
    expect(toRows(set, false)).toEqual([
      { qty: '5', flg: '1', dte: '20260922140509', txt: '007', bad: 'n/a', nested: [{ ln: '2' }], none: null },
    ]);
  });

  it('maps boolean text forms and keeps unknown text', () => {
    const rows = toRows(
      { columns: [{ name: 'a', type: 'O' }, { name: 'b', type: 'O' }, { name: 'c', type: 'O' }], rows: [{ a: 'false', b: '0', c: 'maybe' }] },
      true,
    );
    expect(rows).toEqual([{ a: false, b: false, c: 'maybe' }]);
  });

  it('keeps an empty numeric string as-is', () => {
    expect(toRows({ columns: [{ name: 'n', type: 'I' }], rows: [{ n: '' }] }, true)).toEqual([{ n: '' }]);
  });

  it('looks up type by deduplicated column name, not row-key position', () => {
    const result = toRows(
      {
        columns: [
          { name: 'txt', type: 'S' },
          { name: '1', type: 'I' },
        ],
        rows: [{ txt: '007', '1': '5' }],
      },
      true,
    );
    expect(result).toEqual([{ txt: '007', '1': 5 }]);
  });

  it('keeps an integer that is not a safe integer as a string', () => {
    expect(toRows({ columns: [{ name: 'n', type: 'I' }], rows: [{ n: '9007199254740993' }] }, true)).toEqual([
      { n: '9007199254740993' },
    ]);
  });

  it('only converts strictly-numeric text', () => {
    const columns = [{ name: 'n', type: 'I' }];
    expect(toRows({ columns, rows: [{ n: '0x1F' }] }, true)).toEqual([{ n: '0x1F' }]);
    expect(toRows({ columns, rows: [{ n: 'Infinity' }] }, true)).toEqual([{ n: 'Infinity' }]);
    expect(toRows({ columns, rows: [{ n: 'abc' }] }, true)).toEqual([{ n: 'abc' }]);
    expect(toRows({ columns, rows: [{ n: '1e3' }] }, true)).toEqual([{ n: 1000 }]);
    expect(toRows({ columns, rows: [{ n: '-2.5' }] }, true)).toEqual([{ n: -2.5 }]);
  });

  it('keeps a __proto__ column as an own property', () => {
    const result = toRows(
      { columns: [{ name: '__proto__', type: 'S' }], rows: [{ ['__proto__']: 'x' }] },
      true,
    );
    expect(Object.getOwnPropertyDescriptor(result[0], '__proto__')).toEqual({
      value: 'x',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(result[0] as object)).toBe(Object.prototype);
  });
});
