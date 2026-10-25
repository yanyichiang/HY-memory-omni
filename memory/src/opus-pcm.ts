import { MemoryError } from './service.js';

export interface OpusWindowPacket {
  data: Uint8Array;
  /** Global 48000 Hz sample coordinate, including negative original priming samples. */
  startSample: number;
  /** Full decoder output duration, before any container padding removal. */
  samples: number;
}
export interface OpusWindowInput {
  head: Uint8Array;
  packets: OpusWindowPacket[];
  startSample: number;
  endSample: number;
  maxBytes: number;
}
const fail = (code: string, status = 415): never => {
  throw new MemoryError(code, status);
};

/** RFC 6716 section 3.1, at the fixed Opus output clock. */
function packetSamples(data: Uint8Array): number {
  if (!data.length) return fail('media_opus_packet_invalid');
  const config = data[0]! >> 3;
  const frame = config >= 16
    ? 120 << (config & 3)
    : config >= 12
      ? 480 << (config & 1)
      : (config & 3) === 3 ? 2880 : 480 << (config & 3);
  const code = data[0]! & 3;
  if (code === 3 && data.length < 2) return fail('media_opus_packet_invalid');
  const count = code === 0 ? 1 : code === 3 ? data[1]! & 63 : 2;
  if (!count || frame * count > 5760) return fail('media_opus_packet_invalid');
  return frame * count;
}

/**
 * Caller holds the shared audio-memory permit, binds packets to the inspected source,
 * and supplies at least 80 ms decoder preroll unless decoding from that source's
 * original first packet. Source-start provenance cannot be inferred from sample zero:
 * a source audio track can itself start later than the common video origin.
 * This helper takes no lock and retains no accumulated decoder output.
 */
export async function decodeOpusWindow(input: OpusWindowInput): Promise<{
  bytes: Uint8Array;
  channels: number;
  rate: 48000;
}> {
  const { head, packets, startSample, endSample, maxBytes } = input;
  if (!(head instanceof Uint8Array) || head.length !== 19
    || String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead'
    || head[8]! > 15 || ![1, 2].includes(head[9]!) || head[18] !== 0) {
    return fail('audio_opus_mapping_unsupported');
  }
  if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample)
    || endSample <= startSample || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || !Array.isArray(packets) || !packets.length) {
    return fail('media_opus_window_invalid');
  }
  const channels = head[9]!;
  const byteLength = (endSample - startSample) * channels * 4;
  if (!Number.isSafeInteger(byteLength) || byteLength > maxBytes) {
    return fail('media_slice_too_large', 413);
  }
  let cursor = packets[0]?.startSample;
  if (cursor === undefined) return fail('media_opus_packet_timeline_invalid');
  if (!Number.isSafeInteger(cursor) || cursor > startSample) {
    return fail('media_opus_window_uncovered');
  }
  // Validate the complete selection before allocating the requested output window.
  for (const packet of packets) {
    if (!packet || !(packet.data instanceof Uint8Array) || !packet.data.length
      || packet.data.length > 65536 || !Number.isSafeInteger(packet.startSample)
      || packet.startSample !== cursor || packet.samples !== packetSamples(packet.data)
      || !Number.isSafeInteger(cursor + packet.samples)) {
      return fail('media_opus_packet_timeline_invalid');
    }
    cursor += packet.samples;
  }
  if (cursor < endSample) return fail('media_opus_window_uncovered');
  const header = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const gain = Math.pow(10, header.getInt16(16, true) / (20 * 256));
  const { default: Decoder } = await import('../.generated/audio-codecs/opus-runtime.js');
  const decoder = new Decoder({ channels, sampleRate: 48000, preSkip: 0 });
  try {
    await decoder.ready;
    const bytes = new Uint8Array(byteLength);
    const output = new DataView(bytes.buffer);
    let copied = 0;
    for (const packet of packets) {
      const decoded = decoder.decodeFrame(packet.data);
      if (decoded.errors.length || decoded.sampleRate !== 48000
        || decoded.samplesDecoded !== packet.samples || decoded.channelData.length !== channels
        || decoded.channelData.some(channel => channel.length !== packet.samples)) {
        return fail('media_opus_decode_invalid');
      }
      const from = Math.max(startSample, packet.startSample);
      const to = Math.min(endSample, packet.startSample + packet.samples);
      for (let frame = 0; frame < packet.samples; frame++) {
        const global = packet.startSample + frame;
        for (let channel = 0; channel < channels; channel++) {
          const value = decoded.channelData[channel]![frame]! * gain;
          if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
            return fail('media_opus_decode_nonfinite');
          }
          if (global >= from && global < to) {
            const offset = ((global - startSample) * channels + channel) * 4;
            output.setFloat32(offset, value, true);
          }
        }
      }
      if (to > from) copied += to - from;
    }
    if (copied !== endSample - startSample) return fail('media_opus_window_uncovered');
    return { bytes, channels, rate: 48000 };
  } finally {
    decoder.free();
  }
}
