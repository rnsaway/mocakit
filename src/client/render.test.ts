import { describe, expect, it } from 'vitest';
import { defaultDateCodec } from '../dates/codec.js';
import { MocaArgumentError } from '../errors.js';
import type { CommandSpec } from '../types.js';
import { quoteMocaString, renderCommand } from './render.js';

const spec: CommandSpec = [
  'list orders',
  [
    ['ordnum', 'S', 0],
    ['wh_id', 'S', 1],
    ['ordqty', 'I', 0],
    ['adddte', 'D', 0],
    ['cancel_flg', 'O', 0],
  ],
];
const render = (args?: object, extra?: Record<string, unknown>) =>
  renderCommand(spec, args, extra as never, defaultDateCodec);

describe('renderCommand', () => {
  it('renders declared args in spec order', () => {
    expect(render({ ordqty: 5, wh_id: 'WMD1', ordnum: "O'1" })).toBe(
      `list orders where ordnum = 'O''1' and wh_id = 'WMD1' and ordqty = 5`,
    );
  });

  it('removes undefined and null args entirely (never sends empty strings)', () => {
    expect(render({ wh_id: 'W', ordnum: null, ordqty: undefined })).toBe(`list orders where wh_id = 'W'`);
  });

  it('renders booleans as 1/0 and dates as quoted YYYYMMDDHH24MISS', () => {
    expect(render({ wh_id: 'W', cancel_flg: false, adddte: new Date(2026, 8, 22, 14, 5, 9) })).toBe(
      `list orders where wh_id = 'W' and adddte = '20260922140509' and cancel_flg = 0`,
    );
  });

  it('throws for a missing or null required arg', () => {
    expect(() => render({})).toThrow(MocaArgumentError);
    expect(() => render({ wh_id: null })).toThrow(/Missing required argument "wh_id"/);
  });

  it('throws for non-finite numbers, invalid dates and unsupported types', () => {
    expect(() => render({ wh_id: 'W', ordqty: Number.NaN })).toThrow(MocaArgumentError);
    expect(() => render({ wh_id: 'W', adddte: new Date('x') })).toThrow(MocaArgumentError);
    expect(() => render({ wh_id: 'W', ordnum: { a: 1 } })).toThrow(MocaArgumentError);
  });

  it('rejects undeclared keys in args (use extraArgs instead)', () => {
    expect(() => render({ wh_id: 'W', ordnumm: 'x' })).toThrow(/Unknown argument "ordnumm"/);
  });

  it('appends extraArgs, skipping null/undefined', () => {
    expect(render({ wh_id: 'W' }, { prtnum: 'P1', lotnum: null })).toBe(`list orders where wh_id = 'W' and prtnum = 'P1'`);
  });

  it('rejects extraArgs that are declared or have invalid names', () => {
    expect(() => render({ wh_id: 'W' }, { ordnum: 'x' })).toThrow(/declared/);
    expect(() => render({ wh_id: 'W' }, { 'x = 1 | delete': 'y' })).toThrow(/Invalid argument name/);
  });

  it('renders a bare command when nothing remains', () => {
    const noArgs: CommandSpec = ['list active commands', []];
    expect(renderCommand(noArgs, undefined, undefined, defaultDateCodec)).toBe('list active commands');
  });

  it('rethrows date codec formatting failures as a MocaArgumentError named after the argument', () => {
    let caught: unknown;
    try {
      render({ wh_id: 'W', adddte: new Date(10000, 0, 1) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MocaArgumentError);
    expect((caught as InstanceType<typeof MocaArgumentError>).argument).toBe('adddte');
  });

  it('rejects unsafe integers and exponent notation, but allows negatives and decimals', () => {
    expect(() => render({ wh_id: 'W', ordqty: 2 ** 64 })).toThrow(MocaArgumentError);
    expect(() => render({ wh_id: 'W', ordqty: 1e21 })).toThrow(MocaArgumentError);
    expect(() => render({ wh_id: 'W', ordqty: 1e-7 })).toThrow(MocaArgumentError);
    expect(render({ wh_id: 'W', ordqty: -5 })).toBe(`list orders where wh_id = 'W' and ordqty = -5`);
    expect(render({ wh_id: 'W', ordqty: 2.5 })).toBe(`list orders where wh_id = 'W' and ordqty = 2.5`);
  });

  it('treats inherited properties like "constructor" as absent, not present', () => {
    const specWithCtor: CommandSpec = ['list x', [['constructor', 'S', 1]]];
    expect(() => renderCommand(specWithCtor, {}, undefined, defaultDateCodec)).toThrow(
      /Missing required argument "constructor"/,
    );
  });

  it('rejects an extraArgs key that matches a declared name ignoring case', () => {
    expect(() => render({ wh_id: 'W' }, { WH_ID: 'x' })).toThrow(/declared/);
  });

  it('rejects extraArgs keys that duplicate each other ignoring case', () => {
    expect(() => render({ wh_id: 'W' }, { prtnum: 'P1', PRTNUM: 'P2' })).toThrow(/duplicat/i);
  });

  it('rejects an args key matching a declared name in a different case, pointing at the declared spelling', () => {
    expect(() => render({ WH_ID: 'x' })).toThrow(/declared spelling/i);
  });
});

describe('quoteMocaString', () => {
  it('doubles single quotes', () => {
    expect(quoteMocaString("it's")).toBe(`'it''s'`);
  });
});
