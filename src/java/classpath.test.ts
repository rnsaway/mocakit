import { describe, expect, it } from 'vitest';
import { fileSlug, parseClasspath, resolveRoots, selectEntries } from './classpath.js';

const pick = (...a: Parameters<typeof selectEntries>) => selectEntries(...a).entries;
const LES = '/opt/acme/cust';
const CP = [
  '/opt/acme/cust/lib/*',
  '/opt/acme/cust/javalib/*',
  '/opt/acme/cust/build/classes',
  '/opt/acme/core/lib/*',
  '/opt/acme/core/lib/single.jar',
  '/opt/acme/cust/lib/*',
  '',
].join(':');

describe('parseClasspath', () => {
  const entries = parseClasspath(CP, ':');
  it('types entries and drops empties and duplicates', () => {
    expect(entries.map((e) => [e.index, e.path, e.type])).toEqual([
      [0, '/opt/acme/cust/lib', 'dir-wildcard'],
      [1, '/opt/acme/cust/javalib', 'dir-wildcard'],
      [2, '/opt/acme/cust/build/classes', 'dir'],
      [3, '/opt/acme/core/lib', 'dir-wildcard'],
      [4, '/opt/acme/core/lib/single.jar', 'jar'],
    ]);
    expect(entries[0].raw).toBe('/opt/acme/cust/lib/*');
  });
});

describe('roots and selection', () => {
  const entries = parseClasspath(CP, ':');
  it('resolves roots', () => {
    expect(resolveRoots(['$LESDIR', 'core', '/x/y'], LES, 'posix')).toEqual([
      '/opt/acme/cust',
      '/opt/acme/core',
      '/x/y',
    ]);
  });
  it('selects only the custom layer by default', () => {
    const sel = pick(entries, ['$LESDIR'], LES, 'posix');
    expect(sel.map((e) => [e.component, e.selected])).toEqual([
      ['cust', true],
      ['cust', true],
      ['cust', true],
      ['core', false],
      ['core', false],
    ]);
    expect(pick(entries, ['$LESDIR', 'core'], LES, 'posix').every((e) => e.selected)).toBe(true);
  });
  it('rejects a root that matches nothing', () => {
    expect(() => pick(entries, ['nope'], LES, 'posix')).toThrow(
      'java.roots: "nope" matches no classpath entry; use $LESDIR, the name of a folder next to it, or an absolute path',
    );
  });
  it.each(['', '  ', '.', '..', 'a/b', 'a\\b'])('rejects the root %j', (root) => {
    expect(() => pick(entries, [root], LES, 'posix')).toThrow(
      `java.roots: "${root}" is not $LESDIR, a $NAME server variable, the name of a folder next to $LESDIR, or an absolute path`,
    );
  });
  it('builds slugs', () => {
    const sel = pick(entries, ['$LESDIR', 'core'], LES, 'posix');
    expect(sel.map((e) => e.slug)).toEqual(['lib', 'javalib', 'build-classes', 'lib', 'lib-single']);
  });
  it('numbers colliding slugs in index order', () => {
    const e = parseClasspath('/opt/acme/cust/lib/*:/opt/acme/cust/lib:/opt/acme/cust/lib/', ':');
    expect(pick(e, ['$LESDIR'], LES, 'posix').map((x) => x.slug)).toEqual(['lib', 'lib-2', 'lib-3']);
  });
});

describe('fileSlug', () => {
  const sel = pick(parseClasspath(CP, ':'), ['$LESDIR', 'core'], LES, 'posix');
  it('names JARs and classes folders', () => {
    expect(fileSlug(sel[0], '/opt/acme/cust/lib/acme-cust.jar', 'posix')).toBe('lib-acme-cust');
    expect(fileSlug(sel[2], '/opt/acme/cust/build/classes/com/acme/W.class', 'posix')).toBe('build-classes');
    expect(fileSlug(sel[4], '/opt/acme/core/lib/single.jar', 'posix')).toBe('lib-single');
  });
  it('keeps same-named JARs in lib and javalib apart', () => {
    expect(fileSlug(sel[0], '/opt/acme/cust/lib/x-1.0.jar', 'posix')).toBe('lib-x-1.0');
    expect(fileSlug(sel[1], '/opt/acme/cust/javalib/x-1.0.jar', 'posix')).toBe('javalib-x-1.0');
  });
});

describe('windows', () => {
  const cp = 'C:\\acme\\cust\\lib\\*;C:\\acme\\cust\\build\\classes';
  const les = 'C:\\acme\\cust';
  const entries = parseClasspath(cp, ';');
  it('parses and selects case-insensitively', () => {
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ['C:\\acme\\cust\\lib', 'dir-wildcard'],
      ['C:\\acme\\cust\\build\\classes', 'dir'],
    ]);
    const sel = pick(entries, ['c:\\ACME\\Cust'], les, 'windows');
    expect(sel.map((e) => [e.component, e.selected, e.slug])).toEqual([
      ['cust', true, 'lib'],
      ['cust', true, 'build-classes'],
    ]);
    expect(resolveRoots(['$LESDIR', 'core'], les, 'windows')).toEqual(['C:\\acme\\cust', 'C:\\acme\\core']);
    expect(fileSlug(sel[0], 'C:\\acme\\cust\\lib\\x-1.0.jar', 'windows')).toBe('lib-x-1.0');
  });
});

describe('relative entries', () => {
  const entries = parseClasspath('.:classes:../x:lib/*:/opt/acme/cust/lib/*', ':');
  it('are kept but unusable, never selected, and warned about', () => {
    expect(entries.map((e) => [e.path, e.usable])).toEqual([
      ['.', false],
      ['classes', false],
      ['../x', false],
      ['lib', false],
      ['/opt/acme/cust/lib', true],
    ]);
    const r = selectEntries(entries, ['$LESDIR'], LES, 'posix');
    expect(r.entries.map((e) => e.selected)).toEqual([false, false, false, false, true]);
    expect(r.entries[4].slug).toBe('lib');
    expect(r.warnings).toEqual([
      'classpath entry "." is not an absolute path; skipped',
      'classpath entry "classes" is not an absolute path; skipped',
      'classpath entry "../x" is not an absolute path; skipped',
      'classpath entry "lib/*" is not an absolute path; skipped',
    ]);
  });
});

describe('root wildcards', () => {
  it('keeps a bare root absolute', () => {
    expect(parseClasspath('C:\\*', ';')[0]).toMatchObject({ path: 'C:\\', type: 'dir-wildcard', usable: true });
    expect(parseClasspath('/*', ':')[0]).toMatchObject({ path: '/', type: 'dir-wildcard', usable: true });
    expect(parseClasspath('C:\\acme\\lib\\*', ';')[0].path).toBe('C:\\acme\\lib');
  });
});

describe('entries outside the parent of lesDir', () => {
  const entries = parseClasspath('/x/y/lib/*:/x/y/lib:/opt/acme/cust/lib/*', ':');
  it('use the external component and a whole-path slug', () => {
    const sel = pick(entries, ['$LESDIR'], LES, 'posix');
    expect(sel.map((e) => [e.component, e.slug, e.selected])).toEqual([
      ['external', 'x-y-lib', false],
      ['external', 'x-y-lib-2', false],
      ['cust', 'lib', true],
    ]);
    expect(fileSlug(sel[0], '/x/y/lib/a.jar', 'posix')).toBe('x-y-lib-a');
  });
  it('drops the drive colon on windows', () => {
    const e = parseClasspath('D:\\tools\\lib\\*', ';');
    const sel = pick(e, ['D:\\tools'], 'C:\\acme\\cust', 'windows');
    expect(sel[0]).toMatchObject({ component: 'external', slug: 'D-tools-lib', selected: true });
  });
});
