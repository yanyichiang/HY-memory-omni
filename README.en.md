<div align="center">

# HY-memory-omni

**Memory across modalities. Evidence you can trace.**

Standalone memory for AI agents · Text / Images / Audio / Video / PDF and Office Documents

<p>
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.1.0-6366f1?style=flat-square" alt="Version 0.1.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-22c55e?style=flat-square" alt="License Apache-2.0"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Node.js-22.22%2B-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22.22 or later"></a>
  <a href="memory/"><img src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="engine/"><img src="https://img.shields.io/badge/Python-3776ab?style=flat-square&logo=python&logoColor=white" alt="Python"></a>
  <a href="#how-it-runs"><img src="https://img.shields.io/badge/Cloudflare-Workers-f38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
</p>

[简体中文](README.md) · **English**

[Features](#features) · [Quick Start](#quick-start) · [Integration Examples](#integration-examples) · [API Reference](docs/API.md) · [Acceptance Record](docs/ACCEPTANCE.md)

</div>

---

**HY-memory-omni** builds on [Tencent Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory), bringing text, images, audio, video, and PDF / Office documents into a shared workflow for source management, evidence linking, conflict assessment, and revision governance. Developed and maintained by **YY**, it is an independent derivative project.

Original media and structured propositions coexist: retrieve memories, inspect their original evidence, or use the originals to extract, verify, and revise information again. Agents connect over HTTP, without a dependency on any particular agent framework.

> **Current version: 0.1.0.** Installation, startup, and lifecycle acceptance for all four modalities have been completed for the standalone source tree and npm source package. Validation for the new document path is recorded separately. The project currently provides a source repository and an npm source package; no npm registry package or hosted service has been published. See [Verification and Status](#verification-and-status) for the evidence scope.

## Features

| Capability | What it supports |
| --- | --- |
| 📝 **Text memory** | Ingest statements, retrieve related memories, and retain source and revision history |
| 🖼️ **Image memory** | PNG/JPEG/WebP plus bounded HEIC/AVIF/GIF; preserve originals and animation timing, and verify retrieval against media evidence |
| 🎧 **Audio memory** | Preserve original audio and time positions; retrieve speech and non-speech evidence |
| 🎬 **Video memory** | Process visuals and audio together and return time ranges traceable to the original video |
| 📄 **Document memory** | Preserve PDF pages, native Office paragraphs/tables/cells/slides and image anchors; form whole sources asynchronously and retain unparsed/unrendered coverage |
| 🔎 **Cross-modal retrieval** | Query with text or native media and connect evidence across modalities |
| 🧩 **Knowledge governance** | Link propositions across sources, identify conflicts, apply revisions when justified, and recompute eligibility after source revocation |
| 📦 **Standalone operation** | Start the authenticated gateway, memory service, and Python engine with one `npm start` |

### Original evidence and knowledge state are managed separately

- **Traceable evidence**: Original media, extraction results, structured propositions, and source revisions remain linked.
- **Preserved conflicts**: Conflicts remain when there is insufficient basis to supersede a claim; a newer timestamp alone does not grant revision authority.
- **Verifiable revisions**: Editing currently rebuilds the whole source and invalidates old references; memories can be checked again against the originals.
- **Propagated revocation**: Changes to source status affect facts, retrieval, and reasoning results that depend on it.

### Three levels of long-video support

| Level | Behavior |
| --- | --- |
| **Automatic segmentation** | Supports dynamic scene segmentation and fixed time windows, with chunked uploads for long videos |
| **Grouping by video** | Groups matching segments from the same original video while retaining separate timestamps and references for each segment |
| **Cross-segment reasoning** | Uses a separate task to integrate chronology and evidence, distinguishing proposals, objections, final decisions, and explicit revisions |

Grouping segments does not automatically produce a conclusion across them. Reasoning may remain unresolved when evidence or authority is insufficient.

## Quick Start

### 1. Prepare the environment

- **Node.js 22.22+** and npm.
- **[uv 0.13.4+](https://docs.astral.sh/uv/getting-started/installation/)** to prepare the pinned Python Workers dependencies.
- Your own working Cloudflare Workers AI, AI Gateway, and model access configuration.

Local operation targets Linux and macOS. Current clean-install acceptance was completed on **Linux x64**.

### 2. Install and initialize

```sh
git clone git@github.com:yanyichiang/HY-memory-omni.git
cd HY-memory-omni
npm ci
npm run init
```

Initialization creates `.hy-memory-omni/config.json` and a separate Memory API token. Edit the three `REPLACE_` values in the configuration file:

| Setting | Value |
| --- | --- |
| `CF_ACCOUNT_ID` | Your Cloudflare Account ID |
| `MEMORY_GATEWAY_ID` | Your AI Gateway ID |
| `MEMORY_MODEL_TOKEN` | A **Cloudflare User API Token (CFUT)** scoped to that account, with **Workers AI Read** and **AI Gateway Run** permissions |

The native multimodal embedding model, `gemini-embedding-2`, uses Gateway's native Google endpoint and requires a Google key configured through Gateway **BYOK**. Audio and video understanding models use Gateway **Unified Billing**. These routes require your own working access configuration.

`HY_API_TOKEN` authenticates agent requests to this memory service and is generated locally by initialization. It serves a different purpose from `MEMORY_MODEL_TOKEN`.

### 3. Start

```sh
npm start
```

Default endpoint: `http://127.0.0.1:8787`.

The first start installs the pinned Python Workers dependencies and builds the TypeScript Worker. Subsequent starts reuse the Python dependencies and rebuild the TS bundle. Keep the startup process running while using the service; press **Ctrl+C** to stop it.

<details>
<summary><strong>Install from an npm source package</strong></summary>

The repository also supports creating a source package with `npm pack`. In a new directory, run:

```sh
npm init -y
npm pkg set overrides.undici=7.30.1
npm install /path/to/hy-memory-omni-0.1.0.tgz
npx --no-install hy-memory-omni init
# Edit .hy-memory-omni/config.json
npx --no-install hy-memory-omni start
```

The source package includes source code, npm-shrinkwrap / pylock, and licenses. Runtime dependencies are prepared on the first start after installation. This project has not been published to the npm registry.

Set `overrides` in the consuming project’s root `package.json`. npm does not inherit overrides from dependencies; a local tarball install must not assume its bundled lockfile enforced them. The commands above pin the patched HTTP dependency. Source clones already contain this setting and use `npm ci`. See [npm’s override rules](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/#overrides).

</details>

## Integration Examples

### Ingest and recall text

```js
import { readFile } from 'node:fs/promises';

const { HY_API_TOKEN } = JSON.parse(
  await readFile('.hy-memory-omni/config.json', 'utf8'),
);

async function memory(path, body) {
  const response = await fetch(`http://127.0.0.1:8787${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HY_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

const written = await memory('/ingest-text', {
  operationId: 'note-001',
  sessionRef: 'chat-001',
  messageRef: 'message-001',
  text: 'The design review is scheduled for Saturday.',
});

const recalled = await memory('/search', {
  query: 'When is the design review?',
  sessionRef: 'chat-002',
});

console.log(written.ref, recalled.items);
```

### Ingest an image

Reuse the `memory` function above:

```js
const image = await readFile('example.png');
const saved = await memory('/ingest', {
  operationId: 'image-001',
  sessionRef: 'chat-001',
  messageRef: 'image-message-001',
  mimeType: 'image/png',
  dataBase64: image.toString('base64'),
});

const original = await memory('/read', { ref: saved.ref });
```

See the [API reference](docs/API.md) for complete examples covering audio, video, native media queries, revision, revocation, and long-video tasks. Your agent decides when to recall or write memories and where to write them. Memory content does not grant tool execution authority.

## How It Runs

| Component | Responsibility |
| --- | --- |
| `gateway/` | Bearer authentication, a fixed server-side identity, and public API routing |
| `memory/` | TypeScript memory authority, source and knowledge state, retrieval, SQLite Durable Objects, and R2 |
| `engine/` | Stateless Python Hy Writer / Reader, including pinned Tencent upstream source |
| `scripts/` | Dependency preparation, unified startup, and runtime process management |

`npm start` runs **Workers locally with Miniflare / workerd**; Python also executes inside workerd. Operating the service requires no separate Python daemon, external database, Docker, or FFmpeg. Model requests are sent to Cloudflare according to your configuration.

### Data and access

- Local persistent state lives in `.hy-memory-omni/storage`. Restart from the same directory to continue using it. For backups, stop the service first, then copy the entire state directory.
- The service listens on loopback only by default. Application APIs require the Memory API token; `/health` is the exception.
- Each instance serves one trusted Owner within the `personal` scope. Different Owners use separate configuration, state, and credentials. Callers cannot select another identity.
- A state lock prevents multiple processes from opening the same data simultaneously. After an abnormal exit, confirm that the original process has stopped before handling a leftover `runtime.lock`.
- Local startup does not deploy cloud resources. `npm run cloud -- init/plan/render/deploy` provides a separate installation path for the private engine, storage and authenticated gateway. Read the [deployment guide](docs/DEPLOY.md) first.

<details>
<summary><strong>Configuration overrides and setup options</strong></summary>

| Variable / command | Purpose |
| --- | --- |
| `HY_HOME` | Change the local state directory |
| `HY_CONFIG` | Select another configuration file |
| `PORT` | Change the local listening port |
| Environment variables matching configuration keys | Override values in the configuration file |
| `npm run setup` | Explicitly prepare runtime dependencies and build, without calling models |
| `HY_PYODIDE_MIRROR` | Use a Python download mirror supported by uv; it must provide the corresponding official Pyodide assets |

Keep configuration and credentials private and out of version control.

</details>

<details>
<summary><strong>First-install download failures and abnormal exits</strong></summary>

Run `npm run setup` separately and use uv's output to distinguish Pyodide downloads, Python package installation and build failures. Pyodide mirrors are already supported: `HY_PYODIDE_MIRROR` takes a **base URL** replacing the official releases/download prefix, not the full URL of an archive. Preserve the official version directories and asset names; a local `file:///absolute/path/to/mirror` is also supported. See the [official uv reference](https://docs.astral.sh/uv/reference/cli/#uv-python-install--pyodide-mirror). This project does not automatically switch to a third-party mirror.

When `npm start` receives a normal stop signal, it cancels active dependency preparation and waits for its child process to exit. Killing the supervisor forcibly or losing power can still leave `runtime.lock`. Do not remove it merely because its parent PID is gone: first verify that this instance's runtime/workerd children have also stopped. Stop normally with `Ctrl+C` in its terminal; this project has no separate `npm stop` command.

`/health` only reports that the HTTP entrypoint responds; the startup probe only checks Python loading. Neither establishes live CFUT, BYOK or Unified Billing authorization, or semantic retrieval quality.

</details>

## Verification and Status

| Verification target | Evidence for this version |
| --- | --- |
| Clean installation | Installation in a new directory, locked `npm ci`, Python dependency preparation, build, and type checking passed |
| Standalone npm package | Installation of the source package in a second empty directory, automatic dependency preparation, and startup verification passed |
| Unified startup | Production Python entrypoint loading, health checks, authentication, storage access, and graceful shutdown passed |
| Four-modality lifecycle | Ingest, restart, recall, original retrieval, revision, and revocation passed for text / images / audio / video |
| Access boundaries | Authentication, trusted identity injection, video chunking, and isolation of the internal read endpoint passed |

Four-modality lifecycle acceptance runs real workerd, Hy Writer / Reader, SQLite, and R2; **models use test adapters** (TS HTTP interception and Python fixture model adapters). These tests demonstrate standalone installation and component integration; the separate live-provider runs preserve first answers, failures and independent semantic review. See the [acceptance record](docs/ACCEPTANCE.md) for the full scope, issues encountered, and fixes.

### Live-provider acceptance

`npm run test:live` uses the configured real models, production Python entrypoint, authenticated gateway and independent temporary storage. Set `HY_LIVE_OUTPUT` to a new private directory. `HY_LIVE_PROFILE=knowledge`, `media` or `documents` selects the governance or audiovisual cases; the default is `all`. First API/model responses and usage are retained without automatic retry or failure overwrites. After machine checks, review answer meaning, native evidence and revision targets against the fixed script; the report explicitly records that semantic review is still required. The command invokes your models; never commit its output or credentials.

Cases cover cross-source conflict, explicit revision, withdrawal recomputation, original-image reinspection, native-media recall, recording segmentation/grouping and cross-clip conclusions. See the [acceptance record](docs/ACCEPTANCE.md) for executed results; these synthetic regression cases are not a general accuracy benchmark.

<details>
<summary><strong>Development and verification commands</strong></summary>

```sh
npm run setup
npm run build
npm run typecheck
npm test
npm run test:install
npm run test:memory
npm pack
```

`test:install` creates isolated temporary state; `test:memory` retains the existing memory regression tests. Installation may use tool download caches; a separate empty project-dependency-cache run verified downloads from the default sources, as recorded in acceptance. This is not a bare operating-system installation.

</details>

## Current Scope

- “omni” covers the implemented **text, image, audio, video, and PDF / Office documents** modalities. Supported media formats and codecs depend on the API.
- There is no application-level fixed **2,000-memory total limit**. Request pagination, media size, context windows, and underlying platform capacity retain their respective constraints.
- Retrieval returns a bounded candidate set. No hit does not prove that relevant evidence is absent; grouping segments by video also does not mean cross-segment reasoning has reached a conclusion.
- Cross-clip reasoning event timestamps are model estimates and may be inaccurate even when the conclusion is correct. New events identify this basis and the supplied media window; inspect native evidence through the archived `clipRef`.
- The current editing unit is a **whole-source rebuild**. Individual fact editing is not yet available.
- Audio supports PCM WAV, MP3, M4A / ADTS AAC-LC, HE-AAC and HE-AACv2, Ogg Opus, and native FLAC. AAC / Opus accept mono or stereo; FLAC preserves up to eight channels. Originals are retained; the new compressed formats use float32 WAV derivatives for understanding, media queries and embedding. Small derivatives must fit 8 MiB, and long-audio excerpts 4 MiB; use multipart ingestion when the inline bound is exceeded. See [compatibility](docs/MEDIA.md) for timing and rejection rules. Live calls passed M4A ingestion, Opus/AAC queries and the rebuild/revocation lifecycle; the historical FLAC query case passed a focused retest through current separate-query grounding, with the original failure retained in the [acceptance record](docs/ACCEPTANCE.md).
- Video also supports a restricted WebM / MKV subset: AVC, HEVC, VP9 or AV1 video, with at most one Opus, AAC or MP3 soundtrack. The original container is retained. Existing WASM decoders turn Opus / AAC into sample-trimmed float32 PCM, muxed with the original video packets into MOV for understanding, native queries and embedding; MP3 packets remain compressed. Existing inline, segmented-job and whole-source rebuild / revocation paths apply. PCM expansion can push a small original beyond the 8 MiB derivative bound; use `/video/upload`, and reduce `seconds` for oversized fixed clips. Each clip currently scans from the source beginning; AAC is fully decoded while only the window is retained. Format acceptance does not establish completed real semantic acceptance; see [compatibility](docs/MEDIA.md).
- PDF / DOCX / XLSX / PPTX preserve the original and asynchronously form native evidence units: PDF page visuals, PPTX slide shapes, DOCX paragraphs/tables/drawing anchors, and XLSX sheet ranges, formulas versus cached values, date system and image anchors. Structure and embedded images coexist with run formatting, style provenance, hidden flags and paragraph/table/cell/shape layout properties; unresolved formatting is explicitly marked. Cropped assets retain full-asset and unrendered-viewport indications; this is not a print renderer or complete Office conformance implementation. The root publishes only after all units finish, and whole-source rebuild/revocation applies to every child. Grouping is not cross-page reasoning; no document cross-page reasoning endpoint is provided. The 8 MiB / 128-native-unit limit (plus one optional Owner annotation) applies to each admission, not total corpus storage; query, PDF decode and ZIP expansion have [separate budgets](docs/MEDIA.md#pdf-and-office-documents). See the [acceptance record](docs/ACCEPTANCE.md) for real-model status.
- A local document correction adds an Owner annotation scoped to the current root while native units are observed again; it does not copy the correction into every page fact. Deterministically empty units retain readable locations without model calls or claims.
- Ordinary media ingestion accepts original files up to 8 MiB; audio lasts at most 180 seconds and short video at most 120 seconds. Media queries accept original files up to 2 MiB. Long videos use the job API; long audio uses its own multipart task API with fixed/dynamic segmentation, grouping and explicit cross-clip reasoning. Run `npm run inspect -- FILE` to check an export first; see [compatibility](docs/MEDIA.md) and [API documentation](docs/API.md) for formats and errors.

## Documentation and Contributions

- [API reference and examples](docs/API.md): Request formats, native media queries, revision governance, and video / document tasks.
- [Standalone installation acceptance record](docs/ACCEPTANCE.md): Verified behavior, failures and fixes, and verification boundaries.
- [Project working agreements](AGENTS.md): Component responsibilities, source governance, privacy, and release boundaries.
- [Third-party license notices](THIRD_PARTY_NOTICES.md): Dependency attribution, licenses, and distribution requirements.

When reporting an issue, include the version, minimal reproduction steps, and redacted error information. Update both the Chinese and English READMEs when changing behavior, and preserve the distinction between original evidence and test models.

## License and Acknowledgments

Original code and documentation are released by **YY** under [Apache-2.0](LICENSE). Thanks to [Tencent Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory) for the memory engine. Original attribution and licensing are preserved in [NOTICE](NOTICE) and [UPSTREAM-LICENSE](engine/UPSTREAM-LICENSE). This is an independent derivative project, without official Tencent endorsement or product affiliation.

Mediabunny, audio decoding components, and Python dependencies retain their respective MPL / LGPL / MIT and other licenses. See [third-party license notices](THIRD_PARTY_NOTICES.md). Distribution contains application source and an independently replaceable AAC WASM module, with complete corresponding source, build script and licenses; other decoders are generated from locked dependencies. Redistributing a complete runtime must retain the included components’ notices.



---

<div align="center">

**HY-memory-omni · Maintained by YY**

[Back to top](#hy-memory-omni) · [简体中文](README.md)

</div>
