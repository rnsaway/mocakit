import { escapeXmlAttribute, escapeXmlText } from './xml.js';

export type MocaEnvironment = Record<string, string | null | undefined>;

export function buildRequest(query: string, environment: MocaEnvironment = {}, autocommit = true): string {
  const vars = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== null && entry[1] !== '')
    .map(([name, value]) => `    <var name="${escapeXmlAttribute(name)}" value="${escapeXmlAttribute(value)}"/>`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<moca-request autocommit="${autocommit ? 'true' : 'false'}">`,
    '  <environment>',
    ...vars,
    '  </environment>',
    `  <query>${escapeXmlText(query)}</query>`,
    '</moca-request>',
    '',
  ].join('\n');
}
