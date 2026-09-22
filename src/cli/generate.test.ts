import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeMoca, loginOk, mocaXml } from '../../test/helpers/fake-moca.js';
import { runGenerate } from './generate.js';

const fixture = fileURLToPath(new URL('../../test/fixtures/snapshot.json', import.meta.url));

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } };
}

describe('runGenerate', () => {
  it('generates from a snapshot without a config or server, applying CLI --out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mocakit-gen-'));
    const { io: cliIo, out, err } = io();
    await runGenerate({ fromSnapshot: fixture, out: 'gen/moca.ts', dryRun: false, cwd: dir, env: {}, io: cliIo });
    const code = await readFile(join(dir, 'gen/moca.ts'), 'utf8');
    expect(code).toContain('export class Moca extends mk.MocaClient');
    expect(out.at(-1)).toBe(`Wrote 5 commands to ${join(dir, 'gen/moca.ts')}`);
    expect(err).toEqual(['warning: Commands "list orders", "list-orders" map to the same method name; generated listOrders, listOrders_2']);
  });

  it('introspects a server, writes the snapshot next to out, and applies config filters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mocakit-gen-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'mocakit-gen-'));
    const { io: cliIo, out } = io();
    await runGenerate({ fromSnapshot: fixture, out: 'gen/moca.ts', dryRun: true, cwd: dir, env: {}, io: cliIo });
    await expect(readFile(join(dir, 'gen/moca.ts'), 'utf8')).rejects.toThrow();
    expect(out.at(-1)).toMatch(/^Would write 5 commands/);
  });
});
