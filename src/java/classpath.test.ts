import { describe, expect, it } from 'vitest';
import { componentsOf, fileSlug, parseClasspath, resolveRoots, selectEntries } from './classpath.js';

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
  it('finds components', () => {
    expect(componentsOf(entries, LES, 'posix')).toEqual(['cust', 'core']);
    expect(componentsOf([{ path: '/x/y' }], LES, 'posix')).toEqual(['/x/y']);
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
    const sel = selectEntries(entries, ['$LESDIR'], LES, 'posix');
    expect(sel.map((e) => [e.component, e.selected])).toEqual([
      ['cust', true],
      ['cust', true],
      ['cust', true],
      ['core', false],
      ['core', false],
    ]);
    expect(selectEntries(entries, ['$LESDIR', 'core'], LES, 'posix').every((e) => e.selected)).toBe(true);
  });
  it('rejects a root that matches nothing', () => {
    expect(() => selectEntries(entries, ['nope'], LES, 'posix')).toThrow(
      'java.roots: "nope" matches no classpath entry (components: cust, core)',
    );
  });
  it('builds slugs', () => {
    const sel = selectEntries(entries, ['$LESDIR', 'core'], LES, 'posix');
    expect(sel.map((e) => e.slug)).toEqual(['lib', 'javalib', 'build-classes', 'lib', 'lib-single']);
  });
  it('numbers colliding slugs in index order', () => {
    const e = parseClasspath('/opt/acme/cust/lib/*:/opt/acme/cust/lib:/opt/acme/cust/lib/', ':');
    expect(selectEntries(e, ['$LESDIR'], LES, 'posix').map((x) => x.slug)).toEqual(['lib', 'lib-2', 'lib-3']);
  });
});

describe('fileSlug', () => {
  const sel = selectEntries(parseClasspath(CP, ':'), ['$LESDIR', 'core'], LES, 'posix');
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
    const sel = selectEntries(entries, ['c:\\ACME\\Cust'], les, 'windows');
    expect(sel.map((e) => [e.component, e.selected, e.slug])).toEqual([
      ['cust', true, 'lib'],
      ['cust', true, 'build-classes'],
    ]);
    expect(resolveRoots(['$LESDIR', 'core'], les, 'windows')).toEqual(['C:\\acme\\cust', 'C:\\acme\\core']);
    expect(fileSlug(sel[0], 'C:\\acme\\cust\\lib\\x-1.0.jar', 'windows')).toBe('lib-x-1.0');
  });
});
