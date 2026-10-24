import { BufferSource, BufferTarget, Conversion, CustomSource, EncodedAudioPacketSource, EncodedVideoPacketSource, EncodedPacketSink, Input, MP4, Mp4OutputFormat, Output, QTFF } from 'mediabunny';
import { MemoryError, type Timeline, type TimeRange } from './service.js';
import { isMatroska, inspectMatroskaVideo, sliceMatroskaVideo } from './matroska-video.js';
import { videoSoundtrack } from './video-soundtrack.js';
export { checkMatroska } from './matroska-container.js';

/** The caller binds every read to the same authorized, immutable object revision. */
export interface RangeMedia { size: number; read(offset: number, length: number): Promise<Uint8Array> }
export interface VideoTrackRange {
  type: 'video' | 'audio'; codec: string; original: TimeRange; output: TimeRange; packetCount: number; mappingToleranceMs: number;
}
const fail = (code: string, status = 415): never => { throw new MemoryError(code, status); };
function open(mimeType: string, media: RangeMedia): Input {
  const format = mimeType === 'video/mp4' ? MP4 : mimeType === 'video/quicktime' ? QTFF : undefined;
  if (!format) return fail('media_type_unsupported');
  if (!Number.isSafeInteger(media.size) || media.size <= 0) return fail('media_size_invalid');
  return new Input({ formats: [format], source: new CustomSource({
    getSize: () => media.size, maxCacheSize: 1024, prefetchProfile: 'none',
    read: async (start, end) => {
      if (start < 0 || end > media.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return fail('media_range_invalid');
      const bytes = await media.read(start, end - start);
      if (bytes.byteLength !== end - start) return fail('media_range_short');
      return bytes;
    },
  }), formatOptions: { isobmff: { resolveKeyId: () => fail('media_encrypted') } } });
}
/** Identify shared ISO brands by their tracks; full codec validation follows separately. */
export async function classifyIsoMedia(mimeType: string, source: RangeMedia): Promise<string> {
  // The demuxer allocates a complete moov before invoking CustomSource.read.
  // Inspect top-level sizes first; this guard never reads the media payload.
  if (!Number.isSafeInteger(source.size) || source.size <= 0) return fail('media_size_invalid');
  for (let at = 0; at < source.size;) {
    const head = await source.read(at, Math.min(16, source.size - at));
    if (head.length < 8) return fail('media_container_invalid');
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const type = String.fromCharCode(...head.subarray(4, 8));
    let length = view.getUint32(0), header = 8;
    if (length === 1) {
      if (head.length < 16) return fail('media_container_invalid');
      const wide = view.getBigUint64(8); header = 16;
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return fail('media_container_invalid');
      length = Number(wide);
    }
    if (length === 0) length = source.size - at;
    if (length < header || length > source.size - at) return fail('media_container_invalid');
    if (['moov', 'ftyp'].includes(type) && length - header > 8 * 1024 * 1024) return fail('media_inspection_metadata_limit', 413);
    at += length;
  }
  const input = open(mimeType, source);
  try {
    return !await input.getPrimaryVideoTrack() && await input.getPrimaryAudioTrack() ? 'audio/mp4' : mimeType;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    return fail('media_container_invalid');
  } finally { input.dispose(); }
}
async function inspect(input: Input): Promise<Timeline> {
  const tracks = await input.getTracks();
  const videos = tracks.filter(t => t.isVideoTrack()), audios = tracks.filter(t => t.isAudioTrack());
  if (videos.length !== 1 || audios.length > 1 || tracks.length !== videos.length + audios.length) return fail('media_tracks_invalid');
  let durationMs = 0;
  for (const track of tracks) {
    const codec = await track.getCodec();
    if (!(track.isVideoTrack() ? ['avc', 'hevc', 'av1', 'vp9'] : ['aac', 'mp3']).includes(codec ?? '')) return fail('media_codec_unsupported');
    if (await track.isLive() || await track.isRelativeToUnixEpoch() || await track.getFirstTimestamp() !== 0) return fail('media_timeline_origin');
    // ISO BMFF resolves these through the sample index, not a full packet walk.
    const end = await track.computeDuration();
    if (!Number.isFinite(end) || end <= 0) return fail('media_duration_invalid');
    // Read the first sample to exercise encryption rejection even for inspection-only calls.
    if (!await new EncodedPacketSink(track).getFirstPacket()) return fail('media_packets_invalid');
    durationMs = Math.max(durationMs, Math.ceil(end * 1000));
  }
  return { durationMs, hasVideo: true, hasAudio: audios.length === 1 };
}
function range(value: TimeRange, durationMs: number): TimeRange {
  if (!value || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)
    || value.startMs < 0 || value.endMs <= value.startMs || value.endMs > durationMs) return fail('media_time_range_invalid', 400);
  return { startMs: value.startMs, endMs: value.endMs };
}
export function nextFixedRange(cursorMs: number, durationMs: number, seconds: number): TimeRange | undefined {
  if (![cursorMs, durationMs, seconds].every(Number.isFinite) || cursorMs < 0 || durationMs <= 0 || cursorMs > durationMs || seconds <= 0) return fail('media_segment_plan_invalid', 400);
  if (cursorMs === durationMs) return undefined;
  const endMs = Math.min(durationMs, cursorMs + seconds * 1000);
  if (endMs <= cursorMs) return fail('media_segment_plan_invalid', 400);
  return { startMs: cursorMs, endMs };
}
/** Validate model-proposed boundaries only; this function performs no scene/semantic recognition. */
export function validateDynamicRanges(values: TimeRange[], durationMs: number): TimeRange[] {
  if (!Array.isArray(values) || !values.length || !Number.isFinite(durationMs) || durationMs <= 0) return fail('media_segment_plan_invalid', 400);
  let cursor = 0;
  const result = values.map(value => {
    const checked = range(value, durationMs);
    if (checked.startMs !== cursor) return fail('media_segment_plan_gap_or_overlap', 400);
    cursor = checked.endMs; return checked;
  });
  if (cursor !== durationMs) return fail('media_segment_plan_incomplete', 400);
  return result;
}
export async function inspectLongVideo(mimeType: string, source: RangeMedia): Promise<Timeline> {
  if (isMatroska(mimeType)) return inspectMatroskaVideo(mimeType, source);
  const input = open(mimeType, source);
  try { return await inspect(input); }
  catch (error) { if (error instanceof MemoryError) throw error; return fail('media_container_invalid'); }
  finally { input.dispose(); }
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
export async function sliceVideo(mimeType: string, source: RangeMedia, requested: TimeRange, maxBytes = 8 * 1024 * 1024): Promise<{
  bytes: Uint8Array; mimeType: string; logical: TimeRange; actual: TimeRange; offsetMs: number; tracks: VideoTrackRange[]; timeline: Timeline; sourceTimeline: Timeline;
}> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return fail('media_slice_limit_invalid', 400);
  if (isMatroska(mimeType)) return sliceMatroskaVideo(mimeType, source, requested, maxBytes);
  const input = open(mimeType, source);
  let check: Input | undefined;
  try {
    const timeline = await inspect(input), logical = range(requested, timeline.durationMs);
    const originals = await input.getTracks(), video = originals.find(t => t.isVideoTrack())!;
    const videoStart = await new EncodedPacketSink(video).getKeyPacket(logical.startMs / 1000, { verifyKeyPackets: true })
      ?? await new EncodedPacketSink(video).getFirstKeyPacket({ verifyKeyPackets: true });
    if (!videoStart) return fail('media_packets_invalid');
    const target = new BufferTarget();
    // onwrite is public in 1.62.1; EventEmitter listeners swallow exceptions.
    target.onwrite = (_start, end) => { if (end > maxBytes) fail('media_slice_too_large', 413); };
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const conversion = await Conversion.init({ input, output, trim: { start: logical.startMs / 1000, end: logical.endMs / 1000 },
      copy: { mode: 'forced', boundaryPolicy: 'expand', shiftTolerance: Infinity } });
    if (!conversion.isValid || conversion.discardedTracks.length || conversion.utilizedTracks.length !== originals.length) return fail('media_tracks_not_preserved');
    await conversion.execute();
    if (!target.buffer || target.buffer.byteLength > maxBytes) return fail('media_slice_too_large', 413);
    let bytes = new Uint8Array(target.buffer);
    check = new Input({ formats: [MP4], source: new BufferSource(bytes) });
    const outputs = await check.getTracks();
    if (outputs.length !== originals.length) return fail('media_tracks_not_preserved');
    const outputVideo = outputs.find(t => t.isVideoTrack());
    if (!outputVideo) return fail('media_tracks_not_preserved');
    const first = await new EncodedPacketSink(outputVideo).getFirstPacket();
    if (!first || !sameBytes(first.data, videoStart.data)) return fail('media_time_mapping_invalid');
    // Derive the common mapping from preserved packet evidence, never private Conversion state.
    let offsetMs = (videoStart.timestamp - first.timestamp) * 1000;
    const tracks: VideoTrackRange[] = [];
    const selected = new Map<typeof outputs[number], import('mediabunny').EncodedPacket[]>();
    for (const out of outputs) {
      const original = originals.find(t => t.isVideoTrack() === out.isVideoTrack());
      const codec = await out.getCodec();
      if (!original || codec !== await original.getCodec()) return fail('media_tracks_not_preserved');
      const sink = new EncodedPacketSink(original);
      let startMs = Infinity, endMs = -Infinity, packetCount = 0;
      const packets: import('mediabunny').EncodedPacket[] = [];
      for await (const packet of new EncodedPacketSink(out).packets()) {
        const timestamp = packet.timestamp + offsetMs / 1000;
        // Muxed track times are quantized to its timescale. Looking up just BELOW
        // the original timestamp can return the previous packet (or null at zero).
        // Seek across the bounded quantization neighborhood, then prove identity
        // with encoded bytes and duration; never accept timing proximity alone.
        const epsilon = 2 / await original.getTimeResolution() + 2 / await out.getTimeResolution();
        let evidence = await sink.getPacket(Math.max(0, timestamp - epsilon));
        if (!evidence) evidence = await sink.getFirstPacket();
        for (let attempt = 0; evidence && attempt < 8; attempt++) {
          if (Math.abs(evidence.timestamp - timestamp) <= epsilon && sameBytes(evidence.data, packet.data)) break;
          evidence = await sink.getNextPacket(evidence);
        }
        if (!evidence || !Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration <= 0 || !packet.data.length
          || Math.abs(evidence.timestamp - timestamp) > epsilon || Math.abs(evidence.duration - packet.duration) > epsilon
          || !sameBytes(evidence.data, packet.data)) return fail('media_time_mapping_invalid');
        packets.push(evidence);
        startMs = Math.min(startMs, evidence.timestamp * 1000); endMs = Math.max(endMs, (evidence.timestamp + evidence.duration) * 1000); packetCount++;
      }
      if (!packetCount) return fail('media_tracks_not_preserved');
      selected.set(out, packets);
      tracks.push({ type: out.isVideoTrack() ? 'video' : 'audio', codec: codec!, packetCount, mappingToleranceMs: 2000 / await original.getTimeResolution() + 2000 / await out.getTimeResolution(),
        output: { startMs: startMs - offsetMs, endMs: endMs - offsetMs }, original: { startMs, endMs } });
    }
    const actual = { startMs: Math.min(...tracks.map(t => t.original.startMs)), endMs: Math.max(...tracks.map(t => t.original.endMs)) };
    // Rebase every selected track by ONE common packet origin. In MP4, Conversion's
    // trim intentionally retains negative preroll; shiftTolerance cannot change that.
    const originMs = actual.startMs;
    offsetMs = originMs;
    const normalizedTarget = new BufferTarget();
    normalizedTarget.onwrite = (_start, end) => { if (end > maxBytes) fail('media_slice_too_large', 413); };
    const normalized = new Output({ format: new Mp4OutputFormat(), target: normalizedTarget });
    const pumps: (() => Promise<void>)[] = [];
    for (const track of outputs) {
      if (track.isVideoTrack()) {
        const codec = await track.getCodec(), decoderConfig = await track.getDecoderConfig();
        if (!codec || !decoderConfig) return fail('media_decoder_config_invalid');
        const encoded = new EncodedVideoPacketSource(codec);
        normalized.addVideoTrack(encoded, { decoderConfig, transformationMatrix: await track.getTransformationMatrix() });
        pumps.push(async () => {
          for (const packet of selected.get(track)!) {
            await encoded.add(packet.clone({ timestamp: packet.timestamp - originMs / 1000 }), { decoderConfig });
          }
          encoded.close();
        });
      } else if (track.isAudioTrack()) {
        const codec = await track.getCodec(), decoderConfig = await track.getDecoderConfig();
        if (!codec || !decoderConfig) return fail('media_decoder_config_invalid');
        const encoded = new EncodedAudioPacketSource(codec);
        normalized.addAudioTrack(encoded, { decoderConfig });
        pumps.push(async () => {
          for (const packet of selected.get(track)!) {
            await encoded.add(packet.clone({ timestamp: packet.timestamp - originMs / 1000 }), { decoderConfig });
          }
          encoded.close();
        });
      } else return fail('media_tracks_not_preserved');
    }
    await normalized.start();
    // Tracks run concurrently so muxer backpressure cannot deadlock on an unstarted track.
    await Promise.all(pumps.map(pump => pump()));
    await normalized.finalize();
    if (!normalizedTarget.buffer || normalizedTarget.buffer.byteLength > maxBytes) return fail('media_slice_too_large', 413);
    bytes = new Uint8Array(normalizedTarget.buffer);
    const verify = new Input({ formats: [MP4], source: new BufferSource(bytes) });
    try {
      const normalizedTracks = await verify.getTracks();
      if (normalizedTracks.length !== outputs.length) return fail('media_tracks_not_preserved');
      for (const track of normalizedTracks) {
        const previous = outputs.find(t => t.isVideoTrack() === track.isVideoTrack());
        if (!previous || await track.getCodec() !== await previous.getCodec()) return fail('media_tracks_not_preserved');
        const iterator = selected.get(previous)![Symbol.iterator]();
        const epsilon = 2 / await track.getTimeResolution();
        let count = 0, startMs = Infinity, endMs = -Infinity;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          const prior = await iterator.next();
          if (prior.done || packet.timestamp < 0 || Math.abs(packet.timestamp - (prior.value.timestamp - originMs / 1000)) > epsilon
            || Math.abs(packet.duration - prior.value.duration) > epsilon || !sameBytes(packet.data, prior.value.data)) return fail('media_time_mapping_invalid');
          startMs = Math.min(startMs, packet.timestamp * 1000); endMs = Math.max(endMs, (packet.timestamp + packet.duration) * 1000); count++;
        }
        if (!count || !(await iterator.next()).done) return fail('media_tracks_not_preserved');
        const record = tracks.find(t => t.type === (track.isVideoTrack() ? 'video' : 'audio'))!;
        record.output = { startMs, endMs };
        record.mappingToleranceMs += 2000 / await track.getTimeResolution();
      }
    } finally { verify.dispose(); }
    const outputTimeline = { durationMs: Math.ceil(Math.max(...tracks.map(t => t.output.endMs))), hasVideo: true, hasAudio: timeline.hasAudio };
    if (timeline.hasAudio) {
      try { await videoSoundtrack('video/mp4', bytes); }
      catch (error) { if (error instanceof MemoryError && error.code === 'soundtrack_size_limit') return fail('media_slice_too_large', 413); throw error; }
    }
    return { bytes, mimeType: 'video/mp4', logical, actual, offsetMs, tracks, timeline: outputTimeline, sourceTimeline: timeline };
  } catch (error) { if (error instanceof MemoryError) throw error; return fail('media_container_invalid'); }
  finally { check?.dispose(); input.dispose(); }
}
