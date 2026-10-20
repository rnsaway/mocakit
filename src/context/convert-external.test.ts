import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConverters, convertExternal, converterHash, type ConverterConfig } from './convert-external.js';

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-converter.mjs', import.meta.url));
const config = (mode: string, extra: Partial<ConverterConfig> = {}, withOutput = false): ConverterConfig => ({
  command: process.execPath,
  args: [FAKE, mode, '{input}', ...(withOutput ? ['{output}'] : [])],
  ...extra,
});
const NAME = 'Odd "name" & stuff.PDF';
const source = { name: NAME, bytes: new TextEncoder().encode('%PDF-fake') };
const MD = '# Gadget Guide\n\n## Parts\n\nInput was given.\n';

// Each test gets its own temp root, so leftovers are checked without listing the shared tmpdir.
const roots: string[] = [];
const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'mocakit-convert-test-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const lockedRm = ((): Promise<void> => Promise.reject(new Error('locked'))) as unknown as typeof rm;

describe('convertExternal', () => {
  it('cleans up plain-text output into Markdown', async () => {
    const result = await convertExternal(config('ok-text', { output: 'text' }), source);
    expect(result).toHaveProperty('markdown');
    const md = (result as { markdown: string }).markdown;
    expect(md).not.toContain('ACME CONFIDENTIAL');
    expect(md).toContain('# Overview');
    expect(md).toContain('## Naming');
    expect(md).not.toContain('........');
  });

  it('passes Markdown output through', async () => {
    expect(await convertExternal(config('ok-md'), source)).toEqual({ markdown: MD });
  });

  it('reads the {output} file when it is in args', async () => {
    expect(await convertExternal(config('ok-md', {}, true), source)).toEqual({ markdown: MD });
  });

  it('gives a warning when the converter fails', async () => {
    const result = (await convertExternal(config('fail'), source)) as { warning: string };
    expect(result.warning).toContain(`converter failed for ${NAME} (exit code 2)`);
    expect(result.warning).toContain('boom: cannot convert');
  });

  it('gives a warning for empty output', async () => {
    const warning = { warning: `converter produced no text for ${NAME}` };
    expect(await convertExternal(config('empty'), source)).toEqual(warning);
    expect(await convertExternal(config('empty', {}, true), source)).toEqual(warning);
  });

  it('gives a warning when the text cleans up to nothing', async () => {
    const cfg: ConverterConfig = {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(" \\n\\f \\n")'],
      output: 'text',
    };
    expect(await convertExternal(cfg, source)).toEqual({ warning: `converter produced no text for ${NAME}` });
  });

  it('times out a hanging converter', async () => {
    const result = (await convertExternal(config('hang', { timeoutMs: 200 }), source)) as { warning: string };
    expect(result.warning).toBe(`converter timed out for ${NAME} after 200 ms`);
  });

  it('gives a warning when the command cannot be started', async () => {
    const result = (await convertExternal({ command: 'mocakit-no-such-converter', args: [] }, source)) as {
      warning: string;
    };
    expect(result.warning).toContain('converter command "mocakit-no-such-converter" could not be started');
  });

  it('uses a fixed safe input name with the source extension', async () => {
    const cfg: ConverterConfig = {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(require("node:path").basename(process.argv[1]))', '{input}'],
    };
    expect(await convertExternal(cfg, source)).toEqual({ markdown: 'input.pdf' });
    expect(await convertExternal(cfg, { name: 'x.we"ird;ext!', bytes: new Uint8Array() })).toEqual({
      markdown: 'input',
    });
  });

  it('decodes UTF-8 with replacement, strips a BOM and normalises CRLF', async () => {
    const script =
      'process.stdout.write(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from("a\\r\\nb "),Buffer.from([0xff]),Buffer.from("\\r\\n")]))';
    const result = await convertExternal({ command: process.execPath, args: ['-e', script] }, source);
    expect(result).toEqual({ markdown: 'a\nb �\n' });
  });

  it('removes the temp folder, also after a failure', async () => {
    const tmpRoot = await newRoot();
    await convertExternal(config('ok-md'), source, { tmpRoot });
    await convertExternal(config('fail'), source, { tmpRoot });
    await convertExternal(config('empty', {}, true), source, { tmpRoot });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('never rejects when the temp folder cannot be removed', async () => {
    const tmpRoot = await newRoot();
    const ok = await convertExternal(config('ok-md'), source, { rm: lockedRm, tmpRoot });
    expect(ok).toHaveProperty('markdown');
    expect((ok as { cleanupWarning?: string }).cleanupWarning).toMatch(/^temp folder not removed: /);
    const failed = await convertExternal(config('fail'), source, { rm: lockedRm, tmpRoot });
    expect((failed as { warning: string }).warning).toMatch(/\(temp folder not removed: .+\)$/);
    expect(await readdir(tmpRoot)).toHaveLength(2);
  });
});

describe('checkConverters', () => {
  it('passes for startable commands', async () => {
    await expect(checkConverters({ '.pdf': config('ok-md') })).resolves.toBeUndefined();
    await expect(checkConverters({})).resolves.toBeUndefined();
  });

  it('throws the exact message for a missing command', async () => {
    await expect(checkConverters({ '.pdf': { command: 'mocakit-no-such-converter', args: [] } })).rejects.toThrow(
      'converter command "mocakit-no-such-converter" could not be started',
    );
  });

  it('adds the Windows wrapper hint for EINVAL start failures', async () => {
    if (process.platform !== 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'mocakit-test-'));
    try {
      const cmd = join(dir, 'conv.cmd');
      await writeFile(cmd, '@echo off\r\n');
      await expect(checkConverters({ '.pdf': { command: cmd, args: [] } })).rejects.toThrow(
        `converter command "${cmd}" could not be started (on Windows, .cmd/.bat wrappers can't be run directly; point at the .exe or use java -jar)`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('converterHash', () => {
  const base: ConverterConfig = { command: 'pdftotext', args: ['-layout', '{input}', '-'], output: 'text' };

  it('is a stable sha256 hex', () => {
    expect(converterHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(converterHash({ ...base })).toBe(converterHash(base));
  });

  it('changes when command, args or output change', () => {
    expect(converterHash({ ...base, args: ['{input}', '-'] })).not.toBe(converterHash(base));
    expect(converterHash({ ...base, command: 'other' })).not.toBe(converterHash(base));
    expect(converterHash({ ...base, output: 'markdown' })).not.toBe(converterHash(base));
  });

  it('ignores the timeout and treats a missing output as markdown', () => {
    expect(converterHash({ ...base, timeoutMs: 5 })).toBe(converterHash(base));
    expect(converterHash({ command: 'c', args: [] })).toBe(
      converterHash({ command: 'c', args: [], output: 'markdown' }),
    );
  });
});
