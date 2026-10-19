import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { answerOsCommand, fakeMoca, loginOk, mocaXml, type FakeRequest } from '../../test/helpers/fake-moca.js';
import { fakeOs, type FakeOsOptions } from '../../test/helpers/fake-os.js';
import { buildZip } from '../../test/helpers/zip-builder.js';
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
    for (const f of ['src/moca.commands.json', 'src/moca.generated.ts', 'src/moca.api.json', 'src/moca.api.ts']) expect(await exists(join(dir, f))).toBe(false);
  });

  it('rebuilds offline from moca.api.json and errors clearly when it is missing', async () => {
    const dir = await tempDir();
    await expect(runGenerate({ api: true, fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: io().io })).rejects.toThrow(/API is enabled but .* does not exist/);
    await runGenerate({ api: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: schemaServer().transport, restTransport: restServer().restTransport } });
    const before = await readFile(join(dir, 'src/moca.api.ts'), 'utf8');
    await runGenerate({ api: true, fromSnapshot: join(dir, 'src/moca.commands.json'), dryRun: false, cwd: dir, env: {}, io: io().io });
    expect(await readFile(join(dir, 'src/moca.api.ts'), 'utf8')).toBe(before);
  });

  it('leaves an unchanged API snapshot alone', async () => {
    const dir = await tempDir();
    const deps = () => ({ transport: schemaServer().transport, restTransport: restServer().restTransport });
    await runGenerate({ api: true, dryRun: false, cwd: dir, env, io: io().io, deps: deps() });
    const file = join(dir, 'src/moca.api.json');
    const before = await readFile(file, 'utf8');
    const mtime = (await stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    const second = io();
    await runGenerate({ api: true, dryRun: false, cwd: dir, env, io: second.io, deps: deps() });
    expect(second.out).toContain(`API snapshot unchanged: ${file}`);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });

  it('applies filters only when emitting, not to the snapshot', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ api: { methods: ['post'] } }));
    await runGenerate({ dryRun: false, cwd: dir, env, io: io().io, deps: { transport: schemaServer().transport, restTransport: restServer().restTransport } });
    expect(JSON.parse(await readFile(join(dir, 'src/moca.api.json'), 'utf8')).operations).toHaveLength(1);
    expect(await readFile(join(dir, 'src/moca.api.ts'), 'utf8')).not.toContain('getWidgets');
  });

  it('writes no docs and logs nothing about them when api.docs is false', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ api: { docs: false } }));
    const { io: cliIo, out } = io();
    await runGenerate({ dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: schemaServer().transport, restTransport: restServer().restTransport } });
    expect(await exists(join(dir, 'src/moca-api'))).toBe(false);
    expect(out.some((l) => l.includes('API docs'))).toBe(false);
    expect(await exists(join(dir, 'src/moca.api.ts'))).toBe(true);
  });

  it('refuses before writing anything when moca-api holds a hand-written file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src/moca-api'), { recursive: true });
    await writeFile(join(dir, 'src/moca-api/INDEX.md'), '# hand-written\n');
    await expect(
      runGenerate({ api: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: schemaServer().transport, restTransport: restServer().restTransport } }),
    ).rejects.toThrow(/INDEX\.md exists and was not generated by mocakit/);
    expect(await readFile(join(dir, 'src/moca-api/INDEX.md'), 'utf8')).toBe('# hand-written\n');
    for (const f of ['src/moca.commands.json', 'src/moca.generated.ts', 'src/moca.api.json', 'src/moca.api.ts']) expect(await exists(join(dir, f))).toBe(false);
  });
});

const FAKE_DECOMPILER = fileURLToPath(new URL('../../test/fixtures/fake-decompiler.mjs', import.meta.url));
const JAVA_CLASSPATH = '/opt/acme/cust/lib/*:/opt/acme/cust/thirdparty/*:/opt/acme/cust/classes:/opt/acme/moca/lib/*:rel/x.jar';

function javaFiles(): Record<string, Uint8Array> {
  return {
    '/opt/acme/cust/lib/acme-cust.jar': buildZip({ 'com/acme/cust/Widgets.class': 'w', 'com/acme/base/Shared.class': 's' }),
    '/opt/acme/cust/thirdparty/acme-util-1.2.0.jar': buildZip({
      'META-INF/maven/com.acme/acme-util/pom.properties': 'groupId=com.acme\nartifactId=acme-util\nversion=1.2.0\n',
      'com/acme/util/Strings.class': 'u',
    }),
    '/opt/acme/cust/classes/com/acme/cust/Extra.class': new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
    '/opt/acme/moca/lib/acme-moca.jar': buildZip({ 'com/acme/base/Shared.class': 'b' }),
  };
}

function javaServer(os: Partial<FakeOsOptions> = {}) {
  const server = fakeOs({ family: 'posix', env: { LESDIR: '/opt/acme/cust', CLASSPATH: JAVA_CLASSPATH }, files: javaFiles(), ...os });
  const moca = fakeMoca(async (r) => {
    const answer = await answerOsCommand(r.query, server.exec);
    if (answer !== null) return answer;
    if (r.query.startsWith('login user')) return loginOk();
    if (r.query === 'list active commands') {
      return mocaXml(0, {
        columns: [
          { name: 'cmplvl' }, { name: 'cmplvlseq', type: 'I' }, { name: 'command' }, { name: 'type' },
          { name: 'syntax' }, { name: 'desc' }, { name: 'class' }, { name: 'functn' },
        ],
        rows: [['USRwid', '9000', 'move widget', 'Java Method', null, 'Moves a widget', 'com.acme.cust.Widgets', 'moveWidget']],
      });
    }
    return mocaXml(0);
  });
  return { ...moca, os: server };
}

const isOsCommand = (r: FakeRequest) => r.query.startsWith('execute os command');

async function filesUnder(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out.set(rel, (await readFile(join(dir, entry.name))).toString('base64'));
    }
  };
  await walk(root, '');
  return out;
}

// These runs spawn the fake decompiler (a node process per input), which is slow on a busy machine.
describe('runGenerate with Java introspection', { timeout: 30_000 }, () => {
  const env = { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' };
  const decompilerConfig = { java: { decompiler: { command: process.execPath, args: [FAKE_DECOMPILER, '{input}', '{output}'] } } };

  it('downloads, decompiles and documents the classpath, linking command docs to the implementation', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify(decompilerConfig));
    const server = javaServer();
    const { io: cliIo, out, err } = io();
    await runGenerate({ commandDocs: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: server.transport } });
    const java = join(dir, 'src/moca-java');

    expect(out).toContain('Read classpath: 5 entries (3 selected, 3 files, 0.0 MB)');
    expect(out).toContain('Downloaded 3 files (0.0 MB, 0 unchanged)');
    expect(out).toContain('Decompiled 2 entries (1 skipped: libraries)');
    expect(out).toContain(`Wrote Java inventory to ${java}`);
    expect(err).toContain('warning: classpath entry "rel/x.jar" is not an absolute path; skipped');

    expect(new Uint8Array(await readFile(join(java, 'jars/cust/lib/acme-cust.jar')))).toEqual(javaFiles()['/opt/acme/cust/lib/acme-cust.jar']);
    expect(await exists(join(java, 'jars/cust/thirdparty/acme-util-1.2.0.jar'))).toBe(true);
    expect(await exists(join(java, 'classes/cust/classes/com/acme/cust/Extra.class'))).toBe(true);
    expect(await readFile(join(java, 'src/cust/lib-acme-cust/com/acme/cust/Widgets.java'), 'utf8')).toContain('class Widgets');
    expect(await exists(join(java, 'src/cust/classes/com/acme/cust/Widgets.java'))).toBe(true);
    expect(await exists(join(java, 'src/cust/thirdparty-acme-util-1.2.0'))).toBe(false);

    const manifest = JSON.parse(await readFile(join(java, 'manifest.json'), 'utf8'));
    expect(manifest.entries.map((e: { path: string; selected: boolean; kind?: string }) => [e.path, e.selected, e.kind])).toEqual([
      ['/opt/acme/cust/lib', true, 'custom'],
      ['/opt/acme/cust/thirdparty', true, 'library'],
      ['/opt/acme/cust/classes', true, 'custom'],
      ['/opt/acme/moca/lib', false, 'custom'],
      ['rel/x.jar', false, undefined],
    ]);
    expect(manifest.overridden).toEqual([{ className: 'com.acme.base.Shared', winner: '/opt/acme/cust/lib', losers: ['/opt/acme/moca/lib'] }]);
    expect(manifest.src).toEqual(['src/cust/classes/com/acme/cust/Widgets.java', 'src/cust/lib-acme-cust/com/acme/cust/Widgets.java']);

    expect(await readFile(join(java, 'README.md'), 'utf8')).toContain('Only download or decompile code you are licensed to');
    expect(await readFile(join(java, 'entries/cust/lib-acme-cust.md'), 'utf8')).toContain(
      '- [`move widget`](../../../moca-commands/commands/move-widget.md): `com.acme.cust.Widgets.moveWidget`',
    );
    expect(await readFile(join(dir, 'src/moca-commands/commands/move-widget.md'), 'utf8')).toContain(
      'Implemented in `/opt/acme/cust/lib` (custom) — source: [`src/cust/lib-acme-cust/com/acme/cust/Widgets.java`](../../moca-java/src/cust/lib-acme-cust/com/acme/cust/Widgets.java)',
    );
  });

  it('downloads nothing and leaves every file byte-identical on a second run', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify(decompilerConfig));
    await runGenerate({ commandDocs: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: javaServer().transport } });
    const java = join(dir, 'src/moca-java');
    const before = await filesUnder(java);
    const manifestTime = (await stat(join(java, 'manifest.json'))).mtimeMs;

    const { io: cliIo, out } = io();
    await runGenerate({ commandDocs: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: javaServer().transport } });
    expect(out).toContain('Downloaded 0 files (0.0 MB, 3 unchanged)');
    expect(out).toContain('Decompiled 0 entries (1 skipped: libraries)');
    expect(await filesUnder(java)).toEqual(before);
    expect((await stat(join(java, 'manifest.json'))).mtimeMs).toBe(manifestTime);
  });

  it('treats a damaged manifest as no previous manifest and downloads everything again', async () => {
    const dir = await tempDir();
    await runGenerate({ java: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: javaServer().transport } });
    await writeFile(join(dir, 'src/moca-java/manifest.json'), '{"entries": [{"files": 3}]}');
    const { io: cliIo, out } = io();
    await runGenerate({ java: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: javaServer().transport } });
    expect(out).toContain('Downloaded 3 files (0.0 MB, 0 unchanged)');
    expect(out).toContain('No decompiler configured; skipped Java source');
  });

  it.each([
    ['decompiler: null', (m: Record<string, unknown>) => ({ ...m, decompiler: null })],
    ['decompiler.command not a string', (m: Record<string, unknown>) => ({ ...m, decompiler: { command: 1 } })],
    ['decompiler.inputs with a non-string value', (m: Record<string, unknown>) => ({ ...m, decompiler: { command: 'x', args: [], inputs: { a: 1 } } })],
    ['a malformed commands element', (m: Record<string, unknown>) => ({ ...m, commands: [{ key: 'move widget', name: 7 }] })],
    ['commands not an array', (m: Record<string, unknown>) => ({ ...m, commands: 'x' })],
  ])('treats a manifest with %s as no previous manifest (full download, no crash)', async (_name, damage) => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify(decompilerConfig));
    await runGenerate({ dryRun: false, cwd: dir, env, io: io().io, deps: { transport: javaServer().transport } });
    const file = join(dir, 'src/moca-java/manifest.json');
    await writeFile(file, JSON.stringify(damage(JSON.parse(await readFile(file, 'utf8')))));
    const { io: cliIo, out } = io();
    await runGenerate({ dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: javaServer().transport } });
    expect(out).toContain('Downloaded 3 files (0.0 MB, 0 unchanged)');
    expect(out).toContain('Decompiled 2 entries (1 skipped: libraries)');
  });

  it('removes the files of a JAR that left the server', async () => {
    const dir = await tempDir();
    await runGenerate({ java: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: javaServer().transport } });
    const files = javaFiles();
    delete files['/opt/acme/cust/thirdparty/acme-util-1.2.0.jar'];
    const { io: cliIo, out } = io();
    await runGenerate({ java: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: javaServer({ files }).transport } });
    expect(out).toContain('Removed 1 stale Java files');
    expect(await exists(join(dir, 'src/moca-java/jars/cust/thirdparty'))).toBe(false);
    expect(await exists(join(dir, 'src/moca-java/jars/cust/lib/acme-cust.jar'))).toBe(true);
  });

  it('writes nothing at all when a checksum does not match', async () => {
    const dir = await tempDir();
    const server = javaServer({ corrupt: ['/opt/acme/cust/lib/acme-cust.jar'] });
    await expect(
      runGenerate({ java: true, commandDocs: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: server.transport } }),
    ).rejects.toThrow(/^checksum mismatch for \/opt\/acme\/cust\/lib\/acme-cust\.jar/);
    expect(server.requests.at(-1)?.query).toBe('logout user');
    for (const f of ['src/moca.commands.json', 'src/moca.generated.ts', 'src/moca-commands/INDEX.md', 'src/moca-java']) {
      expect(await exists(join(dir, f))).toBe(false);
    }
  });

  it('lists, downloads and verifies inner-class files whose names contain $', async () => {
    const dir = await tempDir();
    const inner = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 1]);
    const files = { ...javaFiles(), '/opt/acme/cust/build/classes/com/acme/cust/Widget$1.class': inner };
    const server = javaServer({ files, env: { LESDIR: '/opt/acme/cust', CLASSPATH: `${JAVA_CLASSPATH}:/opt/acme/cust/build/classes` } });
    const { io: cliIo, out, err } = io();
    await runGenerate({ java: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: server.transport } });
    expect(out).toContain('Downloaded 4 files (0.0 MB, 0 unchanged)');
    expect(err.filter((l) => l.includes('$'))).toEqual([]);
    expect(server.os.commands.some((c) => c.startsWith('sha256sum ') && c.includes("'/opt/acme/cust/build/classes/com/acme/cust/Widget$1.class'"))).toBe(true);
    expect(new Uint8Array(await readFile(join(dir, 'src/moca-java/classes/cust/build/classes/com/acme/cust/Widget$1.class')))).toEqual(inner);
    const manifest = JSON.parse(await readFile(join(dir, 'src/moca-java/manifest.json'), 'utf8'));
    const entry = manifest.entries.find((e: { path: string }) => e.path === '/opt/acme/cust/build/classes');
    expect(entry.files.map((f: { local: string }) => f.local)).toEqual(['classes/cust/build/classes/com/acme/cust/Widget$1.class']);
    expect(await readFile(join(dir, 'src/moca-java/entries/cust/build-classes.md'), 'utf8')).toContain('`Widget$1`');
  });

  it('fails, writing nothing, when the decompiler cannot be started', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ java: { decompiler: { command: 'mocakit-no-such-decompiler', args: ['{input}'] } } }));
    await expect(
      runGenerate({ dryRun: false, cwd: dir, env, io: io().io, deps: { transport: javaServer().transport } }),
    ).rejects.toThrow('decompiler command "mocakit-no-such-decompiler" could not be started');
    expect(await exists(join(dir, 'src/moca-java'))).toBe(false);
    expect(await exists(join(dir, 'src/moca.commands.json'))).toBe(false);
  });

  it('writes and deletes nothing on --dry-run', async () => {
    const dir = await tempDir();
    const { io: cliIo, out } = io();
    await runGenerate({ java: true, dryRun: true, cwd: dir, env, io: cliIo, deps: { transport: javaServer().transport } });
    expect(out).toContain(`Would write Java inventory to ${join(dir, 'src/moca-java')}`);
    expect(await exists(join(dir, 'src/moca-java'))).toBe(false);
  });

  it('--from-snapshot errors without the folder, and otherwise rebuilds the docs without any server call', async () => {
    const dir = await tempDir();
    const java = join(dir, 'src/moca-java');
    await expect(
      runGenerate({ java: true, fromSnapshot: fixture, out: 'src/moca.generated.ts', dryRun: false, cwd: dir, env: {}, io: io().io }),
    ).rejects.toThrow(`Java introspection is enabled but ${java} does not exist; run generate against a server first, or pass --no-java`);

    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify(decompilerConfig));
    await runGenerate({ commandDocs: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: javaServer().transport } });
    const before = await filesUnder(java);
    await rm(join(java, 'INDEX.md'));
    await rm(join(java, 'entries'), { recursive: true });

    const { io: cliIo, out } = io();
    await runGenerate({ fromSnapshot: 'src/moca.commands.json', dryRun: false, cwd: dir, env: {}, io: cliIo });
    expect(out).toContain(`Wrote Java inventory to ${java}`);
    expect(out).toContain('Decompiled 0 entries (1 skipped: libraries)');
    expect(out.some((l) => l.startsWith('Read classpath') || l.startsWith('Downloaded'))).toBe(false);
    expect(await filesUnder(java)).toEqual(before);
  });

  it('is off by default: no OS commands and no Java logs', async () => {
    const dir = await tempDir();
    const server = javaServer();
    const { io: cliIo, out } = io();
    await runGenerate({ commandDocs: true, dryRun: false, cwd: dir, env, io: cliIo, deps: { transport: server.transport } });
    expect(server.requests.some(isOsCommand)).toBe(false);
    expect(out.filter((l) => /Java|classpath|Decompiled|Downloaded/.test(l))).toEqual([]);
    expect(await exists(join(dir, 'src/moca-java'))).toBe(false);
    expect(await readFile(join(dir, 'src/moca-commands/commands/move-widget.md'), 'utf8')).not.toContain('Implemented in');
  });

  it('--no-java overrides the config', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ java: true }));
    const server = javaServer();
    await runGenerate({ java: false, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: server.transport } });
    expect(server.requests.some(isOsCommand)).toBe(false);
  });

  it('refuses before writing anything when moca-java holds a hand-written docs file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src/moca-java'), { recursive: true });
    await writeFile(join(dir, 'src/moca-java/README.md'), '# mine\n');
    await expect(
      runGenerate({ java: true, dryRun: false, cwd: dir, env, io: io().io, deps: { transport: javaServer().transport } }),
    ).rejects.toThrow(/was not generated by mocakit; move it or choose another java.dir directory/);
    expect(await exists(join(dir, 'src/moca-java/manifest.json'))).toBe(false);
    expect(await exists(join(dir, 'src/moca.commands.json'))).toBe(false);
  });
});

describe('runGenerate with agent context', () => {
  const guide = '# Acme Guide\n\n## Setup\n\nInstall it.\n\n## Usage\n\nUse it.\n';

  it('is off by default: no context logs and no moca-context folder', async () => {
    const dir = await tempDir();
    const { io: cliIo, out, err } = io();
    await runGenerate({ fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: cliIo });
    expect(out).toEqual([`Wrote 10 commands to ${join(dir, 'src/moca.generated.ts')}`]);
    expect(err.some((l) => /context|documents/.test(l))).toBe(false);
    expect(await exists(join(dir, 'src/moca-context'))).toBe(false);
  });

  it('--context converts the sources next to the other output, without a server', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src/moca-context/sources'), { recursive: true });
    await writeFile(join(dir, 'src/moca-context/sources/guide.md'), guide);
    const { io: cliIo, out } = io();
    await runGenerate({ context: true, fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: cliIo });
    expect(out).toEqual([
      'Converted 1 documents (2 sections, 0 unchanged)',
      `Wrote 10 commands to ${join(dir, 'src/moca.generated.ts')}`,
      `Wrote agent context to ${join(dir, 'src/moca-context')}`,
    ]);
    expect(await readFile(join(dir, 'src/moca-context/docs/guide/02-usage.md'), 'utf8')).toContain('Use it.');
  });

  it('runs when the config enables it, and --no-context overrides the config', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.json'), JSON.stringify({ context: { dir: 'ctx' } }));
    await runGenerate({ context: false, fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: io().io });
    expect(await exists(join(dir, 'ctx'))).toBe(false);
    const { io: cliIo, out } = io();
    await runGenerate({ fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: cliIo });
    expect(out).toContain(`Put documents to convert in ${join(dir, 'ctx/sources')}`);
    expect(await exists(join(dir, 'ctx/sources'))).toBe(true);
  });

  it('refuses before writing anything when moca-context holds a hand-written section file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src/moca-context/sources'), { recursive: true });
    await mkdir(join(dir, 'src/moca-context/docs/guide'), { recursive: true });
    await writeFile(join(dir, 'src/moca-context/sources/guide.md'), guide);
    await writeFile(join(dir, 'src/moca-context/docs/guide/01-setup.md'), 'mine\n');
    await expect(
      runGenerate({ context: true, fromSnapshot: fixture, dryRun: false, cwd: dir, env: {}, io: io().io }),
    ).rejects.toThrow(/was not generated by mocakit; move it or choose another context.dir directory/);
    expect(await exists(join(dir, 'src/moca.generated.ts'))).toBe(false);
    expect(await exists(join(dir, 'src/moca-context/INDEX.md'))).toBe(false);
  });

  it('writes nothing for the context on --dry-run', async () => {
    const dir = await tempDir();
    const { io: cliIo, out } = io();
    await runGenerate({ context: true, fromSnapshot: fixture, dryRun: true, cwd: dir, env: {}, io: cliIo });
    expect(out).toContain(`Would write agent context to ${join(dir, 'src/moca-context')}`);
    expect(await exists(join(dir, 'src'))).toBe(false);
  });
});
