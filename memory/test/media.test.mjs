import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectMedia } from '../dist/media.js';
const fixture = name => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
test('pure demux inspects real WAV, MP3 and MP4 packets without WebCodecs', async () => {
  assert.equal(globalThis.VideoDecoder, undefined);
  assert.deepEqual(await inspectMedia('audio/wav', fixture('tone.wav')), { durationMs: 1000, hasAudio: true, hasVideo: false });
  const mp3 = await inspectMedia('audio/mpeg', fixture('tone.mp3'));
  assert.equal(mp3.hasAudio, true); assert.ok(mp3.durationMs >= 1000 && mp3.durationMs < 1200);
  assert.deepEqual(await inspectMedia('video/mp4', fixture('blue.mp4')), { durationMs: 1000, hasAudio: false, hasVideo: true });
  assert.deepEqual(await inspectMedia('video/mp4', fixture('blue-tone.mp4')), { durationMs: 1026, hasAudio: true, hasVideo: true });
  assert.equal(await inspectMedia('image/png', Uint8Array.of(1)), undefined);
});
test('wrong declared container and malformed packet ranges are rejected', async () => {
  await assert.rejects(inspectMedia('audio/wav', fixture('blue.mp4')), /media_container_invalid/);
  await assert.rejects(inspectMedia('video/mp4', fixture('tone.wav')), /media_container_invalid/);
  await assert.rejects(inspectMedia('audio/wav', fixture('tone.wav').slice(0, 60)), /media_container_invalid/);
  await assert.rejects(inspectMedia('video/webm', fixture('blue.mp4')), /media_type_unsupported/);
});
test('duration derives from packets and rejects an overlong WAV', async () => {
  const bytes = new Uint8Array(44 + 181 * 8000), view = new DataView(bytes.buffer);
  const ascii = (at, value) => bytes.set(new TextEncoder().encode(value), at);
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  ascii(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  await assert.rejects(inspectMedia('audio/wav', bytes), /media_duration_exceeded/);
});
test('nonzero origins, multiple audio tracks and encrypted samples fail before model use', async () => {
  await assert.rejects(inspectMedia('video/mp4', fixture('offset.mp4')), /media_timeline_origin/);
  await assert.rejects(inspectMedia('video/mp4', fixture('multi-audio.mp4')), /media_tracks_invalid/);
  await assert.rejects(inspectMedia('video/mp4', fixture('encrypted.mp4')), /media_encrypted/);
});
