import test from 'node:test';
import assert from 'node:assert/strict';
import { perceiveAudio, locateAudio } from '../dist/audio-models.js';

const model = 'google-ai-studio/gemini-2.5-flash';
// Actual PCM samples: leading silence, a one-second audible region, trailing silence.
function recording(durationMs = 12000, activeStartMs = 4500, activeEndMs = 5500) {
  const rate = 8000, count = Math.round(rate * durationMs / 1000);
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const ms = i * 1000 / rate;
    if (ms >= activeStartMs && ms < activeEndMs) bytes.writeInt16LE(i % 32 < 16 ? 12000 : -12000, 44 + i * 2);
  }
  return bytes;
}
function signal(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (bytes.toString('ascii', offset, offset + 4) === 'fmt ') format = chunk;
    if (bytes.toString('ascii', offset, offset + 4) === 'data') data = chunk;
    offset += 8 + size + size % 2;
  }
  assert.ok(format && data);
  assert.equal(format.readUInt16LE(0), 1, 'fixture window must contain integer PCM');
  assert.equal(format.readUInt16LE(14), 16);
  const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4);
  let active = 0, leading = 0, started = false;
  for (let i = 0; i < data.length; i += channels * 2) {
    const audible = Math.abs(data.readInt16LE(i)) > 4000;
    if (audible) { active++; started = true; }
    else if (!started) leading++;
  }
  return { activeMs: active * 1000 / rate, leadingMs: leading * 1000 / rate, durationMs: data.length * 1000 / (channels * 2 * rate) };
}
function sources(parts) {
  const windows = []; let id;
  for (const part of parts) {
    const match = typeof part.text === 'string' && /^SOURCE WINDOW (w\d+)\./.exec(part.text);
    if (match) id = match[1];
    else if (part.inlineData && id) {
      assert.equal(part.inlineData.mimeType, 'audio/wav');
      windows.push({ id, ...signal(Buffer.from(part.inlineData.data, 'base64')) }); id = undefined;
    }
  }
  return windows;
}
const timeline = { durationMs: 12000, hasAudio: true, hasVideo: false };
const input = () => ({ query: 'Find the complete audible tone', mimeType: 'audio/wav', bytes: recording(), timeline });

test('actual PCM excerpts retain leading silence and refine complete audible event to source samples', async () => {
  const calls = [];
  const result = await locateAudio(input(), model, async (parts, schema) => {
    const clips = sources(parts); calls.push(clips);
    assert.ok(schema.properties.matches);
    // Derive the selection from decoded samples, never source IDs or model timestamps.
    return JSON.stringify({ matches: clips.filter(clip => clip.activeMs >= 990).map(clip => ({ id: clip.id, text: 'Complete audible tone' })), correctionRelevant: false });
  });
  // Preserve both overlapping coarse positives: 1 coarse + 2 medium + 2 fine batches.
  assert.equal(calls.length, 5);
  assert.ok(calls.every(batch => batch.length >= 1 && batch.length <= 3));
  assert.equal(calls[0][0].leadingMs, 4500);
  assert.equal(calls[0][0].durationMs, 8000);
  assert.deepEqual(result.intervals.map(({ startMs, endMs, modalities, basis }) => ({ startMs, endMs, modalities, basis })),
    [{ startMs: 4000, endMs: 6000, modalities: ['audio'], basis: 'sample-window' }]);
  assert.equal(result.correctionRelevant, false);
});

test('overlapping coarse positives both refine before final non-overlapping event selection', async () => {
  const first = recording(16000, 1000, 2000), second = recording(16000, 7500, 8500);
  const bytes = Buffer.from(first);
  // Two distinct events in one real PCM recording; event2 crosses the 8s coarse boundary.
  for (let at = 44; at < bytes.length; at += 2) {
    if (second.readInt16LE(at)) bytes.writeInt16LE(second.readInt16LE(at), at);
  }
  const result = await locateAudio({ ...input(), bytes, timeline: { ...timeline, durationMs: 16000 } }, model, async parts => {
    // Count consecutive non-silent samples, not total energy: a clipped half-event
    // must not become a full match merely because another event is in the window.
    const matches = []; let id;
    for (const part of parts) {
      const label = /^SOURCE WINDOW (w\d+)\./.exec(part.text ?? '');
      if (label) { id = label[1]; continue; }
      if (!part.inlineData || id === undefined) continue;
      const clip = Buffer.from(part.inlineData.data, 'base64');
      const rate = clip.readUInt32LE(24), dataStart = clip.indexOf(Buffer.from('data')) + 8;
      let run = 0, longest = 0;
      for (let at = dataStart; at + 2 <= clip.length; at += 2) {
        run = Math.abs(clip.readInt16LE(at)) > 4000 ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
      if (longest * 1000 / rate >= 990) matches.push({ id, text: 'One complete audible event' });
      id = undefined;
    }
    return JSON.stringify({ matches, correctionRelevant: false });
  });
  assert.equal(result.intervals.length, 2);
  assert.ok(result.intervals.some(hit => hit.startMs <= 1000 && hit.endMs >= 2000));
  assert.ok(result.intervals.some(hit => hit.startMs <= 7500 && hit.endMs >= 8500),
    'the event crossing 8s must survive overlap of its coarse candidate with event1');
  assert.ok(result.intervals.every(hit => hit.basis === 'sample-window' && hit.endMs - hit.startMs === 2000));
});

test('verified parent is retained when the complete event cannot fit a finer excerpt', async () => {
  const result = await locateAudio({ ...input(), bytes: recording(12000, 3500, 6500), query: 'The whole three-second event' }, model, async parts =>
    JSON.stringify({ matches: sources(parts).filter(clip => clip.activeMs >= 2990).map(clip => ({ id: clip.id, text: 'Whole three-second event' })), correctionRelevant: false }));
  assert.deepEqual(result.intervals.map(({ startMs, endMs, basis }) => ({ startMs, endMs, basis })),
    [{ startMs: 0, endMs: 8000, basis: 'sample-window' }]);
});

test('perception describes each actual WAV window without inventing event boundaries', async () => {
  const seen = [];
  const perception = await perceiveAudio('audio/wav', recording(), timeline, model, async (parts, schema) => {
    const clips = sources(parts); seen.push(...clips);
    assert.ok(schema.properties.windows);
    return JSON.stringify({ windows: clips.map(clip => ({ id: clip.id, text: clip.activeMs ? 'Silence followed by a tone' : 'Silence' })) });
  });
  assert.equal(perception.kind, 'audio'); assert.equal(perception.configKey, 'sample-window-observation-v1');
  assert.equal(seen[0].leadingMs, 4500);
  assert.match(perception.text, /0–8000 ms/);
  assert.match(perception.text, /excerpt bounds, not exact event times/);
});

test('unknown IDs, duplicates and model timestamps fail on the first classify call', async () => {
  for (const matches of [
    [{ id: 'not-a-source-window', text: 'x' }],
    [{ id: 'w0', text: 'x' }, { id: 'w0', text: 'x' }],
    [{ id: 'w0', text: 'x', startMs: 4500, endMs: 5500 }],
  ]) {
    let calls = 0;
    await assert.rejects(locateAudio(input(), model, async () => { calls++; return JSON.stringify({ matches, correctionRelevant: false }); }), /audio_window_response_invalid/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(perceiveAudio('audio/wav', recording(), timeline, model, async () => {
    calls++; return JSON.stringify({ windows: [{ id: 'w0', text: 'x', startMs: 0 }, { id: 'w1', text: 'x' }] });
  }), /audio_window_response_invalid/);
  assert.equal(calls, 1);
});

test('unsupported visual conjunction remains empty and an unrelated Owner correction stays irrelevant', async () => {
  let calls = 0;
  const result = await locateAudio({ ...input(), query: 'A red circle is visible while the tone sounds', correction: 'Owner identifies this recording as a test.' }, model, async parts => {
    calls++; assert.ok(sources(parts).length);
    assert.match(parts.at(-1).text, /no visual evidence/);
    return JSON.stringify({ matches: [], correctionRelevant: false });
  });
  assert.deepEqual(result, { intervals: [], correctionRelevant: false });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(locateAudio(input(), model, async () => { calls++; return JSON.stringify({ matches: [], correctionRelevant: true }); }), /audio_window_response_invalid/);
  assert.equal(calls, 1);
});
