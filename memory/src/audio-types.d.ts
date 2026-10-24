declare module '*.wasm' { const module: WebAssembly.Module; export default module; }
declare module '*mp3-core.js' {
  export default class MPEGDecoder {
    static module: WebAssembly.Module;
    constructor(options: { enableGapless: boolean });
    ready: Promise<void>;
    decode(bytes: Uint8Array): { channelData: Float32Array[]; samplesDecoded: number; sampleRate: number; errors: unknown[] };
    free(): void;
  }
}
