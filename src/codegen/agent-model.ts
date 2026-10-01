import type { CommandInfo, TriggerInfo } from './introspect-agent.js';
import { buildCommandTrie, scanSource } from './moca-source.js';
import { byCodeUnit } from './names.js';
import type { TableUsage } from './schema-snapshot.js';
import type { SnapshotArg } from './snapshot.js';

export interface TriggerModel extends TriggerInfo {
  calls: string[];
  reads: string[];
  writes: string[];
}

export interface CommandModel {
  info: CommandInfo;
  args: SnapshotArg[];
  triggers: TriggerModel[];
  /** Display names of commands this command (or its triggers) calls. */
  calls: string[];
  /** Display names of commands whose source (or triggers) calls this command. */
  calledBy: string[];
  reads: string[];
  writes: string[];
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(byCodeUnit);

export function buildAgentModel(input: {
  commands: CommandInfo[];
  triggers: TriggerInfo[];
  args: ReadonlyMap<string, SnapshotArg[]>;
  tables: ReadonlySet<string> | null;
}): { commands: CommandModel[]; usage: TableUsage[] | undefined; warnings: string[] } {
  const trie = buildCommandTrie(input.commands.map((c) => c.key));
  const nameOf = new Map(input.commands.map((c) => [c.key, c.name]));
  const scan = (text: string | undefined) =>
    text === undefined ? { reads: [], writes: [], calls: [] } : scanSource(text, { trie, tables: input.tables });

  const triggersBy = new Map<string, TriggerModel[]>();
  let orphans = 0;
  for (const trigger of input.triggers) {
    if (!nameOf.has(trigger.command)) {
      orphans++;
      continue;
    }
    const found = scan(trigger.source);
    const list = triggersBy.get(trigger.command) ?? [];
    list.push({ ...trigger, calls: found.calls.map((k) => nameOf.get(k) ?? k), reads: found.reads, writes: found.writes });
    triggersBy.set(trigger.command, list);
  }

  const models: CommandModel[] = input.commands.map((info) => {
    const own = scan(info.active.source);
    const triggers = triggersBy.get(info.key) ?? [];
    return {
      info,
      args: input.args.get(info.key) ?? [],
      triggers,
      calls: sorted([...own.calls.map((k) => nameOf.get(k) ?? k), ...triggers.flatMap((t) => t.calls)]),
      calledBy: [],
      reads: sorted([...own.reads, ...triggers.flatMap((t) => t.reads)]),
      writes: sorted([...own.writes, ...triggers.flatMap((t) => t.writes)]),
    };
  });

  const byName = new Map(models.map((m) => [m.info.name, m]));
  for (const model of models) {
    for (const callee of model.calls) {
      const target = byName.get(callee);
      if (target !== undefined && !target.calledBy.includes(model.info.name)) target.calledBy.push(model.info.name);
    }
  }
  for (const model of models) model.calledBy.sort(byCodeUnit);

  let usage: TableUsage[] | undefined;
  if (input.tables !== null) {
    const map = new Map<string, { readBy: Set<string>; writtenBy: Set<string> }>();
    const at = (table: string) => {
      let entry = map.get(table);
      if (entry === undefined) {
        entry = { readBy: new Set(), writtenBy: new Set() };
        map.set(table, entry);
      }
      return entry;
    };
    for (const model of models) {
      for (const t of model.reads) at(t).readBy.add(model.info.name);
      for (const t of model.writes) at(t).writtenBy.add(model.info.name);
    }
    usage = [...map.entries()]
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([table, entry]) => ({ table, readBy: sorted(entry.readBy), writtenBy: sorted(entry.writtenBy) }));
  }

  const warnings =
    orphans === 0
      ? []
      : [`${orphans} ${orphans === 1 ? 'trigger fires' : 'triggers fire'} on commands that are not in the command list; not documented`];
  return { commands: models, usage, warnings };
}
