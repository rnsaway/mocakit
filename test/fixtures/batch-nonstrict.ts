// Compiled with strict: false. Without strictFunctionTypes, Command and OptionalArgsCommand are
// mutually assignable, so only their phantom brands let BatchBuilder tell them apart.
import { createMoca } from '../.tmp/moca.generated.js';

const moca = createMoca({ url: 'https://moca.test/service', username: 'u', password: 'p' });

export async function check(): Promise<void> {
  await moca.batch((b) => [b.createInventory(), b.listOrders({ wh_id: 'W' })]);
  // @ts-expect-error wh_id is required, so listOrders needs its arguments
  await moca.batch((b) => [b.listOrders()]);
  // @ts-expect-error exec is not a batch step
  await moca.batch((b) => [b.exec('x')]);
}
