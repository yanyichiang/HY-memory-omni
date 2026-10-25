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
  /** Internal, revision-bound decoder state; never accepts caller-supplied snapshots. */
  checkpoint(): Uint8Array;
  free(): void;
}
const fail = (code: string, status = 415): never => {
  throw new MemoryError(code, status);
};

/**
 * Caller holds the shared audio-memory permit and supplies complete raw AAC packets
 * from the original source beginning or an internal checkpoint. This helper neither locks nor trims priming,
 * padding or packet timestamps; the container adapter owns that sample mapping.
 */
// Checkpoints are specific to the committed FFmpeg 9.0 / Emscripten 4.0.7 module.
// Its sole mutable Wasm global is the ABI stack pointer, restored by every normal
// function return. The fixed function table has no dynamic linker; all allocator,
// AAC, SBR and PS state lives in linear memory. Snapshot only after successful calls.
const CHECKPOINT_HEADER = 32;
const CHECKPOINT_MAGIC = 0x41414331;
export async function createAacFrameDecoder(asc: Uint8Array, checkpoint?: Uint8Array): Promise<AacFrameDecoder> {
  if (!(asc instanceof Uint8Array) || asc.length < 2 || asc.length > 65536) {
    return fail('audio_aac_codec_unsupported');
  }
  let saved: DataView | undefined;
  if (checkpoint) {
    if (!(checkpoint instanceof Uint8Array) || checkpoint.length < CHECKPOINT_HEADER) return fail('audio_aac_checkpoint_invalid');
    saved = new DataView(checkpoint.buffer, checkpoint.byteOffset, checkpoint.byteLength);
    const size = saved.getUint32(4, true), pointer = saved.getUint32(8, true);
    if (saved.getUint32(0, true) !== CHECKPOINT_MAGIC || size < 16 * 1024 * 1024 || size > 64 * 1024 * 1024
      || size % 65536 || checkpoint.length !== size + CHECKPOINT_HEADER + asc.length || pointer < 1 || pointer >= size
      || saved.getUint32(12, true) < 7350 || saved.getUint32(12, true) > 96000
      || ![1, 2].includes(saved.getUint32(16, true)) || saved.getUint32(20, true) !== asc.length
      || asc.some((value, index) => value !== checkpoint[CHECKPOINT_HEADER + index])
      || saved.getUint32(24, true) !== 0 || saved.getUint32(28, true) !== 0) return fail('audio_aac_checkpoint_invalid');
  }
  const [{ default: factory }, { default: wasm }] = await Promise.all([
    import('../codecs/aac/aac-decoder.mjs'),
    import('../codecs/aac/aac-decoder.wasm'),
  ]);
  const module: AacModule = await factory({
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(wasm, imports);
      if (saved) {
        const memory = Object.values(instance.exports).find(value => value instanceof WebAssembly.Memory) as WebAssembly.Memory;
        const pages = (saved.getUint32(4, true) - memory.buffer.byteLength) / 65536;
        if (pages > 0) memory.grow(pages);
      }
      receive(instance, wasm);
      return instance.exports;
    },
  });
  let decoder = 0, rate = 0, channels = 0;
  if (saved) {
    module.HEAPU8.set(checkpoint!.subarray(CHECKPOINT_HEADER + asc.length));
    decoder = saved.getUint32(8, true); rate = saved.getUint32(12, true); channels = saved.getUint32(16, true);
  } else {
    const pointer = module._malloc(asc.length);
    if (!pointer) return fail('audio_aac_allocation_failed', 413);
    try {
      module.HEAPU8.set(asc, pointer);
      decoder = module._aac_create(pointer, asc.length);
    } finally { module._free(pointer); }
    if (!decoder) return fail('audio_aac_decode_invalid');
  }
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
    checkpoint() {
      if (!decoder || failed || !rate || !channels) return fail('audio_aac_decoder_unavailable');
      const bytes = new Uint8Array(CHECKPOINT_HEADER + asc.length + module.HEAPU8.length), view = new DataView(bytes.buffer);
      view.setUint32(0, CHECKPOINT_MAGIC, true); view.setUint32(4, module.HEAPU8.length, true);
      view.setUint32(8, decoder, true); view.setUint32(12, rate, true); view.setUint32(16, channels, true);
      view.setUint32(20, asc.length, true);
      bytes.set(asc, CHECKPOINT_HEADER);
      bytes.set(module.HEAPU8, CHECKPOINT_HEADER + asc.length);
      return bytes;
    },
    free() {
      if (decoder) {
        module._aac_free(decoder);
        decoder = 0;
      }
    },
  };
}
