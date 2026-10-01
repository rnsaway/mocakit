import { describe, expect, it } from 'vitest';
import { buildCommandTrie, commandCalls, scanSource, splitSource, sqlTables } from './moca-source.js';

describe('splitSource', () => {
  it('separates SQL blocks, skips Groovy, strings and comments', () => {
    const { sql, moca } = splitSource(
      "list widgets where x = '[not sql] from a' /* [nor this] */ | [select a from widget w] | [[ def s = 'from widget' ]] | log widget",
    );
    expect(sql).toEqual(['select a from widget w']);
    expect(moca).not.toContain('from a');
    expect(moca).not.toContain('nor this');
    expect(moca).not.toContain('def s');
    expect(moca).toContain('list widgets');
    expect(moca).toContain('log widget');
  });

  it('blanks strings and comments inside SQL and handles nested brackets and unterminated blocks', () => {
    // "']'" becomes "?  " (3), then ' ' and blanked "-- from fake" (12): 15 spaces after the "?"
    expect(splitSource("[select x from widget where y = ']' -- from fake\n and z = 1]").sql).toEqual([
      `select x from widget where y = ?${' '.repeat(15)}\n and z = 1`,
    ]);
    expect(splitSource('[select [order] from ord').sql).toEqual(['select [order] from ord']);
  });
});

describe('sqlTables', () => {
  it.each([
    ['select a from widget', ['widget'], []],
    ['SELECT a FROM Widget w JOIN ord o ON o.id = w.id', ['ord', 'widget'], []],
    ['select * from widget w, ord as o, dbo.loc l where 1 < 2', ['loc', 'ord', 'widget'], []],
    ['select * from (select a from widget) x, ord', ['widget'], []],
    ['insert into widget (a) select a from ord', ['ord'], ['widget']],
    ['update widget set a = 1 where b in (select b from ord)', ['ord'], ['widget']],
    ['delete from widget where a = 1', [], ['widget']],
    ['delete widget where a = 1', [], ['widget']],
    ['merge into widget w using ord o on (w.a = o.a)', ['ord'], ['widget']],
    ['truncate table widget', [], ['widget']],
    ['select a from widget for update', ['widget'], []],
    ['select a from @tbl', [], []],
    ['select @from_dte from widget', ['widget'], []],
    ['select a from @+tbl', [], []],
    ['select a from #tmp t, ord', [], []],
  ])('%s', (sql, reads, writes) => {
    expect(sqlTables(sql)).toEqual({ reads, writes });
  });
});

describe('commandCalls', () => {
  const trie = buildCommandTrie(['list widgets', 'list widget lines', 'create widget', 'log widget', 'list']);

  it('finds commands at statement starts, preferring the longest name', () => {
    expect(
      commandCalls(
        'list widget lines where a = 1 | create widget ; if (@x) { log widget } else { list widgets } & list',
        trie,
      ),
    ).toEqual(['create widget', 'list', 'list widget lines', 'list widgets', 'log widget']);
  });

  it('ignores names that are not at a statement start', () => {
    expect(commandCalls('publish data where name = log widget', trie)).toEqual([]);
  });

  it('does not read variables or operands as commands', () => {
    const t = buildCommandTrie(['list', 'list widgets', 'create widget']);
    expect(commandCalls('if (@list = 1) { create widget }', t)).toEqual(['create widget']);
    expect(commandCalls('publish data where a = 1 and (list = 2)', t)).toEqual([]);
    expect(commandCalls('(@list = @widgets)', t)).toEqual([]);
  });

  it('handles try/catch/finally and ^ overrides', () => {
    expect(commandCalls('try { create widget } catch (@?) { log widget } finally { ^list widgets }', trie)).toEqual([
      'create widget',
      'list widgets',
      'log widget',
    ]);
  });
});

describe('scanSource', () => {
  const trie = buildCommandTrie(['list widgets', 'create widget']);

  it('does not read the alias after a quoted identifier as a table', () => {
    const all = new Set(['widget', 'ord', 'w', 'o']);
    expect(scanSource('[select a from "widget" w, ord o]', { trie, tables: all })).toEqual({
      reads: [],
      writes: [],
      calls: [],
    });
  });

  it('closes Groovy blocks at the matching ]] only', () => {
    const t = buildCommandTrie(['noop', 'list widgets']);
    const none = { trie: t, tables: null };
    expect(scanSource('[[ def x = m[k[0]]; noop ]] | list widgets', none).calls).toEqual(['list widgets']);
    expect(scanSource("[[ def s = ']]' ]] | list widgets", none).calls).toEqual(['list widgets']);
    expect(scanSource('[[ def s = 1', none).calls).toEqual([]);
  });

  it('keeps only known tables and ignores strings, comments and Groovy', () => {
    const text =
      "create widget where note = 'select x from ord' | /* update ord */ [select a from widget w, fake_tbl f] | [[ 'delete from ord' ]] | [update widget set a = 1]";
    expect(scanSource(text, { trie, tables: new Set(['widget', 'ord']) })).toEqual({
      reads: ['widget'],
      writes: ['widget'],
      calls: ['create widget'],
    });
  });

  it('skips table extraction when no table list is given', () => {
    expect(scanSource('[select a from widget] | list widgets', { trie, tables: null })).toEqual({
      reads: [],
      writes: [],
      calls: ['list widgets'],
    });
  });
});
