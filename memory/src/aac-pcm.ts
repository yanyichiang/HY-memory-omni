import { MemoryError } from './service.js';
import type { AacModule } from '../codecs/aac/aac-decoder.mjs';

export interface AacFrameDecoder {
  /** Interleaved float32 data is a WASM heap view, valid only until decode/free. */
  decode(data: Uint8Array): {
    samples: number;
    rate: number;
    channels: number;
    data: Float32Array;
  };
  free(): void;
}
const fail = (code: string, status = 415): never => {
  throw new MemoryError(code, status);
};

/**
 * Caller holds the shared audio-memory permit and supplies complete raw AAC packets
 * from the original source beginning. This helper neither locks nor trims priming,
 * padding or packet timestamps; the container adapter owns that sample mapping.
 */
export async function createAacFrameDecoder(asc: Uint8Array): Promise<AacFrameDecoder> {
  if (!(asc instanceof Uint8Array) || asc.length < 2 || asc.length > 65536) {
    return fail('audio_aac_codec_unsupported');
  }
  const [{ default: factory }, { default: wasm }] = await Promise.all([
    import('../codecs/aac/aac-decoder.mjs'),
    import('../codecs/aac/aac-decoder.wasm'),
  ]);
  const module: AacModule = await factory({
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(wasm, imports);
      receive(instance, wasm);
      return instance.exports;
    },
  });
  const pointer = module._malloc(asc.length);
  if (!pointer) return fail('audio_aac_allocation_failed', 413);
  let decoder = 0;
  try {
    module.HEAPU8.set(asc, pointer);
    decoder = module._aac_create(pointer, asc.length);
  } finally {
    module._free(pointer);
  }
  if (!decoder) return fail('audio_aac_decode_invalid');
  let rate = 0;
  let channels = 0;
  let failed = false;
  return {
    decode(data) {
      if (!decoder || failed) return fail('audio_aac_decoder_unavailable');
      try {
        if (!(data instanceof Uint8Array) || !data.length || data.length > 65536) {
          return fail('audio_aac_packet_invalid');
        }
        const packet = module._malloc(data.length);
        if (!packet) return fail('audio_aac_allocation_failed', 413);
        let samples: number;
        try {
          module.HEAPU8.set(data, packet);
          samples = module._aac_decode(decoder, packet, data.length);
        } finally {
          module._free(packet);
        }
        if (!Number.isSafeInteger(samples) || samples <= 0 || samples > 8192) {
          return fail('audio_aac_decode_invalid');
        }
        if (![1, 4, 28].includes(module._aac_profile(decoder))) {
          return fail('audio_aac_profile_unsupported');
        }
        const currentRate = module._aac_rate(decoder);
        const currentChannels = module._aac_channels(decoder);
        if (!Number.isSafeInteger(currentRate) || currentRate < 7350 || currentRate > 96000
          || !Number.isSafeInteger(currentChannels) || currentChannels < 1 || currentChannels > 2) {
          return fail('audio_aac_format_unsupported');
        }
        if (rate && (rate !== currentRate || channels !== currentChannels)) {
          return fail('audio_aac_format_changed');
        }
        rate = currentRate;
        channels = currentChannels;
        const output = module._aac_output(decoder);
        const length = samples * channels;
        if (!Number.isSafeInteger(output) || output <= 0 || output % 4
          || output / 4 + length > module.HEAPF32.length) {
          return fail('audio_aac_samples_invalid');
        }
        const decoded = module.HEAPF32.subarray(output / 4, output / 4 + length);
        if (decoded.some(value => !Number.isFinite(value))) {
          return fail('audio_aac_samples_invalid');
        }
        return { samples, rate, channels, data: decoded };
      } catch (error) {
        // A failed packet may have changed codec history; do not allow reuse/replay.
        failed = true;
        if (error instanceof MemoryError) throw error;
        return fail('audio_aac_decode_invalid');
      }
    },
    free() {
      if (decoder) {
        module._aac_free(decoder);
        decoder = 0;
      }
    },
  };
}
