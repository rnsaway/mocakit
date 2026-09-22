import { describe, expect, it } from 'vitest';
import { assignMethodNames, isIdentifier, toMethodBase, toPascal } from './names.js';

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

  it('falls back to "command" for names with no alphanumerics', () => {
    expect(toMethodBase('---')).toBe('command');
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
});

describe('helpers', () => {
  it('toPascal and isIdentifier', () => {
    expect(toPascal('listOrders_2')).toBe('ListOrders_2');
    expect(isIdentifier('wh_id')).toBe(true);
    expect(isIdentifier('wh-id')).toBe(false);
    expect(isIdentifier('1abc')).toBe(false);
  });
});
