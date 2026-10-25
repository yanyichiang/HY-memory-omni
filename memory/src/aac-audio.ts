import { ADTS, MP4, CustomSource, EncodedPacketSink, Input } from 'mediabunny';
import { MemoryError, type Timeline, type TimeRange } from './service.js';
import type { RangeMedia } from './video.js';
import { encodeFloatWav } from './extended-audio.js';
import type { AacModule } from '../codecs/aac/aac-decoder.mjs';

const fail = (code: string, status = 415): never => { throw new MemoryError(code, status); };
async function read(source: RangeMedia, at: number, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(source.size) || source.size <= 0 || !Number.isSafeInteger(at)
    || !Number.isSafeInteger(length) || at < 0 || length < 0 || at + length > source.size) return fail('audio_aac_range_invalid');
  // Mediabunny metadata requests are also bounded before allocating, even for long range-backed uploads.
  if (length > 1024 * 1024) return fail('audio_aac_read_limit', 413);
  const bytes = new Uint8Array(length);
  for (let cursor = 0; cursor < length; cursor += 65536) {
    const count = Math.min(65536, length - cursor), part = await source.read(at + cursor, count);
    if (part.length !== count) return fail('audio_range_short');
    bytes.set(part, cursor);
  }
  return bytes;
}
/** Envelope validation supplements the demuxer: it must not silently ignore later edits,
 * fragmented/encrypted tracks, extra tracks, incomplete final frames or trailing bytes. */
async function container(mime: string, source: RangeMedia) {
  if (mime === 'audio/aac') {
    let at = 0, identity = '';
    while (at < source.size) {
      const h = await read(source, at, 7);
      if (h[0] !== 255 || (h[1]! & 246) !== 240 || (h[6]! & 3) !== 0) return fail('audio_aac_adts_header_invalid');
      const rateIndex = (h[2]! >> 2) & 15, channels = ((h[2]! & 1) << 2) | (h[3]! >> 6);
      const id = `${h[1]! & 8}:${h[2]! >> 6}:${rateIndex}:${channels}`;
      const length = ((h[3]! & 3) << 11) | (h[4]! << 3) | (h[5]! >> 5), header = h[1]! & 1 ? 7 : 9;
      if (rateIndex > 12 || channels < 1 || channels > 2 || length <= header || (identity && identity !== id)) return fail('audio_aac_adts_header_invalid');
      if (at + length > source.size) return fail('audio_aac_frame_incomplete');
      // CRC-protected ADTS is not silently accepted without checking its integrity.
      if (header !== 7) return fail('audio_aac_crc_unsupported');
      identity = id; at += length;
    }
    if (!at) return fail('audio_aac_frame_incomplete');
    return undefined;
  }
  if (mime !== 'audio/mp4') return fail('audio_type_unsupported');
  let tracks = 0, moov = 0, mdat = 0, ftyp = 0, edits = 0, descriptions = 0, boxes = 0;
  let movieTimescale = 0, editDuration = 0;
  const scan = async (start: number, end: number, depth: number): Promise<void> => {
    if (depth > 8) return fail('audio_m4a_container_invalid');
    for (let at = start; at < end;) {
      if (++boxes > 250000) return fail('audio_m4a_box_limit', 413);
      const h = await read(source, at, 8), v = new DataView(h.buffer);
      const type = String.fromCharCode(...h.subarray(4));
      let length = v.getUint32(0), header = 8;
      if (length === 1) { const large = new DataView((await read(source, at + 8, 8)).buffer).getBigUint64(0); if (large > BigInt(Number.MAX_SAFE_INTEGER)) return fail('audio_m4a_container_invalid'); length = Number(large); header = 16; }
      if (length === 0) length = end - at;
      if (length < header || at + length > end) return fail('audio_m4a_container_incomplete');
      const payload = at + header, finish = at + length;
      if (['moof', 'mvex', 'mfra', 'sinf', 'senc', 'enca', 'pssh'].includes(type)) return fail('audio_m4a_feature_unsupported');
      // Mediabunny reads moov as one contiguous slice before invoking CustomSource.read.
      // Bound it here, before its ReadOrchestrator can allocate that buffer.
      if (type === 'moov' && finish - payload > 1024 * 1024) return fail('audio_m4a_metadata_limit', 413);
      if (type === 'stsz') {
        const h = await read(source, payload, 12), x = new DataView(h.buffer), size = x.getUint32(4), count = x.getUint32(8);
        if (!count || size > 65536 || finish - payload !== (size ? 12 : 12 + count * 4)) return fail('audio_aac_packet_invalid');
        if (!size) {
          const sizes = await read(source, payload + 12, count * 4), values = new DataView(sizes.buffer);
          for (let i = 0; i < count; i++) if (!values.getUint32(i * 4) || values.getUint32(i * 4) > 65536) return fail('audio_aac_packet_invalid');
        }
      }
      if (type === 'ftyp') ftyp++;
      if (type === 'mdat') mdat++;
      if (type === 'moov') moov++;
      if (type === 'trak') tracks++;
      if (type === 'mvhd') {
        const e = await read(source, payload, Math.min(32, finish - payload)), x = new DataView(e.buffer);
        if (e.length < 20 || ![0, 1].includes(e[0]!) || (e[0] === 1 && e.length < 32) || movieTimescale) return fail('audio_m4a_clock_invalid');
        movieTimescale = x.getUint32(e[0] === 1 ? 20 : 12);
        if (!movieTimescale) return fail('audio_m4a_clock_invalid');
      }
      if (type === 'elst') {
        if (++edits > 1) return fail('audio_m4a_edit_unsupported');
        const prefix = await read(source, payload, 8), version = prefix[0];
        if (![0, 1].includes(version!) || new DataView(prefix.buffer).getUint32(4) !== 1
          || finish - payload !== (version === 1 ? 28 : 20)) return fail('audio_m4a_edit_unsupported');
        const e = await read(source, payload, finish - payload), x = new DataView(e.buffer);
        const duration = version === 1 ? x.getBigUint64(8) : BigInt(x.getUint32(8));
        if (duration <= 0 || duration > BigInt(Number.MAX_SAFE_INTEGER)) return fail('audio_m4a_edit_unsupported');
        editDuration = Number(duration);
        const mediaTime = version === 1 ? x.getBigInt64(16) : BigInt(x.getInt32(12));
        const rateAt = version === 1 ? 24 : 16;
        if (mediaTime < 0 || mediaTime > BigInt(Number.MAX_SAFE_INTEGER) || x.getInt32(rateAt) !== 65536) return fail('audio_m4a_edit_unsupported');
      }
      if (type === 'stsd') {
        const s = await read(source, payload, Math.min(16, finish - payload)), x = new DataView(s.buffer);
        if (s.length < 16 || x.getUint32(4) !== 1 || String.fromCharCode(...s.subarray(12, 16)) !== 'mp4a') return fail('audio_m4a_codec_unsupported');
        descriptions++;
      }
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'].includes(type)) await scan(payload, finish, depth + 1);
      at = finish;
    }
  };
  await scan(0, source.size, 0);
  if (tracks !== 1 || moov !== 1 || !mdat || ftyp !== 1 || descriptions !== 1 || !movieTimescale) return fail('audio_m4a_tracks_invalid');
  return edits ? { durationSeconds: editDuration / movieTimescale, roundingSeconds: Math.min(1 / movieTimescale, 0.001) } : undefined;
}

async function decoderModule(): Promise<AacModule> {
  const [{ default: factory }, { default: module }] = await Promise.all([
    import('../codecs/aac/aac-decoder.mjs'), import('../codecs/aac/aac-decoder.wasm'),
  ]);
  return factory({ instantiateWasm(imports, receive) {
    const instance = new WebAssembly.Instance(module, imports); receive(instance, module); return instance.exports;
  } });
}
async function decode(mime: string, source: RangeMedia, selection?: TimeRange, maxBytes = Infinity, inline = false) {
  let input: Input | undefined, module: AacModule | undefined, decoder = 0;
  try {
    const presentationDuration = await container(mime, source);
    const format = mime === 'audio/mp4' ? MP4 : ADTS;
    input = new Input({ formats: [format], source: new CustomSource({ getSize: () => source.size,
      maxCacheSize: 65536, prefetchProfile: 'none', read: (a, b) => read(source, a, b - a) }) });
    const tracks = await input.getTracks(), track = await input.getPrimaryAudioTrack();
    if (tracks.length !== 1 || !track || await track.getCodec() !== 'aac' || await track.isLive()
      || await track.isRelativeToUnixEpoch() || await track.getFirstTimestamp() > 0) return fail('audio_aac_tracks_invalid');
    const config = await track.getDecoderConfig();
    if (!config || (mime === 'audio/mp4' && !config.description) || config.numberOfChannels < 1 || config.numberOfChannels > 2) return fail('audio_aac_codec_unsupported');
    module = await decoderModule();
    // ADTS packets retain their transport header; FFmpeg reads the configuration directly from it.
    const asc = config.description ? new Uint8Array(config.description as ArrayBuffer) : new Uint8Array(0);
    const pointer = asc.length ? module._malloc(asc.length) : 0;
    if (asc.length && !pointer) return fail('audio_aac_allocation_failed', 413);
    try { if (asc.length) module.HEAPU8.set(asc, pointer); decoder = module._aac_create(pointer, asc.length); } finally { if (pointer) module._free(pointer); }
    if (!decoder) return fail('audio_aac_decode_invalid');
    let samples = 0, rate = 0, channels = 0, cursor: number | undefined, tailTrim = false, presentationEnd = Infinity, presentationRounding = 0;
    let start = 0, end = Infinity, pcm: Uint8Array | undefined;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      if (!packet.data.length || packet.data.length > 65536 || tailTrim) return fail('audio_aac_packet_invalid');
      const p = module._malloc(packet.data.length);
      if (!p) return fail('audio_aac_allocation_failed', 413);
      let decoded: number;
      try { module.HEAPU8.set(packet.data, p); decoded = module._aac_decode(decoder, p, packet.data.length); } finally { module._free(p); }
      if (decoded <= 0) return fail('audio_aac_decode_invalid');
      // FFmpeg profiles: AAC-LC=1, HE-AAC=4, HE-AACv2=28. Other profiles are outside the tested contract.
      if (![1, 4, 28].includes(module._aac_profile(decoder))) return fail('audio_aac_profile_unsupported');
      const currentRate = module._aac_rate(decoder), currentChannels = module._aac_channels(decoder);
      if (!rate) {
        rate = currentRate; channels = currentChannels;
        if (!Number.isSafeInteger(rate) || rate < 7350 || rate > 96000 || channels < 1 || channels > 2) return fail('audio_aac_format_unsupported');
        if (presentationDuration !== undefined) {
          // The movie clock need not resolve individual audio samples. Keep the
          // last partially covered sample, then clamp to the physical decoded end.
          presentationEnd = Math.ceil(presentationDuration.durationSeconds * rate);
          presentationRounding = Math.ceil(presentationDuration.roundingSeconds * rate);
          if (!Number.isSafeInteger(presentationEnd) || presentationEnd <= 0) return fail('audio_m4a_clock_invalid');
        }
        if (selection) {
          start = Math.floor(selection.startMs * rate / 1000); end = Math.min(presentationEnd, Math.ceil(selection.endMs * rate / 1000));
          if (end <= start) return fail('audio_window_invalid', 400);
          if ((end - start) * channels * 4 + 56 > maxBytes) return fail(inline ? 'media_inline_expansion_exceeded' : 'media_slice_too_large', 413);
          pcm = new Uint8Array((end - start) * channels * 4);
        }
      }
      if (rate !== currentRate || channels !== currentChannels) return fail('audio_aac_format_changed');
      const at = Math.round(packet.timestamp * rate), count = Math.round(packet.duration * rate);
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(count) || count <= 0 || count > decoded
        || Math.abs(packet.timestamp * rate - at) > 0.00001 || Math.abs(packet.duration * rate - count) > 0.00001
        || (cursor !== undefined && cursor !== at)) return fail('audio_aac_packet_timeline_mismatch');
      tailTrim = count < decoded; cursor = at + count;
      const data = module.HEAPF32.subarray(module._aac_output(decoder) / 4, module._aac_output(decoder) / 4 + decoded * channels);
      // Inspect all decoded values, including priming/discarded prefix. Never quantize nonzero values to digital silence.
      if (data.length !== decoded * channels || data.some(v => !Number.isFinite(v))) return fail('audio_aac_samples_invalid');
      if (!selection && Math.max(0, Math.min(cursor, presentationEnd)) * channels * 4 + 56 > maxBytes) return fail(inline ? 'media_inline_expansion_exceeded' : 'media_slice_too_large', 413);
      if (pcm) {
        const view = new DataView(pcm.buffer);
        for (let i = Math.max(0, -at, start - at); i < Math.min(count, end - at, presentationEnd - at); i++) {
          for (let c = 0; c < channels; c++) view.setFloat32(((at + i - start) * channels + c) * 4, data[i * channels + c]!, true);
        }
      }
      samples = Math.max(0, Math.min(cursor, presentationEnd));
    }
    // ISO movie clocks may round the final physical sample up by at most one tick (capped at 1ms).
    if (presentationEnd !== Infinity && presentationEnd - samples > presentationRounding) return fail('audio_aac_presentation_incomplete');
    if (!samples || !rate || (selection && samples < end && end - samples > Math.ceil(rate / 1000))) return fail('audio_aac_selection_incomplete');
    if (selection && samples <= start) return fail('audio_window_invalid', 400);
    end = Math.min(end, samples);
    if (pcm) pcm = pcm.subarray(0, (end - start) * channels * 4);
    return { samples, rate, channels, start, end, pcm };
  } catch (error) { if (error instanceof MemoryError) throw error; return fail('audio_aac_decode_invalid'); }
  finally { try { if (decoder) module!._aac_free(decoder); } finally { input?.dispose(); } }
}
export async function inspectExtendedAudio(mime: string, source: RangeMedia, maxWavBytes?: number): Promise<Timeline> {
  const r = await decode(mime, source, undefined, maxWavBytes ?? Infinity, maxWavBytes !== undefined);
  return { durationMs: Math.ceil(r.samples / r.rate * 1000), hasAudio: true, hasVideo: false };
}
export async function sliceExtendedAudio(mime: string, source: RangeMedia, logical: TimeRange, timeline: Timeline, _options?: { validatedSource?: boolean }) {
  if (!timeline.hasAudio || timeline.hasVideo || !Number.isSafeInteger(timeline.durationMs) || timeline.durationMs <= 0
    || !Number.isFinite(logical.startMs) || !Number.isFinite(logical.endMs) || logical.startMs < 0 || logical.endMs <= logical.startMs
    || logical.endMs > timeline.durationMs) return fail('audio_window_invalid', 400);
  const r = await decode(mime, source, logical, 4 * 1024 * 1024);
  if (Math.ceil(r.samples / r.rate * 1000) !== timeline.durationMs) return fail('audio_aac_timeline_mismatch');
  const actual = { startMs: r.start / r.rate * 1000, endMs: r.end / r.rate * 1000 };
  return { bytes: encodeFloatWav(r.pcm!, r.rate, r.channels), mimeType: 'audio/wav', logical, actual, offsetMs: actual.startMs,
    timeline: { durationMs: Math.ceil((r.end - r.start) / r.rate * 1000), hasAudio: true, hasVideo: false }, sourceTimeline: timeline };
}
export async function normalizeExtendedAudio(mime: string, bytes: Uint8Array, timeline: Timeline): Promise<Uint8Array> {
  const r = await decode(mime, { size: bytes.length, read: async (a, n) => bytes.subarray(a, a + n) },
    { startMs: 0, endMs: timeline.durationMs }, 8 * 1024 * 1024, true);
  if (Math.ceil(r.samples / r.rate * 1000) !== timeline.durationMs) return fail('audio_aac_timeline_mismatch');
  return encodeFloatWav(r.pcm!, r.rate, r.channels);
}
