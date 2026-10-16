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

type At = { eocd: number; cd: number };

function patched(zip: Uint8Array, edit: (dv: DataView, at: At) => void): Uint8Array {
  const copy = new Uint8Array(zip);
  const dv = new DataView(copy.buffer);
  const eocd = copy.length - 22;
  edit(dv, { eocd, cd: dv.getUint32(eocd + 16, true) });
  return copy;
}

describe('zip reader hardening', () => {
  const small = { 'a.txt': 'hello hello hello hello' };

  it('caps inflation at the declared size (zip bomb)', () => {
    const zip = buildZip({ 'z.bin': new Uint8Array(2 * 1024 * 1024) }, { deflate: true });
    const bad = patched(zip, (dv, at) => dv.setUint32(at.cd + 24, 1, true));
    const entry = listZip(bad)[0]!;
    expect(entry.size).toBe(1);
    expect(() => readZipEntry(bad, entry)).toThrow(ZipError);
    // aborted during inflation, not after producing the full 2 MiB
    expect(() => readZipEntry(bad, entry)).toThrow('corrupt compressed data');
  });

  it('refuses entries above maxEntrySize', () => {
    const zip = buildZip(small);
    const entry = listZip(zip)[0]!;
    expect(() => readZipEntry(zip, entry, { maxEntrySize: 5 })).toThrow('entry too large');
    expect(readZipEntry(zip, entry, { maxEntrySize: 1000 }).length).toBe(entry.size);
  });

  const cases: [string, boolean, (dv: DataView, at: At) => void, string][] = [
    ['entry data out of range', false, (dv, at) => dv.setUint32(at.cd + 20, 100000, true), 'entry data out of range'],
    ['size mismatch', true, (dv, at) => dv.setUint32(at.cd + 24, 500, true), 'size mismatch'],
    ['corrupt compressed data', true, (dv) => dv.setUint8(30 + 5, 0xff), 'corrupt compressed data'],
    ['corrupt central directory', false, (dv, at) => dv.setUint32(at.cd, 0, true), 'corrupt central directory'],
    ['central directory beyond EOCD', false, (dv, at) => dv.setUint32(at.eocd + 12, 5000, true), 'not a zip file'],
    ['count larger than entries', false, (dv, at) => dv.setUint16(at.eocd + 10, 5, true), 'corrupt central directory'],
    ['zip64 count marker', false, (dv, at) => dv.setUint16(at.eocd + 10, 0xffff, true), 'zip64 not supported'],
    ['zip64 cd offset marker', false, (dv, at) => dv.setUint32(at.eocd + 16, 0xffffffff, true), 'zip64 not supported'],
    ['zip64 entry size marker', false, (dv, at) => dv.setUint32(at.cd + 24, 0xffffffff, true), 'zip64 not supported'],
  ];
  for (const [label, deflate, edit, message] of cases) {
    it(`rejects: ${label}`, () => {
      const bad = patched(buildZip(small, { deflate }), edit);
      const run = () => {
        for (const e of listZip(bad)) readZipEntry(bad, e);
      };
      expect(run).toThrow(ZipError);
      expect(run).toThrow(message);
    });
  }

  it('rejects a truncated archive', () => {
    const zip = buildZip(small);
    expect(() => listZip(zip.subarray(0, zip.length - 10))).toThrow(ZipError);
    expect(() => listZip(zip.subarray(0, 40))).toThrow('not a zip file');
  });
});
