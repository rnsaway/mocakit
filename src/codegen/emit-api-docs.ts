// src/codegen/emit-api-docs.ts
import { redactUrl } from '../util/url.js';
import type { ApiOperation, ApiSchema, ApiSnapshot } from './api-snapshot.js';
import { docHref, DOC_MARKER, PRIVATE_NOTICE } from './docs-writer.js';
import { byCodeUnit } from './names.js';

const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();
const noTicks = (t: string): string => oneLine(t).split('`').join('\\`');
const cell = (t: string | undefined): string => (t === undefined ? '' : noTicks(t.split('\\').join('\\\\')).split('|').join('\\|'));
const firstSentence = (t: string): string => oneLine(t).match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? oneLine(t);

export function apiDocFile(op: ApiOperation): string {
  return `operations/${op.tagKey}/${op.name}.md`;
}

function typeLabel(schema: ApiSchema): string {
  switch (schema.kind) {
    case 'string':
      return schema.enum?.length ? `string (${schema.enum.join(', ')})` : schema.format ? `string (${schema.format})` : 'string';
    case 'number':
      return schema.integer ? 'integer' : 'number';
    case 'array':
      return `array of ${typeLabel(schema.items)}`;
    case 'ref':
      return schema.name;
    default:
      return schema.kind;
  }
}

/** Field rows for an object schema; refs resolved via `defs`; nested objects one level deep. */
function fieldRows(schema: ApiSchema, defs: Record<string, ApiSchema>, prefix = '', depth = 0): string[] {
  const resolved = schema.kind === 'ref' ? defs[schema.name] : schema.kind === 'array' ? (schema.items.kind === 'ref' ? defs[schema.items.name] : schema.items) : schema;
  if (resolved === undefined || resolved.kind !== 'object') return [];
  const rows: string[] = [];
  for (const [name, prop] of Object.entries(resolved.properties)) {
    const full = `${prefix}${name}`;
    rows.push(`| ${cell(full)} | ${cell(typeLabel(prop))} | ${resolved.required.includes(name) ? 'yes' : 'no'} | ${cell(prop.description)} |`);
    if (depth === 0 && (prop.kind === 'object' || prop.kind === 'ref')) rows.push(...fieldRows(prop, defs, `${full}.`, depth + 1));
  }
  return rows;
}

const FIELD_HEADER = ['| field | type | required | description |', '|---|---|---|---|'];

export function emitApiDocs(snapshot: ApiSnapshot, options: { version: string }): { files: Map<string, string>; warnings: string[] } {
  const marker = `${DOC_MARKER} ${options.version} from ${redactUrl(snapshot.server)}. Do not edit; regenerate with \`mocakit generate\`. -->`;
  const privateGroups = new Set(snapshot.groups.filter((g) => g.private).map((g) => g.name));
  const files = new Map<string, string>();
  files.set(
    'README.md',
    [
      marker,
      PRIVATE_NOTICE,
      '',
      '# REST APIs (for coding agents)',
      '',
      '- Search `INDEX.md` by tag, path or description, then open `operations/<tag>/<method>.md`.',
      "- Call with `await moca.api.<tag>.<method>({ path, query, body })`; `{ data: [...] }` responses resolve to the rows, `{ format: 'full' }` gives `{ status, body }`.",
      '- mocakit logs in to the REST API on the first call and reuses the session cookie.',
      '- **POST, PUT, PATCH and DELETE change data immediately.** There is no dry-run or rollback for REST calls; generate with `api.methods: [\'get\']` for a read-only client.',
      '- Each page lists the permissions (`x-permissions`) the caller needs.',
      '',
    ].join('\n'),
  );

  const ops = [...snapshot.operations].sort((a, b) => byCodeUnit(a.tagKey, b.tagKey) || byCodeUnit(a.name, b.name));
  const index = [marker, PRIVATE_NOTICE, '', '# REST API operations', ''];
  let currentTag = '';
  const pages: Array<[string, string]> = [];
  for (const op of ops) {
    if (op.tagKey !== currentTag) {
      currentTag = op.tagKey;
      index.push(privateGroups.has(op.group) ? `## ${op.tagKey} (internal group "${op.group}")` : `## ${op.tagKey}`, '');
    }
    const perms = op.permissions.length ? ` · ${op.permissions.join(', ')}` : '';
    const summary = op.description !== undefined ? ` · ${cell(firstSentence(op.description))}` : '';
    const file = apiDocFile(op);
    index.push(`- [\`${op.name}\`](${docHref(file)}) · ${op.method.toUpperCase()} ${op.path}${perms}${summary}`);

    const lines = [marker, `# ${op.tagKey}.${op.name}`, '', `\`${op.method.toUpperCase()} ${op.fullPath}\``, ''];
    if (privateGroups.has(op.group)) lines.push(`_Internal API group "${op.group}": not part of the supported public API and may change between releases._`, '');
    if (op.description !== undefined) lines.push(noTicks(op.description), '');
    lines.push(`Permissions: ${op.permissions.length ? op.permissions.map((p) => `\`${p}\``).join(', ') : 'none listed'}`, '');
    if (op.method !== 'get') lines.push('> Writes change data immediately; there is no dry-run or rollback.', '');
    if (op.parameters.length > 0) {
      lines.push('## Parameters', '', '| in | name | type | required | description |', '|---|---|---|---|---|');
      for (const p of op.parameters) lines.push(`| ${p.in === 'formData' ? 'form' : p.in} | ${cell(p.name)} | ${cell(typeLabel(p.schema))} | ${p.required ? 'yes' : 'no'} | ${cell(p.description)} |`);
      lines.push('');
    }
    if (op.body !== undefined) {
      const rows = fieldRows(op.body.schema, snapshot.definitions);
      lines.push(`## Request body${op.body.required ? '' : ' (optional)'}`, '');
      lines.push(...(rows.length ? [...FIELD_HEADER, ...rows] : [`Type: ${cell(typeLabel(op.body.schema))}`]), '');
    }
    if (op.response !== undefined) {
      const rows = fieldRows(op.response.schema, snapshot.definitions);
      lines.push(op.response.envelope === 'data' ? '## Response rows (`data` items)' : '## Response body', '');
      lines.push(...(rows.length ? [...FIELD_HEADER, ...rows] : [`Type: ${cell(typeLabel(op.response.schema))}`]), '');
    }
    const parts = [
      op.parameters.some((p) => p.in === 'path') ? 'path: { /* … */ }' : undefined,
      op.parameters.some((p) => p.in === 'query') ? 'query: { /* … */ }' : undefined,
      op.parameters.some((p) => p.in === 'formData') ? 'form: { /* … */ }' : undefined,
      op.body !== undefined ? 'body: { /* … */ }' : undefined,
    ].filter(Boolean);
    lines.push('## Example', '', '```ts', `await moca.api.${op.tagKey}.${op.name}(${parts.length ? `{ ${parts.join(', ')} }` : ''});`, '```', '');
    pages.push([file, lines.join('\n')]);
  }
  index.push('');
  files.set('INDEX.md', index.join('\n'));
  for (const [file, content] of pages.sort(([a], [b]) => byCodeUnit(a, b))) files.set(file, content);
  return { files, warnings: [] };
}
