import { createMoca, type ListOrdersArgs } from '../.tmp/moca.generated.js';
import type { BatchBuilder, BatchOptions, BatchStep, MocaRow } from '../../src/index.js';

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

  // MOCA only enforces flagged arguments on compiled commands, not Local Syntax ones.
  await moca.listGadgetBins({});
  await moca.listGadgetBins();
  await moca.listGadgetBins({ gadget_id: null });
  await moca.validateGadget({ gadget_id: 'G1' });
  // @ts-expect-error required by MOCA for Java commands
  await moca.validateGadget({});

  // autocommit was removed in 0.2.0; dryRun replaces autocommit: false.
  // @ts-expect-error autocommit was removed
  await moca.exec('x', { autocommit: false });
  // @ts-expect-error autocommit was removed
  await moca.listOrders({ wh_id: 'W' }, { autocommit: false });
  // @ts-expect-error autocommit was removed from the client defaults too
  createMoca({ url: 'u', username: 'u', password: 'p', defaults: { autocommit: false } });
  // @ts-expect-error dryRun is per call only
  createMoca({ url: 'u', username: 'u', password: 'p', defaults: { dryRun: true } });
  const dry: Array<{ ordnum: string; ordqty: number }> = await moca.listOrders({ wh_id: 'W' }, { dryRun: true });
  const dryExec: MocaRow[] = await moca.exec('x', { dryRun: true });

  // batch(): the builder mirrors the generated commands, returning BatchSteps.
  let step: BatchStep | undefined;
  const batched = await moca.batch((b) => [
    b.listOrders({ wh_id: 'W', ordqty: 5 }),
    b.createInventory(),
    b.createInventory({ prtnum: 'P' }),
    b.listActiveCommands(),
    (step = b.raw('[select 1 a from dual]')),
  ]);
  const batchedRow: MocaRow | undefined = batched[0];
  const typedBatch: Array<{ n: number }> = await moca.batch<{ n: number }>((b) => [b.raw('x')]);
  const fullBatch = await moca.batch((b) => [b.raw('x')], { format: 'full' });
  const fullBatchStatus: number = fullBatch.status;
  const fullBatchRows: MocaRow[] = fullBatch.rows;
  const batchOpts: BatchOptions = { dryRun: true };
  const eitherBatch = await moca.batch((b) => [b.raw('x')], batchOpts);
  const eitherBatchUnknown: unknown = eitherBatch;
  await moca.batch((b) => [b.raw('x')], { dryRun: true, convert: false, env: { WH_ID: 'W' } });
  // @ts-expect-error wh_id is required
  await moca.batch((b) => [b.listOrders({})]);
  // @ts-expect-error a required-args command needs its arguments
  await moca.batch((b) => [b.listOrders()]);
  // @ts-expect-error typo in an argument name
  await moca.batch((b) => [b.listOrders({ wh_id: 'W', ordnumm: 'A' })]);
  // @ts-expect-error exec is not a batch step
  await moca.batch((b) => [b.exec('x')]);
  // @ts-expect-error login is not a batch step
  await moca.batch((b) => [b.login()]);
  // @ts-expect-error session is not a command
  void ((b: BatchBuilder<typeof moca>) => b.session);
  // @ts-expect-error raw takes MOCA text
  await moca.batch((b) => [b.raw(1)]);
  // @ts-expect-error steps must come from the builder
  await moca.batch(() => [{ moca: 'x' }]);
  // @ts-expect-error autocommit was removed
  await moca.batch((b) => [b.raw('x')], { autocommit: false });
  // @ts-expect-error extraArgs is not a batch option
  await moca.batch((b) => [b.raw('x')], { extraArgs: { a: 1 } });
  // @ts-expect-error noRowsIsError is not settable on a batch (510 always rolls the batch back)
  await moca.batch((b) => [b.raw('x')], { noRowsIsError: false });
  // @ts-expect-error options go on batch(), not on a step
  await moca.batch((b) => [b.listOrders({ wh_id: 'W' }, { format: 'full' })]);
  // @ts-expect-error the builder must return steps synchronously
  await moca.batch(async (b) => [b.raw('x')]);

  const args: ListOrdersArgs = { wh_id: 'W', adddte: new Date(), cancel_flg: true, ordnum: null };
  void [qty, status, fullRows, x, eitherUnknown, firstRow, bad, args, dry, dryExec, step];
  void [batchedRow, typedBatch, fullBatchStatus, fullBatchRows, eitherBatchUnknown];
}
