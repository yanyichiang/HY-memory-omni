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

`memory/scripts/prepare-mp3.mjs` changes only generated JavaScript import routing to omit Worker adapters. It does not change the upstream C implementation or WASM bytes. The adapter source is included, so recipients can inspect and reproduce these routing changes.

Mediabunny's preferred source form is available in the pinned npm archive above. Its MPL-covered files remain MPL-2.0, including any future modifications to those files. See [MPL 2.0 sections 3.1–3.3](https://www.mozilla.org/en-US/MPL/2.0/). Separate original project files are not thereby relicensed.

## Other installed dependencies

`package.json` and the repository lockfile identify JavaScript dependencies; `engine/pyproject.toml` and `engine/pylock.toml` identify Python dependencies and distribution URLs. These manifests do not grant a new license over those dependencies. A source checkout does not bundle the dependency distributions. Recipients install them from their upstream sources and retain their accompanying license files.

The Python lockfile includes annotated-types, anyio, distro, httpx, idna, jieba, jiter, json-repair, langdetect, numpy, openai, pydantic, pydantic-core, pyyaml, rank-bm25, six, sniffio, tqdm, typing-extensions, typing-inspection, and workers-runtime-sdk. Development tooling is separately declared in the package manifests. This list is an inventory, not a completed license review of a bundled runtime image; no blanket Apache-2.0 claim is made for it.

## Synthetic fixtures

The media in `memory/test/fixtures/` are project test fixtures described by [their provenance note](memory/test/fixtures/README.md) as generated frames and tones, without user recordings or production data. FFmpeg was used as a development tool and is not bundled. No FFmpeg program code is included by distributing its generated test media. Codec patent permissions are not granted by this project's copyright license.

## Building versus redistributing an executable

The current deliverable is a source repository. No `node_modules`, installed Python environment, generated decoder WASM, Worker bundle, model weights, or production data are part of this source distribution.

Before distributing a built bundle, container, installed environment, or decoder WASM (including privately to friends), inspect the actual included artifacts and preserve their notices. Specifically:

1. Provide recipients access to the exact MPL-covered preferred source form and any modifications; include the MPL notice and license with the artifact.
2. For mpg123 object/WASM redistribution, supply complete corresponding library source and compilation/install scripts through a method allowed by [LGPL-2.1 sections 4 and 6](https://github.com/madebr/mpg123/blob/08247b317163175e62035893af3ff9e71a5dfefd/COPYING). Where the combined executable requires it, supply the application source/object material needed to rebuild or relink against a modified library, and permit debugging such modifications. Preserve the license and copyright notices.
3. The pinned upstream links and import adapter document provenance, but do not alone establish that the selected binary has complete corresponding build inputs or that recipients can replace/relink the library. That evidence remains required before shipping a built artifact.
4. Inventory all actually bundled transitive npm/Python/native components and carry their required notices and source obligations. The source-only inventory above is not a binary-release clearance.

The authoritative terms are the component license texts. The project license does not add a restriction on rights granted by those licenses.
