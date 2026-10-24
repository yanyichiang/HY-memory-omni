import { CustomSource, EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input, MATROSKA, WEBM, BufferTarget, MovOutputFormat, Output, type InputTrack } from 'mediabunny';
import { MemoryError, type Timeline, type TimeRange } from './service.js';
import { checkMatroska } from './matroska-container.js';
import { decodeOpusWindow } from './opus-pcm.js';
import { acquireAudio } from './audio.js';
import { createAacFrameDecoder } from './aac-pcm.js';
import type { RangeMedia, VideoTrackRange } from './video.js';

const fail = (code: string): never => { throw new MemoryError(code, 415); };
export const isMatroska = (mime: string) => mime === 'video/webm' || mime === 'video/x-matroska';
interface Timing { codecDelayNs: number; seekPreRollNs: number; discardPaddingNs: number; trackNumber: number; timestampScaleNs: number }
interface Sample { packet: EncodedPacket; start: number; end: number; samples?: number }
interface TrackInfo { track: InputTrack; codec: string; start: number; end: number; packets: Sample[]; count: number; resolution: number; pcm?: { bytes: Uint8Array; rate: number; channels: number; start: number; end: number } }
const ticks = (seconds: number, scale: number) => {
  const value = Math.round(seconds * scale);
  if (!Number.isSafeInteger(value) || Math.abs(value / scale - seconds) > 1e-9) return fail('media_time_mapping_invalid');
  return value;
};
const timing = (p: EncodedPacket): Timing => {
  const m = (p.sideData as unknown as { matroska?: Timing }).matroska;
  if (!m || Object.values(m).some(v => !Number.isSafeInteger(v)) || m.codecDelayNs < 0 || m.seekPreRollNs < 0 || m.timestampScaleNs <= 0) return fail('media_matroska_timing_missing');
  return m;
};
/** RFC 6716 section 3.1: decoded samples at the fixed Opus 48 kHz clock. */
function opusSamples(bytes: Uint8Array): number {
  if (!bytes.length) return fail('media_packets_invalid');
  const toc = bytes[0]!, config = toc >> 3;
  const frame = config >= 16 ? 120 * 2 ** (config & 3) : config >= 12 ? 480 * 2 ** (config & 1) : [480, 960, 1920, 2880][config & 3]!;
  const count = (toc & 3) === 0 ? 1 : (toc & 3) === 3 ? (bytes[1] ?? 0) & 63 : 2;
  if (!count || frame * count > 5760) return fail('media_opus_packet_invalid');
  return frame * count;
}
function sourceFor(source: RangeMedia) {
  return new CustomSource({ getSize: () => source.size, maxCacheSize: 65536, prefetchProfile: 'none', read: async (a, b) => {
    if (a < 0 || b > source.size || b - a > 8 * 1024 * 1024) return fail('media_matroska_element_limit');
    const out = new Uint8Array(b - a);
    for (let at = a; at < b; at += 65536) {
      const n = Math.min(65536, b - at), part = await source.read(at, n);
      if (part.length !== n) return fail('media_range_short'); out.set(part, at - a);
    }
    return out;
  } });
}
async function opened(mime: string, source: RangeMedia) {
  await checkMatroska(source, mime);
  return new Input({ formats: [mime === 'video/webm' ? WEBM : MATROSKA], source: sourceFor(source) });
}
async function scan(input: Input, selection?: TimeRange, maxBytes = 8 * 1024 * 1024) {
  const tracks = await input.getTracks(), videos = tracks.filter(t => t.isVideoTrack()), audios = tracks.filter(t => t.isAudioTrack());
  if (videos.length !== 1 || audios.length > 1 || tracks.length !== videos.length + audios.length) return fail('media_tracks_invalid');
  const infos: TrackInfo[] = [];
  let bytes = 0, videoStart = 0, videoEnd = selection ? selection.endMs / 1000 : 0;
  // Video first establishes a decodable, shared presentation origin for every track.
  for (const track of [...videos, ...audios]) {
    const codec = await track.getCodec(), resolution = await track.getTimeResolution();
    if (!(track.isVideoTrack() ? ['avc', 'hevc', 'vp9', 'av1'] : ['opus', 'aac', 'mp3']).includes(codec ?? '')) return fail('media_codec_unsupported');
    if (await track.isLive() || await track.isRelativeToUnixEpoch()) return fail('media_timeline_origin');
    const sink = new EncodedPacketSink(track), selected: Sample[] = [];
    let packet = await sink.getFirstPacket(), count = 0, begin = Infinity, end = -Infinity, clock = 0, decodedCount = 0, rate = 48000, previousEnd = -Infinity, padded = false;
    if (!packet) return fail('media_packets_invalid');
    const firstTiming = timing(packet), delay = firstTiming.codecDelayNs / 1e9;
    let preSkip = 0, aac: Awaited<ReturnType<typeof createAacFrameDecoder>> | undefined;
    const pcmChunks: Uint8Array[] = []; let pcmStart = Infinity, pcmEnd = 0, pcmChannels = 0;
    if (codec === 'opus' && track.isAudioTrack()) {
      const c = await track.getDecoderConfig(), raw = c?.description;
      const h = raw ? ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw) : undefined;
      if (!h || h.length !== 19 || h[8]! > 15 || ![1, 2].includes(h[9]!) || h[18] !== 0) return fail('audio_opus_mapping_unsupported');
      preSkip = new DataView(h.buffer, h.byteOffset, h.length).getUint16(10, true);
      if (Math.abs(preSkip / 48000 - delay) > 1e-9) return fail('media_opus_delay_mismatch');
      if (packet.timestamp !== 0) return fail('media_timeline_origin');
      clock = packet.timestamp - delay;
    } else if (codec === 'aac' && track.isAudioTrack()) {
      const config = await track.getDecoderConfig(), raw = config?.description;
      if (!raw || packet.timestamp !== 0) return fail('media_decoder_config_invalid');
      aac = await createAacFrameDecoder(ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw));
    } else if (delay !== 0 || firstTiming.seekPreRollNs !== 0) return fail('media_matroska_delay_unsupported');
    let pendingKey: Sample[] = [];
    try { while (packet) {
      const next = await sink.getNextPacket(packet), m = timing(packet);
      if (m.codecDelayNs !== firstTiming.codecDelayNs || m.seekPreRollNs !== firstTiming.seekPreRollNs || m.trackNumber !== track.id || padded || m.discardPaddingNs < 0) return fail('media_matroska_padding_unsupported');
      if (!packet.data.length || !Number.isFinite(packet.timestamp) || packet.timestamp < 0) return fail('media_packets_invalid');
      const decoded = aac?.decode(packet.data);
      if (decoded) {
        rate = decoded.rate; pcmChannels = decoded.channels;
        if (count === 0) {
          if (Math.abs(delay * rate - Math.round(delay * rate)) > 0.0001) return fail('media_aac_delay_mismatch');
          clock = packet.timestamp - Math.round(delay * rate) / rate;
        }
      }
      const samples = decoded?.samples ?? (codec === 'opus' ? opusSamples(packet.data) : undefined);
      const start = samples ? clock + decodedCount / rate : packet.timestamp;
      let duration = samples ? samples / rate : packet.duration;
      if (!(duration > 0) && next) duration = next.timestamp - packet.timestamp;
      if (!Number.isFinite(duration) || duration <= 0 || start < previousEnd - m.timestampScaleNs / 1e9 - 1e-9) return fail('media_matroska_discontinuous_timeline');
      if (samples && Math.abs(packet.timestamp - delay - start) > m.timestampScaleNs / 1e9 + 1e-9) return fail('media_matroska_discontinuous_timeline');
      if (samples) decodedCount += samples;
      const padding = m.discardPaddingNs / 1e9;
      if (padding && (!samples || next || padding >= duration || Math.abs(padding * rate - Math.round(padding * rate)) > 0.0001)) return fail('media_matroska_padding_unsupported');
      padded = padding > 0;
      const validStart = Math.max(0, start), validEnd = start + duration - padding;
      if (validEnd <= validStart && (start >= 0 || !next)) return fail('media_packets_invalid');
      begin = Math.min(begin, validStart); end = Math.max(end, validEnd); count++;
      previousEnd = start + duration;
      const sample = { packet, start, end: start + duration, ...(samples ? { samples } : {}) };
      if (selection) {
        if (track.isVideoTrack()) {
          if (packet.type === 'key' && start <= selection.startMs / 1000) { bytes -= pendingKey.reduce((n, s) => n + s.packet.data.length, 0); pendingKey = []; videoStart = start; }
          if (start < selection.endMs / 1000) { pendingKey.push(sample); bytes += packet.data.length; }
        } else if (decoded) {
          const fromSample = Math.max(0, Math.ceil((videoStart - start) * rate - 1e-6));
          const toSample = Math.min(samples!, Math.floor((Math.min(videoEnd, validEnd) - start) * rate + 1e-6));
          if (toSample > fromSample) {
            const size = (toSample - fromSample) * decoded.channels * 4;
            if (bytes + size > maxBytes) throw new MemoryError('media_slice_too_large', 413);
            const chunk = new Uint8Array(size), view = new DataView(chunk.buffer);
            for (let i = fromSample * decoded.channels; i < toSample * decoded.channels; i++) view.setFloat32((i - fromSample * decoded.channels) * 4, decoded.data[i]!, true);
            pcmChunks.push(chunk); bytes += size; pcmStart = Math.min(pcmStart, start + fromSample / rate); pcmEnd = start + toSample / rate; selected.push(sample);
          }
        } else if ((videoStart === 0 || start + duration > Math.max(0, videoStart - (codec === 'opus' ? Math.max(0.08, firstTiming.seekPreRollNs / 1e9) : 0))) && start < videoEnd) {
          selected.push(sample); bytes += packet.data.length;
        }
        if (bytes > maxBytes) throw new MemoryError('media_slice_too_large', 413);
      }
      packet = next;
    } } finally { aac?.free(); }
    if (!count || !Number.isFinite(end) || end <= 0) return fail('media_timeline_origin');
    if (selection && track.isVideoTrack()) {
      if (!pendingKey.length || pendingKey[0]!.packet.type !== 'key') return fail('media_packets_invalid');
      selected.push(...pendingKey);
      videoEnd = Math.max(selection.endMs / 1000, pendingKey.at(-1)!.end);
    }
    let pcm: TrackInfo['pcm'];
    if (pcmChunks.length) {
      const data = new Uint8Array(pcmChunks.reduce((n, p) => n + p.length, 0)); let at = 0;
      for (const part of pcmChunks) { data.set(part, at); at += part.length; }
      pcm = { bytes: data, rate, channels: pcmChannels, start: pcmStart, end: pcmEnd };
    }
    infos.push({ track, codec: codec!, start: begin, end, packets: selected, count, resolution, ...(pcm ? { pcm } : {}) });
  }
  if (Math.min(...infos.map(t => t.start)) !== 0) return fail('media_timeline_origin');
  const timeline = { durationMs: Math.ceil(Math.max(...infos.map(t => t.end)) * 1000), hasAudio: audios.length === 1, hasVideo: true };
  return { infos, timeline };
}
export async function inspectMatroskaVideo(mime: string, source: RangeMedia): Promise<Timeline> {
  const input = await opened(mime, source);
  let release: (() => void) | undefined;
  try { release = await acquireAudio(); return (await scan(input)).timeline; }
  catch (error) { if (error instanceof MemoryError) throw error; return fail('media_container_invalid'); }
  finally { input.dispose(); release?.(); }
}
export async function sliceMatroskaVideo(mime: string, source: RangeMedia, logical: TimeRange, maxBytes = 8 * 1024 * 1024) {
  if (!logical || !Number.isFinite(logical.startMs) || !Number.isFinite(logical.endMs) || logical.startMs < 0 || logical.endMs <= logical.startMs) throw new MemoryError('media_time_range_invalid', 400);
  const input = await opened(mime, source);
  let release: (() => void) | undefined;
  try {
    release = await acquireAudio();
    const { infos, timeline: sourceTimeline } = await scan(input, logical, maxBytes);
    if (logical.endMs > sourceTimeline.durationMs) throw new MemoryError('media_time_range_invalid', 400);
    const video = infos[0]!;
    const origin = logical.startMs === 0 ? 0 : Math.min(video.packets[0]!.start, ...infos.slice(1).filter(i => !['opus', 'aac'].includes(i.codec)).map(i => i.packets[0]!.start));
    const videoEnd = Math.max(logical.endMs / 1000, video.packets.at(-1)!.end);
    const target = new BufferTarget(); target.onwrite = (_a, b) => { if (b > maxBytes) throw new MemoryError('media_slice_too_large', 413); };
    const output = new Output({ format: new MovOutputFormat({ fastStart: false }), target });
    const pumps: (() => Promise<void>)[] = [], tracks: VideoTrackRange[] = [];
    for (const info of infos) {
      if (!info.packets.length) return fail('media_tracks_not_preserved');
      const { track, codec, packets } = info, first = packets[0]!, last = packets.at(-1)!;
      let start = Math.max(0, first.start), end = Math.min(info.end, last.end);
      if (track.isVideoTrack()) {
        const config = await track.getDecoderConfig(); if (!config) return fail('media_decoder_config_invalid');
        const encoded = new EncodedVideoPacketSource(codec as 'avc' | 'hevc' | 'vp9' | 'av1');
        output.addVideoTrack(encoded, { decoderConfig: config, transformationMatrix: await track.getTransformationMatrix() });
        pumps.push(async () => { for (const s of packets) await encoded.add(s.packet.clone({ timestamp: s.start - origin, duration: s.end - s.start }), { decoderConfig: config }); encoded.close(); });
      } else if (track.isAudioTrack()) {
        const config = await track.getDecoderConfig(); if (!config) return fail('media_decoder_config_invalid');
        if (info.pcm) {
          const pcm = info.pcm; start = pcm.start; end = pcm.end;
          const encoded = new EncodedAudioPacketSource('pcm-f32'), pcmConfig = { codec: 'pcm-f32', sampleRate: pcm.rate, numberOfChannels: pcm.channels };
          output.addAudioTrack(encoded, { decoderConfig: pcmConfig });
          pumps.push(async () => { await encoded.add(new EncodedPacket(pcm.bytes, 'key', start - origin, end - start), { decoderConfig: pcmConfig }); encoded.close(); });
        } else if (codec === 'opus') {
          start = Math.max(origin, info.start); end = Math.min(info.end, videoEnd);
          const raw = config.description!;
          const head = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
          const remaining = maxBytes - video.packets.reduce((n, p) => n + p.packet.data.length, 0) - 65536;
          if (remaining <= 0) throw new MemoryError('media_slice_too_large', 413);
          const pcm = await decodeOpusWindow({ head, packets: packets.map(s => ({ data: s.packet.data, startSample: ticks(s.start, 48000), samples: s.samples! })),
            startSample: ticks(start, 48000), endSample: ticks(end, 48000), maxBytes: remaining });
          const encoded = new EncodedAudioPacketSource('pcm-f32');
          const pcmConfig = { codec: 'pcm-f32', sampleRate: pcm.rate, numberOfChannels: pcm.channels };
          output.addAudioTrack(encoded, { decoderConfig: pcmConfig });
          pumps.push(async () => { await encoded.add(new EncodedPacket(pcm.bytes, 'key', start - origin, end - start), { decoderConfig: pcmConfig }); encoded.close(); });
        } else {
          // Compressed AAC/MP3 packets keep their complete boundaries; no implicit decoded trim.
          const encoded = new EncodedAudioPacketSource(codec as 'aac' | 'mp3');
          output.addAudioTrack(encoded, { decoderConfig: config });
          pumps.push(async () => { for (const s of packets) await encoded.add(s.packet.clone({ timestamp: s.start - origin, duration: s.end - s.start }), { decoderConfig: config }); encoded.close(); });
        }
      }
      if (end <= start || start < origin) return fail('media_time_mapping_invalid');
      tracks.push({ type: track.isVideoTrack() ? 'video' : 'audio', codec, packetCount: packets.length, mappingToleranceMs: 1000 / info.resolution + 1000 / 57600,
        original: { startMs: start * 1000, endMs: end * 1000 }, output: { startMs: (start - origin) * 1000, endMs: (end - origin) * 1000 } });
    }
    await output.start(); await Promise.all(pumps.map(p => p())); await output.finalize();
    if (!target.buffer) return fail('media_packets_invalid');
    const bytes = new Uint8Array(target.buffer);
    if (bytes.length > maxBytes) throw new MemoryError('media_slice_too_large', 413);
    const actual = { startMs: origin * 1000, endMs: Math.max(...tracks.map(t => t.original.endMs)) };
    return { bytes, mimeType: 'video/quicktime', logical, actual, offsetMs: actual.startMs, tracks,
      timeline: { durationMs: Math.ceil(actual.endMs - actual.startMs), hasVideo: true, hasAudio: sourceTimeline.hasAudio }, sourceTimeline };
  } catch (error) { if (error instanceof MemoryError) throw error; return fail('media_container_invalid'); }
  finally { input.dispose(); release?.(); }
}
