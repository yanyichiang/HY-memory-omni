# HY-memory-omni

Standalone text/image/audio/video memory. Owner/release author: YY. Keep the repository private until the Owner explicitly changes visibility. Do not publish an npm package, deploy resources, or migrate existing memory as part of ordinary source work.

The intended deliverable is a reusable, self-hosted open-source memory service for other users. The current private repository and npm publication restrictions are release authorization boundaries pending Owner review, not a permanent self-use-only product restriction. Each installation supplies its own model credentials, storage and trusted owner; the project does not provide a shared hosted service.

- Preserve original media, source revisions, independent evidence and linked claims. Conflict is not an automatic revision; revisions require evidence/authority. Whole-source rebuild is the current editing strategy.
- `memory/` is the TS authority and Workers storage, `engine/` is the stateless Python Hy Writer/Reader. `gateway/` authenticates a fixed owner. Do not accept caller-selected principals or expose the internal read callback.
- `npm start` is the unified local entry. Configuration and state are under `.hy-memory-omni/` (or HY_HOME); never commit them. Tests may replace model HTTP explicitly; production startup must load engine/src/main.py.
- Preserve pinned Tencent source and Apache attribution. Original changes are by YY under Apache-2.0. Third-party licenses and exact source pointers remain in NOTICE, THIRD_PARTY_NOTICES.md and memory/licenses/.
- Publish source only unless the actual bundled dependencies and binary redistribution obligations have been checked. No private upstream repository history, logs, media or machine paths belong in this repository.
- Verification: npm run build, npm run typecheck, npm test; npm run test:install exercises real workerd/Python with synthetic TS/Python model adapters. npm run test:memory retains existing regressions. Keep live-model and installation evidence distinct.
- For this development environment, heavy installation/build/full tests run on the authorized home machine; edit/light checks locally. Before Cloudflare resource work, establish project ownership and inspect every binding.
- Commit author and committer for this release repository: YY, using a non-identifying email. Do not rewrite upstream history or strip original copyright.
- Format expansion order approved by Owner: M4A/AAC, Ogg/Opus and FLAC; then WebM/MKV; then HEIC/AVIF/GIF; then PDF/Office. Preserve original binary evidence, sample/frame/page coordinates and derived representations. Animated inputs must retain their timeline; documents must retain page, image and layout relationships. Supporting a MIME label alone does not establish model or retrieval support.

## Documentation

- README.md is the Simplified Chinese landing page; README.en.md is its English counterpart. Keep language navigation, examples, supported capabilities and verification boundaries in sync.
- Use factual project badges for version, technology and license. Do not imply a published npm release, passing CI or production readiness without corresponding evidence.
