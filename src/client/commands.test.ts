import { describe, expect, it, vi } from 'vitest';
import type { CommandSpec } from '../types.js';
import { MocaClient } from './client.js';
import { commandSpecOf, defineCommands } from './commands.js';

const LIST_ORDERS: CommandSpec = ['list orders', [['wh_id', 'S', 1]]];
const EXEC_SPEC: CommandSpec = ['exec', []];

describe('defineCommands', () => {
  class Sub extends MocaClient {}
  defineCommands(Sub.prototype, { listOrders: LIST_ORDERS });
  const client = new Sub({ url: 'https://moca.test/service', username: 'u', password: 'p' });

  it('installs one non-enumerable, writable, configurable method per spec', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Sub.prototype, 'listOrders');
    expect(typeof descriptor?.value).toBe('function');
    expect(descriptor).toMatchObject({ enumerable: false, writable: true, configurable: true });
    expect(Object.keys(Sub.prototype)).not.toContain('listOrders');
  });

  it('attaches the spec to each installed method, readable only through commandSpecOf', () => {
    const method = (Sub.prototype as unknown as Record<string, unknown>).listOrders;
    expect(commandSpecOf(method)).toBe(LIST_ORDERS);
    expect(Object.keys(method as object)).toEqual([]);
    expect(commandSpecOf(MocaClient.prototype.exec)).toBeUndefined();
    expect(commandSpecOf(() => undefined)).toBeUndefined();
    expect(commandSpecOf('listOrders')).toBeUndefined();
  });

  it('delegates to call with the spec, args and options', async () => {
    const call = vi.spyOn(client, 'call').mockResolvedValue([]);
    const opts = { format: 'full' as const };
    await (client as unknown as { listOrders(a: object, o: object): Promise<unknown> }).listOrders({ wh_id: 'W' }, opts);
    expect(call).toHaveBeenCalledWith(LIST_ORDERS, { wh_id: 'W' }, opts);
    expect(call.mock.calls[0]![0]).toBe(LIST_ORDERS);
  });

  it('skips a name that clashes with an existing member on the prototype chain, with a warning', () => {
    class Other extends MocaClient {}
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      defineCommands(Other.prototype, { exec: EXEC_SPEC, toString: EXEC_SPEC, listOrders: LIST_ORDERS });
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        'mocakit: generated command "exec" clashes with a MocaClient member and was not installed; regenerate the client with the installed mocakit version',
        'mocakit: generated command "toString" clashes with a MocaClient member and was not installed; regenerate the client with the installed mocakit version',
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(Object.getOwnPropertyNames(Other.prototype).sort()).toEqual(['constructor', 'listOrders']);
    expect(Other.prototype.exec).toBe(MocaClient.prototype.exec);
  });
});
