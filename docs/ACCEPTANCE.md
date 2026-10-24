# Standalone acceptance — 2026-10-24

## Scope

The standalone source tree includes the TS memory authority, authenticated HTTP gateway, pinned Tencent Python core, Workers runtime launcher and source-only npm packaging. It requires no agent-framework checkout or separate Hy checkout. Publication remains private; this is not an npm-registry release or a cloud deployment.

## Executed verification

Linux x64, Node 22.23.4, uv 0.13.4, workers-py 1.17.9. A new project directory had no node_modules, python_modules or memory state before installation. Tool/download caches were available; this was not an empty operating system or a no-cache download test.

- Fresh npm dependency installation, locked `npm ci`, Worker build and TypeScript typecheck passed.
- Five gateway behavior tests passed: authentication/configuration, fixed owner injection, route boundary, bounded JSON and raw-part metadata/length validation.
- `npm run setup` created a new Python dependency tree from the shipped pylock: 21 locked runtime distributions. No old project's Python dependency directory was copied.
- The actual `npm start` command loaded production `engine/src/main.py` through a model-free startup probe, served health, rejected unauthenticated requests, accessed persistent storage and stopped cleanly without a leftover lock.
- Text, image, audio and video each passed authenticated ingestion, runtime restart, actual Hy Reader retrieval, original-byte readback, correction, invalidation of old refs and revocation. Search after revocation returned no eligible result.
- Raw video multipart upload passed through the public authenticated gateway; caller-supplied principal headers were replaced, and `/read-store` remained inaccessible.

The lifecycle test runs actual workerd, SQLite Durable Objects, R2 emulation and the original Hy Writer/Reader. TS model requests use HTTP interception; Python uses the explicit fixture model adapter and httpx MockTransport. It does not measure current provider/model semantic quality and does not place live model calls. The production startup probe proves Python imports and dependency packaging, not provider authorization.

## Packed installation

`npm pack` produced a source-only tarball. A second empty directory installed it with npm (39 dependency packages), without a copy of node_modules/python_modules or a link to the source checkout. The package's `npm start` automatically prepared Python dependencies and built its Worker, passed the production Python probe and health/auth/storage checks, then shut down cleanly. The installed `npx --no-install hy-memory-omni init` entry also passed. No npm registry publication was made.

## Installation failures found and fixed

1. The default Pyodide download stalled in the test network. Installation continued using a cached copy of the same official Pyodide asset via uv's supported `--pyodide-mirror` option. The first wrapper passed that option incorrectly to pywrangler; setup now invokes `uv python install` for the optional mirror, then pinned `pywrangler sync --allow-build`. The failure was not relabeled as a clean default-network download.
2. Miniflare's synchronous signal exit hook bypassed the launcher's asynchronous cleanup, leaving a state lock after normal termination. The launcher now owns the lock in a parent process and supervises Miniflare in an IPC child. It releases the lock after actual child exit. The process-group SIGTERM case passed after this change.
3. Independent review found configuration accepted owner identifiers longer than the gateway/core. Both now use the existing 160-character limit. Review of the final supervisor, gateway, callbacks and documentation found no remaining blocker within this delivery scope.

## Source and attribution review

The 132 vendored Tencent Python files match pinned upstream revision `4c311b2e935ef76a72e568adbb312c155bd4c1a1`; integration code remains outside that directory. Original release attribution is YY. Apache-2.0 and Tencent notices are preserved, along with media dependency notices and source/build provenance. No bundled-runtime redistribution clearance is claimed: the npm tarball distributes source and manifests, not generated WASM or installed dependencies.

Source review found no private project links, personal host paths, account credentials or production media. Fixture container metadata contains codec/tool metadata, not personal identifiers. The scripted synthetic meeting is identified separately from generated frames/tones. Package inspection excludes state, credentials, node_modules, python_modules, build outputs and generated WASM.

## Reproduce

```sh
npm ci
npm run setup
npm run build
npm run typecheck
npm test
npm run test:install
npm pack
```

`npm run test:install` creates isolated temporary state and synthetic credentials. `HY_PACKAGE_ROOT` can point it at an installed package; `HY_STARTUP_ONLY=1` exercises startup/shutdown without repeating the lifecycle suite. Existing memory regression tests remain available through `npm run test:memory`; the unchanged core's full semantic benchmark was not rerun as a substitute for standalone installation acceptance.

## Review follow-up — 2026-10-24

Two concrete recovery defects were addressed after reviewing installation and API constraints:

1. A stop signal delivered only to the launcher while setup was running did not cancel its preparation subprocess. Both `start` and standalone `setup` now propagate cancellation to their own preparation process group, wait for it to disappear and stop subsequent stages. A direct child's exit does not count as the whole group's exit. After a bounded TERM/KILL sequence, an unconfirmed group produces an explicit error and keeps the runtime lock. A forced kill of the supervisor itself still requires manual inspection; stale locks are not automatically removed.
2. A successful `/video/recover` marked the old job superseded before a caller could safely replay a lost HTTP response. Recovery now binds the new operation to the previous operation, task kind, original reference and query. Identical replays return the established status without another revision or model call; mismatched requests are rejected and a receipt without a job remains unknown. Late results from superseded work remain fenced.

Verification used Linux x64 and Node 22.23.4 in an isolated source checkout with existing locked npm dependencies. Build and typecheck passed. The video manager, real workerd multipart test and gateway suites passed 21 tests. The final setup suite passed seven tests on Linux and macOS, including parent-only SIGTERM for the actual CLI, standalone setup cancellation, and a process-group leader exiting before a TERM-resistant descendant. Independent static review identified two intermediate cancellation regressions; both were fixed and the final increment had no remaining reported blocker.

No default-network cold download or new live-model semantic evaluation was performed in this follow-up. Local documentation links and `git diff --check` passed. Documentation now specifies Base64-decoded original file sizes, audio/video duration and codec limits, actual job states, the distinction between status polling and stepping, and the lack of a long-audio ingestion path.

Remaining usability work includes a release-specific live-provider/semantic acceptance workflow, long-audio ingestion, clearer input compatibility diagnostics, and a complete authenticated cloud deployment path if cloud installation is offered. Semantic search remains bounded; `/sources` and `/knowledge` provide their own pagination. Owner identity limits, stale-ref rejection, explicit unknown recovery, loopback and internal-entrypoint isolation are intentional protections, not defects to remove. Current private/npm publication restrictions govern this project's release authorization, not whether other users may eventually self-host it.
