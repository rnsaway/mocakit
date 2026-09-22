import { describe, expect, it } from 'vitest';
import { baseConfig, fakeMoca, loginOk, mocaXml, type FakeRequest } from '../../test/helpers/fake-moca.js';
import { MocaClient } from '../client/client.js';
import { introspect, resolveColumns } from './introspect.js';

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

  it('fails clearly when every command row has a blank name', async () => {
    const { promise } = run((r) =>
      r.query === 'list active commands'
        ? mocaXml(0, { columns: [{ name: 'command' }], rows: [[''], ['   ']] })
        : mocaXml(510),
    );
    await expect(promise).rejects.toThrow(/returned no commands/);
  });

  it('propagates a non-MocaCommandError from the unfiltered argument call unchanged', async () => {
    const { promise, requests } = run((r) => {
      if (r.query === 'list active commands') return COMMANDS;
      if (r.query === 'list active command arguments') return '<html>not moca</html>';
      return mocaXml(510);
    });
    await expect(promise).rejects.toThrow(/not a valid moca-response/);
    expect(requests.filter((r) => r.query.startsWith('list active command arguments where'))).toHaveLength(0);
  });

  it('resolves columns case-insensitively, including upper-case headers', async () => {
    const upperCommands = mocaXml(0, {
      columns: [{ name: 'COMMAND' }, { name: 'CMPLVL' }, { name: 'TYPE' }, { name: 'DESCRIPTION' }],
      rows: [['list orders', 'wmd', 'Local Syntax', 'Lists orders']],
    });
    const upperArgs = mocaXml(0, {
      columns: [{ name: 'COMMAND' }, { name: 'ARGNAM' }, { name: 'DTYPE' }, { name: 'ARGREQ' }],
      rows: [['list orders', 'wh_id', 'S', '1']],
    });
    const { promise } = run((r) => (r.query === 'list active commands' ? upperCommands : upperArgs));
    const snapshot = await promise;
    expect(snapshot.commands).toEqual([
      {
        name: 'list orders',
        level: 'wmd',
        type: 'Local Syntax',
        description: 'Lists orders',
        args: [{ name: 'wh_id', dtype: 'S', required: true }],
      },
    ]);
  });

  it('treats a boolean-typed required-flag column as still meaning required', async () => {
    const args = mocaXml(0, {
      columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'dtype' }, { name: 'argreq', type: 'O' }],
      rows: [['list orders', 'wh_id', 'S', '1']],
    });
    const { promise } = run((r) => (r.query === 'list active commands' ? COMMANDS : args));
    const snapshot = await promise;
    expect(snapshot.commands.find((c) => c.name === 'list orders')!.args).toEqual([{ name: 'wh_id', dtype: 'S', required: true }]);
  });

  describe('case- and whitespace-insensitive command names', () => {
    it('de-duplicates commands that differ only in case', async () => {
      const commands = mocaXml(0, {
        columns: [{ name: 'command' }],
        rows: [['list orders'], ['List Orders']],
      });
      const { promise } = run((r) => (r.query === 'list active commands' ? commands : mocaXml(510)));
      const snapshot = await promise;
      expect(snapshot.commands).toEqual([{ name: 'list orders', args: [] }]);
    });

    it('attaches arguments whose command name arrives in a different case', async () => {
      const commands = mocaXml(0, { columns: [{ name: 'command' }], rows: [['list orders']] });
      const args = mocaXml(0, {
        columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }],
        rows: [['LIST ORDERS', 'wh_id', 'S', '1']],
      });
      const { promise } = run((r) => (r.query === 'list active commands' ? commands : args));
      const snapshot = await promise;
      expect(snapshot.commands).toEqual([
        { name: 'list orders', args: [{ name: 'wh_id', dtype: 'S', required: true }] },
      ]);
    });
  });

  describe('concurrency validation', () => {
    it.each([0, -1, 1.5])('rejects a non-integer or sub-1 concurrency (%s)', async (concurrency) => {
      const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : mocaXml(510)));
      const client = new MocaClient({ ...baseConfig }, { transport: fake.transport });
      await expect(
        introspect(client, { version: '0.1.0', server: 'https://moca.test/service', concurrency }),
      ).rejects.toThrow(RangeError);
    });
  });

  describe('distinct column resolution', () => {
    it('does not treat a single shared candidate as a clash', async () => {
      // No "dtype" column, so the "dtype" field falls back to its "type" candidate; nothing
      // else in ARG_COLUMNS lists "type", so this should resolve cleanly.
      const args = mocaXml(0, {
        columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'type' }],
        rows: [['list orders', 'wh_id', 'S']],
      });
      const { promise } = run((r) => (r.query === 'list active commands' ? COMMANDS : args));
      const snapshot = await promise;
      expect(snapshot.commands.find((c) => c.name === 'list orders')!.args).toEqual([{ name: 'wh_id', dtype: 'S', required: false }]);
    });

    it('rejects two fields that resolve to the same received column', () => {
      expect(() => resolveColumns(['x'], { a: ['x'], b: ['x'] }, [], 'test source')).toThrow(/"a" and "b" both resolved to "x"/);
    });
  });

  describe('probing before fan-out', () => {
    it('combines the unfiltered and probe failures into one error when both fail', async () => {
      const { promise } = run((r) => {
        if (r.query === 'list active commands') return COMMANDS;
        if (r.query === 'list active command arguments') return mocaXml(2, {}, 'Argument command is required');
        if (r.query.startsWith('list active command arguments where')) return mocaXml(5, {}, 'boom');
        return mocaXml(510);
      });
      await expect(promise).rejects.toThrow(
        /failed unfiltered \(.*Argument command is required.*\) and per command \(.*boom.*\)/,
      );
    });

    it('falls back when the unfiltered call succeeds with zero rows', async () => {
      const { promise, requests } = run((r) => {
        if (r.query === 'list active commands') return COMMANDS;
        if (r.query === 'list active command arguments') return mocaXml(0, { columns: [{ name: 'command' }, { name: 'argnam' }] });
        if (r.query === `list active command arguments where command = 'list orders'`) {
          return mocaXml(0, { columns: [{ name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }], rows: [['wh_id', 'S', '1']] });
        }
        return mocaXml(510);
      });
      const snapshot = await promise;
      expect(snapshot.commands.find((c) => c.name === 'list orders')!.args).toEqual([{ name: 'wh_id', dtype: 'S', required: true }]);
      expect(requests.filter((r) => r.query.startsWith('list active command arguments where'))).toHaveLength(2);
    });
  });

  describe('fallback pool stops after a failure', () => {
    it('stops fanning out once a per-command query fails, without running every remaining command', async () => {
      const total = 20;
      const names = Array.from({ length: total }, (_, i) => `cmd ${i + 1}`);
      const commands = mocaXml(0, { columns: [{ name: 'command' }], rows: names.map((n) => [n]) });
      let whereCount = 0;
      // A small delay per per-command query forces genuine overlap between the two concurrent
      // workers, so the "stop after failure" behavior is exercised deterministically instead of
      // depending on microtask-ordering luck.
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const fake = fakeMoca(async (r) => {
        if (r.query.startsWith('login user')) return loginOk();
        if (r.query === 'list active commands') return commands;
        if (r.query === 'list active command arguments') return mocaXml(2, {}, 'Argument command is required');
        if (r.query.startsWith('list active command arguments where')) {
          await delay(5);
          whereCount++;
          if (whereCount === 3) return mocaXml(99, {}, 'boom');
          return mocaXml(510);
        }
        return mocaXml(510);
      });
      const client = new MocaClient({ ...baseConfig }, { transport: fake.transport });
      const promise = introspect(client, { version: '0.1.0', server: 'https://moca.test/service', concurrency: 2 });
      await expect(promise).rejects.toThrow();
      // Give any (incorrectly) still-running workers a chance to fire more requests before
      // counting, so a regression that fails to stop the pool shows up reliably.
      await delay(50);
      const whereRequests = fake.requests.filter((r) => r.query.startsWith('list active command arguments where'));
      expect(whereRequests.length).toBeGreaterThanOrEqual(3);
      expect(whereRequests.length).toBeLessThanOrEqual(5);
    });
  });
});
