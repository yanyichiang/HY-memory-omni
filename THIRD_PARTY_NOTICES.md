# Third-party notices

HY-memory-omni original code and documentation are Copyright 2026 YY and licensed under [Apache-2.0](LICENSE). This does not relicense third-party code, dependencies, media, or model outputs. Keep this file, `NOTICE`, and the relevant license files with source distributions.

## Vendored Hy-Memory

- Project: [Tencent-Hunyuan/Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory).
- Revision: `4c311b2e935ef76a72e568adbb312c155bd4c1a1`.
- Location: `engine/src/hy_memory/` (132 Python files, unchanged from the pinned upstream tree at initial extraction).
- Copyright (C) 2026 Tencent. All rights reserved.
- License: Apache-2.0. The original Tencent preamble and license are preserved in [`engine/UPSTREAM-LICENSE`](engine/UPSTREAM-LICENSE).
- Integration changes: standalone TypeScript service, storage adapters, transport and deployment/build configuration are outside the vendored tree. No changes to the vendored Python files are claimed.
- Scope: this source copy contains Python code only; no upstream model weights, datasets, benchmark corpora, `memhub` application, or its bundled dependencies are included. This notice does not grant rights to separately obtained models or datasets.

## Media dependencies

These packages are declared dependencies, installed by the recipient. They are not copied into the clean source tree. Their licenses continue to apply if they are later included in generated output.

| Component | Version | License | Attribution and source |
| --- | --- | --- | --- |
| Mediabunny | 1.62.1 | MPL-2.0 | Copyright (c) 2026-present, Vanilagy and contributors; [package source archive](https://registry.npmjs.org/mediabunny/-/mediabunny-1.62.1.tgz), including `src/`; [license copy](docs/licenses/mediabunny-MPL-2.0.txt) |
| mpg123-decoder JavaScript wrapper | 1.0.3 | MIT | [wrapper and common attribution](memory/licenses/wasm-audio-decoders-MIT.txt); [pinned sources](memory/licenses/SOURCES.json) |
| @wasm-audio-decoders/common | 9.0.7 | MIT | [wrapper and common attribution](memory/licenses/wasm-audio-decoders-MIT.txt); [pinned sources](memory/licenses/SOURCES.json) |
| simple-yenc | 1.0.4 | MIT | [original license](memory/licenses/simple-yenc-LICENSE.txt); [pinned sources](memory/licenses/SOURCES.json) |
| mpg123 C library compiled into decoder WASM | revision `08247b317163175e62035893af3ff9e71a5dfefd` | LGPL-2.1 | Copyright (c) 1995-2020 by Michael Hipp and others; [COPYING, including license texts](memory/licenses/mpg123-COPYING.txt); [source/build provenance](memory/licenses/SOURCES.json) |
| opus-decoder / libopus | wrapper 0.7.12; native revision `ddbe48383984d56acd9e1ab6a090c54ca6b735a6` | MIT wrapper; native BSD-style terms | [wrapper notice](memory/licenses/wasm-audio-decoders-MIT.txt), [libopus COPYING](memory/licenses/opus-COPYING.txt), [exact sources](memory/licenses/SOURCES.json) |
| @wasm-audio-decoders/flac / libFLAC | wrapper 0.2.11; native revision `1507800de4b70e21be71f38caa0d9079d0bc6e45` | MIT wrapper; native BSD-3-Clause | [wrapper notice](memory/licenses/wasm-audio-decoders-MIT.txt), [libFLAC COPYING.Xiph](memory/licenses/flac-COPYING.Xiph.txt), [exact sources](memory/licenses/SOURCES.json) |
| codec-parser | 2.5.0 | LGPL-3.0-or-later | [LGPL text](memory/licenses/codec-parser-LGPL-3.0.txt), [referenced GPL text](memory/licenses/GPL-3.0.txt), [exact package and modification provenance](memory/licenses/SOURCES.json) |

`memory/scripts/prepare-mp3.mjs` changes only generated JavaScript import routing to omit Worker adapters. It does not change the upstream C implementation or WASM bytes. The adapter source is included, so recipients can inspect and reproduce these routing changes.

`memory/scripts/prepare-audio-codecs.mjs` likewise supplies static Opus/FLAC WASM modules without changing their decoder algorithms. Its generated copy of `codec-parser@2.5.0` has two documented EOF handling fixes: it retains a short final FLAC frame and respects a verified next-frame boundary while flushing. The fixed source is produced from the pinned original package using the included explicit transformations and retains the LGPL license. The wrapper's MIT license does not relicense this parser.

`memory/scripts/prepare-matroska.mjs` creates a version-checked adaptation of Mediabunny 1.62.1 in `memory/.generated/mediabunny/`. It exports raw CodecDelay, SeekPreRoll and DiscardPadding metadata through packet side data and preserves the upstream packet bytes/timestamps. The generated modified source retains its original copyright headers and MPL-2.0 license; it is not relicensed under Apache-2.0. The preparation script, pinned upstream source archive and [modification record](memory/licenses/MATROSKA-PATCH.md) identify how to reproduce the source. Distributors of the generated executable must provide the corresponding generated MPL-covered source and notices under MPL-2.0. The separate HY Matroska adapter and PCM helpers interpret these fields and reuse the already listed Opus/AAC libraries; no new codec encoder or external transcoding service is introduced.

## Included AAC decoder

`memory/codecs/aac/` contains an independent, replaceable FFmpeg 9.0 AAC decoder module, its C bridge, complete corresponding FFmpeg source archive, license texts and build instructions. This is a deliberate binary exception to the otherwise source-based application distribution. The decoder is built with GPL/nonfree components disabled and without FFmpeg's CLI, networking, demuxers or external codec libraries. Its library license is LGPL-2.1-or-later; it is not covered by this project's Apache notice. Emscripten-generated glue and runtime notices are included alongside it.

Recipients may rebuild or replace this module and debug such modifications. The application and bridge source, [rebuild script](memory/scripts/build-aac-codec.sh), and complete library source are supplied for this purpose. Normal `npm run setup` uses the included module; rebuilding it is an explicit development operation and does not install or activate a system SDK.

Mediabunny's preferred source form is available in the pinned npm archive above. Its MPL-covered files remain MPL-2.0, including any future modifications to those files. See [MPL 2.0 sections 3.1–3.3](https://www.mozilla.org/en-US/MPL/2.0/). Separate original project files are not thereby relicensed.

## Other installed dependencies

`package.json` and the repository lockfile identify JavaScript dependencies; `engine/pyproject.toml` and `engine/pylock.toml` identify Python dependencies and distribution URLs. These manifests do not grant a new license over those dependencies. A source checkout does not bundle the dependency distributions. Recipients install them from their upstream sources and retain their accompanying license files.

The Python lockfile includes annotated-types, anyio, distro, httpx, idna, jieba, jiter, json-repair, langdetect, numpy, openai, pydantic, pydantic-core, pyyaml, rank-bm25, six, sniffio, tqdm, typing-extensions, typing-inspection, and workers-runtime-sdk. Development tooling is separately declared in the package manifests. This list is an inventory, not a completed license review of a bundled runtime image; no blanket Apache-2.0 claim is made for it.

## Synthetic fixtures

The media in `memory/test/fixtures/` and `test/live-fixtures/` are synthetic project fixtures: generated frames/tones, meeting notices and scripted meeting speech. Their [media provenance](memory/test/fixtures/README.md) and [live-case provenance](test/live-fixtures/README.md) identify the content; they contain no user recordings or production data. The FFmpeg command-line program was used as a development tool and is not bundled. Distributing its generated test media does not itself include FFmpeg program code; the separately included AAC library module and its source are documented above. Codec patent permissions are not granted by this project's copyright license.

## Building versus redistributing an executable

The current deliverable contains application source plus the separately documented AAC decoder above. No `node_modules`, installed Python environment, generated npm decoder WASM, Worker bundle, model weights, or production data are included.

Before distributing a built bundle, container, installed environment, or decoder WASM (including privately to friends), inspect the actual included artifacts and preserve their notices. Specifically:

1. Provide recipients access to the exact MPL-covered preferred source form and any modifications; include the MPL notice and license with the artifact.
2. For mpg123 object/WASM redistribution, supply complete corresponding library source and compilation/install scripts through a method allowed by [LGPL-2.1 sections 4 and 6](https://github.com/madebr/mpg123/blob/08247b317163175e62035893af3ff9e71a5dfefd/COPYING). Where the combined executable requires it, supply the application source/object material needed to rebuild or relink against a modified library, and permit debugging such modifications. Preserve the license and copyright notices.
3. The pinned upstream links and import adapter document provenance, but do not alone establish that the selected binary has complete corresponding build inputs or that recipients can replace/relink the library. That evidence remains required before shipping a built artifact.
4. Inventory all actually bundled transitive npm/Python/native components and carry their required notices and source obligations. The source-only inventory above is not a binary-release clearance.

The authoritative terms are the component license texts. The project license does not add a restriction on rights granted by those licenses.
