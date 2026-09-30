import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeMoca, loginOk, mocaXml } from '../../test/helpers/fake-moca.js';
import { SQLSERVER_COLUMNS, SQLSERVER_KEYS } from '../codegen/introspect-schema.js';
import { moduleSpecifier, resolveSchemaSettings, runGenerate } from './generate.js';

const fixture = fileURLToPath(new URL('../../test/fixtures/snapshot.json', import.meta.url));

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } };
}

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mocakit-gen-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runGenerate', () => {
  it('generates from a snapshot without a config or server, applying CLI --out', async () => {
    const dir = await tempDir();
    const { io: cliIo, out, err } = io();
    await runGenerate({ fromSnapshot: fixture, out: 'gen/moca.ts', dryRun: false, cwd: dir, env: {}, io: cliIo });
    const code = await readFile(join(dir, 'gen/moca.ts'), 'utf8');
    expect(code).toContain('export class Moca extends mk.MocaClient');
    expect(out.at(-1)).toBe(`Wrote 10 commands to ${join(dir, 'gen/moca.ts')}`);
    expect(err).toEqual([
      'warning: Command "consume widget pointer" requires stack argument "widget_ptr" (POINTER); skipped (run it with exec())',
      'warning: Command "list orders" argument "odd-name" is not a valid MOCA argument name; dropped the argument',
      'warning: Commands "list orders", "list-orders" map to the same method name; generated listOrders, listOrders_2',
    ]);
  });

  it('introspects a server, writes the snapshot next to out, and applies config filters', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'mocakit.config.json'),
      JSON.stringify({ url: 'https://moca.test/service', out: 'src/moca.generated.ts', exclude: ['create *'] }),
    );
    const fake = fakeMoca((r) => {
      if (r.query.startsWith('login user')) return loginOk();
      if (r.query === 'list active commands') {
        return mocaXml(0, { columns: [{ name: 'command' }], rows: [['list orders'], ['create inventory']] });
      }
      if (r.query === 'list active command arguments') {
        return mocaXml(0, { columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }], rows: [['list orders', 'wh_id', 'S', '1']] });
      }
      return mocaXml(0);
    });
    const { io: cliIo } = io();
    await runGenerate({
      dryRun: false,
      cwd: dir,
      env: { MOCA_USER: 'u', MOCA_PASSWORD: 'p' },
      io: cliIo,
      deps: { transport: fake.transport },
    });
    const snapshot = JSON.parse(await readFile(join(dir, 'src/moca.commands.json'), 'utf8'));
    expect(snapshot.commands.map((c: { name: string }) => c.name)).toEqual(['create inventory', 'list orders']);
    const code = await readFile(join(dir, 'src/moca.generated.ts'), 'utf8');
    expect(code).toContain('listOrders');
    expect(code).not.toContain('createInventory');
    expect(fake.requests.at(-1)?.query).toBe('logout user');
  });

  it('writes nothing on --dry-run', async () => {
    const dir = await tempDir();
    const { io: cliIo, out } = io();
    await runGenerate({ fromSnapshot: fixture, out: 'gen/moca.ts', dryRun: true, cwd: dir, env: {}, io: cliIo });
    await expect(readFile(join(dir, 'gen/moca.ts'), 'utf8')).rejects.toThrow();
    expect(out.at(-1)).toMatch(/^Would write 10 commands/);
  });

  it('resolves a config-relative out against the config file directory, not the cwd', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'cfgdir'), { recursive: true });
    await writeFile(join(dir, 'cfgdir', 'mocakit.config.json'), JSON.stringify({ out: 'gen/moca.ts' }));
    const { io: cliIo } = io();
    await runGenerate({
      configPath: 'cfgdir/mocakit.config.json',
      fromSnapshot: fixture,
      dryRun: false,
      cwd: dir,
      env: {},
      io: cliIo,
    });
    const code = await readFile(join(dir, 'cfgdir', 'gen', 'moca.ts'), 'utf8');
    expect(code).toContain('export class Moca extends mk.MocaClient');
  });

  it('resolves --out and --from-snapshot against the cwd even with a config elsewhere', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'cfgdir'), { recursive: true });
    await writeFile(join(dir, 'cfgdir', 'mocakit.config.json'), JSON.stringify({ out: 'gen/should-not-be-used.ts' }));
    const { io: cliIo } = io();
    await runGenerate({
      configPath: 'cfgdir/mocakit.config.json',
      fromSnapshot: fixture,
      out: 'flag-out/moca.ts',
      dryRun: false,
      cwd: dir,
      env: {},
      io: cliIo,
    });
    const code = await readFile(join(dir, 'flag-out', 'moca.ts'), 'utf8');
    expect(code).toContain('export class Moca extends mk.MocaClient');
    await expect(readFile(join(dir, 'cfgdir', 'gen', 'should-not-be-used.ts'), 'utf8')).rejects.toThrow();
  });

  it('proceeds without a config file when the full connection is in env', async () => {
    const dir = await tempDir();
    const fake = fakeMoca((r) => {
      if (r.query.startsWith('login user')) return loginOk();
      if (r.query === 'list active commands') return mocaXml(0, { columns: [{ name: 'command' }], rows: [['list orders']] });
      return mocaXml(0);
    });
    const { io: cliIo, out } = io();
    await runGenerate({
      dryRun: false,
      cwd: dir,
      env: { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' },
      io: cliIo,
      deps: { transport: fake.transport },
    });
    expect(out.at(-1)).toMatch(/^Wrote 1 commands/);
  });

  it('reports the No mocakit config error, mentioning env vars, when neither a config nor a full env is present', async () => {
    const dir = await tempDir();
    const { io: cliIo } = io();
    await expect(runGenerate({ dryRun: false, cwd: dir, env: {}, io: cliIo })).rejects.toThrow(
      /No mocakit config found.*MOCA_URL, MOCA_USER and MOCA_PASSWORD/s,
    );
  });

  it('wraps a missing --from-snapshot file as "Cannot read snapshot"', async () => {
    const dir = await tempDir();
    const missing = join(dir, 'nope.json');
    const { io: cliIo } = io();
    await expect(runGenerate({ fromSnapshot: missing, out: 'gen/moca.ts', dryRun: false, cwd: dir, env: {}, io: cliIo })).rejects.toThrow(
      `Cannot read snapshot ${missing}: ENOENT`,
    );
  });

  it('does not double the path when the underlying snapshot error already includes it', async () => {
    const dir = await tempDir();
    const badSnapshot = join(dir, 'bad-snapshot.json');
    await writeFile(badSnapshot, 'not json');
    const { io: cliIo } = io();
    let caught: unknown;
    try {
      await runGenerate({ fromSnapshot: badSnapshot, out: 'gen/moca.ts', dryRun: false, cwd: dir, env: {}, io: cliIo });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/is not valid JSON/);
    expect(message.match(new RegExp(badSnapshot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('wraps an unwritable output path as "Cannot write", failing before introspecting the server', async () => {
    const dir = await tempDir();
    // Create a plain file where a directory component of `out` needs to be, so mkdir(recursive) fails.
    await writeFile(join(dir, 'blocked'), 'not a directory');
    const fake = fakeMoca(() => {
      throw new Error('should not be called');
    });
    const { io: cliIo } = io();
    await expect(
      runGenerate({
        out: 'blocked/sub/moca.ts',
        dryRun: false,
        cwd: dir,
        env: { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' },
        io: cliIo,
        deps: { transport: fake.transport },
      }),
    ).rejects.toThrow(/^Cannot write .*blocked.sub.moca\.ts: /);
    expect(fake.requests).toEqual([]);
  });

  it('reports the emitted command count, after de-duplication and skips', async () => {
    const dir = await tempDir();
    const snapshot = JSON.parse(await readFile(fixture, 'utf8'));
    snapshot.commands.push(
      { name: 'EXEC', args: [] },
      { name: 'bad required', args: [{ name: 'a-b', dtype: 'S', required: true }] },
    );
    const snapshotFile = join(dir, 'snap.json');
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    const { io: cliIo, out } = io();
    await runGenerate({ fromSnapshot: snapshotFile, out: 'gen/moca.ts', dryRun: false, cwd: dir, env: {}, io: cliIo });
    expect(out.at(-1)).toBe(`Wrote 10 commands to ${join(dir, 'gen/moca.ts')}`);
    expect(await readFile(join(dir, 'gen/moca.ts'), 'utf8')).toMatch(/— 10 commands\./);
  });

  it('prints at most 50 warnings, then a count of the rest', async () => {
    const dir = await tempDir();
    const commands = Array.from({ length: 53 }, (_, i) => ({
      name: `cmd ${String(i).padStart(2, '0')}`,
      args: [{ name: 'bad-name', dtype: 'STRING', required: false }],
    }));
    const snapshotFile = join(dir, 'snap.json');
    await writeFile(snapshotFile, JSON.stringify({ mocakitVersion: '0.1.0', generatedAt: '', server: 'https://moca.test', commands }));
    const { io: cliIo, err, out } = io();
    await runGenerate({ fromSnapshot: snapshotFile, out: 'gen/moca.ts', dryRun: true, cwd: dir, env: {}, io: cliIo });
    expect(err).toHaveLength(51);
    expect(err[0]).toBe('warning: Command "cmd 00" argument "bad-name" is not a valid MOCA argument name; dropped the argument');
    expect(err[49]).toBe('warning: Command "cmd 49" argument "bad-name" is not a valid MOCA argument name; dropped the argument');
    expect(err[50]).toBe('... and 3 more warnings (use --verbose to see all)');
    expect(out.at(-1)).toMatch(/^Would write 53 commands/);
  });

  it('prints every warning with verbose', async () => {
    const dir = await tempDir();
    const commands = Array.from({ length: 53 }, (_, i) => ({
      name: `cmd ${String(i).padStart(2, '0')}`,
      args: [{ name: 'bad-name', dtype: 'STRING', required: false }],
    }));
    const snapshotFile = join(dir, 'snap.json');
    await writeFile(snapshotFile, JSON.stringify({ mocakitVersion: '0.1.0', generatedAt: '', server: 'https://moca.test', commands }));
    const { io: cliIo, err } = io();
    await runGenerate({ fromSnapshot: snapshotFile, out: 'gen/moca.ts', dryRun: true, verbose: true, cwd: dir, env: {}, io: cliIo });
    expect(err).toHaveLength(53);
    expect(err.every((line) => line.startsWith('warning: '))).toBe(true);
  });

  it('prints exactly 50 warnings without a summary line', async () => {
    const dir = await tempDir();
    const commands = Array.from({ length: 50 }, (_, i) => ({
      name: `cmd ${String(i).padStart(2, '0')}`,
      args: [{ name: 'bad-name', dtype: 'STRING', required: false }],
    }));
    const snapshotFile = join(dir, 'snap.json');
    await writeFile(snapshotFile, JSON.stringify({ mocakitVersion: '0.1.0', generatedAt: '', server: 'https://moca.test', commands }));
    const { io: cliIo, err } = io();
    await runGenerate({ fromSnapshot: snapshotFile, out: 'gen/moca.ts', dryRun: true, cwd: dir, env: {}, io: cliIo });
    expect(err).toHaveLength(50);
    expect(err.every((line) => line.startsWith('warning: '))).toBe(true);
  });

  describe('introspection snapshot', () => {
    const introspectingServer = (commandRows: string[][]) =>
      fakeMoca((r) => {
        if (r.query.startsWith('login user')) return loginOk();
        if (r.query === 'list active commands') return mocaXml(0, { columns: [{ name: 'command' }], rows: commandRows });
        if (r.query === 'list active command arguments') {
          return mocaXml(0, {
            columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }],
            rows: [['list orders', 'wh_id', 'S', '1']],
          });
        }
        return mocaXml(0);
      });
    const env = { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' };

    it('leaves an existing snapshot untouched when the introspected commands are unchanged', async () => {
      const dir = await tempDir();
      const snapshotFile = join(dir, 'src', 'moca.commands.json');
      const fake = introspectingServer([['list orders']]);
      await runGenerate({ out: 'src/moca.generated.ts', dryRun: false, cwd: dir, env, io: io().io, deps: { transport: fake.transport } });
      const first = await readFile(snapshotFile, 'utf8');
      const stale = first.replace(/"generatedAt": "[^"]*"/, '"generatedAt": "2000-01-01T00:00:00.000Z"');
      await writeFile(snapshotFile, stale);

      const { io: cliIo, out } = io();
      await runGenerate({ out: 'src/moca.generated.ts', dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: fake.transport } });
      expect(await readFile(snapshotFile, 'utf8')).toBe(stale);
      expect(out).toContain(`Snapshot unchanged: ${snapshotFile}`);
    });

    it('rewrites the snapshot when the introspected commands changed', async () => {
      const dir = await tempDir();
      const snapshotFile = join(dir, 'src', 'moca.commands.json');
      await runGenerate({
        out: 'src/moca.generated.ts',
        dryRun: false,
        cwd: dir,
        env,
        io: io().io,
        deps: { transport: introspectingServer([['list orders']]).transport },
      });
      await runGenerate({
        out: 'src/moca.generated.ts',
        dryRun: false,
        cwd: dir,
        env,
        io: io().io,
        deps: { transport: introspectingServer([['list orders'], ['create inventory']]).transport },
      });
      const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
      expect(snapshot.commands.map((c: { name: string }) => c.name)).toEqual(['create inventory', 'list orders']);
    });

    it('prints introspection warnings', async () => {
      const dir = await tempDir();
      const { io: cliIo, err } = io();
      await runGenerate({
        out: 'src/moca.generated.ts',
        dryRun: true,
        cwd: dir,
        env,
        io: cliIo,
        deps: { transport: introspectingServer([['list orders'], ["bad'name"]]).transport },
      });
      expect(err).toEqual([`warning: Skipped command "bad'name": not a valid MOCA command name`]);
    });
  });
});

const exists = (p: string) => access(p).then(() => true, () => false);

function schemaServer(overrides: { keys?: string } = {}) {
  return fakeMoca((r) => {
    if (r.query.startsWith('login user')) return loginOk();
    if (r.query === 'list active commands') return mocaXml(0, { columns: [{ name: 'command' }], rows: [['list orders']] });
    if (r.query === 'list active command arguments') {
      return mocaXml(0, { columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }], rows: [['list orders', 'wh_id', 'S', '1']] });
    }
    if (r.query === 'get database') return mocaXml(0, { columns: [{ name: 'database' }], rows: [['sqlserver']] });
    if (r.query === SQLSERVER_COLUMNS) {
      return mocaXml(0, {
        columns: [
          { name: 'table_name' }, { name: 'table_kind' }, { name: 'table_comment' }, { name: 'column_name' },
          { name: 'ordinal', type: 'I' }, { name: 'data_type' }, { name: 'max_length', type: 'I' },
          { name: 'precision', type: 'I' }, { name: 'scale', type: 'I' }, { name: 'is_nullable', type: 'O' }, { name: 'column_comment' },
        ],
        rows: [
          ['widget', 'table', 'Widgets.', 'widget_id', '1', 'nvarchar', '40', '0', '0', '0', null],
          ['tmp_widget', 'table', null, 'a', '1', 'int', '4', '10', '0', '1', null],
        ],
      });
    }
    if (r.query === SQLSERVER_KEYS) {
      return overrides.keys ?? mocaXml(0, { columns: [{ name: 'table_name' }, { name: 'column_name' }, { name: 'key_ordinal', type: 'I' }], rows: [['widget', 'widget_id', '1']] });
    }
    return mocaXml(0);
  });
}

describe('runGenerate with schema', () => {
  const env = { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' };

  it('writes the schema snapshot, types, docs and a typed client when --schema is passed', async () => {
    const dir = await tempDir();
    const fake = schemaServer();
    const { io: cliIo, out } = io();
    await runGenerate({ schema: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: fake.transport } });
    const schema = JSON.parse(await readFile(join(dir, 'src/moca.schema.json'), 'utf8'));
    expect(schema.tables.map((t: { name: string }) => t.name)).toEqual(['tmp_widget', 'widget']);
    expect(await readFile(join(dir, 'src/moca.schema.ts'), 'utf8')).toContain('export interface MocaTables {');
    expect(await readFile(join(dir, 'src/moca.generated.ts'), 'utf8')).toContain('from "./moca.schema.js"');
    expect((await readdir(join(dir, 'src/moca-schema/tables'))).sort()).toEqual(['tmp_widget.md', 'widget.md']);
    expect(out).toContain(`Wrote schema snapshot of 2 tables (2 columns) to ${join(dir, 'src/moca.schema.json')}`);
    expect(out).toContain(`Wrote 2 tables to ${join(dir, 'src/moca.schema.ts')}`);
    expect(out).toContain(`Wrote 2 table docs to ${join(dir, 'src/moca-schema')}`);
  });

  it('applies config filters and paths, and leaves an unchanged schema snapshot alone', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'mocakit.config.json'),
      JSON.stringify({ schema: { exclude: ['tmp_*'], out: 'types/schema.ts', docs: false } }),
    );
    const { io: cliIo, out } = io();
    await runGenerate({ dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: schemaServer().transport } });
    const types = await readFile(join(dir, 'types/schema.ts'), 'utf8');
    expect(types).toContain('widget: {');
    expect(types).not.toContain('tmp_widget');
    expect(await readFile(join(dir, 'src/moca.generated.ts'), 'utf8')).toContain('from "../types/schema.js"');
    expect(await exists(join(dir, 'src/moca-schema'))).toBe(false);
    const snapshotBefore = await readFile(join(dir, 'src/moca.schema.json'), 'utf8');

    const second = io();
    await runGenerate({ dryRun: false, cwd: dir, env, io: second.io, deps: { transport: schemaServer().transport } });
    expect(await readFile(join(dir, 'src/moca.schema.json'), 'utf8')).toBe(snapshotBefore);
    expect(second.out).toContain(`Schema snapshot unchanged: ${join(dir, 'src/moca.schema.json')}`);
    void out;
  });

  it('--no-schema overrides the config and makes no catalog requests', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ schema: true }));
    const fake = schemaServer();
    await runGenerate({ schema: false, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: fake.transport } });
    expect(fake.requests.some((r) => r.query === 'get database')).toBe(false);
    expect(await exists(join(dir, 'src/moca.schema.json'))).toBe(false);
  });

  it('writes nothing at all when the schema introspection fails', async () => {
    const dir = await tempDir();
    const fake = schemaServer({ keys: mocaXml(511, {}, 'permission denied') });
    await expect(
      runGenerate({ schema: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: fake.transport } }),
    ).rejects.toThrow(/Schema introspection failed \(MOCA status 511\)/);
    expect(await exists(join(dir, 'src/moca.commands.json'))).toBe(false);
    expect(await exists(join(dir, 'src/moca.generated.ts'))).toBe(false);
    expect(await exists(join(dir, 'src/moca.schema.json'))).toBe(false);
  });

  it('regenerates offline from snapshots, and errors when the schema snapshot is missing', async () => {
    const dir = await tempDir();
    await expect(
      runGenerate({ schema: true, fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: io().io }),
    ).rejects.toThrow(`Schema is enabled but ${join(dir, 'src/moca.schema.json')} does not exist; run generate against a server first, or pass --no-schema`);
    expect(await exists(join(dir, 'src/moca.generated.ts'))).toBe(false);

    const schemaFixture = fileURLToPath(new URL('../../test/fixtures/schema.json', import.meta.url));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/moca.schema.json'), await readFile(schemaFixture, 'utf8'));
    await runGenerate({ schema: true, fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: io().io });
    expect(await readFile(join(dir, 'src/moca.schema.ts'), 'utf8')).toContain('widget_view: {');
  });

  it('--dry-run introspects and reports without writing', async () => {
    const dir = await tempDir();
    const { io: cliIo, out } = io();
    await runGenerate({ schema: true, dryRun: true, cwd: dir, env, io: cliIo, deps: { transport: schemaServer().transport } });
    expect(await exists(join(dir, 'src'))).toBe(false);
    expect(out).toContain(`Would write 2 tables to ${join(dir, 'src/moca.schema.ts')}`);
  });

  it('rejects a malformed schema setting', () => {
    expect(() => resolveSchemaSettings({ schema: 'yes' as never }, undefined, '/c', '/c/src/a.ts')).toThrow(
      'config.schema must be true, false or an object',
    );
  });

  it('computes NodeNext module specifiers', () => {
    expect(moduleSpecifier(join('/p', 'src', 'moca.generated.ts'), join('/p', 'src', 'moca.schema.ts'))).toBe('./moca.schema.js');
    expect(moduleSpecifier(join('/p', 'src', 'moca.generated.ts'), join('/p', 'types', 'schema.mts'))).toBe('../types/schema.mjs');
  });
});
