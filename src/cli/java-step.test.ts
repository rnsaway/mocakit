import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeOs } from '../../test/helpers/fake-os.js';
import { buildZip } from '../../test/helpers/zip-builder.js';
import type { CommandInfo } from '../codegen/introspect-agent.js';
import type { JavaManifest } from '../java/manifest.js';
import { readJavaServer } from '../java/server-reader.js';
import { buildJavaOutput, resolveJavaSettings, writeJavaOutput, type ResolvedJava } from './java-step.js';

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mocakit-java-step-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('resolveJavaSettings', () => {
  const out = resolve('/p/src/moca.generated.ts');

  it('is off unless the config or flag enables it', () => {
    expect(resolveJavaSettings({}, undefined, '/p', out)).toBeNull();
    expect(resolveJavaSettings({ java: false }, undefined, '/p', out)).toBeNull();
    expect(resolveJavaSettings({ java: true }, false, '/p', out)).toBeNull();
  });

  it('uses the defaults', () => {
    expect(resolveJavaSettings({}, true, '/p', out)).toEqual({
      dir: resolve('/p/src/moca-java'),
      docs: true,
      roots: ['$LESDIR'],
      custom: [],
      libraries: [],
      maxFileSize: 25 * 1024 * 1024,
      decompiler: null,
      decompileLibraries: false,
    });
  });

  it('reads the options, resolving dir against the config folder', () => {
    const decompiler = { command: 'java', args: ['-jar', 'cfr.jar', '{input}', '--outputdir', '{output}'], timeoutMs: 5000 };
    expect(
      resolveJavaSettings(
        {
          java: {
            roots: ['$LESDIR', 'moca'],
            custom: ['acme-*.jar'],
            libraries: ['vendor-*.jar'],
            dir: 'agent/java',
            docs: false,
            maxFileSize: 1000,
            decompiler,
            decompileLibraries: true,
          },
        },
        undefined,
        resolve('/cfg'),
        out,
      ),
    ).toEqual({
      dir: resolve('/cfg/agent/java'),
      docs: false,
      roots: ['$LESDIR', 'moca'],
      custom: ['acme-*.jar'],
      libraries: ['vendor-*.jar'],
      maxFileSize: 1000,
      decompiler,
      decompileLibraries: true,
    });
  });

  it.each([
    [{ java: 'yes' }, 'config.java must be true, false or an object'],
    [{ java: [] }, 'config.java must be true, false or an object'],
    [{ java: { roots: 'cust' } }, 'java.roots must be a non-empty array of strings'],
    [{ java: { roots: [] } }, 'java.roots must be a non-empty array of strings'],
    [{ java: { custom: [1] } }, 'java.custom must be an array of strings'],
    [{ java: { libraries: 'x' } }, 'java.libraries must be an array of strings'],
    [{ java: { dir: 3 } }, 'java.dir must be a string'],
    [{ java: { docs: 'no' } }, 'java.docs must be true or false'],
    [{ java: { maxFileSize: 0 } }, 'java.maxFileSize must be a positive number of bytes'],
    [{ java: { maxFileSize: '1' } }, 'java.maxFileSize must be a positive number of bytes'],
    [{ java: { decompiler: 'cfr' } }, 'java.decompiler must be an object with a command string and an args array of strings'],
    [{ java: { decompiler: { command: 'cfr' } } }, 'java.decompiler must be an object with a command string and an args array of strings'],
    [{ java: { decompiler: { command: 'cfr', args: [], timeoutMs: -1 } } }, 'java.decompiler.timeoutMs must be a positive number'],
    [{ java: { decompileLibraries: 1 } }, 'java.decompileLibraries must be true or false'],
  ])('rejects %j', (config, message) => {
    expect(() => resolveJavaSettings(config as never, undefined, '/p', out)).toThrow(message);
  });

  it.each(['', '  ', '.', '..', 'a/b', 'a\\b'])('rejects the root %j', (root) => {
    expect(() => resolveJavaSettings({ java: { roots: ['$LESDIR', root] } }, undefined, '/p', out)).toThrow(
      `java.roots: "${root}" is not $LESDIR, a $NAME server variable, the name of a folder next to $LESDIR, or an absolute path`,
    );
  });

  it.each(['$LESDIR', '$ACME_HOME', 'cust', '/opt/acme/x', 'C:\\acme\\x'])('accepts the root %j', (root) => {
    expect(resolveJavaSettings({ java: { roots: [root] } }, undefined, '/p', out)?.roots).toEqual([root]);
  });
});

const LES = '/opt/acme/cust';

function settingsFor(dir: string, extra: Partial<ResolvedJava> = {}): ResolvedJava {
  return {
    dir,
    docs: true,
    roots: ['$LESDIR'],
    custom: [],
    libraries: [],
    maxFileSize: 25 * 1024 * 1024,
    decompiler: null,
    decompileLibraries: false,
    ...extra,
  };
}

async function serverRead(classpath: string, files: Record<string, Uint8Array>) {
  const os = fakeOs({ family: 'posix', env: { LESDIR: LES, CLASSPATH: classpath }, files });
  return readJavaServer(os.exec, { roots: ['$LESDIR'], maxFileSize: 25 * 1024 * 1024, cached: () => false });
}

const ctx = (dir: string) => ({ version: '0.6.0', server: 'https://moca.test/service', dir, cache: new Map<string, Uint8Array>(), commands: [] });

describe('buildJavaOutput', () => {
  it('keeps unusable (relative) classpath entries in the manifest, unselected and without files', async () => {
    const dir = await tempDir();
    const read = await serverRead('rel/x.jar:/opt/acme/cust/lib/*', {
      '/opt/acme/cust/lib/acme-cust.jar': buildZip({ 'com/acme/cust/Widgets.class': 'w' }),
    });
    const output = await buildJavaOutput(read, null, settingsFor(dir), ctx(dir));
    expect(output.manifest.entries[0]).toEqual({
      index: 0,
      path: 'rel/x.jar',
      type: 'jar',
      component: '',
      slug: '',
      selected: false,
      missing: false,
      files: [],
    });
    expect(output.manifest.entries[1]).toMatchObject({ path: '/opt/acme/cust/lib', selected: true, kind: 'custom' });
    expect(output.manifest.entries[1].files[0]).toMatchObject({ local: 'jars/cust/lib/acme-cust.jar', classes: 1, readable: true });
    expect(read.warnings).toContain('classpath entry "rel/x.jar" is not an absolute path; skipped');
  });

  it('records every class file of a classes folder, and gives the folder one docs page', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/classes', {
      '/opt/acme/cust/classes/com/acme/cust/A.class': new Uint8Array([1]),
      '/opt/acme/cust/classes/com/acme/cust/B.class': new Uint8Array([2]),
    });
    const output = await buildJavaOutput(read, null, settingsFor(dir), ctx(dir));
    expect(output.manifest.entries[0].files.map((f) => f.local)).toEqual([
      'classes/cust/classes/com/acme/cust/A.class',
      'classes/cust/classes/com/acme/cust/B.class',
    ]);
    const pages = [...output.docs!.keys()].filter((k) => k.startsWith('entries/'));
    expect(pages).toEqual(['entries/cust/classes.md']);
    expect(output.docs!.get('entries/cust/classes.md')).toContain('- `com.acme.cust`: `A`, `B`');
  });
});

const FAKE_DECOMPILER = fileURLToPath(new URL('../../test/fixtures/fake-decompiler.mjs', import.meta.url));
const DECOMPILER = { command: process.execPath, args: [FAKE_DECOMPILER, '{input}', '{output}'] };
const command = (key: string, javaClass: string): CommandInfo => ({ name: key, key, active: { level: 'cust', levelSeq: 1, javaClass, cFunction: 'run' }, overrides: [] });

// These runs spawn the fake decompiler (a node process per input), which is slow on a busy machine.
describe('per-JAR classification', { timeout: 30_000 }, () => {
  const CUST = buildZip({ 'com/acme/cust/Widgets.class': 'w' });
  const LIB = buildZip({ 'com/acme/widget/Lib.class': 'l' });
  const srcFolders = (sources: Map<string, string>) => [...new Set([...sources.keys()].map((k) => k.split('/').slice(0, 3).join('/')))].sort();

  it('decompiles only the custom JAR of a mixed wildcard folder', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/lib/*', { '/opt/acme/cust/lib/acme-cust.jar': CUST, '/opt/acme/cust/lib/widget-lib-2.1.0.jar': LIB });
    const commands = [command('move widget', 'com.acme.cust.Widgets')];
    const output = await buildJavaOutput(read, null, settingsFor(dir, { decompiler: DECOMPILER }), { ...ctx(dir), commands });
    const entry = output.manifest.entries[0];
    expect(entry.kind).toBe('custom');
    expect(entry.files.map((f) => [f.local, f.kind])).toEqual([
      ['jars/cust/lib/acme-cust.jar', 'custom'],
      ['jars/cust/lib/widget-lib-2.1.0.jar', 'library'],
    ]);
    expect(srcFolders(output.sources)).toEqual(['src/cust/lib-acme-cust']);
    expect(output.links.get('move widget')).toMatchObject({ kind: 'custom', entry: '/opt/acme/cust/lib' });
    expect(output.docs!.get('entries/cust/lib-widget-lib-2.1.0.md')).toContain('- Kind: library');
    expect(output.docs!.get('entries/cust/lib-acme-cust.md')).toContain('- Kind: custom');
    expect(output.stats).toMatchObject({ decompiled: 1, skippedLibraries: 1 });
  });

  it('applies a libraries glob to the matching JAR only, and links its classes as library', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/lib/*', {
      '/opt/acme/cust/lib/acme-cust.jar': CUST,
      '/opt/acme/cust/lib/acme-other.jar': LIB,
    });
    const commands = [command('move widget', 'com.acme.cust.Widgets'), command('lib call', 'com.acme.widget.Lib')];
    const settings = settingsFor(dir, { decompiler: DECOMPILER, libraries: ['acme-other.jar'] });
    const output = await buildJavaOutput(read, null, settings, { ...ctx(dir), commands });
    expect(output.manifest.entries[0].files.map((f) => f.kind)).toEqual(['custom', 'library']);
    expect(output.manifest.entries[0].kind).toBe('custom');
    expect(srcFolders(output.sources)).toEqual(['src/cust/lib-acme-cust']);
    expect(output.links.get('move widget')).toMatchObject({ kind: 'custom', entry: '/opt/acme/cust/lib' });
    expect(output.links.get('lib call')).toMatchObject({ kind: 'library', entry: '/opt/acme/cust/lib' });
  });

  it('keeps a library-looking JAR custom when one of its classes implements a command, without its siblings', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/lib/*', {
      '/opt/acme/cust/lib/widget-cust-1.0.0.jar': CUST,
      '/opt/acme/cust/lib/widget-lib-2.1.0.jar': LIB,
    });
    const commands = [command('move widget', 'com.acme.cust.Widgets')];
    const output = await buildJavaOutput(read, null, settingsFor(dir, { decompiler: DECOMPILER }), { ...ctx(dir), commands });
    expect(output.manifest.entries[0].files.map((f) => f.kind)).toEqual(['custom', 'library']);
    expect(srcFolders(output.sources)).toEqual(['src/cust/lib-widget-cust-1.0.0']);
  });

  it('counts decompiled entries, not JARs', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/lib/*', {
      '/opt/acme/cust/lib/acme-a.jar': CUST,
      '/opt/acme/cust/lib/acme-b.jar': buildZip({ 'com/acme/cust/B.class': 'b' }),
      '/opt/acme/cust/lib/acme-c.jar': buildZip({ 'com/acme/cust/C.class': 'c' }),
    });
    const output = await buildJavaOutput(read, null, settingsFor(dir, { decompiler: DECOMPILER }), ctx(dir));
    expect(srcFolders(output.sources)).toEqual(['src/cust/lib-acme-a', 'src/cust/lib-acme-b', 'src/cust/lib-acme-c']);
    expect(output.stats).toMatchObject({ decompiled: 1, skippedLibraries: 0 });
  });

  it('gives colliding source folders of one component distinct names, and decompiles a file reached twice once', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/lib/*:/opt/acme/cust/lib-x.jar:/opt/acme/cust/lib/acme-a.jar', {
      '/opt/acme/cust/lib/x.jar': CUST,
      '/opt/acme/cust/lib-x.jar': buildZip({ 'com/acme/cust/Other.class': 'o' }),
      '/opt/acme/cust/lib/acme-a.jar': buildZip({ 'com/acme/cust/A.class': 'a' }),
    });
    const output = await buildJavaOutput(read, null, settingsFor(dir, { decompiler: DECOMPILER }), ctx(dir));
    expect(output.warnings).toEqual([]);
    expect(srcFolders(output.sources)).toEqual(['src/cust/lib-acme-a', 'src/cust/lib-x', 'src/cust/lib-x-2']);
    expect(output.manifest.src).toEqual([...new Set(output.manifest.src)]);
    expect(output.manifest.src).toHaveLength(3);
  });
});

describe('overridden classes', () => {
  const A = buildZip({ 'com/acme/cust/A.class': 'a', 'com/acme/cust/A$In.class': 'i' });
  it('does not count one file reached through a wildcard and an explicit entry', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/lib/*:/opt/acme/cust/lib/a.jar', { '/opt/acme/cust/lib/a.jar': A });
    const output = await buildJavaOutput(read, null, settingsFor(dir), ctx(dir));
    expect(output.manifest.entries).toHaveLength(2);
    expect(output.manifest.overridden).toEqual([]);
  });
  it('does not count one folder spelled two ways', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/lib/*:/opt/acme//cust/./lib/*', { '/opt/acme/cust/lib/a.jar': A });
    const output = await buildJavaOutput(read, null, settingsFor(dir), ctx(dir));
    expect(output.manifest.entries).toHaveLength(1);
    expect(output.manifest.overridden).toEqual([]);
  });
  it('lists outer classes only', async () => {
    const dir = await tempDir();
    const read = await serverRead('/opt/acme/cust/lib/*:/opt/acme/cust/ext/*', {
      '/opt/acme/cust/lib/a.jar': A,
      '/opt/acme/cust/ext/a-copy.jar': A,
    });
    const output = await buildJavaOutput(read, null, settingsFor(dir), ctx(dir));
    expect(output.manifest.overridden).toEqual([{ className: 'com.acme.cust.A', winner: '/opt/acme/cust/lib', losers: ['/opt/acme/cust/ext'] }]);
  });
});

describe('writeJavaOutput', () => {
  function manifestWith(locals: string[], src: string[] = []): JavaManifest {
    return {
      mocakitVersion: '0.6.0',
      generatedAt: '2026-10-16T00:00:00.000Z',
      server: 'https://moca.test/service',
      os: 'posix',
      lesDir: LES,
      roots: ['$LESDIR'],
      entries: [
        {
          index: 0,
          path: '/opt/acme/cust/lib',
          type: 'dir-wildcard',
          component: 'cust',
          slug: 'lib',
          selected: true,
          missing: false,
          kind: 'custom',
          files: locals.map((local) => ({ path: `/x/${local}`, local, size: 1, sha256: 'a', classes: 0, readable: true })),
        },
      ],
      overridden: [],
      src,
    };
  }
  const emptyOutput = (manifest: JavaManifest) => ({
    manifest,
    binaries: new Map<string, Uint8Array>(),
    sources: new Map<string, string>(),
    docs: null,
    links: new Map(),
    stats: { entries: 1, selected: 1, files: 0, bytes: 0, downloaded: 0, downloadedBytes: 0, unchanged: 0, decompiled: 0, skippedLibraries: 0 },
    warnings: [],
  });

  it('removes stale regular files only, then the folders they leave empty under jars/, classes/ and src/', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'jars/cust/old'), { recursive: true });
    await writeFile(join(dir, 'jars/cust/old/a.jar'), 'a');
    await mkdir(join(dir, 'jars/cust/folder.jar'), { recursive: true }); // a directory where a file was recorded
    await mkdir(join(dir, 'src/cust/x/com'), { recursive: true });
    await writeFile(join(dir, 'src/cust/x/com/A.java'), 'class A {}');
    await writeFile(join(dir, 'src/cust/x/keep.txt'), 'mine');
    const previous = manifestWith(['jars/cust/old/a.jar', 'jars/cust/folder.jar'], ['src/cust/x/com/A.java']);
    const next = manifestWith([]);

    const result = await writeJavaOutput(settingsFor(dir), emptyOutput(next), previous, false);
    expect(result.removed).toBe(2);
    expect(await exists(join(dir, 'jars/cust/old'))).toBe(false);
    expect(await exists(join(dir, 'jars/cust/folder.jar'))).toBe(true);
    expect(await exists(join(dir, 'src/cust/x/com'))).toBe(false);
    expect(await readFile(join(dir, 'src/cust/x/keep.txt'), 'utf8')).toBe('mine');
    expect(await exists(join(dir, 'jars'))).toBe(true);
  });

  it('never deletes outside the folder, even when the previous manifest says so', async () => {
    const parent = await tempDir();
    const dir = join(parent, 'moca-java');
    await mkdir(dir, { recursive: true });
    await writeFile(join(parent, 'outside.jar'), 'x');
    const previous = manifestWith(['jars/../../outside.jar', '../outside.jar', join(parent, 'outside.jar')]);
    const result = await writeJavaOutput(settingsFor(dir), emptyOutput(manifestWith([])), previous, false);
    expect(result.removed).toBe(0);
    expect(await exists(join(parent, 'outside.jar'))).toBe(true);
  });

  it('checks its targets itself, writing nothing when one is not a regular file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'manifest.json'), { recursive: true });
    const output = emptyOutput(manifestWith(['jars/cust/b.jar']));
    output.binaries.set('jars/cust/b.jar', new Uint8Array([1]));
    await expect(writeJavaOutput(settingsFor(dir), output, null, false)).rejects.toThrow(
      `refusing to write into ${join(dir, 'manifest.json')}: it is not a regular file`,
    );
    expect(await exists(join(dir, 'jars'))).toBe(false);
  });

  it('writes and deletes nothing in a dry run', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'jars/cust'), { recursive: true });
    await writeFile(join(dir, 'jars/cust/a.jar'), 'a');
    const output = emptyOutput(manifestWith(['jars/cust/b.jar']));
    output.binaries.set('jars/cust/b.jar', new Uint8Array([1]));
    const result = await writeJavaOutput(settingsFor(dir), output, manifestWith(['jars/cust/a.jar']), true);
    expect(result.removed).toBe(1);
    expect(await exists(join(dir, 'jars/cust/a.jar'))).toBe(true);
    expect(await exists(join(dir, 'jars/cust/b.jar'))).toBe(false);
    expect(await exists(join(dir, 'manifest.json'))).toBe(false);
  });
});
