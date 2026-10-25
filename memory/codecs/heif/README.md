# HEIF/AVIF decoder and corresponding source

This directory contains the unified static-WASM HEVC/AV1 decoder used by the image adapter. Original media must remain independently stored; returned RGBA8 pixels are provider derivatives, not lossless representations of the source.

## Files and versions

- `adapter.mjs`, `adapter.d.mts`: serialized JS API and types. Both imports resolve within this directory.
- `bridge.cpp`: thin C API implementation, including bounds, explicit item/sequence selection and bounded large-grid downsampling.
- `image-decoder.mjs`, `image-decoder.wasm`: generated Emscripten wrapper and the single unified decoder binary. Built with Emscripten **4.0.7**; no runtime WASM compilation, filesystem, network or threads are required.
- `sources/libheif-1.23.6.tar.gz`: official [libheif 1.23.6 release](https://github.com/strukturag/libheif/releases/tag/v1.23.6), [archive](https://github.com/strukturag/libheif/releases/download/v1.23.6/libheif-1.23.6.tar.gz).
- `sources/libde265-1.0.18.tar.gz`: official [libde265 1.0.18 release](https://github.com/strukturag/libde265/releases/tag/v1.0.18), [archive](https://github.com/strukturag/libde265/releases/download/v1.0.18/libde265-1.0.18.tar.gz).
- `sources/libaom-3.15.1.tar.gz`: official [AOM 3.15.1 archive](https://storage.googleapis.com/aom-releases/libaom-3.15.1.tar.gz).
- `patches/001-normative-hevc-filters.patch`: retains normative HEVC deblocking/SAO that upstream's Emscripten branch disables. It does not change threading.
- `patches/002-strict-identity-edit.patch`: recognizes one playback only for a single unit-rate, media_time=0, full-duration edit after equal movie/track clocks and sample-duration checks. Complex edits remain rejected; repetitions=0 is not generally interpreted as one. `patch-identity.py` is the original idempotent patch-generation aid; rebuild uses the supplied patch files.

Only HEVC/libde265 and AV1/AOM decoders are linked. Concrete encoders, other codec plugins, runtime plugin loading, header compression and parallel decoding are disabled in `build.sh`.

## API and bounds

The caller must hold the shared image-memory permit and serialize access to the cached module. `inspectImage(bytes)` enumerates all top-level items and tracks and distinguishes a single still, a collection and a visual sequence. Collections are not interpreted as animation. `imageFrames(bytes,{kind,index})` requires explicit selection and yields one copied frame at a time; native images, handles, context and input allocation are released on completion/error. Release each JS frame before requesting the next.

Sequence output carries integer `startTicks`, `durationTicks`, `timescale` and repetitions for one physical media cycle. Static items are untimed. No artificial zero-delay duration or implicit repeat unrolling is applied. Unavailable sequence source-depth/ICC metadata is `null`.

Input is limited to 8 MiB; ordinary images/sequence frames to 8 million pixels and side 8192; items/tiles/frames to 256 and tracks to 8. WASM memory starts at 16 MiB and has a 64 MiB hard maximum; configured native allocation budgets are 40 MiB per block and 48 MiB total. JS input/output buffers are additional memory. These limits do not establish a universal Worker 128 MiB peak guarantee.

Large static grids may have up to 16 million original pixels, provided the official API confirms more than one independently decodable tile, at most 256 tiles, at most 262144 pixels per tile, rectangular coverage and no transformed offsets/extra dimensions. Parent and tile headers must be opaque 8-bit, without ICC or geometric transformation; HDR transfer functions are rejected. Reported single-tile images and unsupported structures are rejected during inspection, before a full-image decode. The smallest integer sampling factor is chosen such that `ceil(width/factor) * ceil(height/factor) <= 4000000`. Each tile is released after copying nearest-neighbor samples at global coordinates, including final-edge crop. This is a bounded algorithm, not a fixture-size whitelist.

Inspection reports original item dimensions, expected output dimensions and downsampling. Frames report `originalWidth/Height`, actual `width/height` and sampling factor, actual X/Y size ratios, strategy and `providerDerived:true` when downsampled. The original is never replaced by this output.

Small images retain official libheif clap/irot/imir handling. Large-grid alpha/HDR/ICC/complex transformations are unsupported. RGBA8 uses libheif's SDR/sRGB-target conversion; source HDR, wide gamut or ICC fidelity is not claimed. Tested output may have no NCLX profile (`-1` fields).

## Evidence boundary

Actual workerd with static WASM and runtime compilation/network disabled decoded a 1×1 AVIF, both items of an HEIC collection, a rotated/transparent AVIF and all five frames of a tiny animated AVIF. The sequence clock matched independent FFmpeg; first-frame RGBA matched exactly and remaining frames differed by at most 1/channel. A 4032×3024 synthetic opaque normal HEIC grid decoded through the unified adapter to 2016×1512 with 16 MiB WASM heap. Other allowed large-grid geometries, HEVC sequences, broad malformed corpora and complete Worker peak memory are unmeasured. These are decoder feasibility checks, not provider semantic or complete product acceptance.

An earlier malformed-dimensions cleanup trap came from the bridge naming its C++ type `Decoder`, colliding with libheif's internal class. The bridge uses the unique `HyProbeImageDecoder`; controlled rejection followed by normal decode was verified in the same isolate. No cleanup is skipped.

## Offline rebuild and relink

Prerequisites supplied by the builder: an Emscripten 4.0.7 toolchain with its SDK/sysroot cache already populated, compatible Node, CMake, Ninja, Python 3, `tar`, and `patch`. The codec build does not download source or packages. Toolchain installation is separate from this offline codec rebuild.

```sh
EM_CONFIG=/absolute/path/to/emscripten-config.py \
EMSCRIPTEN_ROOT=/absolute/path/to/emscripten \
HEIF_BUILD_DIR=/absolute/path/to/an/empty/build-directory \
./build.sh
```

The script resolves its own location, extracts the supplied archives into the empty build directory, applies both patches and builds with at most 2 jobs. It writes the wrapper/WASM beside the adapter. If `HEIF_BUILD_DIR` is omitted it creates a fresh temporary directory and retains it, including static libraries, objects/build metadata and installed headers for inspection or relinking. No machine-specific path is embedded in the script. Different toolchain versions may change the binary; byte-identical output is not asserted.

The complete codec source archives, local modifications, bridge/application source and link invocation are provided, so a recipient can replace/modify the LGPL codec sources and rebuild/relink this decoder. No external download of codec source or undisclosed object is needed for that operation. The Emscripten/LLVM toolchain is a separately available general-purpose compiler environment; its version/source and runtime notice are identified below. Final distributions must retain this corresponding-source/relink material and applicable notices, rather than distributing only the WASM.

## Licenses

- libheif: LGPL-3.0-or-later library; `licenses/libheif-COPYING` and original archive notices. Sample/wrapper exceptions are recorded in that upstream file.
- libde265: LGPL-3.0-or-later library; `licenses/libde265-COPYING` and original archive notices.
- AOM: BSD-2-Clause plus the separate patent grant; `licenses/libaom-LICENSE`, `licenses/libaom-PATENTS`.
- Emscripten generated support code: MIT / University of Illinois-NCSA alternatives, `licenses/emscripten-LICENSE`; [official 4.0.7 source](https://github.com/emscripten-core/emscripten/tree/4.0.7). Runtime notices also retained here: `licenses/libcxx-LICENSE.TXT`, `licenses/libcxxabi-LICENSE.TXT`, `licenses/compiler-rt-LICENSE.TXT`, `licenses/musl-COPYRIGHT` (from that same Emscripten source tree).

This bundle does not grant patent rights beyond upstream grants or establish that every external distribution arrangement satisfies its licensing obligations. It supplies the actual codec source, modifications and relinking route rather than replacing them with a notice or source URL alone.
