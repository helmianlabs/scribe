/**
 * Minimal read-only ZIP reader for history-export uploads (store + deflate
 * entries, optional zip64 extras). No new dependency: Node's zlib covers
 * deflate; the container format is parsed here directly. Anything outside
 * that shape — encrypted entries, other compression methods, multi-disk
 * archives, bad CRCs — is a loud ZipError, never a guess.
 */
import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry { name: string; data: Buffer; }

export interface ReadZipOpts {
  /** Refuse the archive when the summed uncompressed size exceeds this. */
  maxTotalUncompressed: number;
  /** Refuse any single entry larger than this once inflated. */
  maxEntryUncompressed: number;
}

interface CentralEntry {
  name: string; method: number; flags: number; crc: number;
  compressedSize: number; uncompressedSize: number; localOffset: number;
}

/**
 * ZIP64 values live in extra field 0x0001, positionally: an 8-byte value is
 * present for each of (uncompressed size, compressed size, local offset) —
 * in that order — whose 32-bit field holds the 0xffffffff sentinel.
 */
function zip64Values(extra: Buffer, need: { uncompressed: boolean; compressed: boolean; localOffset: boolean }): { uncompressed?: number; compressed?: number; localOffset?: number } {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const end = Math.min(p + 4 + size, extra.length);
      const take = () => { if (q + 8 > end) throw new ZipError("Truncated ZIP64 extra field."); const v = Number(extra.readBigUInt64LE(q)); q += 8; return v; };
      const out: { uncompressed?: number; compressed?: number; localOffset?: number } = {};
      if (need.uncompressed) out.uncompressed = take();
      if (need.compressed) out.compressed = take();
      if (need.localOffset) out.localOffset = take();
      return out;
    }
    p += 4 + size;
  }
  throw new ZipError("Entry uses ZIP64 sizes but has no ZIP64 extra field.");
}

function parseCentralDirectory(buf: Buffer): CentralEntry[] {
  // Locate the End Of Central Directory record (within the trailing comment window).
  const windowStart = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= windowStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("Not a ZIP file (no end-of-central-directory record).");
  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0) throw new ZipError("Multi-disk ZIP archives are not supported.");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // zip64: the locator sits immediately before the EOCD record.
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== EOCD64_LOCATOR_SIG) throw new ZipError("ZIP64 archive without a locator record.");
    const rec = Number(buf.readBigUInt64LE(loc + 8));
    if (buf.readUInt32LE(rec) !== 0x06064b50) throw new ZipError("ZIP64 end record not found where the locator points.");
    count = Number(buf.readBigUInt64LE(rec + 32));
    cdSize = Number(buf.readBigUInt64LE(rec + 40));
    cdOffset = Number(buf.readBigUInt64LE(rec + 48));
  }
  if (cdOffset + cdSize > buf.length) throw new ZipError("Central directory runs past the end of the file (truncated ZIP?).");

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) throw new ZipError("Corrupt central directory.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    let localOffset = buf.readUInt32LE(p + 42);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const z = zip64Values(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        localOffset: localOffset === 0xffffffff,
      });
      if (z.uncompressed !== undefined) uncompressedSize = z.uncompressed;
      if (z.compressed !== undefined) compressedSize = z.compressed;
      if (z.localOffset !== undefined) localOffset = z.localOffset;
    }
    entries.push({ name, method, flags, crc, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZip(buf: Buffer, opts: ReadZipOpts): ZipEntry[] {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError("Not a ZIP file (too small).");
  const central = parseCentralDirectory(buf);
  const out: ZipEntry[] = [];
  let total = 0;
  for (const e of central) {
    if (e.name.endsWith("/")) continue; // directory placeholder
    if (e.flags & 0x1) throw new ZipError(`Entry "${e.name}" is encrypted; encrypted exports are not supported.`);
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`Entry "${e.name}" uses unsupported compression (method ${e.method}).`);
    if (e.uncompressedSize > opts.maxEntryUncompressed) throw new ZipError(`Entry "${e.name}" is too large once unpacked (${e.uncompressedSize} bytes).`);
    total += e.uncompressedSize;
    if (total > opts.maxTotalUncompressed) throw new ZipError("The export unpacks to more than the import limit allows.");
    const lp = e.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== LOCAL_SIG) throw new ZipError(`Entry "${e.name}" has a corrupt local header.`);
    const lNameLen = buf.readUInt16LE(lp + 26);
    const lExtraLen = buf.readUInt16LE(lp + 28);
    const dataStart = lp + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compressedSize);
    if (raw.length < e.compressedSize) throw new ZipError(`Entry "${e.name}" is truncated.`);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else {
      try { data = inflateRawSync(raw, { maxOutputLength: opts.maxEntryUncompressed + 1 }); }
      catch { throw new ZipError(`Entry "${e.name}" could not be inflated (corrupt deflate stream).`); }
    }
    if (data.length !== e.uncompressedSize) throw new ZipError(`Entry "${e.name}" unpacked to ${data.length} bytes, expected ${e.uncompressedSize}.`);
    if (e.crc !== 0 && crc32(data) !== e.crc) throw new ZipError(`Entry "${e.name}" failed its checksum (corrupt ZIP).`);
    out.push({ name: e.name, data });
  }
  return out;
}
