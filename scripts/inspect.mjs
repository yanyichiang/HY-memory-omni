import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const hints = {
  media_inspection_metadata_limit: 'ISO track discovery is limited to 8 MiB of container metadata; no media payload was decoded.',
  media_tracks_invalid: 'Select one video track and at most one soundtrack before upload.',
  media_timeline_origin: 'Rebase presentation timestamps to zero before upload.',
  audio_codec_unsupported: 'Use a supported audio codec listed in docs/MEDIA.md; changing the extension does not convert a codec.',
  media_slice_too_large: 'Use a shorter segment duration or export a lower bitrate recording.',
  media_inline_expansion_exceeded: 'Use /audio/upload or /video/upload for the matching recording type. Its decoded media is too large for inline ingestion; choose shorter segments.',
};
export async function inspectFile(path) {
  if (!path) throw new Error('Usage: hy-memory-omni inspect FILE (run npm run build first).');
  const file = await open(resolve(path), 'r');
  // The CLI runs in Node; Workers receive this same binary as a compiled Wasm module.
  const hooks = registerHooks({ load(url, context, next) {
    if (!url.endsWith('.wasm')) return next(url, context);
    const data = readFileSync(new URL(url)).toString('base64');
    return { format: 'module', source: `export default new WebAssembly.Module(Buffer.from('${data}', 'base64'));`, shortCircuit: true };
  } });
  try {
    const { size } = await file.stat();
    const read = async (offset, length) => {
      const bytes = Buffer.alloc(length);
      const result = await file.read(bytes, 0, length, offset);
      return new Uint8Array(bytes.subarray(0, result.bytesRead));
    };
    const head = Buffer.from(await read(0, Math.min(size, 4096)));
    const { extendedImageMime } = await import('../memory/dist/native-image.js');
    let mimeType = extendedImageMime(head) ?? (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'matroska'
      : head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE' ? 'audio/wav'
      : head.toString('ascii', 0, 4) === 'OggS' ? 'audio/ogg'
      : head.toString('ascii', 0, 4) === 'fLaC' ? 'audio/flac'
      : head[0] === 255 && (head[1] & 0xf6) === 0xf0 ? 'audio/aac'
      : head.toString('ascii', 0, 3) === 'ID3' || head[0] === 255 && (head[1] & 0xe0) === 0xe0 ? 'audio/mpeg'
      : head.toString('ascii', 4, 8) === 'ftyp' ? head.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
      : head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : head[0] === 255 && head[1] === 216 ? 'image/jpeg'
      : head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined);
    if (!mimeType) return { supported: false, bytes: size, error: 'unrecognized_container', hint: 'See docs/MEDIA.md for supported containers and codecs. The filename extension is not used to infer support.' };
    try {
      if (mimeType === 'matroska') {
        const { checkMatroska } = await import('../memory/dist/video.js');
        mimeType = await checkMatroska({ size, read });
      }
      if (mimeType === 'video/mp4') {
        // Shared brands (including isom) do not tell whether a file contains audio or video.
        const { classifyIsoMedia } = await import('../memory/dist/video.js');
        mimeType = await classifyIsoMedia(mimeType, { size, read });
      }
      let timeline;
      if (mimeType.startsWith('audio/')) {
        const { inspectLongAudio } = await import('../memory/dist/long-audio.js');
        timeline = await inspectLongAudio(mimeType, { size, read });
      } else if (mimeType.startsWith('video/')) {
        const { inspectLongVideo } = await import('../memory/dist/video.js');
        timeline = await inspectLongVideo(mimeType, { size, read });
      } else {
        if (size > 8 * 1024 * 1024) return { supported: false, mimeType, bytes: size, error: 'image_too_large', hint: 'Export an image below 8 MiB. Multipart ingestion is for recordings.' };
        const { inspectMedia } = await import('../memory/dist/media.js');
        timeline = await inspectMedia(mimeType, await read(0, size));
      }
      let multipart = size > 8 * 1024 * 1024 || !!timeline && timeline.durationMs > (timeline.hasVideo ? 120000 : 180000);
      if (!multipart && (mimeType.startsWith('video/') || ['audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac'].includes(mimeType))) {
        // A short compressed recording can still exceed the inline native representation limit.
        const { inspectMedia } = await import('../memory/dist/media.js');
        try { await inspectMedia(mimeType, await read(0, size)); }
        catch (error) { if (error.code === 'media_inline_expansion_exceeded') multipart = true; else throw error; }
      }
      return { supported: true, mimeType, bytes: size, ...(timeline ? { timeline } : {}),
        entrypoint: multipart ? `/${timeline.hasVideo ? 'video' : 'audio'}/upload` : '/ingest',
        ...(mimeType.startsWith('audio/') && mimeType !== 'audio/wav' ? { note: 'Compressed audio inspection validates decoded samples. Segment decoding is bounded in memory and may reread the source; PCM WAV supports direct sample range reads.' } : {}),
        scope: 'Container/codec and applicable decoder checks only; model inference has not run.' };
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('Worker bundle is missing. Run npm run build first.');
      const code = error.code || error.message;
      return { supported: false, mimeType, bytes: size, error: code,
        hint: hints[code] || 'Inspect the container, codec, tracks and timestamps. See docs/MEDIA.md for supported exports.' };
    }
  } finally { hooks.deregister(); await file.close(); }
}
