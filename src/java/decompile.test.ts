import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDecompiler,
  decompile,
  decompilerHash,
  inputHash,
  needsDecompile,
  type DecompilerConfig,
} from './decompile.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'fake-decompiler.mjs');
const config = (extra: Partial<DecompilerConfig> = {}): DecompilerConfig => ({
  command: process.execPath,
  args: [FAKE, '{input}', '{output}'],
  ...extra,
});
const jar = (name = 'cust.jar') => ({ name, files: new Map([[name, new Uint8Array([80, 75, 3, 4])]]) });

function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.FAKE_DECOMPILER_MODE;
  process.env.FAKE_DECOMPILER_MODE = mode;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.FAKE_DECOMPILER_MODE;
    else process.env.FAKE_DECOMPILER_MODE = prev;
  });
}

const before0 = new Set<string>();
const tmpEntries = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('mocakit-decompile-')));

describe('decompile', () => {
  it('returns the sources map for ok output and removes the temp folder', async () => {
    const before = tmpEntries();
    const r = await withMode('ok', () => decompile(config(), jar()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.sources.keys()]).toEqual(['com/acme/cust/Widgets.java']);
      expect(r.sources.get('com/acme/cust/Widgets.java')).toContain('class Widgets');
    }
    expect(tmpEntries()).toEqual(before);
  });

  it('accepts a classes tree', async () => {
    const files = new Map([
      ['com/acme/cust/Widgets.class', new Uint8Array([1])],
      ['com/acme/cust/Other.class', new Uint8Array([2])],
    ]);
    const r = await withMode('ok', () => decompile(config(), { name: 'classes', files }));
    expect(r.ok).toBe(true);
  });

  it('warns naming the input when the decompiler fails', async () => {
    const before = tmpEntries();
    const r = await withMode('fail', () => decompile(config(), jar()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.warning).toContain('cust.jar');
    expect(tmpEntries()).toEqual(before);
  });

  it('warns about a timeout', async () => {
    const before = tmpEntries();
    const r = await withMode('hang', () => decompile(config({ timeoutMs: 200 }), jar()));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.warning).toMatch(/timed out/);
      expect(r.warning).toContain('cust.jar');
    }
    expect(tmpEntries()).toEqual(before);
  });

  it('warns when the decompiler produced no source', async () => {
    const r = await withMode('empty', () => decompile(config(), jar()));
    expect(r).toEqual({ ok: false, warning: 'decompiler produced no source for cust.jar' });
  });

  it('reports a missing command with the exact message', async () => {
    const r = await decompile({ command: 'mocakit-no-such-command-xyz', args: ['{input}', '{output}'] }, jar());
    expect(r).toEqual({ ok: false, warning: 'decompiler command "mocakit-no-such-command-xyz" could not be started' });
  });

  it.each([['/abs/x.class'], ['../x.class'], ['a/../../x.class'], ['a\\b.class'], ['C:x.class'], ['C:/x.class'], ['']])(
    'rejects the unsafe key %j without writing',
    async (key) => {
      const before = tmpEntries();
      const r = await withMode('ok', () =>
        decompile(config(), { name: 'bad', files: new Map([[key, new Uint8Array([1])]]) }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.warning).toContain('bad');
      expect(tmpEntries()).toEqual(before);
    },
  );

  it('returns ok:false instead of rejecting on a key collision', async () => {
    const files = new Map([
      ['a', new Uint8Array([1])],
      ['a/b.class', new Uint8Array([2])],
    ]);
    const before = tmpEntries();
    const r = await withMode('ok', () => decompile(config(), { name: 'clash', files }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.warning).toMatch(/^decompile failed for clash: /);
    expect(tmpEntries()).toEqual(before);
  });

  it('keeps an ok result when removing the temp folder fails', async () => {
    for (const n of tmpEntries()) before0.add(n);
    const failingRm = (async () => {
      throw new Error('EBUSY');
    }) as unknown as typeof rm;
    const r = await withMode('ok', () => decompile(config(), jar(), { rm: failingRm }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cleanupWarning).toMatch(/^temp folder not removed: /);
    const r2 = await withMode('fail', () => decompile(config(), jar(), { rm: failingRm }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.warning).toMatch(/\(temp folder not removed: .+\)$/);
    for (const n of tmpEntries()) if (!before0.has(n)) rmSync(join(tmpdir(), n), { recursive: true, force: true });
  });

  it('does not follow symlinks in decompiler output', async () => {
    if (process.platform === 'win32') return;
    const outside = mkdtempSync(join(tmpdir(), 'mocakit-outside-'));
    writeFileSync(join(outside, 'Secret.java'), 'secret');
    const script = join(outside, 'link.mjs');
    writeFileSync(
      script,
      [
        "import {symlinkSync,mkdirSync,writeFileSync} from 'node:fs';",
        "import {join} from 'node:path';",
        'const out=process.argv[3];',
        `symlinkSync(${JSON.stringify(outside)},join(out,'lnk'));`,
        `symlinkSync(${JSON.stringify(join(outside, 'Secret.java'))},join(out,'Leak.java'));`,
        "mkdirSync(join(out,'a'));writeFileSync(join(out,'a','Ok.java'),'ok');",
      ].join('\n'),
    );
    try {
      const r = await decompile({ command: process.execPath, args: [script, '{input}', '{output}'] }, jar());
      expect(r.ok).toBe(true);
      if (r.ok) expect([...r.sources.keys()]).toEqual(['a/Ok.java']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('checkDecompiler', () => {
  it('resolves when the command starts, ignoring the exit code', async () => {
    await expect(checkDecompiler({ command: process.execPath, args: [] })).resolves.toBeUndefined();
  });

  it('throws the exact message for a missing command', async () => {
    await expect(checkDecompiler({ command: 'mocakit-no-such-command-xyz', args: [] })).rejects.toThrow(
      'decompiler command "mocakit-no-such-command-xyz" could not be started',
    );
  });
});

describe('hashes and needsDecompile', () => {
  it('decompilerHash depends on command and args only', () => {
    const a = decompilerHash(config());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(decompilerHash(config({ timeoutMs: 5 }))).toBe(a);
    expect(decompilerHash({ command: 'x', args: [] })).not.toBe(a);
  });

  it('inputHash is order independent and content sensitive', () => {
    const f1 = { path: 'b.jar', sha256: '2' };
    const f2 = { path: 'a.jar', sha256: '1' };
    expect(inputHash([f1, f2])).toBe(inputHash([f2, f1]));
    expect(inputHash([f1, f2])).not.toBe(inputHash([f1, { path: 'a.jar', sha256: '9' }]));
  });

  it('needsDecompile is true for new, changed or unknown and false otherwise', () => {
    expect(needsDecompile(undefined, 'cust', 'h1')).toBe(true);
    expect(needsDecompile({}, 'cust', 'h1')).toBe(true);
    expect(needsDecompile({ cust: 'h0' }, 'cust', 'h1')).toBe(true);
    expect(needsDecompile({ cust: 'h1' }, 'cust', 'h1')).toBe(false);
  });
});
