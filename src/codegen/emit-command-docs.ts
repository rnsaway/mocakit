// src/codegen/emit-command-docs.ts
import { redactUrl } from '../util/url.js';
import type { CommandModel, TriggerModel } from './agent-model.js';
import { docHref, DOC_MARKER, encodeDocName, PRIVATE_NOTICE } from './docs-writer.js';
import { globToRegExp } from './filter.js';
import type { CommandDefinition } from './introspect-agent.js';

export interface CommandDocsOptions {
  version: string;
  server: string;
  source: 'custom' | 'all' | false;
  customLevels: string[];
  customTriggers: string[];
  triggers: boolean;
  /** Relative href from `commands/<file>.md` to a table doc; undefined when schema docs are off. */
  tableHref?: (table: string) => string;
}

const SAFE = /^[a-z0-9_$#.]$/;
const CAP = 50;

export function commandDocFile(key: string): { file: string; encoded: boolean } {
  // Injective: spaces become '-', and a literal '-' is percent-encoded (it is not in SAFE).
  const parts = key.split(' ').map((part) => encodeDocName(part, SAFE));
  return { file: `${parts.map((p) => p.file.slice(0, -3)).join('-')}.md`, encoded: parts.some((p) => p.encoded) };
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const noTicks = (text: string): string => oneLine(text).split('`').join('\\`');
const cell = (text: string | undefined): string => (text === undefined ? '' : oneLine(text).split('\\').join('\\\\').split('|').join('\\|'));

function fence(source: string): string {
  const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}moca\n${source.replace(/\s+$/, '')}\n${ticks}`;
}

function capped(items: string[], render: (item: string) => string): string {
  const shown = items.slice(0, CAP).map(render).join(', ');
  return items.length > CAP ? `${shown}, and ${items.length - CAP} more` : shown;
}

function implementation(def: CommandDefinition): string[] {
  if (def.javaClass !== undefined || /java/i.test(def.type ?? '')) {
    return [`Java: \`${[def.javaClass, def.cFunction].filter(Boolean).join('.')}\``];
  }
  if (def.cFunction !== undefined) return [`C function: \`${def.cFunction}\``];
  return [];
}

export function emitCommandDocs(commands: CommandModel[], options: CommandDocsOptions): { files: Map<string, string>; warnings: string[] } {
  const marker = `${DOC_MARKER} ${options.version} from ${redactUrl(options.server)}. Do not edit; regenerate with \`mocakit generate\`. -->`;
  const levelGlobs = options.customLevels.map(globToRegExp);
  const triggerGlobs = options.customTriggers.map(globToRegExp);
  const showDef = (def: CommandDefinition) =>
    options.source === 'all' || (options.source === 'custom' && levelGlobs.some((re) => re.test(def.level)));
  const showTrigger = (t: TriggerModel) =>
    options.source === 'all' || (options.source === 'custom' && triggerGlobs.some((re) => re.test(t.name)));
  const productNotice = (def: CommandDefinition) =>
    `_Source not included (Blue Yonder product level ${def.level}; set commandDocs.source to 'all' to include it under your licence)_`;
  const triggerNotice = "_Source not included (trigger level unknown; add its name to commandDocs.customTriggers or set source to 'all')_";

  const warnings: string[] = [];
  const fileOf = new Map<string, string>();
  for (const m of commands) {
    const { file, encoded } = commandDocFile(m.info.key);
    if (encoded) warnings.push(`Command "${m.info.name}" has characters that are not safe in file names; its doc is commands/${file}`);
    fileOf.set(m.info.name, file);
  }
  // Only commands documented in this run get a link; any other name is shown plain (no dead links).
  const commandLink = (name: string) => {
    const file = fileOf.get(name);
    return file === undefined ? `\`${name}\`` : `[\`${name}\`](${docHref(file)})`;
  };
  const tableLink = (table: string) => (options.tableHref ? `[\`${table}\`](${docHref(options.tableHref(table))})` : `\`${table}\``);

  const sourceBlock = (def: CommandDefinition): string[] => {
    if (options.source === false || def.source === undefined) return [];
    return showDef(def) ? [fence(def.source), ''] : [productNotice(def), ''];
  };

  const files = new Map<string, string>();
  files.set(
    'README.md',
    [
      marker,
      PRIVATE_NOTICE,
      '',
      '# MOCA commands (for coding agents)',
      '',
      '- Search `INDEX.md` for a command by name or description, then open `commands/<command>.md`.',
      '- "Active" is the definition MOCA runs (highest component level); "Overrides" lists the lower-level ones it replaces.',
      '- Triggers run automatically, in sequence, whenever their command runs; they are never called directly.',
      '- Calls, Called by, Reads and Writes are found by scanning source text: SQL built at run time and Java/C code are not covered.',
      '',
    ].join('\n'),
  );

  const index = [marker, PRIVATE_NOTICE, '', '# Commands', ''];
  const docs: Array<[string, string]> = [];
  for (const m of [...commands].sort((a, b) => (a.info.key < b.info.key ? -1 : a.info.key > b.info.key ? 1 : 0))) {
    const { active } = m.info;
    const file = fileOf.get(m.info.name)!;
    const triggerCount = options.triggers && m.triggers.length > 0 ? ` · ${m.triggers.length} ${m.triggers.length === 1 ? 'trigger' : 'triggers'}` : '';
    const description = active.description !== undefined ? ` · ${noTicks(active.description)}` : '';
    index.push(`- [\`${m.info.name}\`](commands/${docHref(file)}) · ${active.level} · ${active.type ?? 'unknown type'}${triggerCount}${description}`);

    const lines = [marker, `# ${m.info.name}`, ''];
    if (active.description !== undefined) lines.push(noTicks(active.description), '');
    lines.push(
      `- Level: \`${active.level}\` (sequence ${active.levelSeq})`,
      `- Type: ${active.type ?? 'unknown'}`,
      ...(active.transaction !== undefined ? [`- Transaction: ${active.transaction}`] : []),
      '',
      '## Arguments',
      '',
    );
    if (m.args.length === 0) lines.push('None.', '');
    else {
      lines.push('| name | type | required | description |', '|---|---|---|---|');
      for (const a of m.args) lines.push(`| ${cell(a.name)} | ${cell(a.dtype)} | ${a.required ? 'yes' : 'no'} | ${cell(a.description)} |`);
      lines.push('');
    }
    lines.push('## Implementation', '', ...implementation(active));
    if (implementation(active).length > 0) lines.push('');
    lines.push(...sourceBlock(active));

    if (options.triggers && m.triggers.length > 0) {
      lines.push('## Triggers', '');
      m.triggers.forEach((t, i) => {
        lines.push(`${i + 1}. \`${t.name}\` · sequence ${t.seq} · ${t.enabled ? 'enabled' : 'disabled'}`, '');
        if (options.source !== false && t.source !== undefined) lines.push(showTrigger(t) ? fence(t.source) : triggerNotice, '');
      });
    }

    const related: string[] = [];
    if (m.calls.length > 0) related.push(`- Calls: ${capped(m.calls, commandLink)}`);
    if (m.calledBy.length > 0) related.push(`- Called by: ${capped(m.calledBy, commandLink)}`);
    if (m.reads.length > 0) related.push(`- Reads: ${capped(m.reads, tableLink)}`);
    if (m.writes.length > 0) related.push(`- Writes: ${capped(m.writes, tableLink)}`);
    if (related.length > 0) lines.push('## Related (approximate, from source)', '', ...related, '');

    if (m.info.overrides.length > 0) {
      lines.push('## Overrides', '');
      for (const def of m.info.overrides) {
        lines.push(`### ${def.level} (sequence ${def.levelSeq}) · ${def.type ?? 'unknown type'}`, '', ...implementation(def));
        if (implementation(def).length > 0) lines.push('');
        lines.push(...sourceBlock(def));
      }
    }
    docs.push([`commands/${file}`, `${lines.join('\n').replace(/\n+$/, '')}\n`]);
  }
  index.push('');
  files.set('INDEX.md', index.join('\n'));
  for (const [path, content] of docs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) files.set(path, content);
  return { files, warnings };
}
