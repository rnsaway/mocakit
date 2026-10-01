import { describe, expect, it } from 'vitest';
import { buildAgentModel } from './agent-model.js';
import type { CommandInfo, TriggerInfo } from './introspect-agent.js';

const cmd = (name: string, source?: string, level = 'WIDbase'): CommandInfo => ({
  name,
  key: name,
  active: { level, levelSeq: 100, type: 'Local Syntax', ...(source !== undefined && { source }) },
  overrides: [],
});

const commands: CommandInfo[] = [
  cmd('create widget', '[insert into widget (a) values (1)] | log widget'),
  cmd('list widgets', '[select a from widget w, ord o]'),
  cmd('log widget', undefined),
  cmd('process widget move', 'list widgets | create widget'),
];
const triggers: TriggerInfo[] = [
  { name: 'audit move', command: 'process widget move', seq: 10, enabled: true, source: '[update ord set a = 1] | log widget' },
  { name: 'orphan', command: 'no such command', seq: 1, enabled: true },
];

describe('buildAgentModel', () => {
  const { commands: models, usage, warnings } = buildAgentModel({
    commands,
    triggers,
    args: new Map([['list widgets', [{ name: 'wh_id', dtype: 'STRING', required: true }]]]),
    tables: new Set(['widget', 'ord']),
  });
  const byName = new Map(models.map((m) => [m.info.name, m]));

  it('builds calls, called-by and table access including triggers', () => {
    const move = byName.get('process widget move')!;
    expect(move.calls).toEqual(['create widget', 'list widgets', 'log widget']);
    expect(move.writes).toEqual(['ord']);
    expect(move.triggers[0]).toMatchObject({ name: 'audit move', calls: ['log widget'], writes: ['ord'], reads: [] });
    expect(byName.get('log widget')!.calledBy).toEqual(['create widget', 'process widget move']);
    expect(byName.get('list widgets')!.reads).toEqual(['ord', 'widget']);
    expect(byName.get('list widgets')!.args).toHaveLength(1);
  });

  it('computes table usage and warns about triggers on unknown commands', () => {
    expect(usage).toEqual([
      { table: 'ord', readBy: ['list widgets'], writtenBy: ['process widget move'] },
      { table: 'widget', readBy: ['list widgets'], writtenBy: ['create widget'] },
    ]);
    expect(warnings).toEqual(['1 trigger fires on commands that are not in the command list; not documented']);
  });

  it('omits table data when no table list is given', () => {
    const result = buildAgentModel({ commands, triggers: [], args: new Map(), tables: null });
    expect(result.usage).toBeUndefined();
    expect(result.commands.every((m) => m.reads.length === 0 && m.writes.length === 0)).toBe(true);
  });
});
