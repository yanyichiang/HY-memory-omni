// Build-time extraction/import routing only. Upstream codec implementations are retained.
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export async function prepareAudioCodecs(options = {}) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const require = createRequire(
    options.dependencyRoot
      ? resolve(options.dependencyRoot, "package.json")
      : import.meta.url,
  );
  const out = resolve(root, ".generated/audio-codecs");
  await mkdir(out, { recursive: true });
  const pins = [
    ["opus", "opus-decoder", "0.7.12", "OpusDecoder.js"],
    ["flac", "@wasm-audio-decoders/flac", "0.2.11", "FLACDecoder.js"],
  ];
  const notices = [];
  const parserRoot = dirname(require.resolve("codec-parser"));
  const parserPackage = JSON.parse(
    await readFile(resolve(parserRoot, "package.json"), "utf8"),
  );
  if (parserPackage.version !== "2.5.0")
    throw Error("audio_codec_parser_version_mismatch");
  await cp(parserRoot, resolve(out, "codec-parser"), { recursive: true });
  const parserFile = resolve(out, "codec-parser/src/codecs/flac/FLACParser.js");
  let parser = await readFile(parserFile, "utf8");
  const oldBoundary = `          if (
            this._codecParser._flushing ||
            (yield* FLACHeader[getHeader](
              this._codecParser,
              this._headerCache,
              nextHeaderOffset,
            ))
          ) {`;
  const newBoundary = `          const nextHeader = this._codecParser._flushing ? null :
            (yield* FLACHeader[getHeader](
              this._codecParser,
              this._headerCache,
              nextHeaderOffset,
            ));
          if (this._codecParser._flushing || nextHeader) {`;
  if (
    !parser.includes(oldBoundary) ||
    !parser.includes("if (!this._codecParser._flushing)")
  )
    throw Error("audio_flac_parser_patch_mismatch");
  parser = parser
    .replace(oldBoundary, newBoundary)
    .replace("if (!this._codecParser._flushing)", "if (nextHeader)");
  await writeFile(parserFile, parser);
  const inputFile = resolve(out, "codec-parser/src/CodecParser.js");
  let input = await readFile(inputFile, "utf8");
  const waiting =
    "while (this._rawData[length] <= minSize + readOffset) {\n      rawData = yield;";
  if (!input.includes(waiting))
    throw Error("audio_flac_parser_eof_patch_mismatch");
  input = input.replace(
    waiting,
    "while (this._rawData[length] <= minSize + readOffset) {\n      if (this._flushing && this._rawData[length] > readOffset) return this._rawData[subarray](readOffset);\n      rawData = yield;",
  );
  await writeFile(inputFile, input);
  for (const [name, pkg, version, core] of pins) {
    const packageRoot = dirname(require.resolve(pkg)),
      localRequire = createRequire(resolve(packageRoot, "index.js"));
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    if (manifest.version !== version)
      throw Error(`${name}_decoder_version_mismatch`);
    const commonRoot = dirname(
      localRequire.resolve("@wasm-audio-decoders/common"),
    );
    const commonRequire = createRequire(resolve(commonRoot, "index.js"));
    const commonPackage = JSON.parse(
      await readFile(resolve(commonRoot, "package.json"), "utf8"),
    );
    if (commonPackage.version !== "9.0.7")
      throw Error("audio_common_version_mismatch");
    await writeFile(
      resolve(out, "common.js"),
      (
        await readFile(
          resolve(commonRoot, "src/WASMAudioDecoderCommon.js"),
          "utf8",
        )
      ).replace('"simple-yenc"', '"./simple-yenc.js"'),
    );
    await writeFile(
      resolve(out, "simple-yenc.js"),
      await readFile(
        resolve(dirname(commonRequire.resolve("simple-yenc")), "esm.js"),
      ),
    );
    await writeFile(
      resolve(out, `${name}-core.js`),
      (await readFile(resolve(packageRoot, "src", core), "utf8"))
        .replace(
          'import { WASMAudioDecoderCommon } from "@wasm-audio-decoders/common";',
          'import WASMAudioDecoderCommon from "./common.js";',
        )
        .replace('"./EmscriptenWasm.js"', `"./${name}-emscripten.js"`)
        .replace('from "codec-parser"', 'from "./codec-parser/index.js"'),
    );
    await writeFile(
      resolve(out, `${name}-emscripten.js`),
      await readFile(resolve(packageRoot, "src/EmscriptenWasm.js")),
    );
    await writeFile(resolve(out, "package.json"), '{"type":"module"}\n');
    const { default: Common } = await import(
      pathToFileURL(resolve(out, "common.js")).href
    );
    const { default: Emscripten } = await import(
      pathToFileURL(resolve(out, `${name}-emscripten.js`)).href
    );
    new Common();
    new Emscripten(Common);
    await writeFile(
      resolve(out, `${name}.wasm`),
      await Common.inflateDynEncodeString(Emscripten.wasm),
    );
    await writeFile(
      resolve(out, `${name}-runtime.js`),
      `import wasm from './${name}.wasm';\nimport Decoder${name === "flac" ? ", {_FLACDecoder}" : ""} from './${name}-core.js';\n${name === "flac" ? "_FLACDecoder" : "Decoder"}.module=wasm;\nexport default Decoder;\n`,
    );
    await writeFile(
      resolve(out, `${name}-runtime.d.ts`),
      `export default class Decoder { constructor(options?:Record<string,unknown>); ready:Promise<void>; decode(bytes:Uint8Array):Promise<Decoded>; flush():Promise<Decoded>; decodeFrame(bytes:Uint8Array):Decoded; free():void; }\ninterface Decoded { channelData:Float32Array[];samplesDecoded:number;sampleRate:number;errors:unknown[];bitDepth?:number }\n`,
    );
    notices.push(
      `${pkg}@${version}: MIT wrapper; ${name === "opus" ? "libopus BSD-3-Clause" : "libFLAC BSD-3-Clause"}; source https://github.com/eshaz/wasm-audio-decoders\n`,
    );
  }
  notices.push(
    "@wasm-audio-decoders/common@9.0.7, simple-yenc@1.0.4: MIT; codec-parser@2.5.0: LGPL-3.0-or-later (original LICENSE/source retained under codec-parser/).\ncodec-parser/src/CodecParser.js patched: expose remaining nonempty buffered bytes immediately during EOF flush instead of yielding away the final short frame.\ncodec-parser/src/codecs/flac/FLACParser.js patched: retain verified nextHeader during EOF flush and cut at that proven boundary, including short final frames. Original source: https://github.com/eshaz/codec-parser/tree/v2.5.0\nBuild-time imports rerouted; runtime uses statically supplied WebAssembly.Module. No Worker, runtime compile, ML or network decoder loading.\n",
  );
  await writeFile(resolve(out, "SOURCE.txt"), notices.join(""));
  return out;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prepareAudioCodecs({
    dependencyRoot: process.env.HY_AUDIO_CODEC_DEPENDENCY_ROOT,
  });
