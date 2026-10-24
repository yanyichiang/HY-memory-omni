# HTTP API

Use `Authorization: Bearer <HY_API_TOKEN>` on every application request. JSON endpoints use POST with `Content-Type: application/json`. `/health` is an unauthenticated GET. The gateway always supplies its configured owner and personal scope. Only give the API token to agents allowed to read, correct and revoke that owner's memory.

The following examples use the `memory(path, body)` helper from the README. Preserve the complete returned `ref` (`sourceId`, `revision`, `mediaRef`); do not reconstruct it or substitute the latest revision silently.

## Images, audio and short videos

```js
const bytes = await readFile('example.png');
const saved = await memory('/ingest', {
  operationId: 'image-001', sessionRef: 'chat-001', messageRef: 'image-message-001',
  mimeType: 'image/png', dataBase64: bytes.toString('base64'),
});
const found = await memory('/search', { query: 'Find the blue sign', sessionRef: 'chat-002', limit: 5 });
const original = await memory('/read', { ref: saved.ref });
```

Use the same path for supported audio/video MIME types. Small-media ingestion accepts at most 8 MiB decoded bytes; audio currently supports PCM WAV and MP3. Video supports the implemented MP4/QuickTime demux and copy paths; encrypted/multiple-audio/nonzero-origin examples are explicitly rejected. An extension alone does not establish codec support. Long videos use the multipart job interface below. All-model media support depends on the configured provider models.

Native media can also be a search cue:

```js
const found = await memory('/search', {
  sessionRef: 'chat-002', query: 'Find the same scene with audible speech',
  media: { mimeType: 'image/png', dataBase64: bytes.toString('base64') }, limit: 5,
});
```

Search returns independently grounded `items` plus grouped `videos` when applicable. A group's clips retain their own timestamps and refs. Grouping does not itself produce a cross-clip conclusion. Check retrieval coverage fields; search currently returns a bounded top-k candidate set. It does not offer exhaustive result pagination. A limited retrieval result is not proof that no other evidence exists.

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

1. `POST /video/upload` with `{ mimeType: 'video/mp4' }` returns `uploadId` and `partBytes` (8 MiB).
2. Send ordered raw chunks to `/video/part` with headers `memory-upload`, `memory-part` (1-based), `Content-Length`, and the API authorization. Keep returned `{partNumber, etag}` values. All chunks except the last must meet R2 multipart size requirements. The gateway caps one part at 32 MiB.
3. Complete the upload and create a processing job:

```js
const job = await memory('/video/complete-upload', {
  uploadId, parts, operationId: 'video-001', sessionRef: 'chat-001', messageRef: 'video-message-001',
  strategy: 'dynamic', minDurationMs: 2000,
});
// For fixed windows instead: strategy: 'fixed', seconds: 10.
```

The job proceeds through Workers alarms while the service runs. Read `/video/status` with `{operationId:'video-001'}`; `/video/step` can explicitly advance a queued job. Paused or unknown work requires inspection and `/video/recover`, not blind polling/retry. `/video/events` pages job evidence using `operationId`, optional `cursor` and `limit`. `/video/abort-upload` accepts `{uploadId}` before completion.

Dynamic segmentation reads scene content to choose boundaries; fixed segmentation uses time intervals. Search returns multiple matched clips grouped under their original video's revision. To integrate evidence across time, create a separate reasoning job:

```js
const reasoning = await memory('/video/reason', {
  ref: job.ref, operationId: 'reason-001', query: 'What was finally decided, and what earlier proposal did it revise?',
});
const status = await memory('/video/status', { operationId: 'reason-001' });
```

Read the job result and referenced events; proposals, objections, authorized revisions and uncertainty are preserved. A later clip is not automatically authoritative. A memory revision change invalidates an earlier reasoning view; request a new job against current refs. Retrieve the returned original interval via `/read` to inspect the media independently of the model interpretation.

## Deployment boundary

`npm start` runs loopback-only local workerd. Use it from a local agent or an authenticated tunnel you manage. It does not expose a LAN/public listener. `memory/wrangler.jsonc` and `engine/wrangler.jsonc` are deployment templates; cloud deployment requires independently provisioning storage, binding the authenticated gateway, and configuring secrets/ownership. They are not an automated or accepted hosted deployment. In particular, never expose `MemoryAPI`/`MemoryReadAPI` without the gateway's trust boundary.
