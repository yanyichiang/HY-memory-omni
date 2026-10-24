export interface GifFrame { rgba:Uint8Array;index:number;startMs:number;endMs:number;durationMs:number;rawDelayCentiseconds:number|null;disposal:number;rect:{left:number;top:number;width:number;height:number} }
export interface GifAnimation { width:number;height:number;frames:GifFrame[];durationMs:number;loopCount?:number;pixelAspectRatioRaw:number;background:unknown }
export function decodeGif(bytes:Uint8Array, limits?:Record<string,number>):GifAnimation;
