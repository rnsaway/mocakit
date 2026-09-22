import { describe, expect, it } from 'vitest';
import { redactUrl } from './url.js';

describe('redactUrl', () => {
  it('strips credentials, query and hash', () => {
    expect(redactUrl('https://u:p@moca.example.com:4700/service?token=x')).toBe(
      'https://moca.example.com:4700/service',
    );
  });

  it('returns unparseable input unchanged', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
