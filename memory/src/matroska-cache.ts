import { EncodedPacket, type InputTrack } from 'mediabunny';
import { MemoryError, type Timeline } from './service.js';
import type { RangeMedia } from './video.js';
import type { AacFrameDecoder } from './aac-pcm.js';

type Cache = NonNullable<RangeMedia['matroskaCache']>;
export interface CachedSample { packet: EncodedPacket; start: number; end: number; samples?: number }
interface Page { start: number; end: number; keyPage: number; count: number; firstKey?: number }
interface CachedTrack {
  codec: string; video: boolean; start: number; end: number; count: number; resolution: number; pages: number;
  config: Record<string, unknown>; matrix?: number[]; preroll?: number;
}
export interface MatroskaIndex { version: 1; timeline: Timeline; tracks: CachedTrack[] }
const invalid = (): never => { throw new MemoryError('media_matroska_cache_invalid', 415); };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function json<T>(cache: Cache, key: string): Promise<T> {
  const bytes = await cache.get(key); if (!bytes) return invalid();
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
const prefix = (track: number, page: number) => `track/${track}/page/${page}`;
async function transform(bytes: Uint8Array, compress: boolean) {
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(bytes as Uint8Array<ArrayBuffer>); controller.close(); } });
  const stream = input.pipeThrough(compress ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function cachedMatroskaIndex(cache: Cache): Promise<MatroskaIndex | undefined> {
  const bytes = await cache.get('index.json');
  if (!bytes) return undefined;
  const index = JSON.parse(new TextDecoder().decode(bytes)) as MatroskaIndex;
  if (index.version !== 1 || !Array.isArray(index.tracks) || index.tracks.length < 1 || index.tracks.length > 2
    || index.tracks.some(track => !Number.isSafeInteger(track.pages) || track.pages < 1)) return invalid();
  return index;
}
/** Inspection writes one bounded packet page at a time; the completion index is written last. */
export class MatroskaCacheWriter {
  readonly tracks: CachedTrack[] = [];
  constructor(readonly cache: Cache) {}
  async track(track: InputTrack, codec: string, resolution: number) {
    const raw = await (track.isVideoTrack() ? track.getDecoderConfig() : track.isAudioTrack() ? track.getDecoderConfig() : undefined); if (!raw) return invalid();
    const config = { ...raw } as Record<string, unknown>;
    if (raw.description) {
      const value = raw.description;
      config.description = Array.from(ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value));
    }
    const id = this.tracks.length;
    const info: CachedTrack = { codec, video: track.isVideoTrack(), start: 0, end: 0, count: 0, resolution, pages: 0, config,
      ...(track.isVideoTrack() ? { matrix: Array.from(await track.getTransformationMatrix()) } : {}) };
    this.tracks.push(info);
    let packets: CachedSample[] = [], size = 0, keyPage = 0, pageKeyPage = 0;
    const flush = async () => {
      if (!packets.length) return;
      const metadata = packets.map(s => {
        const sideData = { ...s.packet.sideData } as Record<string, unknown>;
        if (s.packet.sideData.alpha) sideData.alpha = Array.from(s.packet.sideData.alpha);
        return { start: s.start, end: s.end, samples: s.samples, timestamp: s.packet.timestamp, duration: s.packet.duration,
          type: s.packet.type, sequenceNumber: s.packet.sequenceNumber, size: s.packet.data.length, sideData };
      });
      const header = encode(metadata), bytes = new Uint8Array(4 + header.length + size);
      new DataView(bytes.buffer).setUint32(0, header.length, true); bytes.set(header, 4);
      let at = 4 + header.length; for (const s of packets) { bytes.set(s.packet.data, at); at += s.packet.data.length; }
      const name = prefix(id, info.pages);
      await this.cache.put(name + '.bin', bytes);
      await this.cache.put(name + '.json', encode({ start: packets[0]!.start, end: Math.max(...packets.map(p => p.end)), keyPage: pageKeyPage, count: packets.length, ...(packets.some(s => s.packet.type === 'key') ? { firstKey: packets.find(s => s.packet.type === 'key')!.start } : {}) } satisfies Page));
      info.pages++; packets = []; size = 0;
    };
    return {
      before: async (packet: EncodedPacket, aac?: AacFrameDecoder) => {
        if (packets.length && (packets.length >= 256 || size + packet.data.length > 1024 * 1024)) {
          await flush();
          if (aac) await this.cache.put(prefix(id, info.pages) + '.gz', await transform(aac.checkpoint(), true));
        }
      },
      append: (sample: CachedSample) => {
        if (!info.pages && !packets.length) {
          const timing = (sample.packet.sideData as unknown as { matroska?: { seekPreRollNs: number } }).matroska;
          info.preroll = Math.max(0.08, (timing?.seekPreRollNs ?? 0) / 1e9);
        }
        if (!packets.length) pageKeyPage = keyPage;
        if (sample.packet.type === 'key' && info.video) keyPage = info.pages;
        packets.push(sample); size += sample.packet.data.length;
      },
      finish: async (start: number, end: number, count: number) => { await flush(); Object.assign(info, { start, end, count }); },
    };
  }
  async finish(timeline: Timeline) { await this.cache.put('index.json', encode({ version: 1, timeline, tracks: this.tracks } satisfies MatroskaIndex)); }
}
export class MatroskaCacheReader {
  constructor(readonly cache: Cache, readonly index: MatroskaIndex) {}
  async pageInfo(track: number, page: number) { return json<Page>(this.cache, prefix(track, page) + '.json'); }
  /** Binary search bounded page descriptors, including files without Matroska Cues. */
  async locate(track: number, timestamp: number) {
    let low = 0, high = this.index.tracks[track]!.pages;
    while (low + 1 < high) { const mid = Math.floor((low + high) / 2); if ((await this.pageInfo(track, mid)).start <= timestamp) low = mid; else high = mid; }
    return low;
  }
  async checkpoint(track: number, page: number) {
    if (!page) return undefined;
    const bytes = await this.cache.get(prefix(track, page) + '.gz'); if (!bytes) return invalid();
    return transform(bytes, false);
  }
  async packets(track: number, page: number): Promise<CachedSample[]> {
    const bytes = await this.cache.get(prefix(track, page) + '.bin'); if (!bytes || bytes.length < 4) return invalid();
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    if (size > bytes.length - 4) return invalid();
    const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + size))) as {
      start: number; end: number; samples?: number; timestamp: number; duration: number; type: 'key' | 'delta';
      sequenceNumber: number; size: number; sideData: Record<string, unknown>;
    }[];
    if (!Array.isArray(metadata) || metadata.length > 256) return invalid();
    let at = 4 + size;
    const packets = metadata.map(m => {
      if (!Number.isSafeInteger(m.size) || m.size < 1 || at + m.size > bytes.length) return invalid();
      const data = bytes.slice(at, at + m.size); at += m.size;
      if (Array.isArray(m.sideData.alpha)) m.sideData.alpha = new Uint8Array(m.sideData.alpha);
      const packet = new EncodedPacket(data, m.type, m.timestamp, m.duration, m.sequenceNumber, data.length, m.sideData);
      return { packet, start: m.start, end: m.end, ...(m.samples ? { samples: m.samples } : {}) };
    });
    if (at !== bytes.length) return invalid(); return packets;
  }
  track(index: number): InputTrack {
    const info = this.index.tracks[index]!, config = { ...info.config };
    if (Array.isArray(config.description)) config.description = new Uint8Array(config.description);
    return { isVideoTrack: () => info.video, isAudioTrack: () => !info.video,
      getDecoderConfig: async () => config, getTransformationMatrix: async () => info.matrix } as unknown as InputTrack;
  }
}
