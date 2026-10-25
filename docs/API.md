# HTTP API

Use `Authorization: Bearer <HY_API_TOKEN>` on every application request. JSON endpoints use POST with `Content-Type: application/json`. `/health` is an unauthenticated GET. The gateway always supplies its configured owner and personal scope. Only give the API token to agents allowed to read, correct and revoke that owner's memory.

The following examples use the `memory(path, body)` helper from the README. Preserve the complete returned `ref` (`sourceId`, `revision`, `mediaRef`); do not reconstruct it or substitute the latest revision silently.

## Images, audio and short videos

Image MIME types include PNG/JPEG/WebP and bounded HEIC/HEIF/AVIF/GIF. Animated images retain `timeline.animation`; `/read.representation` describes derived dimensions, timing and color/matte changes. Animation search groundings return `basis: "source-frame"` and `frames: {startIndex,endIndex,startMs,endMs}`. These exact decoded boundaries are selected by the model; integer `startMs/endMs` cover them for the existing read API. Zero-hold frames have no displayed interval. See [media limits](MEDIA.md#heic-avif-and-gif).

```js
const bytes = await readFile('example.png');
const saved = await memory('/ingest', {
  operationId: 'image-001', sessionRef: 'chat-001', messageRef: 'image-message-001',
  mimeType: 'image/png', dataBase64: bytes.toString('base64'),
});
const found = await memory('/search', { query: 'Find the blue sign', sessionRef: 'chat-002', limit: 5 });
const original = await memory('/read', { ref: saved.ref });
```

Use the same path for supported audio/video MIME types. Small-media ingestion accepts at most 8 MiB of **Base64-decoded original file bytes**: this is the uploaded file size before Base64 encoding, not its decoded PCM or video-frame size. Media search queries have a separate 2 MiB original-file limit. M4A/AAC, Ogg Opus and FLAC also require the complete float32 WAV derivative to fit 8 MiB; otherwise use multipart audio ingestion (`media_inline_expansion_exceeded`). Original reads retain the uploaded bytes, while perception, media query and embedding receive the WAV derivative.

| Input | Container / codecs | Duration and track limits |
| --- | --- | --- |
| Audio | `audio/wav`: PCM u8, s16, s24, s32 or f32; `audio/mpeg`: MP3 | At most 180 seconds; exactly one audio track |
| Compressed audio | `audio/mp4`: M4A AAC-LC/HE-AAC/HE-AACv2; `audio/aac`: raw ADTS with those profiles; `audio/ogg`: Ogg Opus; `audio/flac`: native FLAC | At most 180 seconds inline; AAC/Opus mono or stereo; FLAC up to eight channels; derived float32 WAV at most 8 MiB |
| Short video | `video/mp4` or `video/quicktime`; video AVC, HEVC, AV1 or VP9; optional audio AAC or MP3 | At most 120 seconds; exactly one video track and at most one audio track |
| WebM / Matroska video | `video/webm` or `video/x-matroska`; AVC, HEVC, VP9 or AV1; optional Opus, AAC or MP3 | Exactly one video and at most one audio track; at most 120 seconds inline; original and derived MOV each at most 8 MiB; see structural/timeline limits in [MEDIA.md](MEDIA.md) |
| Long video | Same supported video containers/codecs, using multipart jobs below | No application-level total duration cap; each processed clip must still fit the media limits |

Encrypted media, extra tracks, live streams and unsupported nonzero track origins are rejected. M4A supports only the single priming/edit mapping documented in [media compatibility](MEDIA.md); ADTS retains its encoded priming/end-padding samples. An extension alone does not establish codec support; a container accepted locally must also be supported by the configured models. Typical validation errors are `media_codec_unsupported`, `media_tracks_invalid`, `media_timeline_origin`, `media_duration_exceeded` and `media_too_large`. Long audio uses the matching `/audio/*` multipart API. Run `npm run inspect -- FILE` before uploading an unfamiliar export; see [media compatibility](MEDIA.md).

WebM/MKV uses the same `/ingest`, `/search`, `/correct`, `/reinspect`, `/revoke` and `/delete` shapes. Original reads return uploaded bytes; provider requests use a native MOV derivative with copied video packets and sample-trimmed float32 PCM for Opus/AAC, or copied MP3 packets. Original media queries retain their 2 MiB input limit. `media_inline_expansion_exceeded` can also mean that WebM/MKV PCM expansion exceeds the 8 MiB derivative limit; use `/video/upload`. This does not change the source revision/evidence contract.

Native media can also be a search cue:

```js
const found = await memory('/search', {
  sessionRef: 'chat-002', query: 'Find the same scene with audible speech',
  media: { mimeType: 'image/png', dataBase64: bytes.toString('base64') }, limit: 5,
});
```

Search returns independently grounded `items` plus grouped `videos` and `audios` when applicable. A group's clips retain their own timestamps and refs. Grouping does not itself produce a cross-clip conclusion. Check retrieval coverage fields; search currently returns a bounded top-k candidate set. It does not offer exhaustive result pagination. A limited retrieval result is not proof that no other evidence exists.

## Revisions and evidence

```js
const corrected = await memory('/correct', {
  ref: saved.ref, operationId: 'correction-001', text: 'The sign says Saturday.',
});
await memory('/validate', { refs: [saved.ref] }); // old ref is now invalid
await memory('/reinspect', {
  ref: corrected.ref, operationId: 'reinspect-001', question: 'What date is visible in the original?',
});
```

Corrections rebuild the source's extracted memories. `/reinspect` re-reads the original media; it does not treat the question as evidence. Original bytes, extracted claims, their evidence links and revision history remain distinct. Source/knowledge changes can invalidate previous retrieval and reasoning results. Revalidate refs before using them for a later action.

| Path | Body | Purpose |
| --- | --- | --- |
| `/sources` | `{ "limit": 64, "cursor": "…" }` | Page through sources; omit cursor initially |
| `/knowledge` | `{ "limit": 64, "continuation": "…" }` | Page through current knowledge/conflicts; omit continuation initially |
| `/revision` | `{}` | Current authority revision |
| `/validate` | `{ "refs": [ref] }` | Check current evidence eligibility |
| `/read` | `{ "ref": ref, "range": { "startMs": 100, "endMs": 800 } }` | Retrieve original bytes or a requested video interval |
| `/revoke` | `{ "ref": ref, "operationId": "revoke-001" }` | Remove source from retrieval eligibility |
| `/delete` | `{ "ref": ref, "operationId": "delete-001" }` | Delete source and original bytes |
| `/operation` | `{ "operationId": "…" }` | Inspect an operation after a dropped response |
| `/recover` | `{ "previousOperationId": "…", "operationId": "…", "acceptUnknown": true }` | Explicitly recover an unknown operation |

Use a distinct operation ID for each intentional write, and reuse it only for the exact same request. Inspect unknown outcomes before recovery; do not automatically repeat model work under a new ID. Source IDs may filter `/knowledge` with `sourceIds` (up to 64). Pages are views over a particular revision; a changed view requires a fresh query.

## Long video upload, segmentation and reasoning

1. `POST /video/upload` with `{ mimeType: 'video/mp4' }` returns `uploadId` and `partBytes` (8 MiB). Supported alternatives are `video/quicktime`, `video/webm` and `video/x-matroska`.
2. Send ordered raw chunks to `/video/part` with headers `memory-upload`, `memory-part` (1-based), `Content-Length`, and the API authorization. Keep returned `{partNumber, etag}` values. All chunks except the last must meet R2 multipart size requirements. The gateway caps one part at 32 MiB.
3. Complete the upload and create a processing job:

```js
const job = await memory('/video/complete-upload', {
  uploadId, parts, operationId: 'video-001', sessionRef: 'chat-001', messageRef: 'video-message-001',
  strategy: 'dynamic', minDurationMs: 2000,
});
// For fixed windows instead: strategy: 'fixed', seconds: 10.
```

For WebM/MKV, a fixed window whose copied video plus derived PCM cannot fit returns `video_fixed_window_too_large_reduce_seconds`; reduce `seconds`. Each excerpt currently scans from the source beginning, and AAC fully decodes while retaining only the window. This path does not promise indexed seek performance. See [format and timing limits](MEDIA.md#webm-and-matroska-video).

The job proceeds through Workers alarms while the service runs. Read `/video/status` with `{operationId:'video-001'}`; `/video/step` can explicitly advance a queued job. A queued job normally progresses automatically. A running job may still be waiting for a provider; polling status does not repeat its work. Do not call `/video/step` as a progress query: observing a running job there marks its outcome unknown to fence late results.

For an unknown outcome, inspect the error and `/operation` before explicitly accepting recovery:

```js
const recovery = { previousOperationId: 'video-001', operationId: 'video-recovery-001', acceptUnknown: true };
const recovered = await memory('/video/recover', recovery);
// If this response is lost, query this new ID, or resend the exact same recovery request.
const current = await memory('/video/status', { operationId: recovery.operationId });
```

Recovery may repeat work whose external outcome was unknown. A new recovery ID represents a new explicit decision, not an automatic network retry. Replaying the same bound recovery returns its recorded status without creating another revision or model call; a receipt with no established job remains unknown. Actual job states are `queued`, `running`, `unknown`, `complete` and `superseded`. `/video/events` pages job evidence using `operationId`, optional `cursor` and `limit`. `/video/abort-upload` accepts `{uploadId}` before completion.

Recovery receipts created before the request-binding fix may reject replay with `operation_conflict`; query `/video/status` using their existing recovery operation ID instead. Do not create a new recovery merely to bypass that conflict.

Dynamic segmentation reads scene content to choose boundaries; fixed segmentation uses time intervals. Search returns multiple matched clips grouped under their original video's revision. To integrate evidence across time, create a separate reasoning job:

```js
const reasoning = await memory('/video/reason', {
  ref: job.ref, operationId: 'reason-001', query: 'What was finally decided, and what earlier proposal did it revise?',
});
const status = await memory('/video/status', { operationId: 'reason-001' });
```

Read the job result and referenced events; proposals, objections, authorized revisions and uncertainty are preserved. A later clip is not automatically authoritative. A memory revision change invalidates an earlier reasoning view; request a new job against current refs.

Reasoning event `startMs/endMs` are model estimates, not verified speech boundaries. New events carry `timeBasis: "model-estimate"` and `sourceWindow`, the actual supplied file's bounds in the original recording clock; a model estimate can miss the utterance even when it falls inside those bounds. Historical events without these fields are also not certified precise. To inspect supporting media, use `/video/events` (or `/audio/events`) and read its `clipRef`. `sourceWindow` can contain fractional milliseconds and is descriptive metadata, not a ready-to-use integer `/read` range. Use sample-window search grounding separately when locating audio. Semantic event order and revision relationships do not establish timestamp accuracy.

## Deployment boundary

`npm start` runs loopback-only local workerd. Use it from a local agent or an authenticated tunnel you manage. It does not expose a LAN/public listener. `memory/wrangler.jsonc` and `engine/wrangler.jsonc` are deployment templates; cloud deployment requires independently provisioning storage, binding the authenticated gateway, and configuring secrets/ownership. They are not an automated or accepted hosted deployment. In particular, never expose `MemoryAPI`/`MemoryReadAPI` without the gateway's trust boundary.

## Long audio

Use the same upload/part/complete-upload/status/events/step/reason/recover/abort-upload flow with the `/audio` prefix. Upload MIME is `audio/wav`, `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/ogg` or `audio/flac`; an audio upload ID cannot be used through video upload routes. Status/step/reason/recover/events use the same owner-bound recording jobs as video.

`/audio/complete-upload` defaults to `strategy: 'fixed', seconds: 20, minDurationMs: 2000`. Both fixed and dynamic strategies operate on native audio; one window is at most 180 seconds and its WAV excerpt must fit 4 MiB. Total source duration has no application-level cap. New codec excerpts are float32 WAV, so their 4 MiB bound includes four bytes per sample and a 56-byte header. MP3 preserves decoder history by decoding preceding audio; validated Opus/FLAC tasks can stop at the requested end; AAC currently re-decodes the complete source per excerpt. PCM WAV supports direct sample ranges and is more efficient for very long recordings. See [input constraints](MEDIA.md).

`/read` accepts the root ref plus a range and returns native WAV with sample-derived coordinates. `/correct` and `/reinspect` rebuild the entire source and invalidate its older version. Search groups matching clips under `audios`, independently of `videos`. `/audio/reason` takes `{ ref, query, operationId }`; poll `/audio/status` and read its evidence-backed conclusion. Grouping alone does not establish that conclusion.
