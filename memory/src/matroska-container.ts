import { MemoryError } from './service.js';
import type { RangeMedia } from './video.js';

const fail = (code = 'media_container_invalid'): never => { throw new MemoryError(code, 415); };
const CLUSTER = 0x1f43b675, SEGMENT = 0x18538067, EBML = 0x1a45dfa3;
const LEVEL_ONE = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, CLUSTER, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367]);
const MASTER = new Set([EBML, 0x1654ae6b, 0xae, 0xe0, 0xe1, CLUSTER, 0xa0, 0x75a1, 0xa6]);
const MAX_CLUSTER = 8 * 1024 * 1024, MAX_METADATA = 1024 * 1024;
interface Element { id: number; data: number; end: number; unknown: boolean }

/** Structural preflight runs before the upstream demuxer can allocate an entire cluster.
 * No payload is decoded and no source-size limit is imposed. Reads are at most 64 KiB.
 */
export async function checkMatroska(source: RangeMedia, expected?: string): Promise<'video/webm' | 'video/x-matroska'> {
  if (!Number.isSafeInteger(source.size) || source.size < 8) return fail();
  let cache: Uint8Array = new Uint8Array(0), cacheAt = -1, docType = '', segments = 0, clusters = 0;
  const read = async (at: number, n: number) => {
    if (at < 0 || n < 0 || at + n > source.size || n > 65536) return fail('media_range_invalid');
    if (at < cacheAt || at + n > cacheAt + cache.length) {
      cacheAt = at; cache = await source.read(at, Math.min(65536, source.size - at));
      if (cache.length !== Math.min(65536, source.size - at)) return fail('media_range_short');
    }
    return cache.subarray(at - cacheAt, at - cacheAt + n);
  };
  const header = async (at: number, parentEnd: number): Promise<Element> => {
    const b = await read(at, Math.min(12, parentEnd - at));
    const vint = (p: number, keep: boolean) => {
      let width = 1, mask = 128;
      while (width <= 8 && !(b[p]! & mask)) { width++; mask >>= 1; }
      if (width > (keep ? 4 : 8) || p + width > b.length) return fail();
      let value = BigInt(keep ? b[p]! : b[p]! & (mask - 1));
      for (let i = 1; i < width; i++) value = value * 256n + BigInt(b[p + i]!);
      const unknown = !keep && value === (1n << BigInt(width * 7)) - 1n;
      if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
      return { width, value: Number(value), unknown };
    };
    const id = vint(0, true), size = vint(id.width, false), data = at + id.width + size.width;
    const end = size.unknown ? parentEnd : data + size.value;
    if (!Number.isSafeInteger(end) || end > parentEnd || end < data) return fail();
    return { id: id.value, data, end, unknown: size.unknown };
  };
  const walk = async (start: number, end: number, parent: number, unknown = false, depth = 0): Promise<number> => {
    if (depth > 8) return fail();
    let at = start;
    while (at < end) {
      const e = await header(at, end), size = e.end - e.data;
      if (parent === CLUSTER && unknown && LEVEL_ONE.has(e.id)) return at;
      if (e.unknown && e.id !== SEGMENT && e.id !== CLUSTER) return fail('media_matroska_unknown_size');
      if (e.id === SEGMENT) {
        if (parent !== 0 || ++segments !== 1) return fail('media_matroska_segments_unsupported');
        at = await walk(e.data, e.end, SEGMENT, e.unknown, depth + 1); continue;
      }
      if (e.id === CLUSTER) {
        if (parent !== SEGMENT || !e.unknown && size > MAX_CLUSTER) return fail('media_matroska_cluster_limit');
        clusters++;
        at = await walk(e.data, e.end, CLUSTER, e.unknown, depth + 1);
        if (at - e.data > MAX_CLUSTER) return fail('media_matroska_cluster_limit');
        continue;
      }
      if (parent === CLUSTER && e.end - start > MAX_CLUSTER) return fail('media_matroska_cluster_limit');
      if (e.id !== 0xec && size > MAX_METADATA) return fail('media_matroska_element_limit');
      if (e.id === 0x4282) {
        if (parent !== EBML || size > 16) return fail();
        docType = new TextDecoder().decode(await read(e.data, size));
      }
      // These require extra presentation intervals or transformations which this adapter cannot preserve yet.
      if ([0x6d80, 0xa4, 0x52f1, 0x537f].includes(e.id)) return fail('media_matroska_transform_unsupported');
      if (e.id === 0x23314f) {
        if (size !== 4 && size !== 8) return fail();
        const b = await read(e.data, size), v = new DataView(b.buffer, b.byteOffset, b.length);
        if ((size === 4 ? v.getFloat32(0) : v.getFloat64(0)) !== 1) return fail('media_matroska_track_scale_unsupported');
      }
      if ([0xa1, 0xa3].includes(e.id)) {
        if (size < 4) return fail();
        const b = await read(e.data, Math.min(size, 12));
        let width = 1, mask = 128; while (width <= 8 && !(b[0]! & mask)) { width++; mask >>= 1; }
        if (width > 8 || width + 3 > b.length) return fail();
        if ((b[width + 2]! >> 1) & 3) return fail('media_matroska_lacing_unsupported');
        if (b[width + 2]! & 0x08) return fail('media_matroska_invisible_frame_unsupported');
      }
      if (MASTER.has(e.id)) await walk(e.data, e.end, e.id, false, depth + 1);
      at = e.end;
    }
    return at;
  };
  const first = await header(0, source.size);
  if (first.id !== EBML || first.unknown || first.end > MAX_METADATA) return fail();
  await walk(0, source.size, 0);
  if (!segments || !clusters || !['webm', 'matroska'].includes(docType)) return fail();
  const mime = docType === 'webm' ? 'video/webm' : 'video/x-matroska';
  if (expected && expected !== mime) return fail('media_type_mismatch');
  return mime;
}
