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
});
