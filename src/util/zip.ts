import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Untrusted archive data: never use it as a file-system path. */
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  encrypted: boolean;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * List the entries of a ZIP archive from its central directory. Sizes come from
 * the central directory, so archives that use data descriptors read correctly.
 * ZIP64 and encrypted archives are rejected.
 */
export function listZip(bytes: Uint8Array): ZipEntry[] {
  const dv = view(bytes);
  if (bytes.length < EOCD_MIN) throw new ZipError('not a zip file');

  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT);
  for (let i = bytes.length - EOCD_MIN; i >= lowest; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip file');

  if (eocd >= 20 && dv.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG) {
    throw new ZipError('zip64 not supported');
  }

  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('zip64 not supported');
  }
  if (cdOffset + cdSize > eocd) throw new ZipError('not a zip file');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CENTRAL_SIG) {
      throw new ZipError('corrupt central directory');
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen > bytes.length) throw new ZipError('corrupt central directory');

    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new ZipError('zip64 not supported');
    }
    const encrypted = (flags & 0x1) !== 0;
    if (encrypted) throw new ZipError('encrypted entry');

    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, size, offset, encrypted });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const DEFAULT_MAX_ENTRY_SIZE = 64 * 1024 * 1024;

/**
 * Read one entry's uncompressed bytes (stored or deflated). Entries whose declared
 * size exceeds maxEntrySize (default 64 MiB) are refused, and inflation is capped
 * at the declared size so a crafted stream cannot expand without limit.
 */
export function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  options?: { maxEntrySize?: number },
): Uint8Array {
  if (entry.encrypted) throw new ZipError('encrypted entry');
  if (entry.size > (options?.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE)) {
    throw new ZipError('entry too large');
  }
  const dv = view(bytes);
  const o = entry.offset;
  if (o + 30 > bytes.length || dv.getUint32(o, true) !== LOCAL_SIG) {
    throw new ZipError('corrupt local header');
  }
  const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError('entry data out of range');
  const data = bytes.subarray(start, end);

  if (entry.method === 0) return data;
  if (entry.method === 8) {
    let out: Uint8Array;
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
    } catch {
      throw new ZipError('corrupt compressed data');
    }
    if (out.length !== entry.size) throw new ZipError('size mismatch');
    return out;
  }
  throw new ZipError(`unsupported compression method ${entry.method}`);
}
