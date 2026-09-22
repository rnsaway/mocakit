import { describe, expect, it } from 'vitest';
import { filterCommands, globToRegExp } from './filter.js';

const commands = [
  { name: 'list orders', level: 'wmd', args: [] },
  { name: 'list order lines', level: 'WMD', args: [] },
  { name: 'create inventory', level: 'dcs', args: [] },
  { name: 'usr my command', level: 'USRint', args: [] },
  { name: 'no level', args: [] },
];
const names = (filter: Parameters<typeof filterCommands>[1]) => filterCommands(commands, filter).map((c) => c.name);

describe('globToRegExp', () => {
  it('supports * and ?, anchored, case-insensitive, escaping regex characters', () => {
    expect(globToRegExp('list *').test('LIST orders')).toBe(true);
    expect(globToRegExp('list *').test('my list orders')).toBe(false);
    expect(globToRegExp('get ?').test('get x')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('filterCommands', () => {
  it('includes everything by default', () => {
    expect(names({})).toHaveLength(5);
  });

  it('applies include, then exclude', () => {
    expect(names({ include: ['list *'], exclude: ['* lines'] })).toEqual(['list orders']);
  });

  it('filters by level case-insensitively and drops commands without a level', () => {
    expect(names({ levels: ['wmd', 'usrint'] })).toEqual(['list orders', 'list order lines', 'usr my command']);
  });
});
