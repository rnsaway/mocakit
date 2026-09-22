import { MocaArgumentError } from '../errors.js';
import { escapeXmlAttribute, escapeXmlText } from './xml.js';

export type MocaEnvironment = Record<string, string | null | undefined>;

// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN_CHAR =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function assertXmlSafe(value: string, argument: string): void {
  if (XML_FORBIDDEN_CHAR.test(value)) {
    throw new MocaArgumentError(`${argument} contains a character not permitted in XML 1.0`, argument);
  }
}

export function buildRequest(query: string, environment: MocaEnvironment = {}, autocommit = true): string {
  assertXmlSafe(query, 'query');

  const vars = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== null && entry[1] !== '')
    .map(([name, value]) => {
      assertXmlSafe(name, `environment variable name "${name}"`);
      assertXmlSafe(value, `environment variable "${name}"`);
      return `    <var name="${escapeXmlAttribute(name)}" value="${escapeXmlAttribute(value)}"/>`;
    });

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
