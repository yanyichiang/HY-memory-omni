// Build-time adapter only. Runtime uses the upstream decoder unchanged apart from import routing.
// Source: mpg123-decoder 1.0.3 (MIT wrapper; mpg123 LGPL-2.1), common 9.0.7 MIT, simple-yenc 1.0.4 MIT.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function prepareMp3() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const require = createRequire(import.meta.url);
  const decoderRoot = dirname(require.resolve('mpg123-decoder'));
  const commonRoot = dirname(createRequire(resolve(decoderRoot, 'index.js')).resolve('@wasm-audio-decoders/common'));
  const commonRequire = createRequire(resolve(commonRoot, 'index.js'));
  const yenc = commonRequire.resolve('simple-yenc');
  const out = resolve(root, '.generated/mp3');
  await mkdir(out, { recursive: true });
  const pkg = JSON.parse(await readFile(resolve(decoderRoot, 'package.json'), 'utf8'));
  if (pkg.version !== '1.0.3') throw Error('mp3_decoder_version_mismatch');
  const common = (await readFile(resolve(commonRoot, 'src/WASMAudioDecoderCommon.js'), 'utf8'))
    .replace('"simple-yenc"', '"./simple-yenc.js"');
  const core = (await readFile(resolve(decoderRoot, 'src/MPEGDecoder.js'), 'utf8'))
    .replace('import { WASMAudioDecoderCommon } from "@wasm-audio-decoders/common";',
      'import WASMAudioDecoderCommon from "./common.js";');
  await writeFile(resolve(out, 'common.js'), common);
  // Resolve the ESM entry explicitly: require.resolve may select the package's CommonJS build.
  await writeFile(resolve(out, 'simple-yenc.js'), await readFile(resolve(dirname(yenc), 'esm.js')));
  await writeFile(resolve(out, 'mp3-core.js'), core);
  await writeFile(resolve(out, 'EmscriptenWasm.js'), await readFile(resolve(decoderRoot, 'src/EmscriptenWasm.js')));
  await writeFile(resolve(out, 'package.json'), '{"type":"module"}\n');
  const { default: Common } = await import(pathToFileURL(resolve(out, 'common.js')).href);
  const { default: Emscripten } = await import(pathToFileURL(resolve(out, 'EmscriptenWasm.js')).href);
  new Common(); new Emscripten(Common);
  const bytes = await Common.inflateDynEncodeString(Emscripten.wasm);
  await writeFile(resolve(out, 'decoder.wasm'), bytes);
  await writeFile(resolve(out, 'SOURCE.txt'), 'mpg123-decoder@1.0.3 https://github.com/eshaz/wasm-audio-decoders\nMIT JS wrapper; mpg123 LGPL-2.1 https://www.mpg123.de/\n@wasm-audio-decoders/common@9.0.7; simple-yenc@1.0.4 MIT\nOnly imports rerouted to avoid WebWorker; original upstream implementation retained.\n');
  await cp(resolve(root, 'licenses'), resolve(out, 'licenses'), { recursive: true });
  return out;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareMp3();
