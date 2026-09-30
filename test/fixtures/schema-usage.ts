import { createMoca } from '../.tmp/moca.schema-client.js';
import type { MocaTables } from '../.tmp/moca.schema.js';
import type { MocaResult, MocaRow, MocaValue } from '../../src/index.js';

const moca = createMoca({ url: 'https://moca.test/service', username: 'u', password: 'p' });

export async function check(): Promise<void> {
  const picked = await moca
    .from('widget')
    .select('widget_id', 'qty')
    .where({ moddte: new Date(), qty: null, flag: true, widget_id: 'W1' })
    .orderBy('qty', 'desc')
    .rows();
  const id: string = picked[0]!.widget_id;
  const qty: number | null = picked[0]!.qty;
  // @ts-expect-error moddte was not selected
  picked[0]!.moddte;

  const all = await moca.from('widget').rows();
  const geo: MocaValue = all[0]!.geo;
  const flag: boolean = all[0]!.flag;

  const full: MocaResult<Pick<MocaTables['ord'], 'ordnum'>> = await moca.from('ord').select('ordnum').rows({ format: 'full' });
  const view: string = (await moca.from('widget_view').rows())[0]!.widget_id;

  // @ts-expect-error unknown table
  moca.from('nope');
  // @ts-expect-error column from another table
  moca.from('ord').select('qty');
  // @ts-expect-error wrong value type for a numeric column
  moca.from('widget').where({ qty: 'five' });
  // @ts-expect-error unknown column in where
  moca.from('widget').where({ nope: 1 });
  // @ts-expect-error dryRun is not a rows() option
  await moca.from('widget').rows({ dryRun: true });

  // The base client stays usable and untyped.
  const untyped: MocaRow[] = await moca.exec('[select 1 x from ord]');
  void [id, qty, geo, flag, full, view, untyped];
}
