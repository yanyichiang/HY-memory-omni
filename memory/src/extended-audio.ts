import { CustomSource, EncodedPacketSink, Input, OGG } from "mediabunny";
import { MemoryError, type Timeline, type TimeRange } from "./service.js";
import type { RangeMedia } from "./video.js";

/** Caller must hold the shared audio permit for each inspect/normalize/slice call.
 * Original bytes remain authoritative. Derived float32 PCM WAV is not a lossless archive.
 * Decoding starts at the source origin; memory is bounded, prefix/whole-source work repeats. */
const fail = (code: string, status = 415): never => {
  throw new MemoryError(code, status);
};
async function read(source: RangeMedia, offset: number, length: number) {
  if (
    !Number.isSafeInteger(source.size) ||
    source.size <= 0 ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > source.size
  )
    return fail("audio_range_invalid");
  const result = new Uint8Array(length);
  for (let at = 0; at < length; at += 65536) {
    const size = Math.min(65536, length - at),
      part = await source.read(offset + at, size);
    if (part.length !== size) return fail("audio_range_short");
    result.set(part, at);
  }
  return result;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let n = 0; n < 8; n++)
    crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  return crc >>> 0;
});
/** Integrity envelope only. Packet demux and Opus sample clocks belong to Mediabunny. */
async function checkOgg(source: RangeMedia) {
  let offset = 0,
    serial: number | undefined,
    sequence = 0,
    pending = 0,
    packets = 0,
    eos = false,
    granule = 0;
  while (offset < source.size) {
    const header = await read(source, offset, 27),
      view = new DataView(header.buffer);
    if (
      view.getUint32(0, false) !== 0x4f676753 ||
      header[4] !== 0 ||
      !header[26] ||
      eos
    )
      return fail("audio_ogg_page_invalid");
    const flags = header[5]!,
      currentSerial = view.getUint32(14, true);
    if (
      flags & ~7 ||
      Boolean(flags & 1) !== pending > 0 ||
      (offset === 0 ? !(flags & 2) : Boolean(flags & 2)) ||
      view.getUint32(18, true) !== sequence++ ||
      (serial !== undefined && serial !== currentSerial)
    )
      return fail("audio_ogg_stream_invalid");
    serial = currentSerial;
    const laces = await read(source, offset + 27, header[26]!),
      size = 27 + laces.length + laces.reduce((a, b) => a + b, 0);
    const page = await read(source, offset, size),
      expected = view.getUint32(22, true);
    page.fill(0, 22, 26);
    let crc = 0;
    for (const value of page)
      crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ value) & 255]!) >>> 0;
    if (crc !== expected) return fail("audio_ogg_crc_invalid");
    for (const length of laces) {
      pending += length;
      if (pending > (packets < 2 ? 1024 * 1024 : 16384))
        return fail("audio_ogg_packet_limit", 413);
      if (length < 255) {
        pending = 0;
        packets++;
      }
    }
    eos = Boolean(flags & 4);
    if (eos) {
      const end = view.getBigUint64(6, true);
      if (end > BigInt(Number.MAX_SAFE_INTEGER) || pending)
        return fail("audio_ogg_end_invalid");
      granule = Number(end);
    }
    offset += size;
  }
  if (!eos || pending || packets < 3) return fail("audio_ogg_incomplete");
  return granule;
}
interface Decoded {
  channelData: Float32Array[];
  samplesDecoded: number;
  sampleRate: number;
  errors: unknown[];
}
interface Collected {
  samples: number;
  rate: number;
  channels: number;
  pcm: Uint8Array | undefined;
  start: number;
  end: number;
}
function collector(
  selection: TimeRange | undefined,
  maxBytes: number,
  inline: boolean,
) {
  let rate = 0,
    channels = 0,
    samples = 0,
    start = 0,
    end = Infinity,
    pcm: Uint8Array | undefined;
  const limit = () =>
    fail(
      inline ? "media_inline_expansion_exceeded" : "media_slice_too_large",
      413,
    );
  return {
    get samples() {
      return samples;
    },
    add(decoded: Decoded, count = decoded.samplesDecoded, gain = 1) {
      if (
        decoded.errors.length ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > decoded.samplesDecoded
      )
        return fail("audio_codec_decode_invalid");
      if (!count) return;
      if (!rate) {
        rate = decoded.sampleRate;
        channels = decoded.channelData.length;
        if (
          !Number.isSafeInteger(rate) ||
          rate <= 0 ||
          !channels ||
          channels > 8
        )
          return fail("audio_format_invalid");
        if (selection) {
          start = Math.floor((selection.startMs * rate) / 1000);
          end = Math.ceil((selection.endMs * rate) / 1000);
          if (end <= start) return fail("audio_window_invalid", 400);
          if ((end - start) * channels * 4 + 56 > maxBytes) limit();
          pcm = new Uint8Array((end - start) * channels * 4);
        }
      }
      if (
        decoded.sampleRate !== rate ||
        decoded.channelData.length !== channels ||
        decoded.channelData.some((c) => c.length < decoded.samplesDecoded)
      )
        return fail("audio_codec_format_changed");
      if (!selection && (samples + count) * channels * 4 + 56 > maxBytes)
        limit();
      if (pcm) {
        const view = new DataView(pcm.buffer);
        for (
          let i = Math.max(0, start - samples);
          i < Math.min(count, end - samples);
          i++
        )
          for (let channel = 0; channel < channels; channel++) {
            const value = decoded.channelData[channel]![i]! * gain;
            if (!Number.isFinite(value))
              return fail("audio_codec_samples_invalid");
            view.setFloat32(
              ((samples + i - start) * channels + channel) * 4,
              value,
              true,
            );
          }
      }
      samples += count;
      if (!Number.isSafeInteger(samples)) return fail("audio_duration_invalid");
    },
    finish(sourceSamples?: number): Collected {
      if (
        !samples ||
        !rate ||
        (selection && samples < end && end - samples > Math.ceil(rate / 1000))
      )
        return fail("audio_codec_timeline_mismatch");
      end = Math.min(end, samples);
      if (pcm) pcm = pcm.subarray(0, (end - start) * channels * 4);
      return {
        samples: sourceSamples ?? samples,
        rate,
        channels,
        pcm,
        start,
        end,
      };
    },
  };
}
async function opus(
  source: RangeMedia,
  selection: TimeRange | undefined,
  maxBytes: number,
  inline: boolean,
  validatedSource = false,
) {
  const granule = validatedSource ? undefined : await checkOgg(source);
  const input = new Input({
    formats: [OGG],
    source: new CustomSource({
      getSize: () => source.size,
      maxCacheSize: 65536,
      prefetchProfile: "none",
      read: (a, b) => read(source, a, b - a),
    }),
  });
  let decoder:
    | InstanceType<
        typeof import("../.generated/audio-codecs/opus-runtime.js").default
      >
    | undefined;
  try {
    const tracks = await input.getTracks(),
      track = await input.getPrimaryAudioTrack();
    if (
      tracks.length !== 1 ||
      !track ||
      (await track.getCodec()) !== "opus" ||
      (await track.isLive()) ||
      (await track.isRelativeToUnixEpoch()) ||
      (await track.getFirstTimestamp()) !== 0
    )
      return fail("audio_ogg_tracks_invalid");
    const config = await track.getDecoderConfig(),
      head = config?.description
        ? new Uint8Array(config.description as ArrayBuffer)
        : undefined;
    if (
      !head ||
      head.length !== 19 ||
      head[8]! > 15 ||
      ![1, 2].includes(head[9]!) ||
      head[18] !== 0
    )
      return fail("audio_opus_mapping_unsupported");
    const view = new DataView(head.buffer, head.byteOffset, head.length),
      preSkip = view.getUint16(10, true),
      gain = Math.pow(10, view.getInt16(16, true) / (20 * 256));
    const sourceSamples =
      granule === undefined
        ? Math.round((await track.computeDuration()) * 48000)
        : granule - preSkip;
    if (!Number.isSafeInteger(sourceSamples) || sourceSamples <= 0)
      return fail("audio_opus_timeline_mismatch");
    const { default: Decoder } = await import(
      "../.generated/audio-codecs/opus-runtime.js"
    );
    decoder = new Decoder({ channels: head[9], sampleRate: 48000, preSkip });
    await decoder.ready;
    const collected = collector(
        selection
          ? {
              ...selection,
              endMs: Math.min(selection.endMs, (sourceSamples / 48000) * 1000),
            }
          : undefined,
        maxBytes,
        inline,
      ),
      sink = new EncodedPacketSink(track);
    let cursor = 0,
      packet = await sink.getFirstPacket();
    while (packet) {
      const next = await sink.getNextPacket(packet),
        decoded = decoder.decodeFrame(packet.data),
        count = Math.round(packet.duration * 48000);
      if (
        Math.abs(packet.timestamp * 48000 - cursor) > 0.00001 ||
        Math.abs(packet.duration * 48000 - count) > 0.00001 ||
        decoded.samplesDecoded < count ||
        (next && decoded.samplesDecoded !== count)
      )
        return fail("audio_opus_timeline_mismatch");
      collected.add(decoded, count, gain);
      cursor += count;
      if (
        validatedSource &&
        selection &&
        cursor >= Math.min(sourceSamples, Math.ceil(selection.endMs * 48))
      )
        break;
      packet = next;
    }
    const result = collected.finish(
      validatedSource ? sourceSamples : undefined,
    );
    if (result.samples !== sourceSamples || result.rate !== 48000)
      return fail("audio_opus_timeline_mismatch");
    return result;
  } finally {
    try {
      decoder?.free();
    } finally {
      input.dispose();
    }
  }
}
async function flac(
  source: RangeMedia,
  selection: TimeRange | undefined,
  maxBytes: number,
  inline: boolean,
  validatedSource = false,
) {
  const header = await read(source, 0, 42),
    view = new DataView(header.buffer);
  if (
    view.getUint32(0, false) !== 0x664c6143 ||
    (header[4]! & 127) !== 0 ||
    view.getUint32(4, false) % 16777216 !== 34
  )
    return fail("audio_flac_header_invalid");
  const bits = view.getBigUint64(18, false),
    expected = Number(bits & 0xfffffffffn),
    rate = Number(bits >> 44n),
    channels = Number((bits >> 41n) & 7n) + 1;
  if (!expected || !rate) return fail("audio_flac_sample_count_required");
  if (!selection && expected * channels * 4 + 56 > maxBytes)
    return fail("media_inline_expansion_exceeded", 413);
  let offset = 4,
    last = false;
  while (!last) {
    const h = await read(source, offset, 4),
      v = new DataView(h.buffer),
      length = v.getUint32(0, false) % 16777216;
    last = Boolean(h[0]! & 128);
    offset += 4 + length;
    if (offset > source.size) return fail("audio_flac_metadata_invalid");
  }
  const { default: Decoder } = await import(
      "../.generated/audio-codecs/flac-runtime.js"
    ),
    decoder = new Decoder();
  await decoder.ready;
  try {
    // Keep original STREAMINFO; skip unrelated pictures/comments without buffering their contents.
    const prefix = header.slice();
    prefix[4] = 128;
    const collected = collector(
      selection
        ? {
            ...selection,
            endMs: Math.min(selection.endMs, (expected / rate) * 1000),
          }
        : undefined,
      maxBytes,
      inline,
    );
    collected.add(await decoder.decode(prefix));
    let withoutOutput = 0,
      prefixComplete = false;
    const frameBound = Math.max(
      65536,
      view.getUint32(14, false) & 0xffffff,
      view.getUint16(10, false) * channels * 4 + 65536,
    );
    for (; offset < source.size; offset += 4096) {
      const bytes = await read(
          source,
          offset,
          Math.min(4096, source.size - offset),
        ),
        decoded = await decoder.decode(bytes);
      collected.add(decoded);
      if (
        validatedSource &&
        selection &&
        collected.samples >=
          Math.min(expected, Math.ceil((selection.endMs * rate) / 1000)) &&
        offset + bytes.length < source.size
      ) {
        prefixComplete = true;
        break;
      }
      withoutOutput = decoded.samplesDecoded ? 0 : withoutOutput + bytes.length;
      if (withoutOutput > frameBound)
        return fail("audio_flac_frame_limit", 413);
    }
    if (!prefixComplete) collected.add(await decoder.flush());
    const result = collected.finish(prefixComplete ? expected : undefined);
    if (
      result.samples !== expected ||
      result.rate !== rate ||
      result.channels !== channels
    )
      return fail("audio_flac_timeline_mismatch");
    return result;
  } finally {
    decoder.free();
  }
}
async function decode(
  mime: string,
  source: RangeMedia,
  selection?: TimeRange,
  maxBytes = Infinity,
  inline = false,
  validatedSource = false,
) {
  try {
    if (mime === "audio/ogg")
      return await opus(source, selection, maxBytes, inline, validatedSource);
    if (mime === "audio/flac")
      return await flac(source, selection, maxBytes, inline, validatedSource);
    return fail("audio_type_unsupported");
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    return fail("audio_codec_decode_invalid");
  }
}
export function encodeFloatWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
) {
  const bytes = new Uint8Array(56 + pcm.length),
    view = new DataView(bytes.buffer);
  const ascii = (at: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), at);
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 4, true);
  view.setUint16(32, channels * 4, true);
  view.setUint16(34, 32, true);
  ascii(36, "fact");
  view.setUint32(40, 4, true);
  view.setUint32(44, pcm.length / (channels * 4), true);
  ascii(48, "data");
  view.setUint32(52, pcm.length, true);
  bytes.set(pcm, 56);
  return bytes;
}
function wav(result: Collected) {
  return encodeFloatWav(result.pcm!, result.rate, result.channels);
}

export async function inspectExtendedAudio(
  mime: string,
  source: RangeMedia,
  maxWavBytes?: number,
): Promise<Timeline> {
  const result = await decode(
    mime,
    source,
    undefined,
    maxWavBytes ?? Infinity,
    maxWavBytes !== undefined,
  );
  return {
    durationMs: Math.ceil((result.samples / result.rate) * 1000),
    hasAudio: true,
    hasVideo: false,
  };
}
export async function sliceExtendedAudio(
  mime: string,
  source: RangeMedia,
  logical: TimeRange,
  timeline: Timeline,
  options?: { validatedSource?: true },
) {
  if (
    !timeline.hasAudio ||
    timeline.hasVideo ||
    !Number.isFinite(logical.startMs) ||
    !Number.isFinite(logical.endMs) ||
    logical.startMs < 0 ||
    logical.endMs <= logical.startMs ||
    logical.endMs > timeline.durationMs
  )
    return fail("audio_window_invalid", 400);
  // Only an internal caller that already bound the immutable source revision may assert this.
  const result = await decode(
    mime,
    source,
    logical,
    4 * 1024 * 1024,
    false,
    options?.validatedSource === true,
  );
  if (Math.ceil((result.samples / result.rate) * 1000) !== timeline.durationMs)
    return fail("audio_codec_timeline_mismatch");
  return {
    bytes: wav(result),
    mimeType: "audio/wav",
    logical,
    actual: {
      startMs: (result.start / result.rate) * 1000,
      endMs: (result.end / result.rate) * 1000,
    },
    offsetMs: (result.start / result.rate) * 1000,
    timeline: {
      durationMs: Math.ceil(((result.end - result.start) / result.rate) * 1000),
      hasAudio: true,
      hasVideo: false,
    },
    sourceTimeline: timeline,
  };
}
export async function normalizeExtendedAudio(
  mime: string,
  bytes: Uint8Array,
  timeline: Timeline,
): Promise<Uint8Array> {
  const result = await decode(
    mime,
    { size: bytes.length, read: async (a, n) => bytes.subarray(a, a + n) },
    { startMs: 0, endMs: timeline.durationMs },
    8 * 1024 * 1024,
    true,
  );
  if (Math.ceil((result.samples / result.rate) * 1000) !== timeline.durationMs)
    return fail("audio_codec_timeline_mismatch");
  return wav(result);
}
