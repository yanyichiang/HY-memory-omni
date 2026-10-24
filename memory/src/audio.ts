import { BufferSource, EncodedPacketSink, Input, MP3, WAVE } from 'mediabunny';
import { MemoryError, type Timeline } from './service.js';

export interface AudioWindow { mimeType: 'audio/wav'; bytes: Uint8Array; startMs: number; endMs: number }
export interface PreparedAudio {
  durationMs: number;
  maxWindowMs: number;
  window(startMs: number, endMs: number): Promise<AudioWindow>;
  dispose(): void;
}

// Per-isolate resource permit only: no decoded media is retained in module state.
let audioInUse = false;
const audioWaiters: (() => void)[] = [];
async function acquireAudio(): Promise<() => void> {
  if (audioInUse) {
    if (audioWaiters.length >= 4) throw new MemoryError('audio_busy', 503);
    await new Promise<void>(resolve => audioWaiters.push(resolve));
  } else audioInUse = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = audioWaiters.shift();
    if (next) next();
    else audioInUse = false;
  };
}

/** PCM samples stay on the original packet timeline. No model-generated timestamps or resampling. */
export async function prepareAudio(mimeType: string, bytes: Uint8Array, timeline: Timeline): Promise<PreparedAudio> {
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) throw new MemoryError('audio_bytes_limit', 413);
  if (!timeline.hasAudio || timeline.hasVideo || !Number.isSafeInteger(timeline.durationMs)
    || timeline.durationMs <= 0 || timeline.durationMs > 180000) throw new MemoryError('audio_timeline_invalid', 415);
  const format = mimeType === 'audio/wav' ? WAVE : mimeType === 'audio/mpeg' ? MP3 : undefined;
  if (!format) throw new MemoryError('audio_type_unsupported', 415);
  const release = await acquireAudio();
  let prepared = false;
  let input: Input | undefined;
  let pcm: Uint8Array | undefined;
  let originalFormat: Uint8Array | undefined;
  let sampleRate = 0, channels = 0, sampleBytes = 0, formatTag = 1, samples = 0;
  try {
    input = new Input({ source: new BufferSource(bytes), formats: [format] });
    const tracks = await input.getTracks();
    if (await input.getFormat() !== format || tracks.length !== 1 || !tracks[0]!.isAudioTrack()) {
      throw new MemoryError('audio_tracks_invalid', 415);
    }
    const track = await input.getPrimaryAudioTrack();
    if (!track || await track.isLive() || await track.isRelativeToUnixEpoch() || await track.getFirstTimestamp() !== 0) {
      throw new MemoryError('audio_timeline_origin', 415);
    }
    sampleRate = await track.getSampleRate(); channels = await track.getNumberOfChannels();
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(channels) || channels <= 0) {
      throw new MemoryError('audio_format_invalid', 415);
    }
    const codec = await track.getCodec();
    const widths: Record<string, number> = { 'pcm-u8': 1, 'pcm-s16': 2, 'pcm-s24': 3, 'pcm-s32': 4, 'pcm-f32': 4 };
    if (format === WAVE) {
      sampleBytes = widths[codec ?? ''] ?? 0;
      formatTag = codec === 'pcm-f32' ? 3 : 1;
      if (!sampleBytes || channels * sampleBytes > 65535 || sampleRate * channels * sampleBytes > 0xffffffff) throw new MemoryError('audio_codec_unsupported', 415);
    } else if (codec !== 'mp3' || sampleRate > 48000 || channels > 2) throw new MemoryError('audio_codec_unsupported', 415);
    if (format === WAVE) {
      // Retain the original fmt chunk, including WAVE_EXTENSIBLE valid bits and channel mask.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let at = 12; at + 8 <= bytes.length;) {
        const length = view.getUint32(at + 4, true);
        if (at + 8 + length > bytes.length) throw new MemoryError('audio_wave_chunk_invalid', 415);
        if (view.getUint32(at, false) === 0x666d7420) { originalFormat = bytes.slice(at + 8, at + 8 + length); break; }
        at += 8 + length + (length & 1);
      }
      if (!originalFormat || originalFormat.length < 16) throw new MemoryError('audio_wave_chunk_invalid', 415);
    }
    const packets: Uint8Array[] = [];
    let packetCount = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      if (++packetCount > 250000 || !Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration)
        || packet.duration <= 0 || !packet.data.byteLength) throw new MemoryError('audio_packets_invalid', 415);
      const start = Math.round(packet.timestamp * sampleRate);
      const count = Math.round(packet.duration * sampleRate);
      if (start !== samples || count <= 0 || Math.abs(packet.timestamp * sampleRate - start) > 0.00001
        || Math.abs(packet.duration * sampleRate - count) > 0.00001) throw new MemoryError('audio_packets_invalid', 415);
      if (format === WAVE) {
        if (packet.data.byteLength !== count * channels * sampleBytes) throw new MemoryError('audio_packets_invalid', 415);
        packets.push(packet.data);
      }
      samples += count;
      if (samples / sampleRate > 180) throw new MemoryError('audio_duration_limit', 413);
    }
    const durationMs = samples / sampleRate * 1000;
    if (!samples || Math.abs(durationMs - timeline.durationMs) > 1) throw new MemoryError('audio_timeline_mismatch', 415);
    if (format === WAVE) {
      pcm = new Uint8Array(samples * channels * sampleBytes);
      let offset = 0;
      for (const packet of packets) { pcm.set(packet, offset); offset += packet.byteLength; }
    } else {
      // Keep importing this file safe in Node: only the actual MP3 path imports the static Wasm module.
      const { decodeMp3 } = await import('./mp3-decoder.js');
      pcm = await decodeMp3(bytes, samples, sampleRate);
      channels = 2; sampleBytes = 2;
    }
    const blockAlign = channels * sampleBytes;
    const fmtLength = originalFormat?.length ?? 16;
    const factLength = formatTag === 3 ? 12 : 0;
    const dataHeader = 20 + fmtLength + (fmtLength & 1) + factLength;
    // Reserve the complete WAV header and a possible odd data pad, not only PCM bytes.
    const maxWindowSamples = Math.floor((4 * 1024 * 1024 - dataHeader - 8 - 1) / blockAlign);
    const maxWindowMs = maxWindowSamples / sampleRate * 1000;
    if (maxWindowMs < 1) throw new MemoryError('audio_format_invalid', 415);
    input.dispose(); input = undefined;
    prepared = true;
    return {
      durationMs, maxWindowMs,
      async window(startMs, endMs) {
        if (!pcm) throw new MemoryError('audio_disposed', 409);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs
          || endMs > durationMs) throw new MemoryError('audio_window_invalid', 400);
        const start = Math.ceil(startMs * sampleRate / 1000);
        const end = endMs === durationMs ? samples : Math.floor(endMs * sampleRate / 1000);
        if (end <= start || end > samples) throw new MemoryError('audio_window_invalid', 400);
        const length = (end - start) * blockAlign;
        // A batch must not accidentally buffer whole long recordings or their base64 representation.
        if (end - start > maxWindowSamples) throw new MemoryError('audio_window_bytes_limit', 413);
        const result = new Uint8Array(dataHeader + 8 + length + (length & 1));
        const view = new DataView(result.buffer);
        const ascii = (offset: number, text: string) => result.set(new TextEncoder().encode(text), offset);
        ascii(0, 'RIFF'); view.setUint32(4, result.length - 8, true); ascii(8, 'WAVEfmt ');
        view.setUint32(16, fmtLength, true);
        if (originalFormat) result.set(originalFormat, 20);
        else {
          view.setUint16(20, formatTag, true); view.setUint16(22, channels, true);
          view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * blockAlign, true);
          view.setUint16(32, blockAlign, true); view.setUint16(34, sampleBytes * 8, true);
        }
        if (factLength) {
          const fact = dataHeader - factLength;
          ascii(fact, 'fact'); view.setUint32(fact + 4, 4, true); view.setUint32(fact + 8, end - start, true);
        }
        ascii(dataHeader, 'data'); view.setUint32(dataHeader + 4, length, true);
        result.set(pcm.subarray(start * blockAlign, end * blockAlign), dataHeader + 8);
        return { mimeType: 'audio/wav', bytes: result, startMs: start / sampleRate * 1000, endMs: end / sampleRate * 1000 };
      },
      dispose() { pcm = undefined; release(); },
    };
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(error instanceof Error && error.message.startsWith('audio_') ? error.message : 'audio_decode_invalid', 415);
  } finally {
    try { input?.dispose(); } finally { if (!prepared) release(); }
  }
}
