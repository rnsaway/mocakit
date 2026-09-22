import { describe, expect, it } from 'vitest';
import { MocaProtocolError } from '../errors.js';
import { columnKeys, parseResponse, uniqueKeys } from './response.js';

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

  it('throws MocaProtocolError when <status> is missing', () => {
    expect(() => parseResponse(wrap('<message>oops</message>'))).toThrow(MocaProtocolError);
  });

  it('deduplicates colliding names without overwriting a real column', () => {
    const response = parseResponse(
      wrap(
        '<status>0</status><moca-results><metadata>' +
          '<column name="a"/><column name="a_2"/><column name="a"/>' +
          '</metadata><data><row><field>1</field><field>2</field><field>3</field></row></data></moca-results>',
      ),
    );
    expect(response.rows).toEqual([{ a: '1', a_2: '2', a_3: '3' }]);
  });

  it('does not let a positional field_2 fallback collide with a real field_2 column', () => {
    const response = parseResponse(
      wrap(
        '<status>0</status><moca-results><metadata><column name="field_2"/></metadata>' +
          '<data><row><field>real</field><field>extra</field></row></data></moca-results>',
      ),
    );
    expect(response.rows).toEqual([{ field_2: 'real', field_2_2: 'extra' }]);
  });

  it('keeps a __proto__ column as an own enumerable property', () => {
    const response = parseResponse(
      wrap(
        '<status>0</status><moca-results><metadata><column name="__proto__"/></metadata>' +
          '<data><row><field>x</field></row></data></moca-results>',
      ),
    );
    expect(Object.getOwnPropertyDescriptor(response.rows[0], '__proto__')).toEqual({
      value: 'x',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(response.rows[0] as object)).toBe(Object.prototype);
  });

  it('parses a pretty-printed response with whitespace between every element', () => {
    const pretty =
      '<?xml version="1.0"?>\n<moca-response>\n  <status>0</status>\n  <moca-results>\n' +
      '    <metadata>\n      <column name="a" type="S"/>\n    </metadata>\n' +
      '    <data>\n      <row>\n        <field>1</field>\n      </row>\n    </data>\n' +
      '  </moca-results>\n</moca-response>\n';
    const response = parseResponse(pretty);
    expect(response).toEqual({ status: 0, message: null, columns: [{ name: 'a', type: 'S' }], rows: [{ a: '1' }] });
  });

  it('keeps a whitespace-only field as a single space, not NULL', () => {
    const response = parseResponse(
      wrap('<status>0</status><moca-results><data><row><field> </field></row></data></moca-results>'),
    );
    expect(response.rows).toEqual([{ field_1: ' ' }]);
  });

  it('decodes entities and CDATA inside a field', () => {
    const response = parseResponse(
      wrap(
        '<status>0</status><moca-results><data><row><field>A &amp; B</field>' +
          '<field><![CDATA[<raw>&unescaped]]></field></row></data></moca-results>',
      ),
    );
    expect(response.rows).toEqual([{ field_1: 'A & B', field_2: '<raw>&unescaped' }]);
  });
});

describe('uniqueKeys', () => {
  it('suffixes collisions incrementally without overwriting a name already taken', () => {
    expect(uniqueKeys(['a', 'a_2', 'a'])).toEqual(['a', 'a_2', 'a_3']);
  });

  it('does not let an unnamed extra field collide with a real field_2 column', () => {
    expect(uniqueKeys(['field_2', 'field_2'])).toEqual(['field_2', 'field_2_2']);
  });

  it('is a pure function that leaves unrelated names untouched', () => {
    expect(uniqueKeys(['x', 'y', 'z'])).toEqual(['x', 'y', 'z']);
  });

  it('reserves every original name before handing out suffixes, so a real column keeps its own name', () => {
    expect(uniqueKeys(['a', 'a', 'a_2'])).toEqual(['a', 'a_3', 'a_2']);
  });
});

describe('columnKeys', () => {
  it('derives the same names as uniqueKeys over (name || positional fallback)', () => {
    expect(columnKeys([{ name: 'ordnum' }, { name: '' }, { name: 'ordnum' }])).toEqual([
      'ordnum',
      'field_2',
      'ordnum_2',
    ]);
  });

  it('falls back to a positional name for an empty column name', () => {
    expect(columnKeys([{ name: '' }, { name: 'field_1' }])).toEqual(['field_1', 'field_1_2']);
  });
});
