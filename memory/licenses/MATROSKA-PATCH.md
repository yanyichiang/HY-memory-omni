# Mediabunny Matroska metadata adaptation

This adaptation applies only to the locked `mediabunny@1.62.1` npm package:
https://registry.npmjs.org/mediabunny/-/mediabunny-1.62.1.tgz
Upstream: https://github.com/Vanilagy/mediabunny . The original source copyright
headers and MPL-2.0 license remain in the generated source tree. The modified
source files remain subject to MPL-2.0; this patch does not relicense them.

`memory/scripts/prepare-matroska.mjs` exports `prepareMatroska(options)` and
returns the absolute generated `src/index.ts` entry for the build's explicit
alias. Running it directly prints that path. It verifies the installed version
and the exact occurrence count of every replaced source fragment before writing
the changed files. Repeated generation starts from the original installed npm
source, never from an already patched tree. No network, native compiler or
runtime decoder is invoked.

The npm tarball contains `src/`, but not the `../shared` TypeScript tree its
source imports, nor its root tsconfig. The preparation copies the package's
unchanged `dist/modules/shared` JavaScript/declarations to generated `shared/`
and supplies an empty generated root tsconfig for `src/tsconfig.json` to extend.
This preserves upstream codec implementations rather than reconstructing them.
The generated package metadata preserves the original browser map and sideEffects
flag. In 1.62.1 that map disables src/node.ts and node:fs/promises for browser
bundles; the adapter verifies these entries before copying them. It does not mark
Node APIs external or provide replacement host functionality.
The source entry must be bundled for ES2022 (as the existing build does), so
upstream explicit resource management is lowered for the supported runtime.

## Added metadata, unchanged packet timing

Each Matroska packet receives optional `sideData.matroska`:

- `codecDelayNs`, `seekPreRollNs`: TrackEntry values, default zero.
- `discardPaddingNs`: signed BlockGroup value, default zero.
- `trackNumber`: the upstream TrackNumber identity.
- `timestampScaleNs`: Segment TimestampScale, including the upstream default.

Nanosecond fields are parsed using the upstream unsigned BigInt reader and
explicit two's complement for signed DiscardPadding. Values outside JavaScript's
safe integer range fail rather than round. This metadata does not alter
`packet.timestamp`, `packet.duration`, codec descriptions or encoded bytes.

BlockGroup children may occur in any order. A bounded two-pass scan using the
upstream EBML header reader first locates exactly one Block, parses it through
the upstream traversal, then traverses all other children in original order.
The upstream element nesting limit is retained. There is no additional child array or payload copy. Invalid/missing/duplicate
Block framing fails. This also binds existing BlockDuration, ReferenceBlock and
BlockAdditions correctly when they precede Block.

Upstream lacing expansion is retained. Negative DiscardPadding is carried only
by the first expanded packet; positive DiscardPadding only by the last. Other
expanded packets receive zero. The full signed value is retained on that edge,
not silently capped to the individual frame's duration. The caller must validate
and apply its presentation meaning; it must not apply the Block's trim once per
laced frame.

This is not complete Opus remux support. CodecDelay conversion, aggregate seek
preroll, valid sample windows, resource pre-scan and output clock mapping belong
to the consuming adapter. HY physically crops decoded Opus/AAC PCM and writes it
alongside copied video packets in MOV; it does not rely on an Opus-in-MP4 edit
list to remove decoded head/tail padding.

## Focused validation

On the isolated home Node 22.23.4 environment, generation from the real locked
npm package and ES2022 source bundling passed. A synthetic two-frame fixed-laced
Opus BlockGroup placed DiscardPadding and BlockDuration before Block. Positive
and negative 5,000,000,000 ns values survived exactly and appeared only on the
appropriate edge packet; packet PTS/durations stayed 0/20 ms and 20/20 ms.
CodecDelay 6,500,000 ns, SeekPreRoll 80,000,000 ns, TrackNumber and TimestampScale
were present. Unsafe 9,007,199,254,740,992 ns was explicitly rejected.

The first bundle attempt exposed the npm package's missing shared/ source; the
preparation now copies its shipped shared implementation. A subsequent probe
initially omitted an ES2022 target and encountered upstream `using` syntax in
Node 22; using the existing build target resolved it. No model, production data,
media decoding or heavy compilation was used. This probe proves metadata
transport, not presentation accuracy, model acceptance or complete remux safety.

A later integration browser build exposed the initially omitted package browser
map. The generated package now preserves that upstream map; a real platform=browser
ES2022 source bundle passed with no Node imports or externals.
