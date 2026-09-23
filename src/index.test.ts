import { describe, expect, it } from 'vitest';
import * as mocakit from './index.js';

describe('public API', () => {
  it('exports the runtime surface', () => {
    expect(Object.keys(mocakit).sort()).toEqual(
      [
        'MOCA_STATUS',
        'MemorySessionStore',
        'MocaArgumentError',
        'MocaAuthError',
        'MocaClient',
        'MocaCommandError',
        'MocaError',
        'MocaProtocolError',
        'MocaTransportError',
        'VERSION',
        'defineCommands',
        'defineConfig',
        'formatMocaDate',
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
