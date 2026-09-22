import { describe, expect, it, vi } from 'vitest';
import type { CommandSpec } from '../types.js';
import { MocaClient } from './client.js';
import { defineCommands } from './commands.js';

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

  it('delegates to call with the spec, args and options', async () => {
    const call = vi.spyOn(client, 'call').mockResolvedValue([]);
    const opts = { format: 'full' as const };
    await (client as unknown as { listOrders(a: object, o: object): Promise<unknown> }).listOrders({ wh_id: 'W' }, opts);
    expect(call).toHaveBeenCalledWith(LIST_ORDERS, { wh_id: 'W' }, opts);
    expect(call.mock.calls[0]![0]).toBe(LIST_ORDERS);
  });

  it('throws when a name clashes with an existing member on the prototype chain', () => {
    class Other extends MocaClient {}
    expect(() => defineCommands(Other.prototype, { exec: EXEC_SPEC })).toThrow(
      /exec.*regenerate the client with the installed mocakit version/,
    );
    expect(() => defineCommands(Other.prototype, { toString: EXEC_SPEC })).toThrow(
      /toString.*regenerate the client with the installed mocakit version/,
    );
    expect(Object.getOwnPropertyNames(Other.prototype)).toEqual(['constructor']);
  });
});
