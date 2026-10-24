# Input compatibility and diagnostics

Run `npm run build`, then `npm run inspect -- /path/to/recording`. This local command uses the same container/audio inspectors as the Worker, detects the file signature rather than trusting its extension, and reports the ingestion entrypoint or an actionable validation error. It makes no model call. Container acceptance does not prove that a configured provider can understand the content.

| Input | Accepted | Prepare unsupported exports |
| --- | --- | --- |
| Images | PNG, JPEG, WebP, up to 8 MiB original bytes | Export one supported still image |
| Audio | PCM WAV (u8/s16/s24/s32/f32, little-endian RIFF), MP3; M4A/ADTS AAC-LC, HE-AAC, HE-AACv2; Ogg Opus; native FLAC | See the codec limits below; RF64, compressed WAV and other Ogg codecs are not accepted |
| Video | MP4/QuickTime; AVC, HEVC, AV1 or VP9; optional AAC/MP3 soundtrack | Select one video track and at most one soundtrack; export timestamps starting at zero |

Encrypted tracks and extra tracks are rejected, not silently discarded. Unsupported nonzero presentation origins are rejected because an untracked timestamp shift would break evidence coordinates. M4A supports the explicit priming/edit mapping described below. The inspector returns `media_tracks_invalid`, `media_codec_unsupported`, `media_timeline_origin`, or the specific audio parser error.

For an unsupported video export, select the intended video/audio tracks in your editor and export H.264 + AAC MP4 with timestamps starting at zero. For audio, PCM WAV avoids MP3 prefix decoding. Conversion is an explicit user preparation step; the service never starts an external transcoding server or substitutes a provider.

ISO audio/video discovery checks top-level box lengths before the demuxer allocates metadata. This local inspector limits `moov`/`ftyp` payloads to 8 MiB (`media_inspection_metadata_limit`); the M4A decoder separately enforces its narrower 1 MiB `moov` limit.

## Compressed audio details

Use `audio/mp4` for M4A, `audio/aac` for raw ADTS, `audio/ogg` for Ogg Opus, and `audio/flac` for native FLAC. Ingestion, media queries, reinspection and embedding retain the compressed original and prepare bounded little-endian float32 WAV with a `fact` chunk for the model. No downmix or PCM16 quantization is applied; this preserves tiny nonzero decoded values, without claiming that a lossy codec becomes lossless.

| Codec | Implemented boundary |
| --- | --- |
| M4A / ADTS AAC | AAC-LC, HE-AAC or HE-AACv2; decoded 7350–96000 Hz, one or two channels. Other AAC profiles are rejected. |
| M4A container | One audio track and one sample description; nonfragmented, unencrypted; no edit or one nonnegative, unit-rate edit. Multiple/empty edits and rate changes are rejected. `moov` payload is at most 1 MiB; each compressed packet is at most 64 KiB. |
| ADTS transport | Stable configuration and one raw data block per frame. CRC-protected ADTS is rejected. There is no gapless edit metadata: decoded priming and end padding remain part of its timeline. |
| Ogg Opus | One logical stream, mapping family 0, mono/stereo, decoded at 48 kHz. Chained/multiplexed streams and other channel mappings are rejected. Page CRC, sequence and complete EOS are checked. Pre-skip, final granule trimming and output gain are applied. |
| Native FLAC | Up to eight channels in decoder order, with no rearrangement or downmix. STREAMINFO must declare a nonzero total sample count. Frame integrity, decoder errors and the decoded sample count are checked. Current fixtures exercise mono FLAC. |

M4A decoding includes the original priming packets and discards samples before presentation zero. A supported edit bounds end trimming. Movie-clock rounding may differ from the physical final sample by at most one tick, capped at 1 ms; it never adds zero padding or evidence time. Excerpts expose the logical interval, actual sample-aligned interval and offset. ADTS time is its decoded transport clock, not the duration of the WAV used before encoding. Incomplete frames/boxes, format changes and inconsistent sample clocks fail validation.

Small ingestion still requires original bytes at most 8 MiB and duration at most 180 seconds; media queries still limit original bytes to 2 MiB. These compressed formats additionally require the complete derived WAV to fit 8 MiB, including its 56-byte header (`56 + samples × channels × 4`). `media_inline_expansion_exceeded` directs larger decoded inputs to multipart ingestion. Inspection checks this before storing a small original.

The first-batch codec tests exercise actual workerd decoding and synthetic lifecycle/wire behavior. Live calls accepted the derived WAVs, ingested M4A, retrieved it with Opus/AAC queries, and preserved reinspection/revocation. One FLAC query returned no grounded match despite intact decoded samples; it remains a semantic false negative. See [acceptance](ACCEPTANCE.md) for the retained first responses and verification boundary. See the [AAC module contract](../memory/codecs/aac/README.md) for its exact decoder and fixture evidence.

## Large recordings

Use `/audio/*` for the audio formats above and `/video/*` for MP4/QuickTime multipart ingestion. Small `/ingest` retains its 8 MiB / 180-second audio / 120-second video limits. The multipart path does not impose an arbitrary total-duration limit, but each derived clip and each Worker execution remains bounded.

Audio defaults to fixed 20-second windows; dynamic topic boundaries are also available. One requested audio window may not exceed 180 seconds, and its prepared WAV must fit 4 MiB. Reduce `seconds` for high-rate/multichannel audio; new compressed formats use four bytes per decoded sample plus the WAV header. Dynamic segmentation reduces oversized analysis windows before inference. Original bytes remain independent of derived WAV excerpts.

WAV uses direct byte ranges with exact sample positions. The long-audio MP3 parser accepts standard bitrate-indexed MPEG-1/2/2.5 Layer III with optional leading ID3v2 and trailing ID3v1 tags. Free-format MP3, unknown trailing bytes and incomplete frames are rejected. MP3 frames can depend on earlier frames, so the current implementation decodes from the start of the original for each excerpt, discarding preceding samples and retaining only the requested window. This keeps memory bounded and preserves decoder history, but total decoding work grows with both recording length and clip count. Very long MP3 should be exported as PCM WAV for efficient range processing. This is an algorithmic limit, not a promise of unlimited physical storage or CPU.

Ogg Opus and FLAC excerpts can decode only through the requested end after whole-source validation, when the durable task has bound the unchanged source revision. Default standalone slicing still validates the complete source. AAC currently decodes and validates the whole source for each excerpt. Memory remains bounded, but repeated prefix/full decoding adds CPU work; there is no measured promise for arbitrarily long recordings.

Both kinds preserve the original reference, logical interval, actual excerpt interval and offset. Search returns `audios` and `videos` groups; grouping is not semantic synthesis. `/audio/reason` and `/video/reason` explicitly process native excerpts in order, preserve evidence references and distinguish proposals, objections, decisions and revisions. Their job status and unknown-recovery contracts are the same.


## Audio observation precision

Perception identifies exact digital silence from the selected decoded PCM samples before describing audio. Every sample must represent zero; there is no volume threshold. The retained original is unchanged. The check uses the supplied decoded samples; new codec derivatives retain float32 values rather than quantizing them to PCM16. A purely measured observation is attributed to `pcm-sample-inspection`; mixed measured/model observations name both. Nonzero audio continues through the configured native model. This does not certify arbitrary speech/sound recognition or reasoning timestamps. Reasoning events expose model estimates and the actual supplied media window; use the archived event's `clipRef` to inspect original evidence.
