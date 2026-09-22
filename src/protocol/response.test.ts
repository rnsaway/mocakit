import { describe, expect, it } from 'vitest';
import { MocaProtocolError } from '../errors.js';
import { parseResponse } from './response.js';

const wrap = (inner: string) => `<?xml version="1.0"?><moca-response>${inner}</moca-response>`;

describe('parseResponse', () => {
  it('parses status, columns, rows, NULLs and duplicate column names', () => {
    const response = parseResponse(
      wrap(
        '<status>0</status><moca-results><metadata>' +
          '<column name="ordnum" type="S" length="20"/><column name="qty" type="I"/><column name="ordnum" type="S"/>' +
          '</metadata><data>' +
          '<row><field>A1</field><field>5</field><field null="true"/></row>' +
          '<row><field></field><field>7</field><field>B</field></row>' +
          '</data></moca-results>',
      ),
    );
    expect(response.status).toBe(0);
    expect(response.message).toBeNull();
    expect(response.columns).toEqual([
      { name: 'ordnum', type: 'S', length: 20 },
      { name: 'qty', type: 'I' },
      { name: 'ordnum', type: 'S' },
    ]);
    expect(response.rows).toEqual([
      { ordnum: 'A1', qty: '5', ordnum_2: null },
      { ordnum: null, qty: '7', ordnum_2: 'B' },
    ]);
  });

  it('returns status and message with no results', () => {
    const response = parseResponse(wrap('<status>510</status><message>No Data Found</message>'));
    expect(response).toEqual({ status: 510, message: 'No Data Found', columns: [], rows: [] });
  });

  it('parses nested result sets', () => {
    const response = parseResponse(
      wrap(
        '<status>0</status><moca-results><metadata><column name="lines" type="R"/></metadata><data><row><field>' +
          '<moca-results><metadata><column name="ln" type="I"/></metadata><data><row><field>1</field></row></data></moca-results>' +
          '</field></row></data></moca-results>',
      ),
    );
    expect(response.rows).toEqual([{ lines: { columns: [{ name: 'ln', type: 'I' }], rows: [{ ln: '1' }] } }]);
  });

  it('falls back to field name attributes and positional names without metadata', () => {
    const response = parseResponse(
      wrap('<status>0</status><moca-results><data><row><field name="x">1</field><field>2</field></row></data></moca-results>'),
    );
    expect(response.rows).toEqual([{ x: '1', field_2: '2' }]);
  });

  it('throws MocaProtocolError when the body is not a moca-response', () => {
    expect(() => parseResponse('<html>Service unavailable</html>')).toThrow(MocaProtocolError);
    try {
      parseResponse('<html>Service unavailable</html>');
    } catch (error) {
      expect((error as MocaProtocolError).rawSnippet).toBe('<html>Service unavailable</html>');
    }
  });

  it('throws MocaProtocolError for a non-integer status', () => {
    expect(() => parseResponse(wrap('<status>abc</status>'))).toThrow(MocaProtocolError);
  });
});
