import { describe, expect, it } from 'vitest';
import { baseConfig, fakeMoca, loginOk, mocaXml, type FakeRequest } from '../../test/helpers/fake-moca.js';
import { MocaClient } from '../client/client.js';
import { readCodes, readCommandDefinitions, readTriggers } from './introspect-agent.js';

const client = (handler: (r: FakeRequest) => string) => {
  const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : handler(r)));
  return { client: new MocaClient({ ...baseConfig }, { transport: fake.transport }), requests: fake.requests };
};

describe('readCommandDefinitions', () => {
  const columns = ['cmplvl', 'cmplvlseq', 'command', 'type', 'syntax', 'class', 'functn', 'trnstyp', 'desc'];
  const row = (level: string, seq: number, command: string, type: string, extra: Record<string, string | null> = {}) => ({
    cmplvl: level, cmplvlseq: seq, command, type, syntax: null, class: null, functn: null, trnstyp: null, desc: null, ...extra,
  });

  it('groups by command key, orders definitions by numeric level sequence and keeps fields', () => {
    const commands = readCommandDefinitions({
      columns,
      rows: [
        row('WIDbase', 100, 'list widgets', 'Local Syntax', { syntax: '[select a from widget]', desc: 'Lists widgets' }),
        row('USRwid', 9000, 'List  Widgets', 'Local Syntax', { syntax: 'list widgets_base' }),
        row('WIDext', 700, 'list widgets', 'Java Method', { class: 'com.example.Widgets', functn: 'list' }),
        row('WIDbase', 100, 'create widget', 'C Function', { functn: 'wdgCreate', trnstyp: 'Required' }),
        row('WIDbase', 100, "bad'name", 'Local Syntax'),
      ],
    });
    expect(commands.map((c) => c.key)).toEqual(['create widget', 'list widgets']);
    const list = commands[1]!;
    expect(list.name).toBe('List Widgets');
    expect(list.active).toEqual({ level: 'USRwid', levelSeq: 9000, type: 'Local Syntax', source: 'list widgets_base' });
    expect(list.overrides.map((o) => [o.level, o.levelSeq])).toEqual([
      ['WIDext', 700],
      ['WIDbase', 100],
    ]);
    expect(list.overrides[0]).toMatchObject({ javaClass: 'com.example.Widgets', cFunction: 'list' });
    expect(list.overrides[1]).toMatchObject({ source: '[select a from widget]', description: 'Lists widgets' });
    expect(commands[0]!.active).toMatchObject({ cFunction: 'wdgCreate', transaction: 'Required' });
  });
});

describe('readTriggers', () => {
  it('reads, normalises and orders triggers', async () => {
    const { client: c } = client(() =>
      mocaXml(0, {
        columns: [{ name: 'name' }, { name: 'command' }, { name: 'trgseq', type: 'I' }, { name: 'syntax' }, { name: 'enabled', type: 'O' }, { name: 'filename' }],
        rows: [
          ['zeta trigger', 'Create Widget', '20', 'log widget', '1', 'z.mtrg'],
          ['alpha trigger', 'create widget', '10', '', '0', 'a.mtrg'],
          ['beta trigger', 'create widget', '10', 'list widgets', '1', 'b.mtrg'],
        ],
      }),
    );
    expect(await readTriggers(c)).toEqual([
      { name: 'alpha trigger', command: 'create widget', seq: 10, enabled: false },
      { name: 'beta trigger', command: 'create widget', seq: 10, enabled: true, source: 'list widgets' },
      { name: 'zeta trigger', command: 'create widget', seq: 20, enabled: true, source: 'log widget' },
    ]);
  });

  it('returns [] for no rows and wraps failures', async () => {
    expect(await readTriggers(client(() => mocaXml(510, {}, 'No rows')).client)).toEqual([]);
    await expect(readTriggers(client(() => mocaXml(511, {}, 'boom')).client)).rejects.toThrow(
      'Reading triggers failed (MOCA status 511): MOCA command failed with status 511: boom. Set commandDocs.triggers to false to skip them.',
    );
  });
});

describe('readCodes', () => {
  const codmst = mocaXml(0, {
    columns: [{ name: 'colnam' }, { name: 'codval' }, { name: 'srtseq', type: 'I' }, { name: 'is_purged', type: 'O' }],
    rows: [
      ['WDGSTS', 'X', '2', '0'],
      ['wdgsts', 'A', '1', '0'],
      ['wdgsts', 'P', '3', '1'],
    ],
  });
  const dscmst = (locale: string) =>
    mocaXml(0, {
      columns: [{ name: 'colnam' }, { name: 'colval' }, { name: 'locale_id' }, { name: 'short_dsc' }, { name: 'lngdsc' }],
      rows:
        locale === 'US_ENGLISH'
          ? [
              ['wdgsts', 'A', 'US_ENGLISH', 'Active', 'Widget is active'],
              ['wdgsts', 'Z', 'US_ENGLISH', 'Zombie', null],
              ['wdgtyp', 'B', 'US_ENGLISH', 'Big', null],
            ]
          : [],
    });

  it('merges values and descriptions, honours srtseq, drops purged rows', async () => {
    const { client: c, requests } = client((r) => (r.query.includes('from codmst') ? codmst : dscmst('US_ENGLISH')));
    const { codes, warnings } = await readCodes(c, 'US_ENGLISH');
    expect(codes).toEqual({
      locale: 'US_ENGLISH',
      columns: [
        { column: 'wdgsts', values: [{ value: 'A', short: 'Active', long: 'Widget is active' }, { value: 'X' }, { value: 'Z', short: 'Zombie' }] },
        { column: 'wdgtyp', values: [{ value: 'B', short: 'Big' }] },
      ],
    });
    expect(warnings).toEqual([]);
    expect(requests.some((r) => r.query.includes("locale_id = 'US_ENGLISH'"))).toBe(true);
  });

  it('falls back to US_ENGLISH with a warning when the locale has no descriptions', async () => {
    const { client: c } = client((r) =>
      r.query.includes('from codmst') ? codmst : dscmst(r.query.includes("'FRENCH'") ? 'FRENCH' : 'US_ENGLISH'),
    );
    const { codes, warnings } = await readCodes(c, 'FRENCH');
    expect(codes.locale).toBe('US_ENGLISH');
    expect(warnings).toEqual(['No code descriptions for locale "FRENCH"; used US_ENGLISH']);
  });

  it('wraps failures', async () => {
    await expect(readCodes(client(() => mocaXml(511, {}, 'no table')).client, 'US_ENGLISH')).rejects.toThrow(
      /^Reading code values failed \(MOCA status 511\): .*no table\. Set schema\.codes to false to skip them\.$/,
    );
  });
});
