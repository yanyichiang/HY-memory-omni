# AAC codec module

This is an independent, replaceable LGPL-2.1-or-later WebAssembly module using the **unmodified native FFmpeg 9.0 AAC decoder**. The thin `decoder-wrapper.c` API bridge is also LGPL-2.1-or-later, copyright 2026 YY. It is not FAAD2, a GPL decoder, or an external FFmpeg process.

## Included source and licenses

- `source/ffmpeg-9.0.tar.xz` is the complete official source release from <https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz>. It retains the original copyright notices, license texts and optional components. Only the configured AAC decoder/parser, libavcodec and libavutil are linked.
- `COPYING.LGPLv2.1` and `FFMPEG-LICENSE.md` retain the license and exact upstream component rules. The actual build's `config.h` says `LGPL version 2.1 or later`, `CONFIG_GPL=0`, `CONFIG_NONFREE=0`, `CONFIG_VERSION3=0`; `config_components.h` enables AAC decoder and AAC parser.
- `EMSCRIPTEN-LICENSE.txt` and `licenses/` retain Emscripten, musl libc, compiler-rt, libc++abi and allocator notices used by the generated runtime. Emscripten 4.0.7 release commit is `8dc91db45bf96c174531006839472a3924d105aa`.
- Generated `aac-decoder.mjs` is the Emscripten loader; `aac-decoder.wasm` contains FFmpeg and its runtime. The application statically imports the Wasm module and supplies `instantiateWasm`; no runtime compilation, Worker creation, filesystem, network fetch, threads or Node API is needed.

The application source is separate from this module. Replace both artifact files together after rebuilding; preserve the same C exports and float32 interleaved output ABI. `aac-decoder.d.mts` documents that interface. The complete FFmpeg source and bridge are provided alongside the binary so the library can be modified and rebuilt. These are the identified software license terms; this record does not claim an exhaustive legal or codec patent clearance.

## Explicit developer rebuild

Normal npm installation and build use the committed small artifacts and **do not download an SDK or run emcc**. `memory/scripts/build-aac-codec.sh` records every configure and link flag and writes only to a caller-selected build directory.

Use isolated Emscripten **4.0.7**, Node, Python 3 and make. The official Linux x64 SDK used for this build is <https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/ef4e9cedeac3332e4738087567552063f4f250d3/wasm-binaries.tar.xz>. Extract its `install/` contents into a task directory. Set `EM_CONFIG` to a task-local config specifying `LLVM_ROOT` as its `bin/`, `BINARYEN_ROOT` as its root, `NODE_JS` as the existing Node executable, and `CACHE` as a task-local cache. No global SDK activation is needed.

```sh
AAC_BUILD_DIR=/absolute/isolated/build \
AAC_EMSCRIPTEN_ROOT=/absolute/isolated/toolchain/emscripten \
EM_CONFIG=/absolute/isolated/emscripten-config.py \
sh memory/scripts/build-aac-codec.sh
```

The script disables autodetection (including SDL), external codecs, network, threads, CLI, demux/mux, filters, GPL and nonfree components. It links only AAC decoder/parser plus supporting native FFmpeg utilities. `ENVIRONMENT=web` avoids Emscripten's worker-shell assumption that `self.location` exists, which does not hold in workerd. Memory starts at 16 MiB and may grow to 64 MiB. The bridge accepts at most stereo float-planar decoder output and exposes it as interleaved float32. The TypeScript adapter accepts 7350–96000 Hz and checks every decoded sample for finiteness.

## Container and timing contract

Accepted decoder profiles are AAC-LC, HE-AAC and HE-AACv2, confirmed using self-generated LC and AudioToolbox HE/v2 fixtures in actual workerd. FFmpeg's other AAC profiles (Main, LTP, LD/ELD, USAC, etc.) are not enabled as product support by this adapter. The decoded FFmpeg profile is checked; an ASC object type of 2 alone does not prove absence of implicit SBR/PS.

`audio/mp4` is limited to a nonfragmented M4A with one AAC audio track, one sample description, and either no edit or one nonnegative, unit-rate edit. Multiple edits, empty edits, changed playback rate, encrypted/fragmented tracks, multiple tracks, incomplete boxes and changing packet format are rejected. `moov` payload is bounded to 1 MiB **before** Mediabunny allocates it; declared raw packet sizes are prechecked at 64 KiB. Custom reads are bounded at 1 MiB, delivered in at most 64 KiB source reads.

For M4A, decoding starts at the original first compressed packet, including negative presentation timestamps needed for decoder priming/history. Samples before presentation zero are discarded. The single edit's duration is an upper bound for end trimming in the movie clock. A final movie-clock rounding difference of at most one tick, capped at 1 ms, may exceed the physical final sample; it never creates zero padding. Movie-clock ends may fall between samples; the adapter rounds that bound up and clamps it to the physical decoded end. Samples are copied from their original presentation positions. Explicit single-edit end trimming is tested separately from decoder success.

`audio/aac` accepts sequential ADTS frames with stable rate/channel/header configuration and one raw data block per frame. CRC-protected ADTS is rejected rather than accepted without checking its CRC. ADTS has no M4A edit/gapless metadata: **all decoded transport samples, including encoder priming and end padding, remain in its timeline**. ADTS duration is not asserted to equal the source WAV duration.

Derived WAV uses little-endian IEEE float32, a `fact` chunk, and the source sample rate/channel count. It does not quantize tiny nonzero samples into digital silence. Range slices preserve sample identity and expose logical range, actual sample-aligned range, offset, and source timeline. Original compressed bytes are unchanged. Caller holds the common audio permit. Slice currently revalidates and decodes the full source even when passed the optional internal `validatedSource` hint; it does not yet use that hint for a prefix-only optimization.

## Verification

`memory/test/aac-workerd.test.mjs` bundles the actual adapter, this committed module and the shared production WAV helper into Miniflare/workerd. Runtime Wasm compilation functions are replaced with throwing functions. It verifies LC/HE/v2 M4A and ADTS, exact decoded sample counts, presentation timing, float WAV fields, byte-identical range and tail slices, unchanged originals, final-byte truncation, unsupported edits/tracks, and 1 GiB virtual metadata rejected after bounded header reads.

LC fixture: 2 s generated 440 Hz mono at 48 kHz, native FFmpeg AAC encoder, 96 kbit/s. M4A presents 96000 samples after its 1024-sample priming and end trim. Its remuxed ADTS presents all 97280 encoded samples.

HE and HEv2 fixtures: the same generated 440 Hz signal at 48 kHz stereo, AudioToolbox `aac_at` profiles 4 and 28, respectively 48 and 32 kbit/s. Their container declares 2090 ms; their physical presentation covers 100288 samples (2089.333… ms) after 2112 priming samples. Their remuxed ADTS presents all 102400 samples. The 2 s input signal is not used as proof of their encoded container duration.

Fixtures establish codec/container/sample behavior, not model transcription quality, remote provider acceptance, deployment behavior or long-file performance. No model was called and no production data was touched.
