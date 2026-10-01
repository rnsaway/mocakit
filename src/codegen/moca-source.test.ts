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
    // ' ' + blanked "']'" (3) + ' ' + blanked "-- from fake" (12) = 17 spaces after "y ="
    expect(splitSource("[select x from widget where y = ']' -- from fake\n and z = 1]").sql).toEqual([
      `select x from widget where y =${' '.repeat(17)}\n and z = 1`,
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
