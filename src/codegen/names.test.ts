import { describe, expect, it } from 'vitest';
import { MocaClient } from '../client/client.js';
import {
  assignMethodNames,
  byCodeUnit,
  commandKey,
  isIdentifier,
  isValidCommandName,
  RESERVED_MEMBERS,
  toMethodBase,
  toPascal,
} from './names.js';

describe('toMethodBase', () => {
  it('camel-cases words split on non-alphanumerics', () => {
    expect(toMethodBase('list active commands')).toBe('listActiveCommands');
    expect(toMethodBase('LIST  Active-command_arguments')).toBe('listActiveCommandArguments');
  });

  it('prefixes a leading digit', () => {
    expect(toMethodBase('3pl sync')).toBe('_3plSync');
  });

  it('prefixes reserved client members and Object.prototype names', () => {
    expect(toMethodBase('exec')).toBe('cmdExec');
    expect(toMethodBase('login')).toBe('cmdLogin');
    expect(toMethodBase('to string')).toBe('cmdToString');
    expect(toMethodBase('constructor')).toBe('cmdConstructor');
  });

  it('prefixes "then" so client instances are never mistaken for thenables', () => {
    expect(toMethodBase('then')).toBe('cmdThen');
  });

  it('falls back to "command" for names with no alphanumerics', () => {
    expect(toMethodBase('---')).toBe('command');
  });

  it('strips diacritics before splitting into words', () => {
    expect(toMethodBase('ünïcödé list')).toBe('unicodeList');
  });

  it('falls back to "command" for fully non-Latin names', () => {
    expect(toMethodBase('日本')).toBe('command');
  });
});

describe('assignMethodNames', () => {
  it('suffixes collisions in input order and reports them', () => {
    const { names, collisions } = assignMethodNames(['list orders', 'list-orders', 'list_orders', 'list lines']);
    expect([...names.entries()]).toEqual([
      ['list orders', 'listOrders'],
      ['list-orders', 'listOrders_2'],
      ['list_orders', 'listOrders_3'],
      ['list lines', 'listLines'],
    ]);
    expect(collisions).toEqual([['list orders', 'list-orders', 'list_orders']]);
  });

  it('de-duplicates exact repeats without renaming or reporting a collision', () => {
    const { names, collisions } = assignMethodNames(['a', 'a', 'b']);
    expect([...names.entries()]).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
    expect(collisions).toEqual([]);
  });
});

describe('RESERVED_MEMBERS', () => {
  it('covers every own property name of MocaClient.prototype', () => {
    for (const name of Object.getOwnPropertyNames(MocaClient.prototype)) {
      expect(RESERVED_MEMBERS.has(name)).toBe(true);
    }
  });

  it('renames commands called batch (a client method) and raw (the batch builder member)', () => {
    expect(toMethodBase('batch')).toBe('cmdBatch');
    expect(toMethodBase('raw')).toBe('cmdRaw');
  });
});

describe('helpers', () => {
  it('toPascal and isIdentifier', () => {
    expect(toPascal('listOrders_2')).toBe('ListOrders_2');
    expect(isIdentifier('wh_id')).toBe(true);
    expect(isIdentifier('wh-id')).toBe(false);
    expect(isIdentifier('1abc')).toBe(false);
  });
});

describe('command-name helpers', () => {
  it('commandKey trims, collapses whitespace and lower-cases', () => {
    expect(commandKey('  List \t  Orders ')).toBe('list orders');
  });

  it('byCodeUnit orders by UTF-16 code unit, not locale', () => {
    expect(['b', 'a', 'B', ' a'].sort(byCodeUnit)).toEqual([' a', 'B', 'a', 'b']);
  });

  it('isValidCommandName accepts MOCA-style names and rejects anything else', () => {
    for (const ok of ['list orders', ' list-orders ', 'a.b_c 1', '_x']) expect(isValidCommandName(ok)).toBe(true);
    for (const bad of ['', '  ', '-x', "a'b", 'a;b', 'a */ b', 'a\tb', 'café']) expect(isValidCommandName(bad)).toBe(false);
  });
});
