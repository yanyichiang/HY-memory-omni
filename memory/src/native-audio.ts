import { acquireAudio } from './audio.js';
import { MemoryError, type Timeline } from './service.js';

export const extendedAudioTypes = ['audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac'] as const;
export function isExtendedAudio(mimeType: string): boolean {
  return (extendedAudioTypes as readonly string[]).includes(mimeType);
}
export function audioDecoderName(mimeType: string): string {
  if (mimeType === 'audio/mp4' || mimeType === 'audio/aac') return 'FFmpeg/9.0-aac';
  if (mimeType === 'audio/ogg') return 'opus-decoder/0.7.12';
  if (mimeType === 'audio/flac') return 'flac/0.2.11+codec-parser/2.5.0-eof-fix';
  return mimeType === 'audio/mpeg' ? 'mpg123-decoder/1.0.3' : 'container';
}

const bufferSource = (bytes: Uint8Array) => ({ size: bytes.length,
  read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) });
export async function audioDecoder(mimeType: string) {
  return mimeType === 'audio/mp4' || mimeType === 'audio/aac'
    ? import('./aac-audio.js') : import('./extended-audio.js');
}

/** Validate the complete decoded sample clock and expansion size before storing an inline source. */
export async function inspectInlineAudio(mimeType: string, bytes: Uint8Array): Promise<Timeline> {
  const release = await acquireAudio();
  try {
    const { inspectExtendedAudio } = await audioDecoder(mimeType);
    const timeline = await inspectExtendedAudio(mimeType, bufferSource(bytes), 8 * 1024 * 1024);
    if (timeline.durationMs > 180000) throw new MemoryError('media_duration_exceeded', 413);
    return timeline;
  } finally { release(); }
}

/** The original remains the source of evidence. This PCM derivative has the same presentation clock.
 * All provider paths (including embedding and media queries) use this representation consistently. */
export async function nativeAudio(input: { mimeType: string; bytes: Uint8Array }, timeline?: Timeline) {
  if (!isExtendedAudio(input.mimeType)) return input;
  const release = await acquireAudio();
  try {
    const { inspectExtendedAudio, normalizeExtendedAudio } = await audioDecoder(input.mimeType);
    const checked = timeline ?? await inspectExtendedAudio(input.mimeType, bufferSource(input.bytes), 8 * 1024 * 1024);
    if (checked.durationMs > 180000) throw new MemoryError('media_duration_exceeded', 413);
    return { mimeType: 'audio/wav', bytes: await normalizeExtendedAudio(input.mimeType, input.bytes, checked) };
  } finally { release(); }
}
