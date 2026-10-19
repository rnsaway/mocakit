import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildZip } from '../../test/helpers/zip-builder.js';
import type { MocakitConfig } from '../define-config.js';
import { readAgentFile, resolveContextSettings, runContext, type ResolvedContext } from './context-step.js';

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-converter.mjs', import.meta.url));
const VERSION = '0.6.0';

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mocakit-context-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } };
}

const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('resolveContextSettings', () => {
  const out = resolve('/proj/src/moca.generated.ts');

  it('is off unless the config or the flag enables it', () => {
    expect(resolveContextSettings({}, undefined, '/proj', out)).toBeNull();
    expect(resolveContextSettings({ context: false }, undefined, '/proj', out)).toBeNull();
    expect(resolveContextSettings({ context: true }, false, '/proj', out)).toBeNull();
  });

  it('uses moca-context next to out, sources inside it and a 61,440-byte section limit by default', () => {
    expect(resolveContextSettings({}, true, '/proj', out)).toEqual({
      dir: resolve('/proj/src/moca-context'),
      sources: resolve('/proj/src/moca-context/sources'),
      converters: {},
      agent: [],
      maxSectionBytes: 61_440,
    });
    expect(resolveContextSettings({ context: true }, undefined, '/proj', out)?.dir).toBe(resolve('/proj/src/moca-context'));
  });

  it('resolves dir and sources against the config folder and keeps the other options', () => {
    const converters = { '.pdf': { command: 'pdftotext', args: ['{input}', '-'], output: 'text' as const, timeoutMs: 5000 } };
    expect(
      resolveContextSettings(
        { context: { dir: 'ctx', sources: 'inbox', converters, agent: ['scans/*'], maxSectionBytes: 1000 } },
        undefined,
        '/cfg',
        out,
      ),
    ).toEqual({ dir: resolve('/cfg/ctx'), sources: resolve('/cfg/inbox'), converters, agent: ['scans/*'], maxSectionBytes: 1000 });
  });

  it.each([
    ['context', { context: 'yes' }, 'config.context must be true, false or an object'],
    ['dir', { context: { dir: 3 } }, 'context.dir must be a string'],
    ['sources', { context: { sources: [] } }, 'context.sources must be a string'],
    ['agent', { context: { agent: 'x' } }, 'context.agent must be an array of strings'],
    ['maxSectionBytes', { context: { maxSectionBytes: 0 } }, 'context.maxSectionBytes must be a positive number of bytes'],
    ['converters', { context: { converters: [] } }, 'context.converters must be an object'],
    ['a converter key', { context: { converters: { PDF: { command: 'x', args: [] } } } }, 'context.converters keys must be lowercase extensions with the dot, e.g. ".pdf"'],
    ['a converter', { context: { converters: { '.pdf': { command: '', args: [] } } } }, 'context.converters[".pdf"] must be an object with a command string and an args array of strings'],
    ['a converter output', { context: { converters: { '.pdf': { command: 'x', args: [], output: 'html' } } } }, `context.converters[".pdf"].output must be 'markdown' or 'text'`],
    ['a converter timeout', { context: { converters: { '.pdf': { command: 'x', args: [], timeoutMs: -1 } } } }, 'context.converters[".pdf"].timeoutMs must be a positive number'],
  ])('rejects an invalid %s', (_name, config, message) => {
    expect(() => resolveContextSettings(config as unknown as MocakitConfig, undefined, '/proj', out)).toThrow(message);
  });
});

describe('readAgentFile', () => {
  const hex = 'a'.repeat(64);

  it('accepts the exact sha line and returns the Markdown after it', () => {
    expect(readAgentFile(`<!-- source-sha256: ${hex} -->\n# Title\n\nBody.\n`)).toEqual({ sha256: hex, markdown: '# Title\n\nBody.\n' });
    expect(readAgentFile(`﻿<!-- source-sha256: ${hex} -->\r\n# T\r\n`)).toEqual({ sha256: hex, markdown: '# T\r\n' });
  });

  it.each([
    ['a missing line', '# Title\n'],
    ['an empty file', ''],
    ['a short hash', '<!-- source-sha256: abc -->\n# T\n'],
    ['a different comment', `<!-- sha256: ${hex} -->\n# T\n`],
    ['the line not first', `\n<!-- source-sha256: ${hex} -->\n# T\n`],
    ['extra text on the line', `<!-- source-sha256: ${hex} --> more\n# T\n`],
  ])('rejects %s', (_name, text) => {
    expect(readAgentFile(text)).toBeNull();
  });
});

describe('runContext', () => {
  const docxXml = [
    '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Picking</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Pick the widgets in order.</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Packing</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Pack them in boxes.</w:t></w:r></w:p>',
    '</w:body></w:document>',
  ].join('');

  async function project(converterMode = 'ok-text'): Promise<{ root: string; settings: ResolvedContext }> {
    const root = await tempDir();
    const settings = resolveContextSettings(
      { context: { converters: { '.pdf': { command: process.execPath, args: [FAKE, converterMode, '{input}'], output: 'text' } } } },
      undefined,
      root,
      join(root, 'src/moca.generated.ts'),
    )!;
    const src = settings.sources;
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'guide.md'), '# Acme Guide\n\n## Setup\n\nInstall the widget first.\n\n## Usage\n\nRun the widget daily.\n');
    await writeFile(join(src, 'notes.docx'), buildZip({ 'word/document.xml': docxXml }));
    await writeFile(join(src, 'table.csv'), 'name,qty\nnut,2\nbolt,5\n');
    await writeFile(join(src, 'scan.pdf'), '%PDF-fake acme scan');
    await writeFile(join(src, 'diagram.vsdx'), 'fake diagram v1');
    return { root, settings };
  }

  const run = async (settings: ResolvedContext, dryRun = false) => {
    const c = capture();
    await runContext(settings, c.io, { dryRun, version: VERSION });
    return c;
  };

  /** Every file under `dir` (except sources/) with its content and mtime. */
  async function snapshot(dir: string): Promise<Map<string, { content: string; mtime: number }>> {
    const result = new Map<string, { content: string; mtime: number }>();
    const walk = async (folder: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const rel = `${prefix}${entry.name}`;
        if (rel === 'sources') continue;
        if (entry.isDirectory()) await walk(join(folder, entry.name), `${rel}/`);
        else result.set(rel, { content: await readFile(join(folder, entry.name), 'utf8'), mtime: (await stat(join(folder, entry.name))).mtimeMs });
      }
    };
    await walk(dir, '');
    return result;
  }

  it('converts four documents on the first run and lists the fifth in PENDING.md', async () => {
    const { settings } = await project();
    const { out, err } = await run(settings);
    const dir = settings.dir;
    expect(err).toEqual([]);
    expect(out).toEqual([
      'Converted 4 documents (6 sections, 0 unchanged)',
      `1 documents waiting for agent conversion (see ${join(dir, 'PENDING.md')})`,
      `Wrote agent context to ${dir}`,
    ]);
    expect((await readdir(join(dir, 'docs'))).sort()).toEqual(['guide', 'notes', 'scan', 'table']);
    expect((await readdir(join(dir, 'docs/guide'))).sort()).toEqual(['01-setup.md', '02-usage.md', 'README.md']);
    expect((await readdir(join(dir, 'docs/notes'))).sort()).toEqual(['01-picking.md', '02-packing.md', 'README.md']);
    expect((await readdir(join(dir, 'docs/scan'))).sort()).toEqual(['01-scan.md', 'README.md']);
    expect((await readdir(join(dir, 'docs/table'))).sort()).toEqual(['01-table.md', 'README.md']);

    const setup = await readFile(join(dir, 'docs/guide/01-setup.md'), 'utf8');
    expect(setup).toContain('Document: Acme Guide · Section 1 of 2 · Source: sources/guide.md');
    expect(setup).toContain('## Setup\n\nInstall the widget first.');
    expect(await readFile(join(dir, 'docs/scan/README.md'), 'utf8')).toContain(
      'Images in the source were not converted; list it under context.agent for agent conversion.',
    );
    expect(await readFile(join(dir, 'docs/guide/README.md'), 'utf8')).toContain('- Method: built-in .md');

    const pending = await readFile(join(dir, 'PENDING.md'), 'utf8');
    expect(pending).toContain('- Source: sources/diagram.vsdx');
    expect(pending).toContain('- Reason: no converter for .vsdx');
    expect(pending).toContain(`<!-- source-sha256: ${sha('fake diagram v1')} -->`);
    expect(pending).toContain('- Target: agent/diagram.md');

    const index = await readFile(join(dir, 'INDEX.md'), 'utf8');
    expect(index).toContain('Sources may be confidential; keep this folder in a private repository.');
    expect(index).toContain('Status: ok · Source: sources/guide.md');
    expect(index).toContain('1 documents waiting for agent conversion — see PENDING.md');

    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const bySource = Object.fromEntries(manifest.documents.map((d: { source: string }) => [d.source, d]));
    expect(Object.keys(bySource)).toEqual(['diagram.vsdx', 'guide.md', 'notes.docx', 'scan.pdf', 'table.csv']);
    expect(bySource['guide.md']).toMatchObject({ slug: 'guide', method: 'built-in', status: 'ok', sections: ['01-setup.md', '02-usage.md'] });
    expect(bySource['scan.pdf']).toMatchObject({ method: 'converter', status: 'ok' });
    expect(bySource['scan.pdf'].converterHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bySource['diagram.vsdx']).toMatchObject({ method: 'pending', status: 'pending', sections: [] });
    expect(await exists(join(dir, 'agent'))).toBe(false);
  });

  it('leaves every file byte-identical on a second run and reports the documents unchanged', async () => {
    const { settings } = await project();
    await run(settings);
    const before = await snapshot(settings.dir);
    const { out } = await run(settings);
    expect(out[0]).toBe('Converted 4 documents (6 sections, 4 unchanged)');
    expect(await snapshot(settings.dir)).toEqual(before);
  });

  it('does not re-run the converter for an unchanged source', async () => {
    const { settings } = await project();
    await run(settings);
    // The timeout is not part of the converter hash; with 1 ms, running the converter again would fail.
    const failing = { ...settings, converters: { '.pdf': { ...settings.converters['.pdf']!, timeoutMs: 1 } } };
    const { out, err } = await run(failing);
    expect(out[0]).toBe('Converted 4 documents (6 sections, 4 unchanged)');
    expect(err).toEqual([]);
  });

  it('picks up the agent file, then marks the document stale when the source changes', async () => {
    const { settings } = await project();
    const dir = settings.dir;
    await run(settings);
    const agentFile = join(dir, 'agent/diagram.md');
    await mkdir(join(dir, 'agent'), { recursive: true });
    await writeFile(
      agentFile,
      `<!-- source-sha256: ${sha('fake diagram v1')} -->\n# Diagram\n\n## Boxes\n\nThe boxes are blue.\n\n## Lines\n\nThe lines are thin.\n`,
    );
    const agentTime = (await stat(agentFile)).mtimeMs;
    const agentDirTime = (await stat(join(dir, 'agent'))).mtimeMs;

    const second = await run(settings);
    expect(second.out).toEqual(['Converted 5 documents (8 sections, 4 unchanged)', `Wrote agent context to ${dir}`]);
    expect((await readdir(join(dir, 'docs/diagram'))).sort()).toEqual(['01-boxes.md', '02-lines.md', 'README.md']);
    expect(await readFile(join(dir, 'docs/diagram/README.md'), 'utf8')).toContain('- Method: agent');
    expect(await exists(join(dir, 'PENDING.md'))).toBe(false);

    await writeFile(join(settings.sources, 'diagram.vsdx'), 'fake diagram v2');
    const third = await run(settings);
    expect(third.out).toEqual([
      'Converted 4 documents (6 sections, 4 unchanged)',
      `1 documents waiting for agent conversion (see ${join(dir, 'PENDING.md')})`,
      `Wrote agent context to ${dir}`,
    ]);
    expect(third.err.join('\n')).toContain('agent/diagram.md');
    const pending = await readFile(join(dir, 'PENDING.md'), 'utf8');
    expect(pending).toContain('- Reason: source changed; reconvert');
    expect(pending).toContain(`<!-- source-sha256: ${sha('fake diagram v2')} -->`);
    expect(await readFile(join(dir, 'docs/diagram/01-boxes.md'), 'utf8')).toContain('The boxes are blue.');
    expect(await readFile(join(dir, 'INDEX.md'), 'utf8')).toContain('Status: stale · Source: sources/diagram.vsdx');
    expect(await readFile(join(dir, 'docs/diagram/README.md'), 'utf8')).toContain('- Status: stale');

    // A stale document stays stale (and byte-identical) on the next run.
    const before = await snapshot(dir);
    await run(settings);
    expect(await snapshot(dir)).toEqual(before);

    // mocakit never modifies agent/.
    expect((await stat(agentFile)).mtimeMs).toBe(agentTime);
    expect((await stat(join(dir, 'agent'))).mtimeMs).toBe(agentDirTime);
    expect(await readdir(join(dir, 'agent'))).toEqual(['diagram.md']);
  });

  it('requests agent conversion for sources matching context.agent', async () => {
    const { settings } = await project();
    const { out } = await run({ ...settings, agent: ['*.pdf'] });
    expect(out[0]).toBe('Converted 3 documents (5 sections, 0 unchanged)');
    const pending = await readFile(join(settings.dir, 'PENDING.md'), 'utf8');
    expect(pending).toContain('## scan');
    expect(pending).toContain('- Reason: agent conversion requested');
  });

  it('ignores an agent file without the sha line, with a warning', async () => {
    const { settings } = await project();
    await mkdir(join(settings.dir, 'agent'), { recursive: true });
    await writeFile(join(settings.dir, 'agent/diagram.md'), '# Diagram\n');
    const { err } = await run(settings);
    expect(err).toEqual(['warning: agent/diagram.md does not start with a source-sha256 line; ignored']);
    expect(await readFile(join(settings.dir, 'PENDING.md'), 'utf8')).toContain('- Reason: no converter for .vsdx');
  });

  it('removes the folder of a removed source', async () => {
    const { settings } = await project();
    await run(settings);
    await rm(join(settings.sources, 'table.csv'));
    const { out } = await run(settings);
    expect(out).toContain('Removed 1 stale documents');
    expect(await exists(join(settings.dir, 'docs/table'))).toBe(false);
    expect(await readFile(join(settings.dir, 'INDEX.md'), 'utf8')).not.toContain('sources/table.csv');
  });

  it('keeps hand-written files in a removed document folder', async () => {
    const { settings } = await project();
    await run(settings);
    await writeFile(join(settings.dir, 'docs/table/my-notes.md'), 'mine\n');
    await rm(join(settings.sources, 'table.csv'));
    await run(settings);
    expect(await readdir(join(settings.dir, 'docs/table'))).toEqual(['my-notes.md']);
  });

  it('refuses to overwrite a hand-written file before writing anything', async () => {
    const { settings } = await project();
    await mkdir(join(settings.dir, 'docs/guide'), { recursive: true });
    await writeFile(join(settings.dir, 'docs/guide/01-setup.md'), 'my own notes\n');
    await expect(run(settings)).rejects.toThrow(/01-setup\.md exists and was not generated by mocakit/);
    expect(await readdir(join(settings.dir, 'docs'))).toEqual(['guide']);
    expect(await readdir(join(settings.dir, 'docs/guide'))).toEqual(['01-setup.md']);
    expect(await exists(join(settings.dir, 'INDEX.md'))).toBe(false);
    expect(await exists(join(settings.dir, 'manifest.json'))).toBe(false);
  });

  it('creates a missing sources folder', async () => {
    const root = await tempDir();
    const settings = resolveContextSettings({}, true, root, join(root, 'src/moca.generated.ts'))!;
    const { out } = await run(settings);
    expect(out).toEqual([
      `Put documents to convert in ${settings.sources}`,
      'Converted 0 documents (0 sections, 0 unchanged)',
      `Wrote agent context to ${settings.dir}`,
    ]);
    expect((await stat(settings.sources)).isDirectory()).toBe(true);
  });

  it('writes and deletes nothing on a dry run', async () => {
    const root = await tempDir();
    const settings = resolveContextSettings({}, true, root, join(root, 'src/moca.generated.ts'))!;
    const { out } = await run(settings, true);
    expect(out).toEqual([
      `Put documents to convert in ${settings.sources}`,
      'Converted 0 documents (0 sections, 0 unchanged)',
      `Would write agent context to ${settings.dir}`,
    ]);
    expect(await exists(join(root, 'src'))).toBe(false);

    const { settings: full } = await project();
    await run(full);
    const before = await snapshot(full.dir);
    await rm(join(full.sources, 'table.csv'));
    await writeFile(join(full.sources, 'extra.md'), '# Extra\n\nMore text.\n');
    const dry = await run(full, true);
    expect(dry.out.at(-1)).toBe(`Would write agent context to ${full.dir}`);
    expect(await snapshot(full.dir)).toEqual(before);
  });

  it('moves a document whose conversion fails to PENDING.md and keeps going', async () => {
    const { settings } = await project('fail');
    await writeFile(join(settings.sources, 'notes.docx'), 'not a zip');
    const { out, err } = await run(settings);
    expect(out[0]).toBe('Converted 2 documents (3 sections, 0 unchanged)');
    expect(err.some((e) => e.startsWith('warning: ') && e.includes('scan.pdf'))).toBe(true);
    const pending = await readFile(join(settings.dir, 'PENDING.md'), 'utf8');
    expect(pending).toMatch(/## notes\n\n[^#]*- Reason: converter failed: /);
    expect(pending).toMatch(/## scan\n\n[^#]*- Reason: converter failed[^\n]*boom: cannot convert/);
  });

  it('fails the run when a configured converter cannot be started', async () => {
    const { settings } = await project();
    const broken = { ...settings, converters: { '.pdf': { command: join(settings.dir, 'no-such-converter'), args: [] } } };
    await expect(run(broken)).rejects.toThrow(`converter command "${join(settings.dir, 'no-such-converter')}" could not be started`);
    expect(await exists(join(settings.dir, 'INDEX.md'))).toBe(false);
  });

  it('keeps untrusted source names and reasons single-line, capped and escaped', async () => {
    const { settings } = await project('noisy');
    await writeFile(join(settings.sources, 'odd [link](x) &amp;.vsdx'), 'x');
    await run(settings);
    const pending = await readFile(join(settings.dir, 'PENDING.md'), 'utf8');
    expect(pending).toContain('- Source: sources/odd \\[link\\](x) &amp;amp;.vsdx');
    const reason = pending.split('\n').find((l) => l.startsWith('- Reason: converter failed for scan.pdf'))!;
    expect(reason).toContain('&lt;b&gt;bad&lt;/b&gt; \\[x\\](y)');
    expect(reason).not.toContain('<b>');
    expect(reason.endsWith('…')).toBe(true);
    expect(reason.length).toBeLessThan(340);
  });

  it('treats a damaged manifest as no previous manifest', async () => {
    const { settings } = await project();
    await run(settings);
    const file = join(settings.dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.documents[1].slug = '../../outside';
    await writeFile(file, JSON.stringify(manifest));
    const { out } = await run(settings);
    expect(out[0]).toBe('Converted 4 documents (6 sections, 0 unchanged)');
    await writeFile(file, '{"documents": 3}');
    expect((await run(settings)).out[0]).toBe('Converted 4 documents (6 sections, 0 unchanged)');
  });

  it('skips sources over 100 MiB with a warning', async () => {
    const { settings } = await project();
    const handle = await open(join(settings.sources, 'huge.md'), 'w');
    await handle.truncate(100 * 1024 * 1024 + 1);
    await handle.close();
    const { out, err } = await run(settings);
    expect(err).toEqual(['warning: skipping sources/huge.md: larger than 100 MiB']);
    expect(out[0]).toBe('Converted 4 documents (6 sections, 0 unchanged)');
  });

  it('skips symbolic links in sources', async () => {
    const { settings } = await project();
    const target = join(await tempDir(), 'secret.md');
    await writeFile(target, '# Secret\n\nOutside text.\n');
    try {
      await symlink(target, join(settings.sources, 'link.md'), 'file');
    } catch {
      return; // creating symbolic links needs extra rights on this machine
    }
    const { out } = await run(settings);
    expect(out[0]).toBe('Converted 4 documents (6 sections, 0 unchanged)');
    expect(await exists(join(settings.dir, 'docs/link'))).toBe(false);
  });
});
