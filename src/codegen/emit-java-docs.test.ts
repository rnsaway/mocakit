// src/codegen/emit-java-docs.test.ts
import { describe, expect, it } from 'vitest';
import type { JavaLink } from '../java/inventory.js';
import type { JavaManifest } from '../java/manifest.js';
import { DOC_MARKER, PRIVATE_NOTICE } from './docs-writer.js';
import { emitJavaDocs, LICENCE_LINE } from './emit-java-docs.js';

const manifest: JavaManifest = {
  mocakitVersion: '0.6.0',
  generatedAt: '2026-01-01T00:00:00Z',
  server: 'https://u:p@moca.test/service',
  os: 'posix',
  lesDir: '/opt/acme/les',
  roots: ['$LESDIR'],
  entries: [
    {
      index: 0, path: '/opt/acme/cust/lib/cust.jar', type: 'jar', component: 'cust', slug: 'lib-cust', selected: true, missing: false, kind: 'custom',
      files: [{ path: '/opt/acme/cust/lib/cust.jar', local: 'jars/cust/lib/cust.jar', size: 10, sha256: 'a', classes: 2, readable: true }],
    },
    {
      index: 1, path: '/opt/acme/cust/lib/util-1.0.jar', type: 'jar', component: 'cust', slug: 'lib-util-1.0', selected: true, missing: false, kind: 'library',
      files: [{ path: '/opt/acme/cust/lib/util-1.0.jar', local: 'jars/cust/lib/util-1.0.jar', size: 10, sha256: 'b', maven: 'org.lib:util', version: '1.0', classes: 1, readable: true }],
    },
    { index: 2, path: '/opt/acme/cust/old.jar', type: 'jar', component: 'cust', slug: 'old', selected: true, missing: true, files: [] },
    {
      index: 3, path: '/opt/acme/cust/classes', type: 'dir', component: 'cust', slug: 'classes', selected: true, missing: false, kind: 'custom',
      files: [{ path: '/opt/acme/cust/classes', local: 'classes/cust/classes', size: 0, sha256: 'c', classes: 0, readable: false }],
    },
  ],
  overridden: [{ className: 'com.acme.cust.Widgets', winner: '/opt/acme/cust/lib/cust.jar', losers: ['/opt/acme/cust/lib/util-1.0.jar'] }],
  src: [],
};
const links = new Map<string, JavaLink>([
  ['acme a', { className: 'com.acme.cust.Widgets', method: 'run', entry: '/opt/acme/cust/lib/cust.jar', kind: 'custom', downloaded: true }],
  ['acme gone', { className: 'com.acme.Gone', method: 'run', entry: '', kind: 'unknown', downloaded: false }],
]);
const input = {
  version: '0.6.0',
  classes: new Map([
    ['jars/cust/lib/cust.jar', ['com.acme.cust.Widgets', 'com.acme.cust.Widgets$Inner', 'com.acme.cust.util.Helper', 'bad name`|x', '9bad']],
    ['jars/cust/lib/util-1.0.jar', ['com.acme.cust.Widgets']],
  ]),
  links,
  commandNames: new Map([['acme a', 'acme a']]),
  commandHref: (key: string) => `../../../moca-commands/commands/${key.split(' ').join('-')}.md`,
};

describe('emitJavaDocs', () => {
  const files = emitJavaDocs(manifest, input);

  it('README: marker, notice, licence line in order, no Windows wording', () => {
    const readme = files.get('README.md')!;
    expect(readme.startsWith(DOC_MARKER)).toBe(true);
    expect(readme.indexOf(PRIVATE_NOTICE)).toBeGreaterThan(0);
    expect(readme.indexOf(LICENCE_LINE)).toBeGreaterThan(readme.indexOf(PRIVATE_NOTICE));
    expect(readme).toContain('execute os command');
    expect(readme).toContain('jars/');
    expect(readme).not.toMatch(/windows/i);
    expect(readme).not.toContain('u:p@');
  });

  it('INDEX: classpath order with columns and overridden section', () => {
    const index = files.get('INDEX.md')!;
    expect(index.startsWith(DOC_MARKER)).toBe(true);
    expect(index).toContain(PRIVATE_NOTICE);
    expect(index).toContain('| index | entry | selected | kind | version | classes | linked commands |');
    const rows = index.split('\n').filter((l) => /^\| \d/.test(l));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('cust.jar');
    expect(rows[0]).toContain('| custom |');
    expect(rows[1]).toContain('| 1.0 |');
    expect(rows[2]).toContain('missing on the server');
    expect(rows[3]).toContain('classes unknown');
    expect(index).toContain('## Overridden classes');
    expect(index).toContain('com.acme.cust.Widgets');
  });

  it('writes one page per file at entries/<component>/<slug>.md', () => {
    expect([...files.keys()].filter((k) => k.startsWith('entries/')).sort()).toEqual([
      'entries/cust/classes.md', 'entries/cust/lib-cust.md', 'entries/cust/lib-util-1.0.md', 'entries/cust/old.md',
    ]);
  });

  it('entry page lists packages, commands and overrides in both directions', () => {
    const page = files.get('entries/cust/lib-cust.md')!;
    expect(page).toContain('com.acme.cust');
    expect(page).toContain('Widgets$Inner');
    expect(page).toContain('com.acme.cust.util');
    expect(page).toContain('[`acme a`](../../../moca-commands/commands/acme-a.md)');
    expect(page).toContain('Overrides');
    expect(page).toContain('util-1.0.jar');
    expect(files.get('entries/cust/lib-util-1.0.md')).toContain('Overridden by');
  });

  it('drops invalid class names with a count and never emits them', () => {
    const page = files.get('entries/cust/lib-cust.md')!;
    expect(page).not.toContain('bad name');
    expect(page).not.toContain('9bad');
    expect(page).toContain('2 class names were dropped');
  });

  it('marks missing and unknown entries', () => {
    expect(files.get('entries/cust/old.md')).toContain('missing on the server');
    expect(files.get('entries/cust/classes.md')).toContain('classes unknown');
  });

  it('escapes hostile names in table cells and is deterministic', () => {
    const hostile = structuredClone(manifest);
    hostile.entries[0].path = '/opt/acme/cust/a|b.jar';
    hostile.entries[0].files[0].path = '/opt/acme/cust/a|b.jar';
    const out = emitJavaDocs(hostile, input).get('INDEX.md')!;
    expect(out).toContain('a\\|b.jar');
    expect([...emitJavaDocs(manifest, input)]).toEqual([...files]);
  });
});
