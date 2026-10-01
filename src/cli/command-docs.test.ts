import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { relativeHref, resolveCodesSettings, resolveCommandDocsSettings } from './command-docs.js';

const out = join('/p', 'src', 'moca.generated.ts');

describe('resolveCommandDocsSettings', () => {
  it('is off by default and honours the flag', () => {
    expect(resolveCommandDocsSettings({}, undefined, '/p', out)).toBeNull();
    expect(resolveCommandDocsSettings({ commandDocs: true }, false, '/p', out)).toBeNull();
    expect(resolveCommandDocsSettings({}, true, '/p', out)).toEqual({
      out: resolve('/p', 'src', 'moca-commands'),
      filter: { include: undefined, exclude: undefined, levels: undefined },
      source: 'custom',
      customLevels: ['USR*'],
      customTriggers: [],
      triggers: true,
    });
  });

  it('inherits the command filters and lets commandDocs override them', () => {
    const inherited = resolveCommandDocsSettings({ include: ['list *'], levels: ['USRwid'], commandDocs: true }, undefined, '/p', out)!;
    expect(inherited.filter).toEqual({ include: ['list *'], exclude: undefined, levels: ['USRwid'] });
    const own = resolveCommandDocsSettings(
      { include: ['list *'], commandDocs: { include: ['*'], out: 'agent/cmds', source: 'all', customTriggers: ['usr*'], triggers: false } },
      undefined,
      '/p',
      out,
    )!;
    expect(own).toMatchObject({ out: resolve('/p', 'agent', 'cmds'), source: 'all', customTriggers: ['usr*'], triggers: false });
    expect(own.filter.include).toEqual(['*']);
  });

  it.each([
    [{ commandDocs: 'yes' }, 'config.commandDocs must be true, false or an object'],
    [{ commandDocs: { source: 'some' } }, "commandDocs.source must be 'custom', 'all' or false"],
  ])('rejects %j', (config, message) => {
    expect(() => resolveCommandDocsSettings(config as never, undefined, '/p', out)).toThrow(message);
  });
});

describe('resolveCodesSettings', () => {
  it('reads schema.codes only when schema is enabled', () => {
    expect(resolveCodesSettings({ schema: { codes: true } }, true)).toEqual({});
    expect(resolveCodesSettings({ schema: { codes: { locale: 'FRENCH' } } }, true)).toEqual({ locale: 'FRENCH' });
    expect(resolveCodesSettings({ schema: { codes: true } }, false)).toBeNull();
    expect(resolveCodesSettings({ schema: true }, true)).toBeNull();
  });
});

describe('relativeHref', () => {
  it('builds posix links between folders', () => {
    expect(relativeHref(join('/p', 'src', 'moca-commands', 'commands'), join('/p', 'src', 'moca-schema', 'tables', 'widget.md'))).toBe(
      '../../moca-schema/tables/widget.md',
    );
  });
});
