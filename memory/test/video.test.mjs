import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectLongVideo, sliceVideo, nextFixedRange, validateDynamicRanges } from '../dist/video.js';
const fixture = name => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
function source(bytes) {
  const reads = [];
  return { size: bytes.length, reads, async read(offset, length) { reads.push({ offset, length }); return bytes.slice(offset, offset + length); } };
}
test('range-backed inspection and forced-copy preserve audio/video and a common original-time mapping', async () => {
  assert.equal(globalThis.VideoDecoder, undefined);
  assert.equal(globalThis.AudioDecoder, undefined);
  const bytes = fixture('blue-tone.mp4'), media = source(bytes);
  assert.deepEqual(await inspectLongVideo('video/mp4', media), { durationMs: 1026, hasVideo: true, hasAudio: true });
  const clip = await sliceVideo('video/mp4', media, { startMs: 300, endMs: 700 });
  assert.deepEqual(clip.logical, { startMs: 300, endMs: 700 });
  assert.equal(clip.offsetMs, 0);
  assert.equal(clip.mimeType, 'video/mp4');
  assert.ok(clip.bytes.length > 0 && clip.bytes.length < bytes.length);
  assert.deepEqual(clip.tracks.map(t => [t.type, t.codec]), [['video', 'avc'], ['audio', 'mp3']]);
  for (const track of clip.tracks) {
    assert.ok(track.packetCount > 0);
    assert.ok(Math.abs(track.original.startMs - track.output.startMs - clip.offsetMs) <= track.mappingToleranceMs);
    assert.ok(Math.abs(track.original.endMs - track.output.endMs - clip.offsetMs) <= track.mappingToleranceMs);
  }
  assert.ok(clip.tracks.every(t => t.output.startMs >= 0));
  assert.equal(clip.tracks[0].output.startMs, 0);
  assert.ok(clip.tracks[1].output.startMs > 250);
  assert.equal(clip.timeline.durationMs, Math.ceil(Math.max(...clip.tracks.map(t => t.output.endMs))));
  assert.ok(clip.actual.startMs < clip.logical.startMs && clip.actual.endMs > clip.logical.endMs);
  // This fixture's suffix is not required by either container inspection or this selected window.
  assert.ok(Math.max(...media.reads.map(r => r.offset + r.length)) < bytes.length);
});
test('oversize actual windows, unsupported containers, encrypted or multiple audio tracks reject', async () => {
  await assert.rejects(sliceVideo('video/mp4', source(fixture('blue-tone.mp4')), { startMs: 300, endMs: 700 }, 1024), /media_slice_too_large/);
  await assert.rejects(inspectLongVideo('video/webm', source(fixture('blue.mp4'))), /media_type_unsupported/);
  await assert.rejects(inspectLongVideo('video/mp4', source(fixture('encrypted.mp4'))), /media_encrypted/);
  await assert.rejects(inspectLongVideo('video/mp4', source(fixture('multi-audio.mp4'))), /media_tracks_invalid/);
  await assert.rejects(inspectLongVideo('video/mp4', { size: 100, read: async () => new Uint8Array(0) }), /media_range_short/);
  await assert.rejects(sliceVideo('video/mp4', source(fixture('blue.mp4')), { startMs: 0, endMs: 2000 }), /media_time_range_invalid/);
});
test('fixed cursor reaches the tail and dynamic validation exposes gaps/overlaps without identifying scenes', () => {
  assert.deepEqual(nextFixedRange(0, 2500, 1), { startMs: 0, endMs: 1000 });
  assert.deepEqual(nextFixedRange(2000, 2500, 1), { startMs: 2000, endMs: 2500 });
  assert.equal(nextFixedRange(2500, 2500, 1), undefined);
  assert.throws(() => nextFixedRange(0, 2500, 0), /media_segment_plan_invalid/);
  const ranges = [{ startMs: 0, endMs: 1000 }, { startMs: 1000, endMs: 2500 }];
  assert.deepEqual(validateDynamicRanges(ranges, 2500), ranges);
  assert.throws(() => validateDynamicRanges([{ startMs: 1, endMs: 2500 }], 2500), /gap_or_overlap/);
  assert.throws(() => validateDynamicRanges([{ startMs: 0, endMs: 1000 }], 2500), /incomplete/);
});

test('actual two-second fixture slices its back half and tail with timescale-aware original packet evidence',async()=>{
  const bytes=fixture('blue-tone-2s.mp4'),media=source(bytes),timeline=await inspectLongVideo('video/mp4',media);
  assert.equal(timeline.durationMs,2026);
  for(const startMs of [0,500,1000,1500,2000]){
    const clip=await sliceVideo('video/mp4',media,{startMs,endMs:Math.min(startMs+500,timeline.durationMs)});
    assert.equal(clip.tracks.length,2);assert.ok(clip.actual.startMs<=startMs);assert.ok(clip.actual.endMs>=Math.min(startMs+500,2026)-1);
    assert.equal(clip.offsetMs,clip.actual.startMs);assert.ok(clip.tracks.every(t=>t.output.startMs>=0&&t.packetCount>0));
    for(const track of clip.tracks){assert.ok(Math.abs(track.original.startMs-track.output.startMs-clip.offsetMs)<=track.mappingToleranceMs);assert.ok(Math.abs(track.original.endMs-track.output.endMs-clip.offsetMs)<=track.mappingToleranceMs)}
    if(startMs>=1000)assert.ok(clip.offsetMs>0,'back-half clips retain their own original-time offset');
  }
});
test('synthetic ten-minute container exceeds the former 120-second limit and remuxes the actual back-half packets',async()=>{
  // Generated locally with ffmpeg lavfi blue 32x32@1fps, 600s, libx264 ultrafast,
  // g=5, bf=0, threads=1, no audio, use_editlist=0, faststart. No model inference.
  const bytes=fixture('synthetic-blue-600s.mp4'),media=source(bytes);
  assert.deepEqual(await inspectLongVideo('video/mp4',media),{durationMs:600000,hasVideo:true,hasAudio:false});
  const clip=await sliceVideo('video/mp4',media,{startMs:590000,endMs:599000});
  assert.deepEqual(clip.logical,{startMs:590000,endMs:599000});assert.deepEqual(clip.actual,clip.logical);assert.equal(clip.offsetMs,590000);
  assert.equal(clip.timeline.durationMs,9000);assert.equal(clip.sourceTimeline.durationMs,600000);assert.equal(clip.tracks.length,1);assert.equal(clip.tracks[0].packetCount,9);
  assert.deepEqual(clip.tracks[0].output,{startMs:0,endMs:9000});assert.deepEqual(clip.tracks[0].original,clip.logical);
  assert.ok(clip.bytes.length<bytes.length);assert.ok(media.reads.every(read=>read.length<bytes.length));
});
