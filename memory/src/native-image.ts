import { encode as encodePng } from 'fast-png';
import { MemoryError, type Timeline, type ImageRepresentation } from './service.js';
import { acquireAudio } from './audio.js';

export const isExtendedImage = (mime: string) => ['image/heic', 'image/heif', 'image/avif', 'image/gif'].includes(mime);
interface NativeImage { mimeType: 'image/png' | 'video/mp4'; bytes: Uint8Array; representation: ImageRepresentation; timeline?: Timeline }
const cache = new WeakMap<Uint8Array, { mimeType: string; pending: Promise<NativeImage> }>();
const fail = (code: string, status = 415): never => { throw new MemoryError(code, status); };
const LIMIT = 8 * 1024 * 1024;
/** Only identifies the image family; libheif/GIF validate the complete container. */
export function extendedImageMime(bytes: Uint8Array): string | undefined {
  const ascii=(a:number,b:number)=>String.fromCharCode(...bytes.subarray(a,b));
  if (['GIF87a','GIF89a'].includes(ascii(0,6))) return 'image/gif';
  if (bytes.length < 16 || ascii(4,8) !== 'ftyp') return undefined;
  const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
  if (size < 16 || size > bytes.length || size > 4096 || size % 4) return undefined;
  const brands=[ascii(8,12)];
  for(let at=16;at<size;at+=4) brands.push(ascii(at,at+4));
  if(brands.some(b=>['avif','avis'].includes(b))) return 'image/avif';
  if(brands.some(b=>['heic','heix','hevc','hevx'].includes(b))) return 'image/heic';
  if(brands.some(b=>['mif1','msf1'].includes(b))) return 'image/heif';
  return undefined;
}
function png(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number) {
  const bytes = encodePng({ data: rgba, width, height, channels: 4, depth: 8 });
  if (bytes.length > LIMIT) return fail('image_representation_too_large', 413);
  return bytes;
}
function clock(ticks: bigint, rate: number) {
  if (!Number.isSafeInteger(rate) || rate <= 0 || ticks < 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) return fail('image_animation_clock_invalid');
  return Number(ticks) / rate * 1000;
}
/** Originals remain caller-owned. Cached derivatives have only the immutable input's lifetime. */
export async function nativeImage(mimeType: string, bytes: Uint8Array): Promise<NativeImage> {
  if (!isExtendedImage(mimeType) || !bytes.length || bytes.length > LIMIT) return fail('image_input_invalid');
  const actual=extendedImageMime(bytes);
  if (!actual || actual !== mimeType && !(mimeType === 'image/heif' && actual !== 'image/gif')) return fail('image_mime_mismatch');
  const old = cache.get(bytes);
  if (old?.mimeType === mimeType) return old.pending;
  const pending = normalize(mimeType, bytes); cache.set(bytes, { mimeType, pending }); return pending;
}
async function normalize(mimeType: string, bytes: Uint8Array): Promise<NativeImage> {
  // Audio and image decoding share the isolate's existing codec-memory permit.
  const release = await acquireAudio();
  try {
    let frames: AsyncIterable<{rgba:Uint8Array|Uint8ClampedArray;width:number;height:number;index:number;startMs:number;endMs:number}>;
    let representation: ImageRepresentation;
    if (mimeType === 'image/gif') {
      const { iterateGif } = await import('../codecs/gif/gif-stream.mjs');
      if (bytes.length < 13) return fail('gif_truncated');
      const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=header.getUint16(6,true),height=header.getUint16(8,true);
      const iterator=iterateGif(bytes),first=iterator.next();
      if (first.done) return fail('image_frame_missing');
      const second=iterator.next();
      representation = { inputMimeType: mimeType, originalWidth: width, originalHeight: height,
        kind: second.done ? 'still' : 'animation', frames:[], loopMeaning: 'GIF raw Netscape count; zero means infinite. One encoded cycle is supplied.',
        colorLimitation: 'GIF palette samples; provider animation uses a white matte and YUV420 compression.' };
      const metadata=(gif:ReturnType<typeof iterator.next>['value'])=>{
        if (!('background' in gif)) return fail('gif_metadata_missing');
        if (gif.loopCount !== undefined) representation.loopCount=gif.loopCount;
        representation.background=gif.background; representation.pixelAspectRatioRaw=gif.pixelAspectRatioRaw;
      };
      if (second.done) { metadata(second.value); const {index,startMs,endMs,rawDelayCentiseconds,disposal}=first.value; representation.frames.push({index,startMs,endMs,rawDelayCentiseconds,disposal}); representation.outputWidth=width; representation.outputHeight=height; return {mimeType:'image/png',bytes:png(first.value.rgba,width,height),representation}; }
      frames = (async function* () {
        try {
          let next:ReturnType<typeof iterator.next>=first;
          for (;;) {
            if (next.done) { metadata(next.value); return; }
            const frame:import('../codecs/gif/gif-adapter.mjs').GifFrame=next.value;
            const {index,startMs,endMs,rawDelayCentiseconds,disposal}=frame;
            representation.frames.push({index,startMs,endMs,rawDelayCentiseconds,disposal});
            yield {...next.value,width,height};
            next = index === first.value.index ? second : iterator.next();
          }
        } finally { iterator.return(undefined as never); }
      })();
    } else {
      const { inspectImage, imageFrames } = await import('../codecs/heif/adapter.mjs');
      const info = await inspectImage(bytes);
      if (info.kind === 'collection') return fail('image_collection_unsupported');
      if (info.kind === 'invalid') return fail('image_container_invalid');
      const visual = info.tracks.map((t,index)=>({t,index})).filter(({t})=>['pict','vide'].includes(t.type));
      if (info.kind === 'sequence' && (visual.length !== 1 || info.tracks.length !== 1)) return fail('image_sequence_tracks_unsupported');
      const selection = info.kind === 'sequence' ? {kind:'sequence' as const,index:visual[0]!.index} : {kind:'item' as const,index:0};
      if (info.kind !== 'sequence' && info.items.length !== 1) return fail('image_item_required');
      representation = { inputMimeType:mimeType, kind:info.kind === 'sequence' ? 'animation':'still',
        itemIds:info.items.map(i=>i.id), frames:[], colorLimitation:'RGBA8 SDR/sRGB target via libheif; not lossless HDR/wide-gamut/ICC preservation.' };
      const decoded = imageFrames(bytes,selection);
      if (info.kind !== 'sequence') {
        for await (const frame of decoded) {
          representation.originalWidth=frame.originalWidth; representation.originalHeight=frame.originalHeight;
          representation.outputWidth=frame.width; representation.outputHeight=frame.height; representation.downsample=frame.downsample;
          representation.sourceDepth=frame.sourceDepth; representation.sourceIccBytes=frame.sourceIccBytes;
          return {mimeType:'image/png',bytes:png(frame.rgba,frame.width,frame.height),representation};
        }
        return fail('image_frame_missing');
      }
      frames = (async function* () {
        for await (const frame of decoded) {
          representation.originalWidth ??= frame.width; representation.originalHeight ??= frame.height;
          representation.timescale=frame.timescale; representation.repetitions=frame.repetitions;
          representation.loopMeaning='HEIF sequence repetitions metadata; one physical media cycle is supplied.';
          const startMs=clock(frame.startTicks,frame.timescale),endMs=clock(frame.startTicks+frame.durationTicks,frame.timescale);
          representation.frames.push({index:frame.index,startMs,endMs,startTicks:frame.startTicks.toString(),durationTicks:frame.durationTicks.toString()});
          yield {rgba:frame.rgba,width:frame.width,height:frame.height,index:frame.index,startMs,endMs};
        }
      })();
    }
    const { encodeAnimation } = await import('../codecs/animation/encoder.mjs');
    const encoded = await encodeAnimation(frames);
    if (encoded.bytes.length > LIMIT || encoded.durationMs > 120000) return fail('image_animation_inline_limit',413);
    representation.outputWidth=encoded.width; representation.outputHeight=encoded.height; representation.matte='white';
    representation.mapping=encoded.mapping;
    representation.colorLimitation += ' Provider video is an encoded derivative; the retained original and source frame timings remain authoritative.';
    const timeline:Timeline={durationMs:Math.ceil(encoded.durationMs),hasAudio:false,hasVideo:true,animation:representation};
    return {mimeType:'video/mp4',bytes:encoded.bytes,representation,timeline};
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    return fail(error instanceof Error ? error.message : 'image_decode_failed');
  } finally { release(); }
}
