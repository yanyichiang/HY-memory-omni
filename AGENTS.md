# HY-memory-omni

Standalone text/image/audio/video/document memory. Owner/release author: YY. This repository contains the open-source distribution; changing its visibility requires explicit Owner authorization. Do not publish an npm package, deploy resources, or migrate existing memory as part of ordinary source work.

The deliverable is a reusable, self-hosted open-source memory service for other users. Source distribution, npm publication and hosted deployment are separate release actions. The package's `private: true` prevents accidental npm publication and does not restrict source use under the included licenses. Each installation supplies its own model credentials, storage and trusted owner; the project does not provide a shared hosted service.

- Preserve original media, source revisions, independent evidence and linked claims. Conflict is not an automatic revision; revisions require evidence/authority. Whole-source rebuild is the current editing strategy.
- `memory/` is the TS authority and Workers storage, `engine/` is the stateless Python Hy Writer/Reader. `gateway/` authenticates a fixed owner. Do not accept caller-selected principals or expose the internal read callback.
- `npm start` is the unified local entry. Configuration and state are under `.hy-memory-omni/` (or HY_HOME); never commit them. Tests may replace model HTTP explicitly; production startup must load engine/src/main.py.
- Preserve pinned Tencent source and Apache attribution. Original changes are by YY under Apache-2.0. Third-party licenses and exact source pointers remain in NOTICE, THIRD_PARTY_NOTICES.md and memory/licenses/.
- Publish source only unless the actual bundled dependencies and binary redistribution obligations have been checked. No private upstream repository history, logs, media or machine paths belong in this repository.
- Verification: npm run build, npm run typecheck, npm test; npm run test:install exercises real workerd/Python with synthetic TS/Python model adapters. npm run test:memory retains existing regressions. Keep live-model and installation evidence distinct.
- For this development environment, heavy installation/build/full tests run on the authorized home machine; edit/light checks locally. Before Cloudflare resource work, establish project ownership and inspect every binding.
- Owner attribution in project code, documentation and package metadata is **YY**. Never introduce the Owner's legal name, personal email, private filesystem paths or credentials into tracked content, commit messages or published reports. Preserve third-party copyright names and contact addresses; they are not Owner identity data.
- For new commits and merges, explicitly set both author and committer to `YY <213390552+yanyichiang@users.noreply.github.com>` for that command; do not inherit the global Git identity. Before pushing, inspect the raw author and committer fields of the outgoing commits, including merges. A mailmap changes presentation, not stored identities.
- Create merges locally with the identity above. Do not use a GitHub-generated web/API merge unless its effective email privacy setting has been verified: GitHub uses account settings independently of local Git settings. Changing account settings or rewriting existing remote history requires separate Owner authorization. Do not rewrite upstream history or strip original copyright.
- Push development changes only to the verified `origin` release repository. If an `archive` remote is present, treat it as a read-only historical reference; do not push to it or mirror its refs into the release repository without explicit Owner authorization.
- Format expansion order approved by Owner: M4A/AAC, Ogg/Opus and FLAC; then WebM/MKV; then HEIC/AVIF/GIF; then PDF/Office. Preserve original binary evidence, sample/frame/page coordinates and derived representations. Animated inputs must retain their timeline; documents must retain page, image and layout relationships. Supporting a MIME label alone does not establish model or retrieval support.
- Office evidence uses native structure, as approved by Owner: DOCX sections/paragraphs/tables/drawing anchors and XLSX sheets/cell ranges/image anchors. Preserve their relationships and original binary; do not label these coordinates as Word/Excel print pages. PDF retains original page numbers and PPTX retains slide numbers.

## Documentation

- README.md is the Simplified Chinese landing page; README.en.md is its English counterpart. Keep language navigation, examples, supported capabilities and verification boundaries in sync.
- Use factual project badges for version, technology and license. Do not imply a published npm release, passing CI or production readiness without corresponding evidence.
