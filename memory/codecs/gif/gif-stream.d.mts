import type {GifFrame,GifAnimation} from './gif-adapter.mjs';
export function iterateGif(bytes:Uint8Array,limits?:Record<string,number>):Generator<GifFrame,Omit<GifAnimation,'frames'> & {frameCount:number},void>;
