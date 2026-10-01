// src/codegen/emit-command-docs.test.ts
import { describe, expect, it } from 'vitest';
import type { CommandModel } from './agent-model.js';
import { DOC_MARKER, PRIVATE_NOTICE } from './docs-writer.js';
import { commandDocFile, emitCommandDocs, type CommandDocsOptions } from './emit-command-docs.js';

const model = (over: Partial<CommandModel> & { name: string }): CommandModel => ({
  info: { name: over.name, key: over.name.toLowerCase(), active: { level: 'WIDbase', levelSeq: 100, type: 'Local Syntax' }, overrides: [] },
  args: [],
  triggers: [],
  calls: [],
  calledBy: [],
  reads: [],
  writes: [],
  ...over,
});

const custom = model({
  name: 'list widgets',
  info: {
    name: 'list widgets',
    key: 'list widgets',
    active: { level: 'USRwid', levelSeq: 9000, type: 'Local Syntax', source: 'publish data where x = 1 | [select a from widget]', description: 'Lists | widgets' },
    overrides: [{ level: 'WIDbase', levelSeq: 100, type: 'Local Syntax', source: 'PRODUCT SOURCE ``` here' }],
  },
  args: [
    { name: 'wh_id', dtype: 'STRING', required: true, description: 'Warehouse' },
    { name: 'qty', dtype: 'INTEGER', required: false },
  ],
  triggers: [
    { name: 'usr audit', command: 'list widgets', seq: 10, enabled: true, source: 'log widget', calls: ['log widget'], reads: [], writes: [] },
    { name: 'product trg', command: 'list widgets', seq: 20, enabled: false, source: 'SECRET TRIGGER', calls: [], reads: [], writes: [] },
  ],
  calls: ['log widget'],
  calledBy: ['process widget move'],
  reads: ['widget'],
});
const product = model({
  name: 'create widget',
  info: { name: 'create widget', key: 'create widget', active: { level: 'WIDbase', levelSeq: 100, type: 'C Function', cFunction: 'wdgCreate' }, overrides: [] },
});
const productSource = model({
  name: 'log widget',
  info: { name: 'log widget', key: 'log widget', active: { level: 'WIDbase', levelSeq: 100, type: 'Local Syntax', source: 'PRODUCT LOG' }, overrides: [] },
});

const base: CommandDocsOptions = {
  version: '0.4.0',
  server: 'https://u:p@moca.test/service',
  source: 'custom',
  customLevels: ['USR*'],
  customTriggers: [],
  triggers: true,
  tableHref: (t) => `../../moca-schema/tables/${t}.md`,
};

describe('commandDocFile', () => {
  it('turns spaces into underscores and encodes the rest', () => {
    expect(commandDocFile('list widgets')).toEqual({ file: 'list_widgets.md', encoded: false });
    expect(commandDocFile('sl_get x.y-z')).toEqual({ file: 'sl_get_x.y-z.md', encoded: false });
    expect(commandDocFile('a/b')).toEqual({ file: 'a%2Fb.md', encoded: true });
  });
});

describe('emitCommandDocs', () => {
  const { files, warnings } = emitCommandDocs([custom, product, productSource], base);
  const doc = files.get('commands/list_widgets.md')!;

  it('writes README, INDEX and one file per command, all with the marker and notice', () => {
    expect([...files.keys()]).toEqual(['README.md', 'INDEX.md', 'commands/create_widget.md', 'commands/list_widgets.md', 'commands/log_widget.md']);
    for (const content of files.values()) expect(content.startsWith(DOC_MARKER)).toBe(true);
    expect(files.get('README.md')).toContain(PRIVATE_NOTICE);
    expect(files.get('INDEX.md')).toContain(PRIVATE_NOTICE);
    expect(files.get('INDEX.md')).toContain('- [`list widgets`](commands/list_widgets.md) · USRwid · Local Syntax · 2 triggers · Lists | widgets');
    expect(files.get('README.md')).not.toContain('u:p@');
    expect(warnings).toEqual([]);
  });

  it('shows custom source, hides product source behind the notice (default source: custom)', () => {
    expect(doc).toContain('publish data where x = 1 | [select a from widget]');
    expect(doc).not.toContain('PRODUCT SOURCE');
    expect(doc).toContain("Source not included (Blue Yonder product level WIDbase; set commandDocs.source to 'all' to include it under your licence)");
    expect(doc).not.toContain('SECRET TRIGGER');
    expect(doc).not.toContain('log widget\n```'); // trigger source hidden (level unknown)
    expect(doc).toContain("Source not included (trigger level unknown; add its name to commandDocs.customTriggers or set source to 'all')");
    expect(files.get('commands/log_widget.md')).not.toContain('PRODUCT LOG');
  });

  it('renders arguments, implementation, triggers, links and overrides', () => {
    expect(doc).toContain('| wh_id | STRING | yes | Warehouse |');
    expect(doc).toContain('| qty | INTEGER | no |  |');
    expect(doc).toContain('1. `usr audit` · sequence 10 · enabled');
    expect(doc).toContain('2. `product trg` · sequence 20 · disabled');
    expect(doc).toContain('- Calls: [`log widget`](log_widget.md)');
    expect(doc).toContain('- Called by: [`process widget move`](process_widget_move.md)');
    expect(doc).toContain('- Reads: [`widget`](../../moca-schema/tables/widget.md)');
    expect(doc).toContain('### WIDbase (sequence 100) · Local Syntax');
    expect(files.get('commands/create_widget.md')).toContain('C function: `wdgCreate`');
  });

  it('includes everything with source: all, using a fence longer than any backtick run', () => {
    const all = emitCommandDocs([custom], { ...base, source: 'all' }).files.get('commands/list_widgets.md')!;
    expect(all).toContain('````moca\nPRODUCT SOURCE ``` here\n````');
    expect(all).toContain('SECRET TRIGGER');
  });

  it('shows trigger source for customTriggers, none at all for source: false, and drops triggers when disabled', () => {
    const named = emitCommandDocs([custom], { ...base, customTriggers: ['usr *'] }).files.get('commands/list_widgets.md')!;
    expect(named).toContain('```moca\nlog widget\n```');
    expect(named).not.toContain('SECRET TRIGGER');
    const none = emitCommandDocs([custom], { ...base, source: false }).files.get('commands/list_widgets.md')!;
    expect(none).not.toContain('publish data where x = 1');
    const noTriggers = emitCommandDocs([custom], { ...base, triggers: false }).files.get('commands/list_widgets.md')!;
    expect(noTriggers).not.toContain('## Triggers');
  });

  it('caps long lists and omits table links without schema docs', () => {
    const many = model({ name: 'big', calledBy: Array.from({ length: 55 }, (_, i) => `caller ${String(i).padStart(2, '0')}`), reads: ['widget'] });
    const out = emitCommandDocs([many], { ...base, tableHref: undefined }).files.get('commands/big.md')!;
    expect(out).toContain('and 5 more');
    expect(out).toContain('- Reads: `widget`');
  });
});
