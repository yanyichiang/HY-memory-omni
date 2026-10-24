import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { inspectMedia } from '../dist/media.js';

// Run the actual custom-build split modules, not a rewritten decoder or a Node WASM loader.
test('Workers static MP3 decoder rejects compile, returns original-time PCM windows, and fails closed',async()=>{
  const directory=new URL('../dist/',import.meta.url);
  const modules={};
  for(const name of await readdir(directory)) {
    if(name.endsWith('.js')) modules[name]={type:'esm',contents:await readFile(new URL(name,directory),'utf8')};
    if(name.endsWith('.wasm')) modules[name]={type:'wasm',contents:await readFile(new URL(name,directory))};
  }
  modules['test-entry.js']={type:'esm',contents:`
    import {prepareAudio} from './audio.js';
    import {inspectLongAudio,sliceLongAudio} from './long-audio.js';
    WebAssembly.compile=()=>{throw Error('runtime_compile_forbidden');};
    WebAssembly.compileStreaming=()=>{throw Error('runtime_compile_forbidden');};
    export default {async fetch(request){
      const bytes=new Uint8Array(await request.arrayBuffer());
      const url=new URL(request.url);
      if(url.pathname==='/long') {
        let reads=0,maxRead=0;
        const generated=url.searchParams.has('generated');
        const media={size:generated?384*10000-Number(url.searchParams.get('cut')||0):bytes.length,async read(offset,length){
          reads+=length;maxRead=Math.max(maxRead,length);
          if(!generated)return bytes.slice(offset,offset+length);
          const out=new Uint8Array(length),header=[255,251,148,0];
          for(let i=0;i<length;i++){const at=(offset+i)%384;if(at<4)out[i]=header[at];}
          return out;
        }};
        const before=performance.now(),timeline=await inspectLongAudio('audio/mpeg',media),inspectMs=performance.now()-before;
        if(url.searchParams.has('inspect')) return Response.json({timeline});
        const startMs=generated?239000:100,endMs=generated?240000:200;
        const beforeSlice=performance.now(),clip=await sliceLongAudio('audio/mpeg',media,{startMs,endMs},timeline),sliceMs=performance.now()-beforeSlice;
        let same=true;
        if(!generated){
          const audio=await prepareAudio('audio/mpeg',bytes,timeline);
          try{const comparison=await audio.window(startMs,endMs);same=comparison.bytes.length===clip.bytes.length&&comparison.bytes.every((v,i)=>v===clip.bytes[i]);}finally{audio.dispose();}
        }
        return Response.json({timeline,actual:clip.actual,length:clip.bytes.length,same,reads,maxRead,inspectMs,sliceMs});
      }
      const durationMs=Number(new URL(request.url).searchParams.get('duration'));
      const audio=await prepareAudio('audio/mpeg',bytes,{durationMs,hasAudio:true,hasVideo:false});
      try{
        const end=Number(new URL(request.url).searchParams.get('end')||200);
        const window=await audio.window(100,end);
        let binary='';for(let at=0;at<window.bytes.length;at+=8192) binary+=String.fromCharCode(...window.bytes.subarray(at,at+8192));
        const base64Length=btoa(binary).length;
        return Response.json({durationMs:audio.durationMs,startMs:window.startMs,endMs:window.endMs,header:Array.from(window.bytes.slice(0,44)),length:window.bytes.length,base64Length});
      }finally{audio.dispose();}
    }};`};
  const mf=new Miniflare({workers:[{config:{name:'audio-static-test',compatibilityDate:'2026-10-19',manifest:{mainModule:'test-entry.js',modules}}}]});
  try {
    const bytes=new Uint8Array(await readFile(new URL('fixtures/tone.mp3',import.meta.url)));
    const timeline=await inspectMedia('audio/mpeg',bytes);
    const response=await mf.dispatchFetch('http://test/?duration='+timeline.durationMs,{method:'POST',body:bytes});
    assert.equal(response.status,200,await response.clone().text());
    const result=await response.json();
    assert.ok(Math.abs(result.durationMs-timeline.durationMs)<=1);
    assert.ok(result.startMs>=100&&result.endMs<=200);
    const longResponse=await mf.dispatchFetch('http://test/long',{method:'POST',body:bytes});
    assert.equal(longResponse.status,200,await longResponse.clone().text());
    const long=await longResponse.json();assert.equal(long.same,true);assert.ok(long.maxRead<=4096);
    for(const removed of [1,100,300]){
      const truncated=await mf.dispatchFetch('http://test/long?inspect=1',{method:'POST',body:bytes.slice(0,-removed)});
      assert.equal(truncated.status,500);assert.match(await truncated.text(),/audio_mp3_frame_incomplete/);
    }
    const tagged=new Uint8Array(bytes.length+128);tagged.set(bytes);tagged.set([84,65,71],bytes.length);
    const tagResponse=await mf.dispatchFetch('http://test/long?inspect=1',{method:'POST',body:tagged});
    assert.equal(tagResponse.status,200,await tagResponse.clone().text());assert.deepEqual((await tagResponse.json()).timeline,long.timeline);
    const truncatedLong=await mf.dispatchFetch('http://test/long?generated=1&inspect=1&cut=1',{method:'POST'});
    assert.equal(truncatedLong.status,500);assert.match(await truncatedLong.text(),/audio_mp3_frame_incomplete/);
    const generated=await mf.dispatchFetch('http://test/long?generated=1',{method:'POST'});
    assert.equal(generated.status,200,await generated.clone().text());
    const streamed=await generated.json();
    assert.equal(streamed.timeline.durationMs,240000);assert.deepEqual(streamed.actual,{startMs:239000,endMs:240000});
    assert.equal(streamed.length,192044);assert.ok(streamed.maxRead<=4096);
    console.log('240s generated MP3 bounded decode timings',JSON.stringify(streamed));
    assert.equal(result.header[20],1); assert.equal(result.header[22],2); assert.equal(result.header[34],16);
    const wrong=await mf.dispatchFetch('http://test/?duration=900',{method:'POST',body:bytes});
    assert.equal(wrong.status,500); assert.match(await wrong.text(),/audio_timeline_mismatch/);
    // Synthetic valid MPEG1 Layer III silent frames, 48kHz stereo, 180s. ID3 padding brings
    // the original to the exact 8MiB cap; this exercises PCM16 + 4MiB window + base64 in workerd.
    const large=new Uint8Array(8*1024*1024), frameSize=384, frameCount=7500;
    const tagSize=large.length-frameSize*frameCount-10;
    large.set([73,68,51,4,0,0,(tagSize>>>21)&127,(tagSize>>>14)&127,(tagSize>>>7)&127,tagSize&127]);
    for(let frame=0;frame<frameCount;frame++) large.set([255,251,148,0],10+tagSize+frame*frameSize);
    const bounded=await mf.dispatchFetch('http://test/?duration=180000&end=21800',{method:'POST',body:large});
    assert.equal(bounded.status,200,await bounded.clone().text());
    const largeResult=await bounded.json();
    assert.equal(largeResult.durationMs,180000); assert.ok(largeResult.length<=4*1024*1024);
    assert.equal(largeResult.base64Length,Math.ceil(largeResult.length/3)*4);
  }finally{await mf.dispose();}
});
