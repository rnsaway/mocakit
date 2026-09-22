import { describe, expect, it } from 'vitest';
import { MocaArgumentError } from '../errors.js';
import { buildRequest } from './request.js';

describe('buildRequest', () => {
  it('builds a moca-request with environment and escaped query', () => {
    const xml = buildRequest(`list orders where ordnum = 'A&B' and x < 1`, {
      USR_ID: 'JDOE',
      WH_ID: 'W"1',
    });
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<moca-request autocommit="true">',
        '  <environment>',
        '    <var name="USR_ID" value="JDOE"/>',
        '    <var name="WH_ID" value="W&quot;1"/>',
        '  </environment>',
        `  <query>list orders where ordnum = 'A&amp;B' and x &lt; 1</query>`,
        '</moca-request>',
        '',
      ].join('\n'),
    );
  });

  it('defaults autocommit to true and honours false', () => {
    expect(buildRequest('x')).toContain('autocommit="true"');
    expect(buildRequest('x', {}, false)).toContain('autocommit="false"');
  });

  it('omits undefined, null and empty environment values', () => {
    const xml = buildRequest('x', { A: undefined, B: null, C: '', D: 'd' });
    expect(xml).not.toMatch(/name="[ABC]"/);
    expect(xml).toContain('<var name="D" value="d"/>');
  });

  it('throws MocaArgumentError when the query contains an XML 1.0-forbidden character', () => {
    expect(() => buildRequest('a\u0001b')).toThrow(MocaArgumentError);
  });

  it('throws MocaArgumentError when an environment value contains an XML 1.0-forbidden character', () => {
    expect(() => buildRequest('x', { A: 'a\u0001b' })).toThrow(MocaArgumentError);
  });
});
