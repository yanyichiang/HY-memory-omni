import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

async function createRuntime() {
  const modules = {};
  for (const n of await readdir(new URL('../dist/', import.meta.url))) if (n.endsWith('.js') || n.endsWith('.wasm')) {
    modules[n] = { type: n.endsWith('.wasm') ? 'wasm' : 'esm', contents: await readFile(new URL('../dist/' + n, import.meta.url), n.endsWith('.wasm') ? undefined : 'utf8') };
  }
  modules['test.js'] = { type: 'esm', contents: `import {inspectLongVideo,sliceVideo,checkMatroska}from'./video.js';import{inspectMedia}from'./media.js';
    export default {async fetch(r){try{const u=new URL(r.url),bytes=new Uint8Array(await r.arrayBuffer());let largest=0,reads=0,cacheReads=[];const cache=new Map();const source={size:bytes.length,read:async(a,n)=>{reads++;largest=Math.max(largest,n);return bytes.slice(a,a+n)}};
      if(u.pathname==='/huge'){const head=new Uint8Array([0x1a,0x45,0xdf,0xa3,0x87,0x42,0x82,0x84,119,101,98,109,0x18,0x53,0x80,0x67,255,0x1f,0x43,0xb6,0x75,0x11,0,0,0]);try{await checkMatroska({size:1073741824,read:async(a,n)=>{largest=Math.max(largest,n);const b=new Uint8Array(n);if(a<head.length)b.set(head.subarray(a,Math.min(head.length,a+n)));return b;}})}catch(e){return Response.json({code:e.code,largest})}}
      if(u.pathname==='/cached')source.matroskaCache={get:async key=>{cacheReads.push(key);return cache.get(key)||null},put:async(key,data)=>{cache.set(key,data)}};
      const mime=await checkMatroska(source),timeline=await inspectLongVideo(mime,source);
      const inspectionReads=reads;cacheReads=[];
      if(u.pathname==='/inline')return Response.json(await inspectMedia(mime,bytes));
      const clip=await sliceVideo(mime,source,{startMs:+u.searchParams.get('start'),endMs:Math.min(+u.searchParams.get('end'),timeline.durationMs)},+(u.searchParams.get('limit')||8388608));
      let byteIdentity;
      if(u.pathname==='/cached'){
        const cachedReads=reads-inspectionReads;
        const direct=await sliceVideo(mime,{size:source.size,read:source.read},clip.logical);
        byteIdentity=clip.bytes.length===direct.bytes.length&&clip.bytes.every((value,i)=>value===direct.bytes[i]);
        return Response.json({byteIdentity,cachedReads,cacheReads,cacheKeys:[...cache.keys()],tracks:clip.tracks});
      }
      return new Response(clip.bytes,{headers:{'x-result':JSON.stringify({...clip,bytes:undefined,largest})}});
    }catch(e){return Response.json({error:e.message,code:e.code},{status:e.status||415})}}}` };
  const mf = new Miniflare({ workers: [{ config: { name: 'matroska-format-test', compatibilityDate: '2026-10-19', manifest: { mainModule: 'test.js', modules } } }] });
  return mf;
}
test('actual Workers remux WebM/MKV with original video packets and precisely bounded Opus PCM', {timeout:120000}, async () => {
  const mf = await createRuntime();
  try {
    for (const file of ['timing.webm', 'timing-aac.mkv', 'opus-video-clock.webm']) {
      const bytes = await readFile(new URL('fixtures/' + file, import.meta.url));
      for (const [start, end] of (file === 'opus-video-clock.webm' ? [[0, 50]] : [[0, 2100], [700, 1400], [1800, 2100]])) {
        const r = await mf.dispatchFetch(`http://test/?start=${start}&end=${end}`, { method: 'POST', body: bytes });
        if(r.status!==200)assert.fail(file + ': ' + await r.text());
        const info = JSON.parse(r.headers.get('x-result'));
        assert.equal(info.mimeType, 'video/quicktime');
        assert.ok(info.largest <= 65536);
        assert.equal(info.tracks.length, 2);
        assert.ok(info.actual.startMs <= start && info.actual.endMs >= Math.min(end, info.sourceTimeline.durationMs) - 1);
        assert.equal(info.offsetMs, info.actual.startMs);
        const audio = info.tracks.find(t => t.type === 'audio');
        if (file.endsWith('.webm')) {
          for (const boundary of [audio.original.startMs, audio.original.endMs])
            assert.ok(Math.abs(boundary * 48 - Math.round(boundary * 48)) < 1e-6, 'Opus mapping uses complete samples');
        }
        for (const t of info.tracks) {
          assert.ok(t.packetCount > 0 && t.output.startMs >= 0);
          assert.ok(Math.abs(t.original.startMs - t.output.startMs - info.offsetMs) < 1e-6);
        }
        const output = new Uint8Array(await r.arrayBuffer());
        assert.ok(output.length > 0 && output.length < 8 * 1024 * 1024);
        if (process.env.HY_MATROSKA_ARTIFACTS) {
          await mkdir(process.env.HY_MATROSKA_ARTIFACTS, { recursive: true });
          await writeFile(`${process.env.HY_MATROSKA_ARTIFACTS}/${file}-${start}.mov`, output);
          await writeFile(`${process.env.HY_MATROSKA_ARTIFACTS}/${file}-${start}.json`, JSON.stringify(info, null, 2));
        }
      }
      if (file === 'opus-video-clock.webm') continue;
      const oversize = await mf.dispatchFetch('http://test/?start=0&end=2100&limit=1024', { method: 'POST', body: bytes });
      assert.equal(oversize.status, 413);
    }
  } finally { await mf.dispose(); }
});
test('Matroska retains audio tails and rejects PCM expansion and oversized clusters', {timeout:120000}, async () => {
  const mf = await createRuntime();
  try {
    const tail = await readFile(new URL('fixtures/audio-tail.webm', import.meta.url));
    const tailResponse = await mf.dispatchFetch('http://test/?start=0&end=4000', { method: 'POST', body: tail });
    if(tailResponse.status!==200)assert.fail(await tailResponse.text());
    const tailInfo = JSON.parse(tailResponse.headers.get('x-result'));
    assert.ok(tailInfo.tracks.find(t=>t.type==='audio').original.endMs >= 3020);
    assert.ok(tailInfo.tracks.find(t=>t.type==='video').original.endMs <= 1001);
    assert.ok(tailInfo.timeline.durationMs >= 3020, 'audio after final video frame is retained');
    const expansion = await readFile(new URL('fixtures/expansion.webm', import.meta.url));
    assert.ok(expansion.length < 8 * 1024 * 1024);
    const inline = await mf.dispatchFetch('http://test/inline', { method: 'POST', body: expansion });
    assert.equal(inline.status, 413); assert.equal((await inline.json()).code, 'media_inline_expansion_exceeded');
    const huge = await (await mf.dispatchFetch('http://test/huge', { method: 'POST', body: new Uint8Array(0) })).json();
    assert.equal(huge.code, 'media_matroska_cluster_limit'); assert.ok(huge.largest <= 65536);
  } finally { await mf.dispose(); }
});


test('revision cache reads indexed packet pages and restores exact AAC history without rescanning original', {timeout:120000}, async () => {
  const mf=await createRuntime();
  try {
    for (const file of ['indexed-aac.mkv','timing.webm']) {
      const bytes=await readFile(new URL('fixtures/'+file,import.meta.url));
      const [start,end]=file==='indexed-aac.mkv'?[6500,6600]:[700,1400];
      const r=await mf.dispatchFetch(`http://test/cached?start=${start}&end=${end}`,{method:'POST',body:bytes});
      assert.equal(r.status,200,file+': '+await r.clone().text());
      const result=await r.json();assert.equal(result.byteIdentity,true,file+' cached output equals source-beginning decode');
      assert.equal(result.cachedReads,0,'completed revision cache needs no original container reads');
      if(file==='indexed-aac.mkv'){
        assert.equal(result.cacheReads.filter(key=>key.endsWith('.gz')).length,1,'restore one exact checkpoint');
        assert.ok(result.cacheReads.filter(key=>key.endsWith('.bin')).length<=3,'only selected video/audio pages are read');
        assert.ok(result.cacheKeys.some(key=>key.endsWith('.gz')),'inspection persisted checkpoint history');
      }
    }
  } finally {await mf.dispose();}
});
