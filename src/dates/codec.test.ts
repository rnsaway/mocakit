import { describe, expect, it } from 'vitest';
import { defaultDateCodec, formatMocaDate, parseMocaDate } from './codec.js';

describe('formatMocaDate', () => {
  it('formats local time as YYYYMMDDHH24MISS with a 24-hour clock', () => {
    expect(formatMocaDate(new Date(2026, 8, 22, 14, 5, 9))).toBe('20260922140509');
    expect(formatMocaDate(new Date(2026, 0, 2, 0, 0, 0))).toBe('20260102000000');
    expect(formatMocaDate(new Date(2026, 11, 31, 23, 59, 59))).toBe('20261231235959');
  });

  it('rejects an invalid Date', () => {
    expect(() => formatMocaDate(new Date('nope'))).toThrow(RangeError);
  });
});

describe('parseMocaDate', () => {
  it('parses to local time and round-trips', () => {
    const date = parseMocaDate('20260922140509');
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]).toEqual([
      2026, 8, 22, 14, 5, 9,
    ]);
    expect(formatMocaDate(date)).toBe('20260922140509');
  });

  it('rejects malformed or out-of-range input', () => {
    for (const bad of ['2026092214050', '2026-09-22', '20261322140509', '20260932140509', '20260922250000', '20260922146000']) {
      expect(() => parseMocaDate(bad), bad).toThrow(RangeError);
    }
  });

  it('exposes both through the default codec', () => {
    expect(defaultDateCodec.format(defaultDateCodec.parse('20260101120000'))).toBe('20260101120000');
  });

  it('rejects input with leading whitespace instead of trimming it', () => {
    expect(() => parseMocaDate(' 20260101120000')).toThrow(RangeError);
  });

  it('round-trips a year below 100 without the two-digit-year pitfall', () => {
    const date = parseMocaDate('00500315120000');
    expect(formatMocaDate(date)).toBe('00500315120000');
  });
});

describe('formatMocaDate year range', () => {
  it('rejects years outside 0-9999', () => {
    expect(() => formatMocaDate(new Date(10000, 0, 1))).toThrow(RangeError);
    expect(() => formatMocaDate(new Date(-5, 0, 1))).toThrow(RangeError);
  });
});
