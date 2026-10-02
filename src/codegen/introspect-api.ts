import { MocaTransportError } from '../errors.js';
import { isTransientStatus, withRetry, type RestResponse, type RestTransport } from '../transport/rest.js';
import { apiBaseUrl, redactUrl } from '../util/url.js';
import { assignOperationNames, normalizeSwagger, reachableDefinitions } from './api-normalize.js';
import type { ApiGroup, ApiOperation, ApiSchema, ApiSnapshot } from './api-snapshot.js';
import { byCodeUnit } from './names.js';

export { apiBaseUrl };

const PUBLIC_GROUP = 'Public APIs';
const DELAYS = [500, 1500];

export async function introspectApi(options: {
  url: string;
  ignoreSslIssues: boolean;
  timeoutMs?: number;
  groups: string[];
  version: string;
  transport: RestTransport;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ snapshot: ApiSnapshot; warnings: string[] }> {
  const base = apiBaseUrl(options.url);
  // Only the transport call is retried (transport errors and transient statuses);
  // status and JSON checks run afterwards, outside the retried function.
  const get = (path: string, what: string): Promise<unknown> =>
    withRetry<RestResponse>(
      () =>
        options.transport({
          method: 'GET',
          url: new URL(path.replace(/^\//, ''), base).href,
          headers: { accept: 'application/json' },
          timeoutMs: options.timeoutMs ?? 300_000,
          ignoreSslIssues: options.ignoreSslIssues,
        }),
      {
        delays: DELAYS,
        retryOn: ({ result, error }) =>
          error instanceof MocaTransportError || (result !== undefined && isTransientStatus(result.status)),
        sleep: options.sleep,
      },
    ).then((response) => {
      if (response.status !== 200) throw new Error(`Fetching ${what} failed (HTTP ${response.status})`);
      try {
        return JSON.parse(response.body) as unknown;
      } catch {
        throw new Error(`Fetching ${what} failed (not JSON)`);
      }
    });

  const list = await get('ws/admin/publicApis', 'the API list');
  if (!Array.isArray(list)) throw new Error('Fetching the API list failed (unexpected shape)');
  const entries = list.filter((e): e is { name: string; url: string } => typeof e?.name === 'string' && typeof e?.url === 'string');
  const available = entries.map((e) => e.name);
  for (const name of options.groups) {
    if (!available.includes(name)) throw new Error(`Unknown API group "${name}"; available: ${available.join(', ')}`);
  }

  const warnings: string[] = [];
  const groups: ApiGroup[] = [];
  const unnamed: Omit<ApiOperation, 'name'>[] = [];
  const allDefinitions: Record<string, ApiSchema> = {};
  for (const name of options.groups) {
    const entry = entries.find((e) => e.name === name)!;
    const spec = await get(entry.url, `API spec "${name}"`);
    const normalized = normalizeSwagger({ name, private: name !== PUBLIC_GROUP }, spec);
    groups.push(normalized.group);
    unnamed.push(...normalized.operations);
    warnings.push(...normalized.warnings);
    for (const [defName, schema] of Object.entries(normalized.definitions)) {
      if (defName in allDefinitions && JSON.stringify(allDefinitions[defName]) !== JSON.stringify(schema)) {
        warnings.push(`API definition "${defName}" differs between groups; kept the first`);
        continue;
      }
      allDefinitions[defName] ??= schema;
    }
  }
  const named = assignOperationNames(unnamed);
  warnings.push(...named.warnings);
  const operations = named.operations.sort((a, b) => byCodeUnit(a.tagKey, b.tagKey) || byCodeUnit(a.path, b.path) || byCodeUnit(a.method, b.method));
  return {
    snapshot: {
      mocakitVersion: options.version,
      generatedAt: new Date().toISOString(),
      server: redactUrl(options.url),
      groups,
      operations,
      definitions: reachableDefinitions(operations, allDefinitions),
    },
    warnings,
  };
}
