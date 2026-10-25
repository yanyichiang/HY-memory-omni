# Synthetic media fixtures

These fixtures are generated test media. They contain no user recordings, personal metadata, production data or provider responses. The synthetic meeting fixture includes scripted meeting content; the other fixtures use blue frames and/or generated tones.

- `blue.mp4`: one second, 32×32 blue H.264 video, no soundtrack.
- `blue-tone.mp4`: blue H.264 video and one 440 Hz MP3 soundtrack; packet-derived end is 1026 ms because of MP3 framing.
- `blue-tone-2s.mp4`: two-second blue video and generated tone.
- `synthetic-blue-600s.mp4`: ten-minute, 1 fps, 32×32 blue video for long-container indexing.
- `synthetic-meeting-m42.mp4`: 28.171-second scripted synthetic M42 meeting: propose Friday, object, decide Saturday, explicitly revise to Sunday; no real meeting or participants.
- `tone.wav`, `tone.mp3`: short generated mono tone audio.
- `synthetic-extended-48123.wav`, `.opus`, `.flac`: generated 440 Hz mono tone, 48123 input samples at 48 kHz. The WAV is PCM16; Opus/FLAC were encoded with FFmpeg (`libopus` at 64 kbit/s and native FLAC, `-map_metadata -1`). Tests check Opus pre-skip/end trim, exact sample mapping, CRC/truncation rejection and bounded source reads.
- `synthetic-extended-low24.wav`, `.flac`: 800 mono PCM24 samples at 8 kHz; the first three integer samples are 1, -1 and 2, followed by zero. This exercises tiny nonzero float output and a valid 13-byte final FLAC frame. FLAC fixtures are mono; they do not establish multichannel coverage.
- `tone-aac.m4a`, `tone.aac`: generated 2-second 440 Hz mono input at 48 kHz, native FFmpeg AAC at 96 kbit/s. M4A presents 96000 samples; ADTS remux retains 97280 samples including transport priming/padding.
- `tone-he-aac.m4a`, `tone-he.aac`, `tone-he-aac-v2.m4a`, `tone-he-v2.aac`: the same generated tone at 48 kHz stereo, encoded with AudioToolbox `aac_at` profiles 4 / 28 at 48 / 32 kbit/s; ADTS uses `-c copy -f adts`. M4A declares 2090 ms and physically presents 100288 samples after priming; ADTS retains 102400 samples. The original 2-second tone is not their encoded duration assertion.
- `multi-aac.m4a`: multiple AAC tracks, expected rejection. AAC construction commands and exact timing checks are documented in [the codec module](../../codecs/aac/README.md).
- `timing.webm`: synthetic VP9 video and Opus tone; tests beginning/middle/tail excerpts, original video packet preservation, decoder preroll and sample-based audio trimming into MOV.
- `timing-aac.mkv`: synthetic AVC video and AAC tone; tests AAC codec delay, full-history decoding and the same excerpt/clock mapping contract.
- `audio-tail.webm`: synthetic recording whose audio continues after its final video frame; checks that source duration and derived output retain the audio tail.
- `expansion-aac.mp4`: the same 30-second stereo silence as `expansion.webm`, with AAC packet timestamps rebased to zero (`asetpts=PTS+1024/SR/TB`, `-use_editlist 0`). Checks that a small ISO original is routed to multipart when its actual float32 soundtrack exceeds 8 MiB; a 10-second excerpt succeeds. The first fixture export retained negative AAC priming and was correctly rejected before this size check.
- `expansion.webm`: synthetic compressed recording below the original-file size bound whose float32 PCM derivative exceeds inline 8 MiB; checks `media_inline_expansion_exceeded` and the multipart route. These fixtures establish format/runtime behavior, not real-model semantic quality.
- `offset.mp4`: nonzero presentation origin, expected rejection.
- `multi-audio.mp4`: multiple soundtrack tracks, expected rejection.
- `encrypted.mp4`: synthetic encrypted media, expected rejection without a decryption key.

FFmpeg CLI and AudioToolbox are development fixture tools; no external transcoding process runs in the Worker. AAC decoding does use the separately packaged FFmpeg WASM subset described in [the codec module](../../codecs/aac/README.md). These files validate demux/runtime contracts, not model accuracy. The first attempt to mux an 8 kHz MP3 track failed; the valid AV fixture uses 44.1 kHz. No failed fixture was relabeled as a successful recording.

- `tone-aac-44100.m4a`: 88,949 generated 330 Hz samples at 44.1 kHz. Its millisecond movie-clock edit duration is 2,017 ticks, which is not an integer sample count; verifies legal movie-clock rounding without appending silence.

- `opus-video-clock.webm`: 250 ms synthetic 32x32 blue video at 30000/1001 fps with a generated 440 Hz Opus tone. A 0-50 ms excerpt extends to a non-sample-aligned video frame end, exercising independent 48 kHz PCM crop bounds. Generated with FFmpeg color/sine lavfi sources, libvpx-vp9 and libopus; no user media.

- `indexed-aac.mkv`: eight seconds of generated 32x32 blue H.264 (one keyframe per second) and 440 Hz mono AAC, encoded with FFmpeg lavfi color/sine, libx264 and native AAC. Exceeds one 256-packet cache page to verify exact decoder checkpoint restore and bounded packet page reads for a late excerpt.
