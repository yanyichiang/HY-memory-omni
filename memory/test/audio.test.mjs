import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareAudio } from '../dist/audio.js';
const fixture = name => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const timeline = durationMs => ({durationMs,hasAudio:true,hasVideo:false});

test('WAV uses sample-aligned, lossless PCM windows and disposes the retained audio', async () => {
  // A Node import of this helper succeeds without loading its lazy .wasm module.
  const original = fixture('tone.wav');
  const audio = await prepareAudio('audio/wav', original, timeline(1000));
  const window = await audio.window(101, 303);
  const src = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const rate = src.getUint32(24,true), align = src.getUint16(32,true);
  // Fixture has a standard RIFF header; locate data rather than assume 44 bytes.
  let dataOffset = 12;
  while (String.fromCharCode(...original.subarray(dataOffset,dataOffset+4)) !== 'data') {
    const size = src.getUint32(dataOffset+4,true); dataOffset += 8+size+(size&1);
  }
  dataOffset += 8;
  const start = Math.ceil(101*rate/1000), end = Math.floor(303*rate/1000);
  assert.deepEqual(window.bytes.subarray(44,44+(end-start)*align),original.subarray(dataOffset+start*align,dataOffset+end*align));
  assert.equal(window.startMs,start/rate*1000); assert.equal(window.endMs,end/rate*1000);
  await assert.rejects(audio.window(0,1001),/audio_window_invalid/);
  audio.dispose(); await assert.rejects(audio.window(0,100),/audio_disposed/);
});

test('declared timeline and empty or unsupported audio fail before any decoder/model use',async()=>{
  await assert.rejects(prepareAudio('audio/wav',fixture('tone.wav'),timeline(900)),/audio_timeline_mismatch/);
  await assert.rejects(prepareAudio('audio/wav',new Uint8Array(),timeline(1000)),/audio_bytes_limit/);
  await assert.rejects(prepareAudio('audio/aiff',fixture('tone.wav'),timeline(1000)),/audio_type_unsupported/);
});

test('WAVE_EXTENSIBLE PCM retains valid bits and channel mask when rewrapped',async()=>{
  const bytes=new Uint8Array(68+64*4), view=new DataView(bytes.buffer);
  const ascii=(at,s)=>bytes.set(new TextEncoder().encode(s),at);
  ascii(0,'RIFF');view.setUint32(4,bytes.length-8,true);ascii(8,'WAVEfmt ');
  view.setUint32(16,40,true);view.setUint16(20,65534,true);view.setUint16(22,2,true);
  view.setUint32(24,8000,true);view.setUint32(28,32000,true);view.setUint16(32,4,true);view.setUint16(34,16,true);
  view.setUint16(36,22,true);view.setUint16(38,16,true);view.setUint32(40,3,true);
  bytes.set([1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113],44);
  ascii(60,'data');view.setUint32(64,64*4,true);
  const audio=await prepareAudio('audio/wav',bytes,timeline(8));
  try{const window=await audio.window(0,audio.durationMs);assert.deepEqual(window.bytes,bytes);}
  finally{audio.dispose();}
});

test('prepare serializes decoded resources, wakes on disposal/failure, and bounds its queue',async()=>{
  const bytes=fixture('tone.wav');
  const first=await prepareAudio('audio/wav',bytes,timeline(1000));
  let entered=false;
  const secondPromise=prepareAudio('audio/wav',bytes,timeline(1000)).then(audio=>{entered=true;return audio;});
  await Promise.resolve(); assert.equal(entered,false);
  first.dispose(); first.dispose(); // Release is idempotent; it cannot admit a second concurrent owner.
  const second=await secondPromise;
  const rejected=assert.rejects(prepareAudio('audio/wav',Uint8Array.of(1),timeline(1000)),/audio_decode_invalid/);
  const following=prepareAudio('audio/wav',bytes,timeline(1000));
  second.dispose(); await rejected;
  const held=await following;
  const queued=Array.from({length:4},()=>prepareAudio('audio/wav',bytes,timeline(1000)));
  await assert.rejects(prepareAudio('audio/wav',bytes,timeline(1000)),error=>error.message==='audio_busy'&&error.status===503);
  held.dispose();
  for(const pending of queued) (await pending).dispose();
});

test('dense accepted WAV exposes a format-sized window instead of rejecting an 8-second default',async()=>{
  const rate=192000,channels=8,sampleBytes=4,frames=rate;
  const bytes=new Uint8Array(44+frames*channels*sampleBytes),view=new DataView(bytes.buffer);
  const ascii=(at,s)=>bytes.set(new TextEncoder().encode(s),at);
  ascii(0,'RIFF');view.setUint32(4,bytes.length-8,true);ascii(8,'WAVEfmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*channels*sampleBytes,true);
  view.setUint16(32,channels*sampleBytes,true);view.setUint16(34,32,true);
  ascii(36,'data');view.setUint32(40,bytes.length-44,true);
  const audio=await prepareAudio('audio/wav',bytes,timeline(1000));
  try{
    assert.ok(audio.maxWindowMs>=1&&audio.maxWindowMs<1000);
    const first=await audio.window(0,Math.floor(audio.maxWindowMs));
    assert.ok(first.bytes.length<=4*1024*1024);assert.ok(first.endMs<=Math.floor(audio.maxWindowMs));
    const last=await audio.window(Math.floor(audio.maxWindowMs),audio.durationMs);
    assert.ok(last.bytes.length<=4*1024*1024);assert.equal(last.endMs,1000);
  }finally{audio.dispose();}
});
