import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, cp } from 'node:fs/promises';
import { prepareMp3 } from './scripts/prepare-mp3.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
await prepareMp3();
await build({ absWorkingDir: root, entryPoints: ['src/worker.ts', 'src/service.ts', 'src/models.ts', 'src/media.ts', 'src/audio.ts', 'src/audio-models.ts', 'src/knowledge.ts', 'src/knowledge-models.ts', 'src/storage.ts', 'src/staged-store.ts', 'src/paged-store.ts', 'src/vector-index.ts', 'src/node-store.ts', 'src/knowledge-store.ts', 'src/video.ts', 'src/video-models.ts', 'src/long-video.ts', 'src/long-audio.ts', 'src/uploads.ts'],
  outdir: 'dist', bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'], sourcemap: true,
  plugins: [{ name: 'static-mp3-wasm', setup(build) {
    build.onResolve({ filter: /\.wasm$/ }, () => ({ path: './decoder.wasm', external: true }));
  } }] });
await copyFile(new URL('.generated/mp3/decoder.wasm', import.meta.url), new URL('dist/decoder.wasm', import.meta.url));
await copyFile(new URL('.generated/mp3/SOURCE.txt', import.meta.url), new URL('dist/MP3-SOURCE.txt', import.meta.url));
await cp(new URL('licenses/', import.meta.url), new URL('dist/licenses/', import.meta.url), { recursive: true });
