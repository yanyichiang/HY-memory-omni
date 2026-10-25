import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { copyFile, cp } from 'node:fs/promises';
import { prepareMp3 } from './scripts/prepare-mp3.mjs';
import { prepareAudioCodecs } from './scripts/prepare-audio-codecs.mjs';
import { prepareMatroska } from './scripts/prepare-matroska.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
await prepareMp3();
await prepareAudioCodecs();
const matroskaEntry = await prepareMatroska();
await build({ absWorkingDir: root, entryPoints: ['src/worker.ts', 'src/service.ts', 'src/models.ts', 'src/media.ts', 'src/audio.ts', 'src/extended-audio.ts', 'src/aac-audio.ts', 'src/native-audio.ts', 'src/audio-models.ts', 'src/knowledge.ts', 'src/knowledge-models.ts', 'src/storage.ts', 'src/staged-store.ts', 'src/paged-store.ts', 'src/vector-index.ts', 'src/node-store.ts', 'src/knowledge-store.ts', 'src/video.ts', 'src/video-models.ts', 'src/long-video.ts', 'src/long-audio.ts', 'src/uploads.ts'],
  outdir: 'dist', bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'], sourcemap: true, alias: { mediabunny: matroskaEntry },
  plugins: [{ name: 'static-audio-wasm', setup(build) {
    build.onResolve({ filter: /\.wasm$/ }, args => ({ path: `./${basename(args.path)}`, external: true }));
  } }] });
await copyFile(new URL('.generated/mp3/decoder.wasm', import.meta.url), new URL('dist/decoder.wasm', import.meta.url));
await copyFile(new URL('.generated/mp3/SOURCE.txt', import.meta.url), new URL('dist/MP3-SOURCE.txt', import.meta.url));
await copyFile(new URL('codecs/aac/aac-decoder.wasm', import.meta.url), new URL('dist/aac-decoder.wasm', import.meta.url));
for (const name of ['opus', 'flac']) {
  await copyFile(new URL(`.generated/audio-codecs/${name}.wasm`, import.meta.url), new URL(`dist/${name}.wasm`, import.meta.url));
}
await copyFile(new URL('.generated/audio-codecs/SOURCE.txt', import.meta.url), new URL('dist/AUDIO-SOURCE.txt', import.meta.url));
await cp(new URL('licenses/', import.meta.url), new URL('dist/licenses/', import.meta.url), { recursive: true });
// Keep binary redistribution provenance alongside the runtime bundle.
await cp(new URL('codecs/aac/', import.meta.url), new URL('dist/licenses/aac/', import.meta.url), { recursive: true });
await cp(new URL('.generated/mediabunny/', import.meta.url), new URL('dist/licenses/mediabunny/', import.meta.url), { recursive: true });
