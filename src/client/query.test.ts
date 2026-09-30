import { describe, expect, it } from 'vitest';
import { baseConfig, fakeMoca, loginOk, mocaXml } from '../../test/helpers/fake-moca.js';
import { defaultDateCodec } from '../dates/codec.js';
import { MocaArgumentError } from '../errors.js';
import { MocaClient } from './client.js';
import { renderQuery } from './query.js';

const state = (over: Partial<Parameters<typeof renderQuery>[0]> = {}) => ({ table: 'widget', columns: [], filter: [], order: [], ...over });

describe('renderQuery', () => {
  it('selects everything with no filter', () => {
    expect(renderQuery(state(), defaultDateCodec)).toBe('[select * from widget]');
  });

  it('binds values through publish data and writes is null directly', () => {
    const text = renderQuery(
      state({
        columns: ['widget_id', 'qty'],
        filter: [['wh_id', 'WMD1'], ['qty', 5], ['ship_id', null], ['active', true]],
        order: [['widget_id', 'desc'], ['qty', 'asc']],
      }),
      defaultDateCodec,
    );
    expect(text).toBe(
      "publish data where wh_id = 'WMD1' and qty = 5 and active = 1" +
        ' | [select widget_id, qty from widget where wh_id = @wh_id and qty = @qty and ship_id is null and active = @active' +
        ' order by widget_id desc, qty asc]',
    );
  });

  it('renders dates in MOCA format', () => {
    const text = renderQuery(state({ filter: [['moddte', new Date(2026, 8, 30, 13, 5, 9)]] }), defaultDateCodec);
    expect(text).toBe("publish data where moddte = '20260930130509' | [select * from widget where moddte = @moddte]");
  });

  it('keeps hostile string values inside the quoted publish data value', () => {
    const text = renderQuery(state({ filter: [['note', "a' | [x] @y"]] }), defaultDateCodec);
    expect(text).toBe("publish data where note = 'a'' | [x] @y' | [select * from widget where note = @note]");
  });
});

function client(handler: (query: string) => string = () => mocaXml(0, { columns: [{ name: 'widget_id' }], rows: [['W1']] })) {
  const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : handler(r.query)));
  return { moca: new MocaClient({ ...baseConfig }, { transport: fake.transport }), requests: fake.requests };
}

describe('MocaClient.from', () => {
  it('builds immutably and runs the rendered text', async () => {
    const { moca, requests } = client();
    const base = moca.from('widget');
    const narrowed = base.select('widget_id').where({ wh_id: 'W', skip: undefined }).orderBy('widget_id');
    expect(await narrowed.rows()).toEqual([{ widget_id: 'W1' }]);
    await base.rows();
    const sent = requests.map((r) => r.query).filter((q) => !q.startsWith('login'));
    expect(sent).toEqual([
      "publish data where wh_id = 'W' | [select widget_id from widget where wh_id = @wh_id order by widget_id asc]",
      '[select * from widget]',
    ]);
  });

  it('returns [] for no rows and supports format full', async () => {
    const { moca } = client(() => mocaXml(510, {}, 'No rows affected'));
    expect(await moca.from('widget').rows()).toEqual([]);
    const full = await moca.from('widget').rows({ format: 'full' });
    expect(full.rows).toEqual([]);
  });

  it.each([
    ['uppercase table', () => client().moca.from('Widget')],
    ['table with a space', () => client().moca.from('widget x')],
    ['bad column', () => client().moca.from('widget').select('a b')],
    ['duplicate select column', () => client().moca.from('widget').select('a', 'a')],
    ['duplicate where column', () => client().moca.from('widget').where({ a: 1 }).where({ a: 2 })],
    ['$ column in where', () => client().moca.from('widget').where({ a$b: 1 })],
    ['duplicate order column', () => client().moca.from('widget').orderBy('a').orderBy('a')],
    ['bad direction', () => client().moca.from('widget').orderBy('a', 'sideways' as 'asc')],
  ])('rejects %s with MocaArgumentError', (_label, build) => {
    expect(build).toThrow(MocaArgumentError);
  });

  it.each(['dryRun', 'extraArgs', 'noRowsIsError'])('rejects the %s option on rows()', async (option) => {
    const { moca, requests } = client();
    await expect(moca.from('widget').rows({ [option]: true } as never)).rejects.toThrow(`${option} is not supported by from().rows()`);
    expect(requests).toEqual([]);
  });

  it('allows $ and # columns in select and orderBy', async () => {
    const { moca, requests } = client();
    await moca.from('widget').select('a$b', 'c#d').orderBy('a$b').rows();
    expect(requests.at(-1)!.query).toBe('[select a$b, c#d from widget order by a$b asc]');
  });
});
