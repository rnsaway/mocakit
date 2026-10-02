import { createMoca } from '../.tmp/moca.api-client.js';
import type { Def_widget_v1_Widget } from '../.tmp/moca.api.js';

const moca = createMoca({ url: 'https://moca.test/service', username: 'u', password: 'p' });

export async function check(): Promise<void> {
  const rows: Def_widget_v1_Widget[] = await moca.api.widget.getWidgets({ query: { wh_id: 'W', status: 'A' } });
  const id: string = rows[0]!.widget_id;
  const when = await moca.api.widget.getWidgets({ query: { wh_id: new Date() } });
  const full = await moca.api.widget.getWidgets({ query: { wh_id: 'W' } }, { format: 'full' });
  const status: number = full.status;
  const moved: number | undefined = (await moca.api.widget.postWidgetMove({ body: { wh_id: 'W', qty: 2 } })).moved;

  // @ts-expect-error wh_id is required
  await moca.api.widget.getWidgets({ query: {} });
  // @ts-expect-error status must be "A" | "X"
  await moca.api.widget.getWidgets({ query: { wh_id: 'W', status: 'Z' } });
  // @ts-expect-error body.qty must be a number
  await moca.api.widget.postWidgetMove({ body: { wh_id: 'W', qty: 'two' } });
  // @ts-expect-error unknown operation
  await moca.api.widget.nope();
  void [id, when, status, moved];
}
