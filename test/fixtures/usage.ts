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

  const args: ListOrdersArgs = { wh_id: 'W', adddte: new Date(), cancel_flg: true, ordnum: null, 'odd-name': 'x' };
  void [qty, status, fullRows, x, eitherUnknown, firstRow, bad, args];
}
