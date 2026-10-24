# Live acceptance fixtures

B, C and D are generated meeting notices, not real user media. `knowledge.json` records the scripted ground truth and is used only by the verifier, never sent to a provider. A is generated from its literal text in the runner. `meeting.wav` is the soundtrack of the same scripted M42 video, exported as mono 16 kHz PCM; it introduces no new speech. Existing tone and synthetic M42 fixtures are under `memory/test/fixtures`.

The scenarios check conflict without automatic revision, different-event separation, explicitly evidenced revision, source withdrawal and original-media reinspection. They are deliberately small regression cases, not a general retrieval benchmark.
