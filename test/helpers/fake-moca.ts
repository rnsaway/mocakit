import { escapeXmlAttribute, escapeXmlText, findChild, findChildren, parseXml } from '../../src/protocol/xml.js';
import type { Transport } from '../../src/transport/http.js';

export interface FakeRequest {
  url: string;
  query: string;
  env: Record<string, string>;
  autocommit: boolean;
}

export interface FakeResultSet {
  columns?: Array<{ name: string; type?: string }>;
  rows?: Array<Array<string | null>>;
}

export function mocaXml(status: number, result: FakeResultSet = {}, message?: string): string {
  const columns = (result.columns ?? [])
    .map((c) => `<column name="${escapeXmlAttribute(c.name)}"${c.type ? ` type="${c.type}"` : ''}/>`)
    .join('');
  const rows = (result.rows ?? [])
    .map((row) => `<row>${row.map((v) => (v === null ? '<field null="true"/>' : `<field>${escapeXmlText(v)}</field>`)).join('')}</row>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?><moca-response><status>${status}</status>` +
    (message ? `<message>${escapeXmlText(message)}</message>` : '') +
    `<moca-results><metadata>${columns}</metadata><data>${rows}</data></moca-results></moca-response>`
  );
}

/** A successful `login user` response. `session_key` is column 5 and `locale_id` is column 2, like real MOCA. */
export function loginOk(key = 'KEY1', locale = 'US_ENGLISH'): string {
  return mocaXml(0, {
    columns: [{ name: 'usr_id' }, { name: 'locale_id' }, { name: 'addon_id' }, { name: 'cust_lvl', type: 'I' }, { name: 'session_key' }],
    rows: [['JDOE', locale, 'WM', '0', key]],
  });
}

export function fakeMoca(handler: (request: FakeRequest) => string | Promise<string>) {
  const requests: FakeRequest[] = [];
  const transport: Transport = async ({ url, body }) => {
    const root = findChild(parseXml(body), 'moca-request')!;
    const env: Record<string, string> = {};
    for (const v of findChildren(findChild(root, 'environment')!, 'var')) env[v.attributes.name!] = v.attributes.value ?? '';
    const request: FakeRequest = {
      url,
      query: findChild(root, 'query')?.text ?? '',
      env,
      autocommit: root.attributes.autocommit === 'true',
    };
    requests.push(request);
    return handler(request);
  };
  return { transport, requests };
}

export const baseConfig = {
  url: 'https://moca.test/service',
  username: 'JDOE',
  password: "p'w",
  session: { reuse: false },
} as const;
