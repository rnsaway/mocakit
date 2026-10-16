import { describe, expect, it } from 'vitest';
import { buildZip } from '../../test/helpers/zip-builder.js';
import { listZip, readZipEntry, ZipError } from './zip.js';

const MANIFEST = 'Manifest-Version: 1.0\r\nImplementation-Title: cust-lib\r\n\r\n';
const files: Record<string, string | Uint8Array> = {
  'com/acme/cust/Widgets.class': new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]),
  'META-INF/MANIFEST.MF': MANIFEST,
  'META-INF/maven/com.acme/cust-lib/pom.properties': 'groupId=com.acme\nartifactId=cust-lib\nversion=1.2.3\n',
};
const names = Object.keys(files);

describe('zip reader', () => {
  for (const [label, opts] of [
    ['stored', {}],
    ['deflated', { deflate: true }],
    ['deflated with data descriptors', { deflate: true, dataDescriptor: true }],
  ] as const) {
    it(`lists and reads a ${label} archive`, () => {
      const zip = buildZip(files, opts);
      const entries = listZip(zip);
      expect(entries.map((e) => e.name)).toEqual(names);
      const mf = entries.find((e) => e.name === 'META-INF/MANIFEST.MF')!;
      expect(mf.method).toBe('deflate' in opts ? 8 : 0);
      expect(mf.size).toBe(MANIFEST.length);
      expect(Buffer.from(readZipEntry(zip, mf)).toString('utf8')).toBe(MANIFEST);
      const cls = entries[0]!;
      expect(Array.from(readZipEntry(zip, cls))).toEqual(Array.from(files[names[0]!] as Uint8Array));
    });
  }

  it('reads an empty archive', () => {
    expect(listZip(buildZip({}))).toEqual([]);
  });

  it('rejects random bytes', () => {
    const junk = new Uint8Array(200).map((_, i) => (i * 31 + 7) & 0xff);
    expect(() => listZip(junk)).toThrow(ZipError);
    expect(() => listZip(junk)).toThrow('not a zip file');
    expect(() => listZip(new Uint8Array(3))).toThrow('not a zip file');
  });

  it('rejects encrypted entries', () => {
    const zip = buildZip(files, { encrypted: ['META-INF/MANIFEST.MF'] });
    expect(() => listZip(zip)).toThrow(ZipError);
    expect(() => listZip(zip)).toThrow('encrypted entry');
  });

  it('rejects zip64 archives', () => {
    const zip = buildZip(files, { zip64: true });
    expect(() => listZip(zip)).toThrow(ZipError);
    expect(() => listZip(zip)).toThrow('zip64 not supported');
  });

  it('rejects a corrupted entry', () => {
    const zip = buildZip(files);
    const entry = listZip(zip)[1]!;
    expect(() => readZipEntry(zip, { ...entry, offset: 3 })).toThrow(ZipError);
    expect(() => readZipEntry(zip, { ...entry, method: 99 })).toThrow('unsupported compression method');
  });
});
