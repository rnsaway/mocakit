import { deflateRawSync } from 'node:zlib';

export interface BuildZipOptions {
  /** Deflate entries (method 8) instead of storing them (method 0). */
  deflate?: boolean;
  /** Entry names whose general-purpose flag gets the encrypted bit (bit 0). */
  encrypted?: string[];
  /** Append a ZIP64 end-of-central-directory locator and record. */
  zip64?: boolean;
  /** Write sizes in a data descriptor (flag bit 3), zero in the local header. */
  dataDescriptor?: boolean;
}

let crcTable: Uint32Array | undefined;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive in memory. Used to make JAR and DOCX fixtures. */
export function buildZip(
  files: Record<string, string | Uint8Array>,
  options: BuildZipOptions = {},
): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const method = options.deflate ? 8 : 0;
    const data = options.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    let flags = 0;
    if (options.encrypted?.includes(name)) flags |= 0x1;
    if (options.dataDescriptor) flags |= 0x8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(options.dataDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(options.dataDescriptor ? 0 : data.length, 18);
    local.writeUInt32LE(options.dataDescriptor ? 0 : raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    if (options.dataDescriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(data.length, 8);
      dd.writeUInt32LE(raw.length, 12);
      parts.push(dd);
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + data.length + (options.dataDescriptor ? 16 : 0);
  }

  const cdBuf = Buffer.concat(central);
  const count = Object.keys(files).length;
  const tail: Buffer[] = [];
  if (options.zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cdBuf.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  tail.push(eocd);

  return new Uint8Array(Buffer.concat([...parts, cdBuf, ...tail]));
}
