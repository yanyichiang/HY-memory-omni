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
