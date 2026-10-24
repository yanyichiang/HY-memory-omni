# Input compatibility and diagnostics

Run `npm run build`, then `npm run inspect -- /path/to/recording`. This local command uses the same container/audio inspectors as the Worker, detects the file signature rather than trusting its extension, and reports the ingestion entrypoint or an actionable validation error. It makes no model call. Container acceptance does not prove that a configured provider can understand the content.

| Input | Accepted | Prepare unsupported exports |
| --- | --- | --- |
| Images | PNG, JPEG, WebP, up to 8 MiB original bytes | Export one supported still image |
| Audio | PCM WAV (u8/s16/s24/s32/f32, little-endian RIFF), MP3 | Export PCM WAV; AAC/M4A, Ogg, FLAC, RF64 and compressed WAV are not accepted |
| Video | MP4/QuickTime; AVC, HEVC, AV1 or VP9; optional AAC/MP3 soundtrack | Select one video track and at most one soundtrack; export timestamps starting at zero |

Encrypted tracks and extra tracks are rejected, not silently discarded. A file with a nonzero presentation origin is rejected because an untracked timestamp shift would break evidence coordinates. The inspector returns `media_tracks_invalid`, `media_codec_unsupported`, `media_timeline_origin`, or the specific audio parser error.

For an unsupported video export, select the intended video/audio tracks in your editor and export H.264 + AAC MP4 with timestamps starting at zero. For audio, PCM WAV avoids MP3 prefix decoding. Conversion is an explicit user preparation step; the service never starts an external transcoding server or substitutes a provider.

## Large recordings

Use `/audio/*` for WAV/MP3 and `/video/*` for MP4/QuickTime multipart ingestion. Small `/ingest` retains its 8 MiB / 180-second audio / 120-second video limits. The multipart path does not impose an arbitrary total-duration limit, but each derived clip and each Worker execution remains bounded.

Audio defaults to fixed 20-second windows; dynamic topic boundaries are also available. One requested audio window may not exceed 180 seconds, and its prepared WAV must fit 4 MiB. Reduce `seconds` for high-rate/multichannel PCM. Dynamic segmentation reduces oversized analysis windows before inference. Original bytes remain independent of derived WAV excerpts.

WAV uses direct byte ranges with exact sample positions. The long-audio MP3 parser accepts standard bitrate-indexed MPEG-1/2/2.5 Layer III with optional leading ID3v2 and trailing ID3v1 tags. Free-format MP3, unknown trailing bytes and incomplete frames are rejected. MP3 frames can depend on earlier frames, so the current implementation decodes from the start of the original for each excerpt, discarding preceding samples and retaining only the requested window. This keeps memory bounded and preserves decoder history, but total decoding work grows with both recording length and clip count. Very long MP3 should be exported as PCM WAV for efficient range processing. This is an algorithmic limit, not a promise of unlimited physical storage or CPU.

Both kinds preserve the original reference, logical interval, actual excerpt interval and offset. Search returns `audios` and `videos` groups; grouping is not semantic synthesis. `/audio/reason` and `/video/reason` explicitly process native excerpts in order, preserve evidence references and distinguish proposals, objections, decisions and revisions. Their job status and unknown-recovery contracts are the same.


## Audio observation precision

Perception identifies exact digital silence from the selected decoded PCM samples before describing audio. Every sample must represent zero; there is no volume threshold. The retained original and native windows are unchanged. A purely measured observation is attributed to `pcm-sample-inspection`; mixed measured/model observations name both. Nonzero audio continues through the configured native model. This does not certify arbitrary speech/sound recognition or reasoning timestamps. Reasoning events expose model estimates and the actual supplied media window; use the archived event's `clipRef` to inspect original evidence.
