import { describe, expect, it } from 'vitest';
import * as mocakit from './index.js';

describe('public API', () => {
  it('exports the runtime surface', () => {
    expect(Object.keys(mocakit).sort()).toEqual(
      [
        'ApiClient',
        'MOCA_STATUS',
        'MemorySessionStore',
        'MocaApiError',
        'MocaArgumentError',
        'MocaAuthError',
        'MocaClient',
        'MocaCommandError',
        'MocaError',
        'MocaProtocolError',
        'MocaTransportError',
        'VERSION',
        'defineApi',
        'defineCommands',
        'defineConfig',
        'formatMocaDate',
        'httpRestTransport',
        'httpTransport',
        'isMocaStatus',
        'parseMocaDate',
        'sharedSessionStore',
      ].sort(),
    );
  });

  it('defineConfig is the identity function', () => {
    const config = { out: 'x.ts' };
    expect(mocakit.defineConfig(config)).toBe(config);
  });
});
