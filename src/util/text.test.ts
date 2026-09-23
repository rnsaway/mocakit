import { describe, expect, it } from 'vitest';
import { isMocaArgName, stripBom } from './text.js';

describe('text helpers', () => {
  it('stripBom removes one leading BOM only', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('x﻿')).toBe('x﻿');
  });

  it('isMocaArgName accepts identifiers without $', () => {
    expect(['wh_id', '_x', 'A1'].every(isMocaArgName)).toBe(true);
    expect(['odd-name', '1x', '$x', '', 'a b'].some(isMocaArgName)).toBe(false);
  });
});
