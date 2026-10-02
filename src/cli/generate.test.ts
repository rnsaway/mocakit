import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeMoca, loginOk, mocaXml, type FakeRequest } from '../../test/helpers/fake-moca.js';
import { SQLSERVER_COLUMNS, SQLSERVER_KEYS } from '../codegen/introspect-schema.js';
import type { RestRequest, RestResponse } from '../transport/rest.js';
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

function schemaServerHandler(r: FakeRequest, overrides: { keys?: string } = {}): string {
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
}

function schemaServer(overrides: { keys?: string } = {}) {
  return fakeMoca((r) => schemaServerHandler(r, overrides));
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

  it('refuses to run, writing nothing, when a hand-written file is in the docs directory', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src/moca-schema'), { recursive: true });
    await writeFile(join(dir, 'src/moca-schema/README.md'), '# hand-written\n');
    await expect(
      runGenerate({ schema: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: schemaServer().transport } }),
    ).rejects.toThrow(/README\.md exists and was not generated by mocakit/);
    expect(await readFile(join(dir, 'src/moca-schema/README.md'), 'utf8')).toBe('# hand-written\n');
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

function agentServer(overrides: { triggers?: string } = {}) {
  return fakeMoca((r) => {
    if (r.query.startsWith('login user')) return loginOk();
    if (r.query === 'list active commands') {
      return mocaXml(0, {
        columns: [{ name: 'cmplvl' }, { name: 'cmplvlseq', type: 'I' }, { name: 'command' }, { name: 'type' }, { name: 'syntax' }, { name: 'desc' }],
        rows: [
          ['WIDbase', '100', 'list orders', 'Local Syntax', '[select a from widget]', 'Lists orders'],
          ['USRwid', '9000', 'list orders', 'Local Syntax', 'list orders base | [update widget set a = 1]', 'Custom list'],
        ],
      });
    }
    if (r.query === 'list active triggers') {
      return (
        overrides.triggers ??
        mocaXml(0, {
          columns: [{ name: 'name' }, { name: 'command' }, { name: 'trgseq', type: 'I' }, { name: 'syntax' }, { name: 'enabled', type: 'O' }],
          rows: [['audit', 'list orders', '10', 'noop', '1']],
        })
      );
    }
    if (r.query.includes('from codmst')) return mocaXml(0, { columns: [{ name: 'colnam' }, { name: 'codval' }, { name: 'srtseq', type: 'I' }], rows: [['widget_id', 'W1', '1']] });
    if (r.query.includes('from dscmst')) return mocaXml(0, { columns: [{ name: 'colnam' }, { name: 'colval' }, { name: 'short_dsc' }, { name: 'lngdsc' }], rows: [['widget_id', 'W1', 'First', null]] });
    return schemaServerHandler(r);
  });
}

describe('runGenerate with command docs and codes', () => {
  const env = { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' };

  it('writes command docs, codes and usage with --schema --command-docs', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ schema: { codes: true } }));
    const { io: cliIo, out } = io();
    await runGenerate({ schema: true, commandDocs: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: agentServer().transport } });
    const doc = await readFile(join(dir, 'src/moca-commands/commands/list-orders.md'), 'utf8');
    expect(doc).toContain('list orders base | [update widget set a = 1]'); // USR source shown
    expect(doc).not.toContain('[select a from widget]'); // product source hidden
    expect(doc).toContain('[`widget`](../../moca-schema/tables/widget.md)');
    const schema = JSON.parse(await readFile(join(dir, 'src/moca.schema.json'), 'utf8'));
    expect(schema.usage).toEqual([{ table: 'widget', readBy: [], writtenBy: ['list orders'] }]);
    expect(schema.codes.columns[0].column).toBe('widget_id');
    expect(await readFile(join(dir, 'src/moca-schema/codes/widget_id.md'), 'utf8')).toContain('| W1 | First |  |');
    expect(await readFile(join(dir, 'src/moca-schema/tables/widget.md'), 'utf8')).toContain(
      '- Written by: [`list orders`](../../moca-commands/commands/list-orders.md)',
    );
    expect(out).toContain('Read 1 triggers on 1 commands');
    expect(out).toContain(`Wrote 1 command docs to ${join(dir, 'src/moca-commands')}`);
  });

  it('does not link table docs to commands the commandDocs filter left out', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ commandDocs: { include: ['nothing*'] } }));
    const { io: cliIo, out } = io();
    await runGenerate({ schema: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: agentServer().transport } });
    const table = await readFile(join(dir, 'src/moca-schema/tables/widget.md'), 'utf8');
    expect(table).toContain('- Written by: `list orders`');
    expect(table).not.toContain('moca-commands');
    expect(await exists(join(dir, 'src/moca-commands/commands/list-orders.md'))).toBe(false);
    const schema = JSON.parse(await readFile(join(dir, 'src/moca.schema.json'), 'utf8'));
    expect(schema.usage).toEqual([{ table: 'widget', readBy: [], writtenBy: ['list orders'] }]); // unfiltered
    expect(out).toContain(`Wrote 0 command docs to ${join(dir, 'src/moca-commands')}`);
  });

  it('does not link command docs to tables the schema filter left out', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ schema: { exclude: ['widget'] } }));
    await runGenerate({ schema: true, commandDocs: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: agentServer().transport } });
    const doc = await readFile(join(dir, 'src/moca-commands/commands/list-orders.md'), 'utf8');
    expect(doc).toContain('- Writes: `widget`');
    expect(doc).not.toContain('moca-schema/tables/widget.md');
    expect(await exists(join(dir, 'src/moca-schema/tables/widget.md'))).toBe(false);
  });

  it('keeps the previous usage when a later run has command docs off', async () => {
    const dir = await tempDir();
    await runGenerate({ schema: true, commandDocs: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: agentServer().transport } });
    await runGenerate({ schema: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: agentServer().transport } });
    const schema = JSON.parse(await readFile(join(dir, 'src/moca.schema.json'), 'utf8'));
    expect(schema.usage).toEqual([{ table: 'widget', readBy: [], writtenBy: ['list orders'] }]);
    expect(await readFile(join(dir, 'src/moca-schema/tables/widget.md'), 'utf8')).toContain('Written by');
  });

  it('keeps "Used by" command links in offline and --no-command-docs runs, from the generated command INDEX', async () => {
    const dir = await tempDir();
    const tableDoc = join(dir, 'src/moca-schema/tables/widget.md');
    await runGenerate({ schema: true, commandDocs: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: agentServer().transport } });
    const first = await readFile(tableDoc, 'utf8');
    expect(first).toContain('[`list orders`](../../moca-commands/commands/list-orders.md)');

    await runGenerate({ schema: true, fromSnapshot: 'src/moca.commands.json', dryRun: false, cwd: dir, env: {}, io: io().io });
    expect(await readFile(tableDoc, 'utf8')).toBe(first);

    await runGenerate({ schema: true, commandDocs: false, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: agentServer().transport } });
    expect(await readFile(tableDoc, 'utf8')).toBe(first);
  });

  it('honours a configured commandDocs.out when reading the command INDEX with command docs off', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ commandDocs: { out: 'agent/cmds' } }));
    await runGenerate({ schema: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: agentServer().transport } });
    await runGenerate({ schema: true, commandDocs: false, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: agentServer().transport } });
    expect(await readFile(join(dir, 'src/moca-schema/tables/widget.md'), 'utf8')).toContain(
      '[`list orders`](../../../agent/cmds/commands/list-orders.md)',
    );
  });

  it('refuses before writing anything when moca-commands holds a hand-written file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src/moca-commands'), { recursive: true });
    await writeFile(join(dir, 'src/moca-commands/README.md'), '# mine\n');
    await expect(
      runGenerate({ schema: true, commandDocs: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: agentServer().transport } }),
    ).rejects.toThrow(/was not generated by mocakit; move it or choose another commandDocs.out directory/);
    for (const f of ['src/moca.commands.json', 'src/moca.generated.ts', 'src/moca.schema.json', 'src/moca-schema/INDEX.md']) {
      expect(await exists(join(dir, f))).toBe(false);
    }
  });

  it('writes nothing when reading triggers fails', async () => {
    const dir = await tempDir();
    const fake = agentServer({ triggers: mocaXml(511, {}, 'denied') });
    await expect(
      runGenerate({ commandDocs: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: fake.transport } }),
    ).rejects.toThrow(/^Reading triggers failed \(MOCA status 511\)/);
    expect(await exists(join(dir, 'src/moca.commands.json'))).toBe(false);
  });

  it('skips command docs with a note under --from-snapshot', async () => {
    const dir = await tempDir();
    const { io: cliIo, out } = io();
    await runGenerate({ commandDocs: true, fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: cliIo });
    expect(out).toContain('Skipped command docs: they need a live server (--from-snapshot)');
    expect(await exists(join(dir, 'src/moca-commands'))).toBe(false);
  });

  it('notes missing table cross-references when schema is off, and prints the source reminder for source: all', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ commandDocs: { source: 'all' } }));
    const { io: cliIo, out } = io();
    await runGenerate({ dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: agentServer().transport } });
    expect(out).toContain('Command docs written without table cross-references (schema is off)');
    expect(out).toContain("Command docs include Blue Yonder product source (commandDocs.source = 'all'); keep them in a private repository.");
    expect(await readFile(join(dir, 'src/moca-commands/commands/list-orders.md'), 'utf8')).toContain('[select a from widget]');
  });
});

function restServer(overrides: { spec?: () => RestResponse } = {}) {
  const requests: RestRequest[] = [];
  const json = (status: number, body: unknown): RestResponse => ({ status, headers: {}, setCookies: [], body: JSON.stringify(body) });
  const restTransport = async (req: RestRequest): Promise<RestResponse> => {
    requests.push(req);
    const path = new URL(req.url).pathname;
    if (path.endsWith('/ws/admin/publicApis')) return json(200, [{ name: 'Public APIs', url: '/api/api-docs/v2' }]);
    if (path.endsWith('/api/api-docs/v2')) {
      return overrides.spec?.() ?? json(200, {
        swagger: '2.0', basePath: '/api',
        paths: { '/widget/v1/widgets': { get: { tags: ['widget (v1)'], 'x-permissions': ['VIEW_WIDGET'], responses: { 200: { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { widget_id: { type: 'string' } } } } } } } } } } },
      });
    }
    return json(404, {});
  };
  return { restTransport, requests };
}

describe('runGenerate with the REST API', () => {
  const env = { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' };

  it('writes the API snapshot, moca.api.ts, docs and a client with moca.api', async () => {
    const dir = await tempDir();
    const rest = restServer();
    const { io: cliIo, out } = io();
    await runGenerate({ api: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: schemaServer().transport, restTransport: rest.restTransport } });
    expect(JSON.parse(await readFile(join(dir, 'src/moca.api.json'), 'utf8')).operations).toHaveLength(1);
    expect(await readFile(join(dir, 'src/moca.api.ts'), 'utf8')).toContain('getWidgets');
    expect(await readFile(join(dir, 'src/moca.generated.ts'), 'utf8')).toContain('import { API, type MocaApi } from "./moca.api.js";');
    expect(await exists(join(dir, 'src/moca-api/operations/widget/getWidgets.md'))).toBe(true);
    expect(out).toContain('Read 1 API groups (1 operations)');
    expect(out).toContain(`Wrote 1 API operations to ${join(dir, 'src/moca.api.ts')}`);
    expect(rest.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('is fully off by default: no REST requests, no new log lines, client unchanged', async () => {
    const dir = await tempDir();
    const rest = restServer();
    const { io: cliIo, out } = io();
    await runGenerate({ dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: schemaServer().transport, restTransport: rest.restTransport } });
    expect(rest.requests).toEqual([]);
    expect(out.some((l) => l.includes('API'))).toBe(false);
    expect(await readFile(join(dir, 'src/moca.generated.ts'), 'utf8')).not.toContain('MocaApi');
  });

  it('writes nothing when a spec fetch fails', async () => {
    const dir = await tempDir();
    const rest = restServer({ spec: () => ({ status: 403, headers: {}, setCookies: [], body: '{}' }) });
    await expect(
      runGenerate({ api: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: schemaServer().transport, restTransport: rest.restTransport } }),
    ).rejects.toThrow('Fetching API spec "Public APIs" failed (HTTP 403)');
    for (const f of ['src/moca.commands.json', 'src/moca.generated.ts', 'src/moca.api.json']) expect(await exists(join(dir, f))).toBe(false);
  });

  it('rebuilds offline from moca.api.json and errors clearly when it is missing', async () => {
    const dir = await tempDir();
    await expect(runGenerate({ api: true, fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: io().io })).rejects.toThrow(/API is enabled but .* does not exist/);
    await runGenerate({ api: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: schemaServer().transport, restTransport: restServer().restTransport } });
    const before = await readFile(join(dir, 'src/moca.api.ts'), 'utf8');
    await runGenerate({ api: true, fromSnapshot: join(dir, 'src/moca.commands.json'), dryRun: false, cwd: dir, env: {}, io: io().io });
    expect(await readFile(join(dir, 'src/moca.api.ts'), 'utf8')).toBe(before);
  });
});
