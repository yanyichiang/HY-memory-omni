# Input compatibility and diagnostics

Run `npm run build`, then `npm run inspect -- /path/to/recording`. This local command uses the same container/audio inspectors as the Worker, detects the file signature rather than trusting its extension, and reports the ingestion entrypoint or an actionable validation error. It makes no model call. Container acceptance does not prove that a configured provider can understand the content.

| Input | Accepted | Prepare unsupported exports |
| --- | --- | --- |
| Images | PNG, JPEG, WebP; bounded HEIC/HEIF/AVIF and GIF, up to 8 MiB original bytes | See image representation limits below |
| Audio | PCM WAV (u8/s16/s24/s32/f32, little-endian RIFF), MP3; M4A/ADTS AAC-LC, HE-AAC, HE-AACv2; Ogg Opus; native FLAC | See the codec limits below; RF64, compressed WAV and other Ogg codecs are not accepted |
| Video | MP4/QuickTime with AVC, HEVC, AV1 or VP9 and optional AAC/MP3 soundtrack; restricted WebM/Matroska with the same video codecs and optional Opus/AAC/MP3 | Select one video track and at most one soundtrack; export timestamps starting at zero |

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

## Video soundtrack retrieval

Gemini Embedding 2 does not process a video's embedded audio track. Video embeddings now aggregate the native video and its actual extracted float32 WAV in the same request. The WAV retains its sample rate, channels and presentation offset; the request names that offset without adding silence. Existing video vectors without audio remain eligible with an explicit coverage limitation; whole-source reinspection rebuilds them. Video frame sampling remains a model limitation.

ISO inline ingestion also checks the expanded soundtrack, including its 56-byte WAV header, against 8 MiB before storing the source. A small compressed file may require `/video/upload` with shorter clips. Fixed windows that cannot fit return `video_fixed_window_too_large_reduce_seconds`; dynamic analysis reduces oversized windows. Media queries have no multipart input and must fit the same bounded representation: choose a shorter query excerpt when `media_inline_expansion_exceeded` is returned.

Audio/video queries keep native embedding. For evidence grounding, the configured reader first observes the query recording independently; candidate source checks receive that bounded query cue and the source's own native media. This prevents concatenating two recordings into one source timeline. The cue is a model interpretation, never stored-source evidence or Owner authority, and can miss details; grounded results must be assessed together with that limitation. Still-image cues remain directly supplied. Explicit relationship queries can ask for a later decision related to a proposal; unqualified cues must not treat every event in the same meeting as a match.

## WebM and Matroska video

Use `video/webm` or `video/x-matroska`. The adapter accepts exactly one AVC, HEVC, VP9 or AV1 video track and at most one Opus, AAC or MP3 audio track. Audio-only WebM/Matroska, Vorbis, VP8, extra tracks and other codecs are outside this interface. The file signature and EBML DocType must match the declared container; changing a suffix is not conversion.

The original WebM/MKV is retained. Before perception, native media queries and embedding, the service copies video packets into a bounded `video/quicktime` MOV derivative. Opus and AAC use the existing WASM decoders to produce interleaved float32 PCM with sample-based head/tail trimming; MP3 packets are copied at their complete packet boundaries. This supplies actual frames and sound to the model, without replacing the recording with a transcript or starting an external transcoding process. For an inline source, `/read` returns the retained original. For a multipart recording root, `/read` requires a time range and returns a linked native excerpt; the original remains in storage. Reinspection, whole-source rebuild, revision invalidation and revocation retain their existing contracts.

The structural preflight accepts one Segment in a finite file, with clusters bounded to 8 MiB and non-Void elements (including individual Blocks and metadata elements) bounded to 1 MiB. Source reads are at most 64 KiB. Unknown-size elements are restricted to Segment/Cluster; an unknown-size Cluster must still terminate within the cluster bound. Live tracks, encryption/compression or other content transformations, codec-state changes, lacing, invisible frames and non-unit TrackTimestampScale are rejected. These are implementation limits, not claims of complete Matroska support.

Opus uses mapping family 0, mono/stereo, at 48 kHz; its CodecDelay must agree with OpusHead pre-skip. AAC uses the first-batch LC/HE/HEv2 decoder limits and validates delay on its decoded sample clock. Opus/AAC packet times must agree with the continuous sample clock within the container tick precision. Negative DiscardPadding, padding before the last packet, nonintegral sample padding and padding that removes a complete final packet are rejected. Unsupported delays on other tracks, invalid origins and discontinuous or inconsistent timelines fail closed. Keyframe expansion can make the actual video interval wider than the logical request; returned track mappings and offsets identify that interval. MOV timestamps retain the muxer's finite timebase precision; exact PCM trimming does not certify model event timestamps.

Both original and derived bytes must fit the inline 8 MiB bound, and inline video still lasts at most 120 seconds. A highly compressed short original can exceed the derivative bound after PCM expansion: `media_inline_expansion_exceeded` means use `/video/upload`. Long video clips remain bounded; `video_fixed_window_too_large_reduce_seconds` means reduce fixed `seconds`. There is no application-level total recording duration cap.

Current processing scans from the source beginning for every clip. AAC decodes the complete track but retains only the selected PCM window; Opus supplies retained decoder preroll before cropping. This is bounded processing, not efficient indexed random access, and repeated scans/decodes increase work with clip count. The synthetic fixtures check container, samples and lifecycle contracts. Real-model cross-clip revision and lifecycle evidence, plus retained retrieval failures and repairs, are recorded in [ACCEPTANCE](ACCEPTANCE.md).

The build-time metadata adaptation and its generated MPL-covered source are described in [MATROSKA-PATCH.md](../memory/licenses/MATROSKA-PATCH.md). Its exported delay/preroll/padding fields leave original compressed bytes and upstream packet timestamps unchanged; the HY adapter owns their interpretation.

## Large recordings

Use `/audio/*` for the audio formats above and `/video/*` for supported MP4/QuickTime/WebM/Matroska multipart ingestion. Small `/ingest` retains its 8 MiB / 180-second audio / 120-second video limits. The multipart path does not impose an arbitrary total-duration limit, but each derived clip and each Worker execution remains bounded.

Audio defaults to fixed 20-second windows; dynamic topic boundaries are also available. One requested audio window may not exceed 180 seconds, and its prepared WAV must fit 4 MiB. Reduce `seconds` for high-rate/multichannel audio; new compressed formats use four bytes per decoded sample plus the WAV header. Dynamic segmentation reduces oversized analysis windows before inference. Original bytes remain independent of derived WAV excerpts.

WAV uses direct byte ranges with exact sample positions. The long-audio MP3 parser accepts standard bitrate-indexed MPEG-1/2/2.5 Layer III with optional leading ID3v2 and trailing ID3v1 tags. Free-format MP3, unknown trailing bytes and incomplete frames are rejected. MP3 frames can depend on earlier frames, so the current implementation decodes from the start of the original for each excerpt, discarding preceding samples and retaining only the requested window. This keeps memory bounded and preserves decoder history, but total decoding work grows with both recording length and clip count. Very long MP3 should be exported as PCM WAV for efficient range processing. This is an algorithmic limit, not a promise of unlimited physical storage or CPU.

Ogg Opus and FLAC excerpts can decode only through the requested end after whole-source validation, when the durable task has bound the unchanged source revision. Default standalone slicing still validates the complete source. AAC currently decodes and validates the whole source for each excerpt. Memory remains bounded, but repeated prefix/full decoding adds CPU work; there is no measured promise for arbitrarily long recordings.

Both kinds preserve the original reference, logical interval, actual excerpt interval and offset. Search returns `audios` and `videos` groups; grouping is not semantic synthesis. `/audio/reason` and `/video/reason` explicitly process native excerpts in order, preserve evidence references and distinguish proposals, objections, decisions and revisions. Their job status and unknown-recovery contracts are the same.


## Audio observation precision

Perception identifies exact digital silence from the selected decoded PCM samples before describing audio. Every sample must represent zero; there is no volume threshold. The retained original is unchanged. The check uses the supplied decoded samples; new codec derivatives retain float32 values rather than quantizing them to PCM16. A purely measured observation is attributed to `pcm-sample-inspection`; mixed measured/model observations name both. Nonzero audio continues through the configured native model. This does not certify arbitrary speech/sound recognition or reasoning timestamps. Reasoning events expose model estimates and the actual supplied media window; use the archived event's `clipRef` to inspect original evidence.

## HEIC, AVIF and GIF

`/ingest` and native-media `/search` accept `image/heic`, `image/heif`, `image/avif` and `image/gif`. The original bytes remain stored and returned by `/read`. Static provider derivatives are PNG; animations are H264 MP4, with no invented audio. This conversion runs inside Workers using the included static WASM and JavaScript codecs. Normal setup needs no native SDK or external conversion service.

`/read.representation` records original/output dimensions and any downsampling. Animation `timeline.animation` also records source frame indices, exact source ticks/delays, one-cycle duration, raw repetitions, alpha matte, color limitations and the output time mapping. Animated grounding selects explicit source-frame IDs. The service maps those IDs to decoded source intervals and returns `basis: "source-frame"`, integer covering bounds and exact `frames` coordinates. Frame selection remains a model judgment; the clock mapping is deterministic. Loops are not expanded. Zero-delay frames influence composition but have no displayed interval; all-zero animations fail explicitly.

The service accepts a single HEIF still item or a single visual sequence. Multi-item collections, additional tracks and complex edit lists are rejected instead of choosing one item silently. Ordinary stills/sequence decode frames are bounded to 8 million pixels and side 8192. Independent opaque 8-bit SDR HEIC grids may reach 16 million original pixels, with at most 256 independently decoded tiles of at most 262144 pixels each; the provider output is sampled to at most 4 million pixels. Large-grid alpha, ICC, HDR and geometric transforms are unsupported. Original dimensions and actual sampling ratios remain available. Small-image libheif transforms are retained, but RGBA8 conversion does not promise original HDR/wide-gamut color fidelity.

GIF canvases are bounded to 1,048,576 pixels, side 4096, 128 frames and 32 MiB cumulative decoded work. The animation encoder accepts a coded canvas of at most 1,048,576 pixels, side 2048, at most 128 frames, 120 seconds and 8 MiB output. It uses white matte, YUV420 and edge padding; these are disclosed derivatives. Unknown GIF applications, plain-text blocks and user-interaction waits are rejected. Long animation uploads are not routed through `/video/upload`; export an explicitly timed video for that interface.

Raw source coordinates are authoritative. A sampled/converted representation can omit fine detail; query cues from animations are observed separately before source grounding, with the same disclosed lossiness as audio/video cues. Source correction, reinspection and revocation retain the existing whole-source version rules.
