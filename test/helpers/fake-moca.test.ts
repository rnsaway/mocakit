import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../src/protocol/request.js';
import { parseResponse } from '../../src/protocol/response.js';
import { fakeMoca, loginOk, mocaXml } from './fake-moca.js';

describe('fake-moca helper', () => {
  it('builds parseable responses', () => {
    const response = parseResponse(mocaXml(0, { columns: [{ name: 'a', type: 'I' }], rows: [['1'], [null]] }, 'hi'));
    expect(response).toMatchObject({ status: 0, message: 'hi', rows: [{ a: '1' }, { a: null }] });
    expect(parseResponse(loginOk('K9')).rows[0]).toMatchObject({ session_key: 'K9' });
  });

  it('records query, env and autocommit', async () => {
    const { transport, requests } = fakeMoca(() => mocaXml(0));
    await transport({ url: 'u', body: buildRequest("x where a = 'b'", { USR_ID: 'J' }), timeoutMs: 1, ignoreSslIssues: false });
    expect(requests).toEqual([{ url: 'u', query: "x where a = 'b'", env: { USR_ID: 'J' }, autocommit: true }]);
  });
});
