// src/codegen/emit-context-docs.ts
// Markdown emitters for agent-context documents. Document titles, headings and paths come from untrusted
// sources, so every piece of source text is escaped before it is placed in the output.
import { escapeText, type Section } from '../context/sections.js';
import { DOC_MARKER, docHref, PRIVATE_NOTICE } from './docs-writer.js';

export interface ContextDocRecord {
  slug: string;
  /** Path relative to `sources/`. */
  source: string;
  sha256: string;
  /** `built-in <ext>`, `converter <command>` or `agent`. */
  method: string;
  size: number;
  status: 'ok' | 'stale';
  title: string;
  sections: Section[];
  /** The source is a PDF converted as text only, so its images were lost. */
  imagesNote: boolean;
}

export const IMAGES_NOTE = 'Images in the source were not converted; list it under context.agent for agent conversion.';
export const CONFIDENTIALITY_LINE = 'Sources may be confidential; keep this folder in a private repository.';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const text = (value: string): string => escapeText(oneLine(value));
const marker = (version: string): string => `${DOC_MARKER} ${version}. Do not edit; regenerate with \`mocakit context\`. -->`;
const sourcePath = (source: string): string => `sources/${text(source)}`;

/** A section file. `index` is the section's zero-based position in `doc.sections`. */
export function emitSectionFile(doc: ContextDocRecord, index: number, version: string): string {
  const section = doc.sections[index];
  if (!section) throw new Error(`section ${index} does not exist in ${doc.slug}`);
  return [
    marker(version),
    PRIVATE_NOTICE,
    `Document: ${text(doc.title)} · Section ${index + 1} of ${doc.sections.length} · Source: ${sourcePath(doc.source)} (sha256 ${doc.sha256.slice(0, 12)}…)`,
    '',
    section.markdown,
    '',
  ].join('\n');
}

export function emitDocReadme(doc: ContextDocRecord, version: string): string {
  const lines = [
    marker(version),
    PRIVATE_NOTICE,
    '',
    `# ${text(doc.title)}`,
    '',
    `- Source: ${sourcePath(doc.source)}`,
    `- sha256: ${doc.sha256}`,
    `- Method: ${text(doc.method)}`,
    `- Size: ${doc.size} bytes`,
  ];
  if (doc.status === 'stale') lines.push('- Status: stale (the source changed; reconvert, see PENDING.md)');
  if (doc.imagesNote) lines.push('', IMAGES_NOTE);
  lines.push('', '## Sections', '');
  doc.sections.forEach((section, i) => {
    const sentence = section.firstSentence === '' ? '' : ` — ${text(section.firstSentence)}`;
    lines.push(`${i + 1}. [${text(section.heading)}](${docHref(section.file)})${sentence}`);
    for (const sub of section.subheadings) lines.push(`   - ${text(sub)}`);
  });
  lines.push('');
  return lines.join('\n');
}

export function emitContextIndex(docs: ContextDocRecord[], pendingCount: number, version: string): string {
  const lines = [marker(version), PRIVATE_NOTICE, CONFIDENTIALITY_LINE, '', '# Context documents', ''];
  for (const doc of [...docs].sort((a, b) => compare(a.slug, b.slug))) {
    lines.push(`## [${text(doc.title)}](docs/${doc.slug}/README.md)`, '');
    lines.push(`Status: ${doc.status} · Source: ${sourcePath(doc.source)}`, '');
    for (const section of doc.sections) {
      const sentence = section.firstSentence === '' ? '' : ` — ${text(section.firstSentence)}`;
      lines.push(`- [${text(section.heading)}](docs/${doc.slug}/${docHref(section.file)})${sentence}`);
    }
    lines.push('');
  }
  if (pendingCount > 0) lines.push(`${pendingCount} documents waiting for agent conversion — see PENDING.md`, '');
  return lines.join('\n');
}

export function emitPending(
  pending: Array<{ slug: string; source: string; sha256: string; reason: string }>,
  version: string,
): string {
  const lines = [
    marker(version),
    PRIVATE_NOTICE,
    '',
    '# Documents waiting for agent conversion',
    '',
    'For each document below, write the Markdown file named under Target. mocakit never writes or deletes files under `agent/`; run `mocakit context` again afterwards.',
    '',
    '- Start the file with the `source-sha256` line shown for the document.',
    '- convert the whole document with real Markdown headings.',
    '- render screenshots of code or screens as code blocks or short descriptions.',
    '- drop repeated headers, footers and the table of contents.',
    '- keep tables as pipe tables.',
    '',
  ];
  for (const item of [...pending].sort((a, b) => compare(a.slug, b.slug))) {
    lines.push(
      `## ${text(item.slug)}`,
      '',
      `- Source: ${sourcePath(item.source)}`,
      `- sha256: ${item.sha256}`,
      `- Target: agent/${item.slug}.md`,
      `- Reason: ${text(item.reason)}`,
      '',
      'First line of the target file:',
      '',
      '```',
      `<!-- source-sha256: ${item.sha256} -->`,
      '```',
      '',
    );
  }
  return lines.join('\n');
}
