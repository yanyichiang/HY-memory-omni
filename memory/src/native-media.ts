import { nativeAudio } from './native-audio.js';
import { inspectMatroskaVideo, isMatroska, sliceMatroskaVideo } from './matroska-video.js';
import { isExtendedImage, nativeImage } from './native-image.js';

/** Provider representation only. Callers retain original bytes/MIME as source evidence. */
export async function nativeMedia(input: { mimeType: string; bytes: Uint8Array }) {
  if (isExtendedImage(input.mimeType)) return nativeImage(input.mimeType,input.bytes);
  if (!isMatroska(input.mimeType)) return nativeAudio(input);
  const source = { size: input.bytes.length, read: async (a: number, n: number) => input.bytes.subarray(a, a + n) };
  const timeline = await inspectMatroskaVideo(input.mimeType, source);
  const clip = await sliceMatroskaVideo(input.mimeType, source, { startMs: 0, endMs: timeline.durationMs });
  return { mimeType: clip.mimeType, bytes: clip.bytes };
}
