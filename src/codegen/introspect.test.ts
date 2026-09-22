import { describe, expect, it } from 'vitest';
import { baseConfig, fakeMoca, loginOk, mocaXml, type FakeRequest } from '../../test/helpers/fake-moca.js';
import { MocaClient } from '../client/client.js';
import { introspect } from './introspect.js';

const COMMANDS = mocaXml(0, {
  columns: [{ name: 'command' }, { name: 'cmplvl' }, { name: 'type' }, { name: 'description' }],
  rows: [
    ['list orders', 'wmd', 'Local Syntax', 'Lists orders'],
    ['create inventory', 'dcs', 'Java', null],
    ['list orders', 'base', 'Local Syntax', 'duplicate at lower level'],
  ],
});

const ARGS = mocaXml(0, {
  columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }, { name: 'argdsc' }],
  rows: [
    ['list orders', 'wh_id', 'S', 'Y', 'Warehouse'],
    ['list orders', 'ordqty', 'I', '0', null],
    ['list orders', 'wh_id', 'S', '0', 'duplicate'],
  ],
});

function run(handler: (r: FakeRequest) => string) {
  const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : handler(r)));
  const client = new MocaClient({ ...baseConfig }, { transport: fake.transport });
  return { promise: introspect(client, { version: '0.1.0', server: 'https://u:p@moca.test/service?x=1' }), requests: fake.requests };
}

describe('introspect', () => {
  it('builds a sorted, de-duplicated snapshot from the two list commands', async () => {
    const { promise } = run((r) => (r.query === 'list active commands' ? COMMANDS : ARGS));
    const snapshot = await promise;
    expect(snapshot.mocakitVersion).toBe('0.1.0');
    expect(snapshot.server).toBe('https://moca.test/service');
    expect(snapshot.commands).toEqual([
      { name: 'create inventory', level: 'dcs', type: 'Java', args: [] },
      {
        name: 'list orders',
        level: 'wmd',
        type: 'Local Syntax',
        description: 'Lists orders',
        args: [
          { name: 'wh_id', dtype: 'S', required: true, description: 'Warehouse' },
          { name: 'ordqty', dtype: 'I', required: false },
        ],
      },
    ]);
  });

  it('falls back to per-command argument queries when the unfiltered call fails', async () => {
    const { promise, requests } = run((r) => {
      if (r.query === 'list active commands') return COMMANDS;
      if (r.query === 'list active command arguments') return mocaXml(2, {}, 'Argument command is required');
      if (r.query === `list active command arguments where command = 'list orders'`) {
        return mocaXml(0, { columns: [{ name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }], rows: [['wh_id', 'S', '1']] });
      }
      return mocaXml(510);
    });
    const snapshot = await promise;
    expect(snapshot.commands.find((c) => c.name === 'list orders')!.args).toEqual([{ name: 'wh_id', dtype: 'S', required: true }]);
    expect(requests.filter((r) => r.query.startsWith('list active command arguments where'))).toHaveLength(2);
  });

  it('reports the columns it received when it cannot find the command column', async () => {
    const { promise } = run(() => mocaXml(0, { columns: [{ name: 'foo' }, { name: 'bar' }], rows: [['a', 'b']] }));
    await expect(promise).rejects.toThrow(/list active commands.*received columns: foo, bar/);
  });

  it('fails clearly when no commands are returned', async () => {
    const { promise } = run(() => mocaXml(510));
    await expect(promise).rejects.toThrow(/returned no commands/);
  });
});
