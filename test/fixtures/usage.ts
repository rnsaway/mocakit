import { createMoca, type ListOrdersArgs } from '../.tmp/moca.generated.js';
import type { MocaRow } from '../../src/index.js';

declare module '../../src/index.js' {
  interface MocaOutputs {
    'list orders': { ordnum: string; ordqty: number };
  }
}

const moca = createMoca({ url: 'https://moca.test/service', username: 'u', password: 'p' });

export async function check(): Promise<void> {
  const orders = await moca.listOrders({ wh_id: 'W' });
  const qty: number = orders[0]!.ordqty;

  const full = await moca.listOrders({ wh_id: 'W' }, { format: 'full' });
  const status: number = full.status;
  const fullRows: Array<{ ordnum: string }> = full.rows;

  const custom = await moca.listOrders<{ x: 1 }>({ wh_id: 'W' });
  const x: 1 = custom[0]!.x;

  const opts: import('../../src/index.js').CallOptions = {};
  const either = await moca.listOrders({ wh_id: 'W' }, opts);
  const eitherUnknown: unknown = either;

  const rows = await moca.listActiveCommands();
  const firstRow: MocaRow | undefined = rows[0];
  // @ts-expect-error cannot re-type the result through the annotation
  const bad: Array<{ nope: string }> = await moca.listActiveCommands();
  // @ts-expect-error NoArgs rejects unknown keys
  await moca.listActiveCommands({ x: 1 });
  await moca.cmdExec();
  await moca.listOrders_2();
  await moca.createInventory();
  await moca.createInventory({ prtnum: 'P', untqty: null }, { format: 'full' });
  await moca.exec('[select 1 from dual]');
  await moca.logout();

  // @ts-expect-error wh_id is required
  await moca.listOrders({});
  // @ts-expect-error typo in an argument name
  await moca.listOrders({ wh_id: 'W', ordnumm: 'A' });
  // @ts-expect-error ordqty is a number
  await moca.listOrders({ wh_id: 'W', ordqty: '5' });
  // @ts-expect-error required args cannot be null
  await moca.listOrders({ wh_id: null });

  // FLAG is boolean, UNKNOWN takes any scalar, `@door_id` is plain `door_id`.
  await moca.assignDockDoor({ door_id: 'D1', rush_flg: true, priority: 5 });
  await moca.assignDockDoor({ door_id: 'D1', priority: 'high' });
  await moca.assignDockDoor({ door_id: 'D1', priority: new Date() });
  // @ts-expect-error FLAG only accepts boolean
  await moca.assignDockDoor({ door_id: 'D1', rush_flg: 'Y' });
  // @ts-expect-error @-names are exposed without the @
  await moca.assignDockDoor({ '@door_id': 'D1' });

  // Pass-through (@*) commands take extra arguments via opts.extraArgs.
  await moca.processWidgets({ widget_id: 'W1' }, { extraArgs: { lotnum: 'L1' } });

  // Optional stack-only arguments are not on the interface.
  await moca.summarizeWidgets({ widget_id: 'W1' });
  // @ts-expect-error result_set is RESULTS-typed and stack-only
  await moca.summarizeWidgets({ result_set: 'x' });
  // @ts-expect-error a command with a required POINTER argument is not generated
  await moca.consumeWidgetPointer();

  const args: ListOrdersArgs ={ wh_id: 'W', adddte: new Date(), cancel_flg: true, ordnum: null };
  void [qty, status, fullRows, x, eitherUnknown, firstRow, bad, args];
}
