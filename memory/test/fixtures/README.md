# Synthetic media fixtures

These fixtures are generated test media. They contain no user recordings, personal metadata, production data or provider responses. The synthetic meeting fixture includes scripted meeting content; the other fixtures use blue frames and/or generated tones.

- `blue.mp4`: one second, 32×32 blue H.264 video, no soundtrack.
- `blue-tone.mp4`: blue H.264 video and one 440 Hz MP3 soundtrack; packet-derived end is 1026 ms because of MP3 framing.
- `blue-tone-2s.mp4`: two-second blue video and generated tone.
- `synthetic-blue-600s.mp4`: ten-minute, 1 fps, 32×32 blue video for long-container indexing.
- `synthetic-meeting-m42.mp4`: 28.171-second scripted synthetic M42 meeting: propose Friday, object, decide Saturday, explicitly revise to Sunday; no real meeting or participants.
- `tone.wav`, `tone.mp3`: short generated mono tone audio.
- `offset.mp4`: nonzero presentation origin, expected rejection.
- `multi-audio.mp4`: multiple soundtrack tracks, expected rejection.
- `encrypted.mp4`: synthetic encrypted media, expected rejection without a decryption key.

Generated using FFmpeg as a development fixture tool; FFmpeg is not a Worker dependency or runtime service. These files validate demux/runtime contracts, not model accuracy. The first attempt to mux an 8 kHz MP3 track failed; the valid AV fixture uses 44.1 kHz. No failed fixture was relabeled as a successful recording.
