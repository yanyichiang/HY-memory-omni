# HY-memory-omni

Standalone multimodal memory by **YY**, based on [Tencent Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory). Unofficial derivative; not a Tencent product or endorsement.

Text, images, audio and video share source revisions, evidence links, conflict handling and conditional corrections. Original media stays available for retrieval and reinspection. Long videos support fixed/dynamic segmentation, grouped clip retrieval and separate cross-clip reasoning jobs. The service can be used from any agent through HTTP; it does not require an agent framework.

## Install and start

Prerequisites: **Node.js 22.22+**, npm, and [uv 0.13.4+](https://docs.astral.sh/uv/getting-started/installation/). Linux and macOS are the intended local platforms; the clean installation acceptance currently runs on Linux x64.

```sh
git clone git@github.com:yanyichiang/HY-memory-omni.git
cd HY-memory-omni
npm ci
npm run init
```

Edit `.hy-memory-omni/config.json`, filling its three `REPLACE_` entries:

- `CF_ACCOUNT_ID`: your Cloudflare account.
- `MEMORY_GATEWAY_ID`: your AI Gateway.
- `MEMORY_MODEL_TOKEN`: your **Cloudflare User API Token (CFUT)** with Workers AI Read and AI Gateway Run for that account.

The configured Gateway needs native Google embedding access for `gemini-embedding-2` (Google key stored in Gateway BYOK); the audio/video model uses Gateway Unified Billing. These provider routes require your own enabled access. The memory service API token is generated locally by `init`; it is separate from the Cloudflare token.

```sh
npm start
```

The first start installs the pinned Python Workers dependencies and builds the TypeScript Worker. Subsequent starts reuse Python dependencies and rebuild the small TS bundle. It starts the gateway, TS memory authority and Python Hy engine together at **http://127.0.0.1:8787**. There is no Python daemon, external database, Docker or FFmpeg runtime requirement. Python runs inside workerd. The Node launcher remains running while the service is in use.

The server uses **local Workers storage** under `.hy-memory-omni/storage` and makes configured model requests to Cloudflare. It does not deploy Workers or create cloud storage. Shut it down with Ctrl+C; restart from the same directory to retain memory. Back up the whole state directory while stopped. A lock prevents two processes opening it simultaneously. After an unclean exit, remove `runtime.lock` only after verifying its process is stopped.

`HY_HOME` changes the state directory; `HY_CONFIG` selects a different config file; `PORT` changes the local port. Configuration keys may be supplied as environment variables. Keep config files private and out of version control. `npm run setup` explicitly rebuilds the runtime dependencies without calling models. For restricted networks, `HY_PYODIDE_MIRROR` accepts the official uv Python-download mirror option; it must serve the corresponding official Pyodide assets.

## Use from an agent

An agent sends authenticated POST JSON requests. It cannot choose another owner or read the internal Python storage callback. One service instance represents one trusted owner and the personal scope; separate owners use separate config/state and credentials.

```js
import { readFile } from 'node:fs/promises';
const { HY_API_TOKEN } = JSON.parse(await readFile('.hy-memory-omni/config.json', 'utf8'));
const memory = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:8787${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
};
const written = await memory('/ingest-text', {
  operationId: 'note-001', sessionRef: 'chat-001', messageRef: 'message-001',
  text: 'The design review is on Saturday.',
});
const recalled = await memory('/search', { query: 'When is the design review?', sessionRef: 'chat-002' });
console.log(written.ref, recalled.items);
```

See [API examples](docs/API.md) for images/audio/video, pagination, source revisions and long-video jobs. Automatic recall and deciding when/where to write belong to your agent. Stored media or recalled text never grants tool permissions.

## Package and verification

```sh
npm run setup
npm run build
npm run typecheck
npm test
npm run test:install
# Existing memory regression tests:
npm run test:memory
# Source package; not an npm registry publication:
npm pack
```

The tarball contains source, npm-shrinkwrap/pylock pinned dependencies and licenses; it builds its runtime after installation. From a clean directory, `npm install /path/to/hy-memory-omni-0.1.0.tgz`, then use `npx --no-install hy-memory-omni init` and `npx --no-install hy-memory-omni start`.

`test:install` loads the production Python entrypoint through `npm start` and checks health/auth/storage. Its multimodal lifecycle arm runs real Workers, Hy Writer/Reader, SQLite and R2, with **synthetic models** (TS HTTP interception and the Python fixture model adapter). It is installation/integration evidence, not a new live-model quality benchmark. See [acceptance record](docs/ACCEPTANCE.md).

## Scope and license

There is no application-wide fixed 2,000-memory ceiling. Per-request paging, media format/size, context windows and underlying platform capacity still apply. Unsupported media fails explicitly; “omni” here covers the implemented text/image/audio/video inputs, not every possible file format or sensor. Cross-clip reasoning is distinct from clip grouping and can remain unresolved when evidence is insufficient.

[Apache-2.0](LICENSE) covers original project code; Tencent attribution is retained in [NOTICE](NOTICE) and [engine/UPSTREAM-LICENSE](engine/UPSTREAM-LICENSE). Third-party MPL/LGPL/MIT and Python dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This repository distributes source rather than a prebuilt decoder/runtime image.

The current repository is private for review. No npm registry package or managed hosted service is published.
