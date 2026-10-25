export interface AacModule {
  HEAPU8: Uint8Array; HEAPF32: Float32Array;
  _malloc(bytes: number): number; _free(pointer: number): void;
  _aac_create(asc: number, length: number): number;
  _aac_decode(decoder: number, packet: number, length: number): number;
  _aac_output(decoder: number): number; _aac_rate(decoder: number): number;
  _aac_channels(decoder: number): number; _aac_profile(decoder: number): number; _aac_free(decoder: number): void;
}
export default function factory(options: {
  instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void): WebAssembly.Exports;
}): Promise<AacModule>;
