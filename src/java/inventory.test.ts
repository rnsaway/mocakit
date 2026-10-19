import { describe, expect, it } from 'vitest';
import { buildZip } from '../../test/helpers/zip-builder.js';
import type { CommandInfo } from '../codegen/introspect-agent.js';
import {
  LIBRARY_FILE_NAME,
  classNameOf,
  classifyEntry,
  jarFacts,
  linkCommands,
  overriddenClasses,
  type JarFacts,
} from './inventory.js';
import type { JavaEntryRecord, JavaManifest } from './manifest.js';

const NO_GLOBS = { custom: [], libraries: [] };
const facts = (over: Partial<JarFacts> = {}): JarFacts => ({ classes: [], readable: true, ...over });

describe('jarFacts', () => {
  it('lists classes, version and maven coordinates', () => {
    const jar = buildZip({
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Version: 2.3.1\r\n',
      'META-INF/maven/org.acme/zeta/pom.properties': 'groupId=org.acme\nartifactId=zeta\nversion=9.9\n',
      'META-INF/maven/org.acme/cust-lib/pom.properties': 'groupId=org.acme\r\nartifactId=cust-lib\r\nversion=2.3.1\r\n',
      'com/acme/cust/Widgets.class': 'x',
      'com/acme/cust/Widgets$Inner.class': 'x',
      'com/acme/cust/readme.txt': 'x',
    });
    const f = jarFacts(jar);
    expect(f.readable).toBe(true);
    expect(f.classes).toEqual(['com.acme.cust.Widgets', 'com.acme.cust.Widgets$Inner']);
    expect(f.version).toBe('2.3.1');
    expect(f.maven).toBe('org.acme:cust-lib:2.3.1');
  });

  it('falls back to Bundle-Version and joins continuation lines', () => {
    const jar = buildZip({
      'META-INF/MANIFEST.MF': 'Bundle-Name: a\r\nBundle-Version: 1.\r\n 4.0\r\n',
    });
    expect(jarFacts(jar).version).toBe('1.4.0');
  });

  it('excludes META-INF classes and module-info', () => {
    const jar = buildZip({
      'META-INF/versions/9/com/acme/cust/Widgets.class': 'x',
      'module-info.class': 'x',
      'com/acme/cust/Widgets.class': 'x',
    });
    expect(jarFacts(jar).classes).toEqual(['com.acme.cust.Widgets']);
  });

  it('reports a corrupt jar as unreadable with a warning', () => {
    const f = jarFacts(new Uint8Array([1, 2, 3, 4]));
    expect(f.readable).toBe(false);
    expect(f.classes).toEqual([]);
    expect(f.warning).toMatch(/\S/);
  });
});

describe('classNameOf', () => {
  it('handles posix and windows paths', () => {
    expect(classNameOf('/opt/acme/cust/classes/com/acme/Widgets.class', '/opt/acme/cust/classes')).toBe('com.acme.Widgets');
    expect(classNameOf('C:\\acme\\classes\\com\\acme\\Widgets$Inner.class', 'C:\\acme\\classes\\')).toBe(
      'com.acme.Widgets$Inner',
    );
    expect(classNameOf('C:/acme/classes/com/acme/Widgets.class', 'C:\\acme\\classes')).toBe('com.acme.Widgets');
  });
});

describe('classifyEntry', () => {
  const none = new Set<string>();
  it('treats a named, maven-described jar as a library', () => {
    expect(classifyEntry(['cust-lib-2.3.1.jar'], [facts({ maven: 'org.acme:cust-lib:2.3.1' })], none, NO_GLOBS)).toBe(
      'library',
    );
  });
  it('treats a jar with a command class as custom', () => {
    const f = facts({ maven: 'org.acme:cust-lib:2.3.1', classes: ['com.acme.cust.Widgets'] });
    expect(classifyEntry(['cust-lib-2.3.1.jar'], [f], new Set(['com.acme.cust.Widgets']), NO_GLOBS)).toBe('custom');
  });
  it('treats an unversioned, unmapped jar as custom', () => {
    expect(classifyEntry(['acme-cust.jar'], [facts()], none, NO_GLOBS)).toBe('custom');
  });
  it('lets globs override, libraries first', () => {
    expect(classifyEntry(['acme-cust.jar'], [facts()], none, { custom: [], libraries: ['acme-*.jar'] })).toBe('library');
    expect(classifyEntry(['x-1.0.jar'], [facts()], none, { custom: ['x-*.jar'], libraries: [] })).toBe('custom');
    expect(classifyEntry(['x-1.0.jar'], [facts()], none, { custom: ['x-*.jar'], libraries: ['x-*.jar'] })).toBe('library');
  });
  it('matches globs on the base name of a path', () => {
    expect(
      classifyEntry(['/opt/acme/cust/lib/acme-cust.jar'], [facts()], none, { custom: [], libraries: ['acme-*.jar'] }),
    ).toBe('library');
  });
  it('requires every file to look like a library', () => {
    expect(classifyEntry(['a-1.0.jar', 'mine.jar'], [facts({ maven: 'g:a:1' }), facts()], none, NO_GLOBS)).toBe('custom');
  });
  it('exports a library file name pattern', () => {
    expect(LIBRARY_FILE_NAME.test('commons-io-2.11.0.jar')).toBe(true);
    expect(LIBRARY_FILE_NAME.test('acme-cust.jar')).toBe(false);
  });
});

describe('overriddenClasses', () => {
  it('records one winner per shadowed class, in class-name order', () => {
    const classes = ['com.acme.B', 'com.acme.A', 'com.acme.A$In'];
    const out = overriddenClasses([
      { path: '/opt/acme/cust/lib/x-1.0.jar', file: '/opt/acme/cust/lib/x-1.0.jar', classes },
      { path: '/opt/acme/cust/extlib/x-1.0.jar', file: '/opt/acme/cust/extlib/x-1.0.jar', classes },
      { path: '/opt/acme/cust/unknown.jar', classes: null },
    ]);
    const w = '/opt/acme/cust/lib/x-1.0.jar';
    const l = ['/opt/acme/cust/extlib/x-1.0.jar'];
    expect(out).toEqual([
      { className: 'com.acme.A', winner: w, losers: l },
      { className: 'com.acme.B', winner: w, losers: l },
    ]);
  });
  it('skips a class whose providers are all the same file', () => {
    const file = '/opt/acme/cust/lib/a.jar';
    expect(
      overriddenClasses([
        { path: '/opt/acme/cust/lib', file, classes: ['p.A'] },
        { path: '/opt/acme/cust/lib/a.jar', file, classes: ['p.A'] },
        { path: '/opt/acme/cust/ext', file: '/opt/acme/cust/ext/b.jar', classes: ['p.B'] },
      ]),
    ).toEqual([]);
  });
  it('ignores classes that appear once and repeats within one entry', () => {
    expect(
      overriddenClasses([
        { path: 'a.jar', classes: ['p.A', 'p.A'] },
        { path: 'b.jar', classes: ['p.B'] },
      ]),
    ).toEqual([]);
  });
});

describe('linkCommands', () => {
  const rec = (path: string, over: Partial<JavaEntryRecord>): JavaEntryRecord =>
    ({ index: 0, path, type: 'jar', component: 'cust', slug: 's', selected: true, missing: false, files: [], ...over }) as JavaEntryRecord;
  const manifest = {
    entries: [
      rec('/opt/acme/cust/lib/cust.jar', {
        kind: 'custom',
        files: [{ path: 'p', local: 'l', size: 1, sha256: 'h', classes: 1, readable: true }],
      }),
      rec('/opt/acme/other/o.jar', { selected: false, kind: 'library' }),
    ],
  } as unknown as JavaManifest;
  const cmd = (name: string, javaClass: string | undefined, cFunction?: string, type?: string): CommandInfo => ({
    name,
    key: name,
    active: { level: 'cust', levelSeq: 1, javaClass, cFunction, type },
    overrides: [],
  });
  const index = new Map([
    ['com.acme.cust.Widgets', { entry: '/opt/acme/cust/lib/cust.jar' }],
    ['com.acme.other.Thing', { entry: '/opt/acme/other/o.jar' }],
  ]);

  it('links downloaded, undownloaded and unknown classes; skips non-java commands', () => {
    const links = linkCommands(
      [
        cmd('list widgets', 'com.acme.cust.Widgets', 'listWidgets', 'Java Method'),
        cmd('get thing', 'com.acme.other.Thing', 'getThing'),
        cmd('ghost', 'com.acme.Missing', 'run'),
        cmd('plain', undefined, 'c_func', 'C Function'),
      ],
      manifest,
      index,
      (c) => (c === 'com.acme.cust.Widgets' ? 'com/acme/cust/Widgets.java' : undefined),
    );
    expect(links.get('list widgets')).toEqual({
      className: 'com.acme.cust.Widgets',
      method: 'listWidgets',
      entry: '/opt/acme/cust/lib/cust.jar',
      kind: 'custom',
      downloaded: true,
      source: 'com/acme/cust/Widgets.java',
    });
    expect(links.get('get thing')).toEqual({
      className: 'com.acme.other.Thing',
      method: 'getThing',
      entry: '/opt/acme/other/o.jar',
      kind: 'library',
      downloaded: false,
    });
    expect(links.get('ghost')).toEqual({
      className: 'com.acme.Missing',
      method: 'run',
      entry: '',
      kind: 'unknown',
      downloaded: false,
    });
    expect(links.has('plain')).toBe(false);
  });

  it('reports unknown with an empty entry when the entry is not in the manifest or has no kind', () => {
    const m = {
      entries: [rec('/opt/acme/cust/nokind.jar', { files: [{ path: 'p', local: 'l', size: 1, sha256: 'h', classes: 1, readable: true }] })],
    } as unknown as JavaManifest;
    const idx = new Map([
      ['com.acme.cust.Gone', { entry: '/opt/acme/cust/gone.jar' }],
      ['com.acme.cust.NoKind', { entry: '/opt/acme/cust/nokind.jar' }],
    ]);
    const links = linkCommands(
      [cmd('gone', 'com.acme.cust.Gone', 'a'), cmd('no kind', 'com.acme.cust.NoKind', 'b')],
      m,
      idx,
      () => 'x.java',
    );
    for (const key of ['gone', 'no kind']) {
      expect(links.get(key)).toMatchObject({ entry: '', kind: 'unknown', downloaded: false });
      expect(links.get(key)).not.toHaveProperty('source');
    }
  });

  it('does not link a java-typed command without a javaClass', () => {
    const links = linkCommands([cmd('typed', undefined, 'run', 'Java Method')], manifest, index, () => undefined);
    expect(links.has('typed')).toBe(false);
  });

  it('omits method when there is no cFunction', () => {
    const links = linkCommands([cmd('nomethod', 'com.acme.cust.Widgets')], manifest, index, () => undefined);
    expect(links.get('nomethod')).not.toHaveProperty('method');
  });

  it('takes the kind of the JAR that provides the class', () => {
    const file = (path: string, kind: 'custom' | 'library') => ({ path, local: path.slice(1), size: 1, sha256: 'h', classes: 1, readable: true, kind });
    const m = {
      entries: [rec('/opt/acme/cust/lib', { type: 'dir-wildcard', kind: 'custom', files: [file('/opt/acme/cust/lib/a.jar', 'custom'), file('/opt/acme/cust/lib/b-1.0.jar', 'library')] })],
    } as unknown as JavaManifest;
    const idx = new Map([
      ['com.acme.A', { entry: '/opt/acme/cust/lib', file: '/opt/acme/cust/lib/a.jar' }],
      ['com.acme.B', { entry: '/opt/acme/cust/lib', file: '/opt/acme/cust/lib/b-1.0.jar' }],
    ]);
    const links = linkCommands([cmd('a', 'com.acme.A', 'run'), cmd('b', 'com.acme.B', 'run')], m, idx, () => undefined);
    expect(links.get('a')).toMatchObject({ kind: 'custom' });
    expect(links.get('b')).toMatchObject({ kind: 'library' });
  });

  it('links any command with a javaClass regardless of type', () => {
    const links = linkCommands([cmd('odd', 'com.acme.cust.Widgets', 'm', 'C Function')], manifest, index, () => undefined);
    expect(links.get('odd')).toMatchObject({ className: 'com.acme.cust.Widgets', kind: 'custom', downloaded: true });
  });
});
