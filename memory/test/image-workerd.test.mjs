import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Fully synthetic palette GIFs. Clear before each literal keeps the fixture's
// encoder trivial; this test verifies production integration, not LZW internals.
function gif(animated) {
  const le = n => [n & 255, n >> 8];
  const out = [...Buffer.from('GIF89a'), ...le(2), ...le(1), 0x81, 0, 0,
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
  if (animated) out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  for (const [color, delay] of animated ? [[1, 0], [2, 2], [3, 3]] : [[1, 0]]) {
    const values = [4, color, 4, color, 5]; let bits = 0, datum = 0; const data = [];
    for (const code of values) { datum |= code << bits; bits += 3; while (bits >= 8) { data.push(datum & 255); datum >>>= 8; bits -= 8; } }
    if (bits) data.push(datum);
    out.push(0x21, 0xf9, 4, 4, ...le(delay), 0, 0, 0x2c,
      ...le(0), ...le(0), ...le(2), ...le(1), 0, 2, data.length, ...data, 0);
  }
  return Buffer.from([...out, 0x3b]);
}

test('actual Worker preserves GIF originals through production image/model/service wires and revision/revocation', { timeout: 120000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), wasms = new Map();
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export {MemoryService} from './src/service.ts';
    export {MemoryStore} from './src/storage.ts';
    export {CloudflareMemoryModels} from './src/models.ts';
    export {nativeImage} from './src/native-image.ts';
    export {lzw} from './codecs/gif/vendor/lzw.js';
    export {BufferSource,EncodedPacketSink,Input,MP4} from 'mediabunny';` },
  write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  alias: { mediabunny: join(root, '.generated/mediabunny/src/index.ts') },
  plugins: [{ name: 'image-static-wasm', setup(b) {
    b.onResolve({ filter: /\.wasm$/ }, a => {
      const path = resolve(a.resolveDir, a.path), name = basename(path);
      if (wasms.has(name)) assert.equal(wasms.get(name), path, 'WASM basenames must not collide');
      wasms.set(name, path); return { path: './' + name, external: true };
    });
  } }] });
  const modules = { 'production.js': { type: 'esm', contents: bundle.outputFiles[0].text } };
  for (const [name, path] of wasms) modules[name] = { type: 'wasm', contents: await readFile(path) };
  modules['test.js'] = { type: 'esm', contents: `
    import {MemoryService,MemoryStore,CloudflareMemoryModels,nativeImage,lzw,BufferSource,EncodedPacketSink,Input,MP4} from './production.js';
    WebAssembly.compile=WebAssembly.compileStreaming=()=>{throw Error('runtime_compile_forbidden')};
    const encode=b=>btoa(String.fromCharCode(...b));
    const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    const check=(ok,message)=>{if(!ok)throw Error(message)};
    const temporal=text=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});
    export default {async fetch(request){try{
      if(new URL(request.url).pathname==='/frame-grounding'){
        const fixture=await request.json(),bytes=decode(fixture.base64),native=await nativeImage('image/gif',bytes);
        const models=new CloudflareMemoryModels({accountId:'fixture',gatewayId:'fixture',token:'fixture',temporalModel:'gemini-2.5-flash'}, {},
          async(_url,init)=>{const body=JSON.parse(init.body);check(body.input.generationConfig.responseSchema.properties.ranges,'animation must use frame schema');
            return temporal(JSON.stringify({ranges:[{startFrame:fixture.start,endFrame:fixture.end,text:'Synthetic selected frame.'}]}));});
        return Response.json(await models.locate({mimeType:'image/gif',bytes,timeline:native.timeline,query:'Find the synthetic displayed frame.'}));
      }
      if(new URL(request.url).pathname==='/lzw-regression'){
        const input=await request.json();return Response.json({pixels:Array.from(lzw(2,Uint8Array.from(input.data),2))});
      }
      if(new URL(request.url).pathname==='/gif-regression'){
        const bytes=new Uint8Array(await request.arrayBuffer()),before=encode(bytes),native=await nativeImage('image/gif',bytes);
        check(encode(bytes)===before,'regression decoder mutated original');
        const input=new Input({formats:[MP4],source:new BufferSource(native.bytes)}),packets=[];
        try{const t=await input.getPrimaryVideoTrack();for await(const p of new EncodedPacketSink(t).packets())packets.push({startMs:p.timestamp*1000,durationMs:p.duration*1000,type:p.type});}finally{input.dispose();}
        return Response.json({mimeType:native.mimeType,timeline:native.timeline,representation:native.representation,packets});
      }
      const fixtures=await request.json(),wire=[];
      const settings={accountId:'fixture-account',gatewayId:'fixture-gateway',token:'fixture-token',
        formationModel:'fixture-formation',temporalModel:'gemini-2.5-flash',mediaEmbeddingModel:'gemini-embedding-2'};
      const models=new CloudflareMemoryModels(settings,{fetch:async r=>{
        const body=await r.json();
        if(body.operation==='write'){
          // Mirrors an observed engine.py 422 boundary, not a permissive model
          // adapter: source representation metadata is not a Hy writer field.
          check(JSON.stringify(Object.keys(body.perception).sort())===JSON.stringify(['configKey','kind','model','text']),'engine PERCEPTION_REQUIRED: unexpected perception keys');
          check(['text','image','audio','video'].includes(body.perception.kind),'engine PERCEPTION_KIND_INVALID');
          check(['model','configKey','text'].every(k=>typeof body.perception[k]==='string'&&body.perception[k].trim()),'engine PERCEPTION_INVALID');
          check(body.content===body.perception.text,'engine PERCEPTION_CONTENT_MISMATCH');
        }
        return Response.json(body.operation==='search'?{success:true,memories:[]}:{success:true,nodes:[{
          payload:{node_id:body.requestId,user_id:body.principal.ownerRef,agent_id:body.principal.scopeRef,
            content:body.content,layer:'l2_fact',status:'active',is_latest:true,custom:{meta:[{sourceRef:body.sourceRef}]}},
          embedding:[1,0,0],lexicalTokens:['synthetic','image']}]});
      }},async(url,init)=>{
        const body=JSON.parse(init.body);wire.push({url,body});
        if(url.includes(':embedContent'))return Response.json({embedding:{values:Array(1536).fill(0.1)}});
        if(body.input){const schema=body.input.generationConfig.responseSchema;
          if(schema?.properties?.ranges)return temporal(JSON.stringify({ranges:[{startFrame:'source-frame-1',endFrame:'source-frame-2',text:'Synthetic green then blue displayed frames.'}]}));
          if(schema?.properties?.intervals)return temporal(JSON.stringify({intervals:[{startMs:0,endMs:20,text:'Synthetic green frame.',modalities:['video']}]}));
          if(schema?.properties?.matches)return temporal(JSON.stringify({matches:true,text:'Synthetic source image matches.'}));
          if(body.input.contents[0].parts.some(p=>p.text?.startsWith('QUERY MEDIA ONLY')))return temporal('A synthetic green then blue animation.');
          return temporal('A synthetic green then blue animation.');
        }
        const system=body.messages?.[0]?.content;
        let content='A synthetic red image.';
        if(system?.startsWith('Project the supplied')){
          const input=JSON.parse(body.messages[1].content);
          content=JSON.stringify({claims:[{key:'fixture',nodeId:input.nodes[0].nodeId,text:input.perception.text,
            subject:'Synthetic source',event:'Synthetic image observation',predicate:'appearance',value:input.perception.text,
            validTime:'',conditions:'',quote:input.perception.text}]});
        }else if(system?.includes('relations')){
          const input=JSON.parse(body.messages[1].content);
          content=JSON.stringify({relations:input.pairs.map(p=>({left:p.left.id,right:p.right.id,kind:'different',reason:'Distinct synthetic source observations.'}))});
        }else if(system?.startsWith('Verify image retrieval')){
          content=JSON.stringify({matches:true,text:'Synthetic source image matches.'});
        }
        return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
      });
      const objects=new Map(),db=new MemoryStore(),blobs={put:async(k,b,m)=>objects.set(k,{bytes:b.slice(),mimeType:m}),
        get:async k=>objects.get(k)?.bytes??null,delete:async k=>objects.delete(k)};
      const owner={ownerRef:'synthetic-owner',scopeRef:'personal'};
      let service=new MemoryService(db,blobs,models,owner);
      const upload=(name,data)=>({operationId:name,messageRef:name,sessionRef:'fixture',mimeType:'image/gif',dataBase64:data});
      const still=await service.ingest(upload('still',fixtures.still));
      const animation=await service.ingest(upload('animation',fixtures.animation));
      const stillRead=await service.read(still.ref),animationRead=await service.read(animation.ref);
      check(stillRead.dataBase64===fixtures.still&&animationRead.dataBase64===fixtures.animation,'original bytes changed');
      check(stillRead.mimeType==='image/gif'&&animationRead.mimeType==='image/gif','original MIME changed');
      check(!stillRead.timeline&&animationRead.timeline.durationMs===50,'still/animation classification failed');
      check(stillRead.parser.kind==='image'&&animationRead.parser.kind==='image','derivative replaced source kind');
      check(stillRead.knowledge.claims.length===1&&animationRead.knowledge.claims.length===1,'fixture must publish source-bound claims before testing invalidation');
      const source=decode(fixtures.animation),before=encode(source),native=await nativeImage('image/gif',source);
      check(encode(source)===before,'nativeImage mutated original');
      const input=new Input({formats:[MP4],source:new BufferSource(native.bytes)}),packets=[];
      try{const track=await input.getPrimaryVideoTrack();for await(const p of new EncodedPacketSink(track).packets())packets.push({startMs:p.timestamp*1000,durationMs:p.duration*1000,type:p.type});}finally{input.dispose();}
      const beforeSearch=wire.length;
      const search=await service.search({sessionRef:'query',media:{mimeType:'image/gif',dataBase64:fixtures.animation},limit:5});
      const searchWire=wire.slice(beforeSearch);
      check(search.items.length===2,'both still and temporal image consumers must be connected');
      check(search.items.some(i=>i.retrieval==='verified-image')&&search.items.some(i=>i.retrieval==='grounded'),'image/temporal grounding split failed');
      const beforeStillQuery=wire.length;
      await service.search({sessionRef:'still-query',media:{mimeType:'image/gif',dataBase64:fixtures.still},limit:5});
      const stillQueryWire=wire.slice(beforeStillQuery);
      const rebuildBefore=wire.length;
      const rebuilt=await service.reinspect({ref:animation.ref,operationId:'reinspect',question:'Recheck the synthetic animation.'});
      check(!(await service.validate([animation.ref])).valid,'old interpretation remains valid');
      service=new MemoryService(db,blobs,models,owner);
      const rebuiltRead=await service.read(rebuilt.ref);
      check(rebuiltRead.dataBase64===fixtures.animation&&rebuiltRead.ref.revision===2,'rebuild lost original/source revision');
      check(rebuiltRead.knowledge.claims.length===1&&rebuiltRead.knowledge.claims[0].source.revision===2,'rebuild retained stale claim revision');
      const rebuildWire=wire.slice(rebuildBefore);
      await service.forget({ref:rebuilt.ref,operationId:'revoke-animation'},true);
      await service.forget({ref:still.ref,operationId:'revoke-still'},true);
      check(!(await service.validate([rebuilt.ref])).valid,'revoked reference remains valid');
      const final=await service.search({sessionRef:'after-revoke',query:'synthetic',limit:5});
      check(final.items.length===0&&final.knowledge.claims.length===0,'revoked image remains searchable');
      return Response.json({stillRead,animationRead,rebuiltRead,packets,search,wire,searchWire,stillQueryWire,rebuildWire,
        originalsRetained:[...objects.values()].map(o=>({mimeType:o.mimeType,base64:encode(o.bytes)}))});
    }catch(e){return Response.json({error:e.message,stack:e.stack},{status:500});}}};
  ` };
  const runtime = new Miniflare({ workers: [{ config: { name: 'production-image-integration', compatibilityDate: '2026-10-19', manifest: { mainModule: 'test.js', modules } } }] });
  try {
    const still = gif(false), animation = gif(true);
    const response = await runtime.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({ still: still.toString('base64'), animation: animation.toString('base64') }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    const { stillRead, animationRead, rebuiltRead, packets, wire, searchWire, rebuildWire } = result;
    assert.equal(stillRead.parser.representation.kind, 'still');
    assert.equal(animationRead.parser.representation.kind, 'animation');
    assert.deepEqual(stillRead.representation, stillRead.parser.representation, 'source-owned derivative metadata survives the strict engine projection');
    assert.deepEqual(animationRead.representation, animationRead.parser.representation);
    assert.deepEqual(rebuiltRead.representation, animationRead.representation);
    assert.deepEqual(animationRead.timeline.animation.frames.map(f => [f.startMs, f.endMs, f.rawDelayCentiseconds]), [[0, 0, 0], [0, 20, 2], [20, 50, 3]]);
    assert.deepEqual(packets, [{ startMs: 0, durationMs: 20, type: 'key' }, { startMs: 20, durationMs: 30, type: 'key' }]);
    assert.deepEqual(rebuiltRead.timeline.animation.frames, animationRead.timeline.animation.frames);
    const embeds = wire.filter(w => w.url.includes(':embedContent'));
    assert.deepEqual(embeds.slice(0, 2).map(w => w.body.content.parts[0].inline_data.mime_type), ['image/png', 'video/mp4']);
    assert.equal(Buffer.from(embeds[0].body.content.parts[0].inline_data.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const cue = searchWire.filter(w => w.body.input?.contents[0].parts.some(p => p.text?.startsWith('QUERY MEDIA ONLY')));
    assert.equal(cue.length, 1, 'one animation query cue shared across candidates');
    assert.deepEqual(cue[0].body.input.contents[0].parts.filter(p => p.inlineData).map(p => p.inlineData.mimeType), ['video/mp4']);
    const grounding = searchWire.filter(w => w.body.input?.generationConfig.responseSchema);
    assert.deepEqual(grounding.map(w => w.body.input.contents[0].parts.filter(p => p.inlineData).map(p => p.inlineData.mimeType)).sort(), [['image/png'], ['video/mp4']].sort());
    assert.ok(grounding.every(w => w.body.input.contents[0].parts.some(p => p.text?.includes('not source evidence'))));
    const temporalHit = result.search.items.find(i => i.retrieval === 'grounded').groundings[0];
    assert.equal(temporalHit.basis, 'source-frame');
    assert.deepEqual(temporalHit.frames, { startIndex: 1, endIndex: 2, startMs: 0, endMs: 50 });
    assert.equal(temporalHit.startMs, 0); assert.equal(temporalHit.endMs, 50);
    assert.ok(searchWire.some(w => w.body.input?.contents[0].parts.some(p => p.text?.includes('Source frame clock (authoritative)'))));
    assert.equal(result.stillQueryWire.filter(w => w.body.input?.contents[0].parts.some(p => p.text?.startsWith('QUERY MEDIA ONLY'))).length, 0, 'still GIF query remains a native PNG, not a textual cue');
    const imagePair = result.stillQueryWire.find(w => w.body.messages?.[1]?.content?.filter?.(p => p.type === 'image_url').length === 2);
    assert.ok(imagePair);
    assert.ok(imagePair.body.messages[1].content.filter(p => p.type === 'image_url').every(p => p.image_url.url.startsWith('data:image/png;base64,')));
    assert.equal(rebuildWire.filter(w => w.url.includes(':embedContent')).length, 1, 'reinspection rebuilds vector');
    assert.ok(result.originalsRetained.some(o => o.base64 === animation.toString('base64') && o.mimeType === 'image/gif'));
    for (const [index, expected] of [[1, [0, 20]], [2, [20, 50]]]) {
      const mapped = await runtime.dispatchFetch('http://test/frame-grounding', { method: 'POST', body: JSON.stringify({ base64: animation.toString('base64'), start: 'source-frame-' + index, end: 'source-frame-' + index }) });
      const match = await mapped.json(); assert.equal(mapped.status, 200, JSON.stringify(match));
      assert.equal(match.intervals[0].basis, 'source-frame');
      assert.deepEqual([match.intervals[0].startMs, match.intervals[0].endMs], expected);
      assert.deepEqual(match.intervals[0].frames, { startIndex: index, endIndex: index, startMs: expected[0], endMs: expected[1] });
    }
    for (const [start, end] of [['source-frame-0', 'source-frame-0'], ['source-frame-999', 'source-frame-999'], ['source-frame-2', 'source-frame-1'], [1, 2]]) {
      const invalid = await runtime.dispatchFetch('http://test/frame-grounding', { method: 'POST', body: JSON.stringify({ base64: animation.toString('base64'), start, end }) });
      assert.notEqual(invalid.status, 200);
      assert.equal((await invalid.json()).error, 'animation_grounding_invalid');
    }
    // Owner-generated FFmpeg synthetic B→D notification. Its second LZW stream
    // has byte-packing padding after EOI; valid pixels must not be rejected.
    const regression = await readFile(new URL('../../test/live-fixtures/revision.gif', import.meta.url));
    const rr = await runtime.dispatchFetch('http://test/gif-regression', { method: 'POST', body: regression });
    const decoded = await rr.json(); assert.equal(rr.status, 200, JSON.stringify(decoded));
    assert.equal(decoded.mimeType, 'video/mp4');
    assert.equal(decoded.timeline.durationMs, 6000);
    assert.equal(decoded.representation.originalWidth, 1000);
    assert.equal(decoded.representation.originalHeight, 566);
    assert.deepEqual(decoded.representation.frames.map(f => [f.startMs, f.endMs]), [[0, 3000], [3000, 6000]]);
    assert.deepEqual(decoded.packets, [{ startMs: 0, durationMs: 3000, type: 'key' }, { startMs: 3000, durationMs: 3000, type: 'key' }]);
    const truncated = await runtime.dispatchFetch('http://test/gif-regression', { method: 'POST', body: regression.subarray(0, regression.length - 1) });
    assert.notEqual(truncated.status, 200, 'missing GIF trailer must still fail');
    const pack = codes => {
      let datum = 0, bits = 0; const data = [];
      for (const code of codes) { datum |= code << bits; bits += 3; while (bits >= 8) { data.push(datum & 255); datum >>>= 8; bits -= 8; } }
      if (bits) data.push(datum); return data;
    };
    const padded = await runtime.dispatchFetch('http://test/lzw-regression', { method: 'POST', body: JSON.stringify({ data: [...pack([4, 1, 4, 1, 5]), 0] }) });
    assert.equal(padded.status, 200);
    assert.deepEqual((await padded.json()).pixels, [1, 1]);
    for (const [name, codes] of [['missing EOI', [4, 1, 4, 1]], ['early EOI', [4, 1, 5]], ['invalid dictionary', [4, 7, 5]], ['pixel overflow', [4, 1, 4, 1, 4, 1, 5]]]) {
      const invalid = await runtime.dispatchFetch('http://test/lzw-regression', { method: 'POST', body: JSON.stringify({ data: pack(codes) }) });
      assert.notEqual(invalid.status, 200, name);
      assert.equal((await invalid.json()).error, 'gif_lzw_invalid', name);
    }
  } finally { await runtime.dispose(); }
});
