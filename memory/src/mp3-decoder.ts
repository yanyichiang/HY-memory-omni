import wasm from '../.generated/mp3/decoder.wasm';
import MPEGDecoder from '../.generated/mp3/mp3-core.js';
MPEGDecoder.module = wasm;

/** Same upstream decoder state across small feeds; no Worker or runtime Wasm compilation. */
export async function decodeMp3(bytes: Uint8Array, expectedSamples: number, sampleRate: number): Promise<Uint8Array> {
  const decoder = new MPEGDecoder({ enableGapless: false });
  await decoder.ready;
  // mpg123 wrapper forces stereo. Compact PCM16 only: at most 180*48000*2*2 = 34,560,000 bytes.
  const pcm = new Uint8Array(expectedSamples * 4);
  const view = new DataView(pcm.buffer);
  let samples = 0;
  try {
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      const result = decoder.decode(bytes.subarray(offset, offset + 4096));
      if (result.errors.length) throw Error('audio_mp3_decode_error');
      if (!result.samplesDecoded) continue;
      if (result.sampleRate !== sampleRate || samples + result.samplesDecoded > expectedSamples
        || result.channelData.length !== 2) throw Error('audio_mp3_timeline_mismatch');
      for (let channel = 0; channel < 2; channel++) {
        const data = result.channelData[channel]!;
        if (data.length !== result.samplesDecoded) throw Error('audio_mp3_samples_invalid');
        for (let i = 0; i < data.length; i++) {
          const value = data[i]!;
          if (!Number.isFinite(value)) throw Error('audio_mp3_samples_invalid');
          const clipped = Math.max(-1, Math.min(1, value));
          view.setInt16(((samples + i) * 2 + channel) * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
        }
      }
      samples += result.samplesDecoded;
    }
    // Upstream drains each feed to MPG123_NEED_MORE and sets NO_READAHEAD. decode(empty) is a no-op,
    // not an EOF flush. The independently counted complete packet samples must all have decoded.
    if (samples !== expectedSamples) throw Error('audio_mp3_timeline_mismatch');
    return pcm;
  } finally { decoder.free(); }
}

/** Sequential Layer III framing with one 4KiB source cache. Do not treat mpg123
 * NEED_MORE at EOF as proof that the final compressed frame was complete. */
async function* mp3Frames(source: { size: number; read(offset: number, length: number): Promise<Uint8Array> }) {
  let cache: Uint8Array = new Uint8Array();
  let cacheStart = -1, offset = 0, format = '', frames = 0;
  const read = async (at: number, length: number) => {
    if (at < 0 || at + length > source.size) throw Error('audio_mp3_frame_incomplete');
    const bytes = new Uint8Array(length);
    for (let copied = 0; copied < length;) {
      const cursor = at + copied;
      if (cursor < cacheStart || cursor >= cacheStart + cache.length) {
        cacheStart = cursor; cache = await source.read(cursor, Math.min(4096, source.size - cursor));
        if (cache.length !== Math.min(4096, source.size - cursor)) throw Error('audio_range_short');
      }
      const count = Math.min(length - copied, cacheStart + cache.length - cursor);
      bytes.set(cache.subarray(cursor - cacheStart, cursor - cacheStart + count), copied); copied += count;
    }
    return bytes;
  };
  while (offset + 10 <= source.size) {
    const header = await read(offset, 10);
    if (header[0] !== 73 || header[1] !== 68 || header[2] !== 51) break;
    if (![2,3,4].includes(header[3]!) || header.subarray(6,10).some(v => v > 127)) throw Error('audio_mp3_tag_invalid');
    const size = header[6]! * 2097152 + header[7]! * 16384 + header[8]! * 128 + header[9]!;
    offset += 10 + size + (header[3] === 4 && (header[5]! & 16) ? 10 : 0);
    if (offset > source.size) throw Error('audio_mp3_tag_invalid');
  }
  while (offset < source.size) {
    if (source.size - offset === 128) {
      const tag = await read(offset, 3);
      if (tag[0] === 84 && tag[1] === 65 && tag[2] === 71) { offset += 128; break; }
    }
    const header = await read(offset, 4), version = (header[1]! >> 3) & 3, layer = (header[1]! >> 1) & 3;
    const rateIndex = (header[2]! >> 2) & 3, bitrateIndex = header[2]! >> 4;
    if (header[0] !== 255 || (header[1]! & 224) !== 224 || version === 1 || layer !== 1
      || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) throw Error('audio_mp3_frame_invalid');
    const rate = [44100,48000,32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex]!;
    const channels = header[3]! >> 6 === 3 ? 1 : 2, identity = `${version}:${rate}:${channels}`;
    if (format && identity !== format) throw Error('audio_mp3_frame_invalid');
    format = identity;
    const length = Math.floor((version === 3 ? 144000 : 72000) * bitrate / rate) + ((header[2]! >> 1) & 1);
    const bytes = await read(offset, length);
    const xingAt = version === 3 ? (channels === 1 ? 21 : 36) : (channels === 1 ? 13 : 21);
    const signature = bytes.length >= xingAt + 4 ? new DataView(bytes.buffer).getUint32(xingAt, false) : 0;
    const metadata = frames === 0 && (signature === 0x58696e67 || signature === 0x496e666f);
    yield { bytes, samples: metadata ? 0 : version === 3 ? 1152 : 576, rate };
    frames++; offset += length;
  }
  if (!frames || offset !== source.size) throw Error('audio_mp3_frame_incomplete');
}

/** Decode from the original beginning so MP3 bit reservoirs and synthesis history remain intact.
 * Only the requested PCM is retained; preceding decoded samples are discarded. */
export async function decodeMp3Range(source: { size: number; read(offset: number, length: number): Promise<Uint8Array> }, selection?: { startMs: number; endMs: number }) {
  const decoder = new MPEGDecoder({ enableGapless: false });
  await decoder.ready;
  let samples = 0, expectedSamples = 0, sampleRate = 0, pcm: Uint8Array | undefined, start = 0, end = Infinity;
  try {
    for await (const frame of mp3Frames(source)) {
      expectedSamples += frame.samples;
      const result = decoder.decode(frame.bytes);
      if (result.errors.length) throw Error('audio_mp3_decode_error');
      if (!result.samplesDecoded) continue;
      if (!sampleRate) {
        sampleRate = result.sampleRate;
        if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || sampleRate > 48000) throw Error('audio_format_invalid');
        if (selection) {
          start = Math.floor(selection.startMs * sampleRate / 1000);
          end = Math.ceil(selection.endMs * sampleRate / 1000);
          if ((end - start) * 4 > 4 * 1024 * 1024 - 44) throw Error('media_slice_too_large');
          pcm = new Uint8Array((end - start) * 4);
        }
      }
      if (result.sampleRate !== sampleRate || result.channelData.length !== 2) throw Error('audio_mp3_timeline_mismatch');
      if (pcm) {
        const view = new DataView(pcm.buffer);
        for (let i = Math.max(0, start - samples); i < Math.min(result.samplesDecoded, end - samples); i++) {
          for (let channel = 0; channel < 2; channel++) {
            const value = result.channelData[channel]![i]!;
            if (!Number.isFinite(value)) throw Error('audio_mp3_samples_invalid');
            const clipped = Math.max(-1, Math.min(1, value));
            view.setInt16(((samples + i - start) * 2 + channel) * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
          }
        }
      }
      samples += result.samplesDecoded;
      if (!Number.isSafeInteger(samples)) throw Error('audio_duration_invalid');
      if (selection && samples >= end) break;
    }
    if (samples !== expectedSamples) throw Error('audio_mp3_timeline_mismatch');
    if (!samples || selection && samples < end && end - samples > Math.ceil(sampleRate / 1000)) throw Error('audio_mp3_timeline_mismatch');
    if (selection && samples < end) { end = samples; pcm = pcm!.subarray(0, (end - start) * 4); }
    return { samples, sampleRate, pcm, startSample: start, endSample: end };
  } finally { decoder.free(); }
}
