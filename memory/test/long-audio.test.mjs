import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectLongAudio, sliceLongAudio } from '../dist/long-audio.js';
import { prepareAudio } from '../dist/audio.js';
const fixture = name => new Uint8Array(readFileSync(new URL(`fixtures/${name}`,import.meta.url)));
const media = bytes => ({size:bytes.length,read:async(o,n)=>bytes.slice(o,o+n)});

test('hour-long WAV reads only metadata and selected samples, preserving original sample clock',async()=>{
  const rate=8000, samples=rate*3600, header=new Uint8Array(44),v=new DataView(header.buffer);
  const ascii=(at,s)=>header.set(new TextEncoder().encode(s),at);
  ascii(0,'RIFF');v.setUint32(4,samples+36,true);ascii(8,'WAVEfmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate,true);v.setUint16(32,1,true);v.setUint16(34,8,true);ascii(36,'data');v.setUint32(40,samples,true);
  const reads=[];
  const source={size:44+samples,async read(o,n){reads.push({o,n});const b=new Uint8Array(n);for(let i=0;i<n;i++)b[i]=o+i<44?header[o+i]:(o+i-44)%251;return b;}};
  const timeline=await inspectLongAudio('audio/wav',source);
  assert.equal(timeline.durationMs,3600000);
  const logical={startMs:3598000,endMs:3600000};
  const clip=await sliceLongAudio('audio/wav',source,logical,timeline);
  assert.deepEqual(clip.actual,logical);assert.equal(clip.offsetMs,3598000);
  assert.equal(clip.bytes.length,16044);
  assert.ok(reads.reduce((sum,r)=>sum+r.n,0)<17000);
  await assert.rejects(sliceLongAudio('audio/wav',source,{startMs:0,endMs:3600000},timeline),/media_slice_too_large/);
  const prepared=await prepareAudio(clip.mimeType,clip.bytes,clip.timeline);
  try {assert.equal(prepared.durationMs,2000);} finally {prepared.dispose();}
});

test('WAV exact fmt and sample bytes survive bounded slicing; invalid containers and oversized windows reject',async()=>{
  const original=fixture('tone.wav'), source=media(original), timeline=await inspectLongAudio('audio/wav',source);
  const clip=await sliceLongAudio('audio/wav',source,{startMs:101,endMs:303},timeline);
  assert.equal(clip.actual.startMs,101); assert.equal(clip.actual.endMs,303);
  assert.deepEqual(clip.bytes.slice(20,36),original.slice(20,36));
  await assert.rejects(inspectLongAudio('audio/aiff',source),/audio_type_unsupported/);
  const changed=original.slice();changed[0]=0;
  await assert.rejects(inspectLongAudio('audio/wav',media(changed)),/audio_wave_container_invalid/);
  const badRate=original.slice();new DataView(badRate.buffer).setUint32(24,0,true);
  await assert.rejects(inspectLongAudio('audio/wav',media(badRate)),/audio_codec_unsupported/);
  await assert.rejects(sliceLongAudio('audio/wav',source,{startMs:0,endMs:timeline.durationMs+1},timeline),/audio_window_invalid/);
});
