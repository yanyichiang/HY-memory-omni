import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Uses the actual TypeScript adapter, committed FFmpeg module and production WAV helper.
test('AAC LC / HE / HEv2 decode in workerd with presentation-time priming/tail trims and original sample slices', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const entry = `import {inspectExtendedAudio,normalizeExtendedAudio,sliceExtendedAudio} from './src/aac-audio.ts';
  WebAssembly.compile=()=>{throw Error('runtime_compile_forbidden')};WebAssembly.compileStreaming=WebAssembly.compile;
  export default {async fetch(request){let stage="inspect",maximumRead=0;try{
    const mime=new URL(request.url).searchParams.get('mime'),bytes=new Uint8Array(await request.arrayBuffer()),original=bytes.slice();
    let source={size:bytes.length,read:async(a,n)=>{maximumRead=Math.max(maximumRead,n);return bytes.subarray(a,a+n)}};
    if(['/large-edit','/large-moov'].includes(new URL(request.url).pathname)){
      const size=1024*1024*1024,h=new Uint8Array(16),v=new DataView(h.buffer);
      v.setUint32(0,size);h.set(new URL(request.url).pathname==='/large-moov'?[109,111,111,118]:[101,108,115,116],4);v.setUint32(12,1);
      source={size,read:async(a,n)=>{maximumRead=Math.max(maximumRead,n);const out=new Uint8Array(n);if(a<h.length)out.set(h.subarray(a,Math.min(a+n,h.length)));return out;}};
    }
    const timeline=await inspectExtendedAudio(mime,source);stage="normalize";const wav=await normalizeExtendedAudio(mime,bytes,timeline),v=new DataView(wav.buffer);
    const rate=v.getUint32(24,true),channels=v.getUint16(22,true),samples=v.getUint32(44,true),align=channels*4;
    stage="slice";const logical={startMs:100.123,endMs:900.456},clip=await sliceExtendedAudio(mime,source,logical,timeline);
    stage="tail";const tail=await sliceExtendedAudio(mime,source,{startMs:timeline.durationMs-100,endMs:timeline.durationMs},timeline);
    const check=(item)=>{const start=Math.round(item.actual.startMs*rate/1000),end=Math.round(item.actual.endMs*rate/1000);
      const expected=wav.subarray(56+start*align,56+end*align),got=item.bytes.subarray(56);
      return expected.length===got.length && got.every((value,i)=>value===expected[i]);};
    let energy=0;for(let at=56;at<wav.length;at+=4){const x=v.getFloat32(at,true);if(!Number.isFinite(x))throw Error('nonfinite');energy+=x*x;}
    return Response.json({timeline,rate,channels,samples,energy,tag:v.getUint16(20,true),bits:v.getUint16(34,true),fact:String.fromCharCode(...wav.subarray(36,40)),
      dataLength:v.getUint32(52,true),length:wav.length,actual:clip.actual,logical:clip.logical,offsetMs:clip.offsetMs,sourceTimeline:clip.sourceTimeline,
      sampleIdentity:check(clip),tailIdentity:check(tail),tailEnd:tail.actual.endMs,originalUnchanged:bytes.every((x,i)=>x===original[i])});
  }catch(error){return Response.json({error:error.message,stage,maximumRead},{status:415});}}};`;
  const result = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, sourcefile: 'aac-test-entry.js' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'],
    plugins: [{name:'static-wasm',setup(b){b.onResolve({filter:/\.wasm$/},args=>({path:'./'+args.path.split('/').at(-1),external:true}));}}] });
  const mf = new Miniflare({workers:[{config:{name:'aac-format-test',compatibilityDate:'2026-10-19',manifest:{mainModule:'entry.js',modules:{
    'entry.js':{type:'esm',contents:result.outputFiles[0].text},
    'aac-decoder.wasm':{type:'wasm',contents:await readFile(new URL('../codecs/aac/aac-decoder.wasm',import.meta.url))},
  }}}}]});
  try {
    for (const [file,mime,rate,channels,presentationSamples] of [
      ['tone-aac.m4a','audio/mp4',48000,1,96000],['tone-aac-44100.m4a','audio/mp4',44100,1,88949],['tone-he-aac.m4a','audio/mp4',48000,2,100288],['tone-he-aac-v2.m4a','audio/mp4',48000,2,100288],
      ['tone.aac','audio/aac',48000,1,97280],['tone-he.aac','audio/aac',48000,2,102400],['tone-he-v2.aac','audio/aac',48000,2,102400],
    ]) {
      const bytes=await readFile(new URL('fixtures/'+file,import.meta.url));
      const response=await mf.dispatchFetch('http://test/?mime='+mime,{method:'POST',body:bytes});
      assert.equal(response.status,200,file+': '+await response.clone().text());const r=await response.json();
      assert.equal(r.rate,rate,file);assert.equal(r.channels,channels,file);assert.equal(r.samples,presentationSamples,file);
      assert.equal(r.timeline.durationMs,Math.ceil(presentationSamples/rate*1000),file);
      assert.equal(r.length,56+presentationSamples*channels*4);assert.equal(r.dataLength,r.length-56);
      assert.equal(r.tag,3);assert.equal(r.bits,32);assert.equal(r.fact,'fact');assert.ok(r.energy>0);
      assert.equal(r.sampleIdentity,true,file);assert.equal(r.tailIdentity,true,file);assert.equal(r.originalUnchanged,true,file);
      assert.deepEqual(r.logical,{startMs:100.123,endMs:900.456});assert.deepEqual(r.sourceTimeline,r.timeline);
      assert.equal(r.offsetMs,r.actual.startMs);assert.equal(r.actual.startMs,Math.floor(100.123*rate/1000)/rate*1000);
      assert.equal(r.actual.endMs,Math.ceil(900.456*rate/1000)/rate*1000);assert.equal(r.tailEnd,presentationSamples/rate*1000);
      const truncated=await mf.dispatchFetch('http://test/?mime='+mime,{method:'POST',body:bytes.subarray(0,-1)});
      assert.equal(truncated.status,415,file+' tail truncation');
    }
    const edited=Buffer.from(await readFile(new URL('fixtures/tone-he-aac.m4a',import.meta.url)));
    const elst=edited.indexOf(Buffer.from('elst'));assert.ok(elst>0);edited.writeUInt32BE(2000,elst+12);
    const editedResponse=await mf.dispatchFetch('http://test/?mime=audio/mp4',{method:'POST',body:edited});
    assert.equal(editedResponse.status,200,await editedResponse.clone().text());assert.equal((await editedResponse.json()).samples,96000,'single edit crops end padding at presentation end');
    for(const [offset,value] of [[8,2],[20,131072]]){
      const invalid=Buffer.from(edited);invalid.writeUInt32BE(value,elst+offset);
      const r=await mf.dispatchFetch('http://test/?mime=audio/mp4',{method:'POST',body:invalid});assert.equal(r.status,415);
    }
    const largeEdit=await mf.dispatchFetch('http://test/large-edit?mime=audio/mp4',{method:'POST',body:new Uint8Array(0)});
    assert.equal(largeEdit.status,415);const large=await largeEdit.json();assert.equal(large.error,'audio_m4a_edit_unsupported');assert.ok(large.maximumRead<=8,'reject huge elst before allocating its payload');
    const largeMoov=await mf.dispatchFetch('http://test/large-moov?mime=audio/mp4',{method:'POST',body:new Uint8Array(0)});
    assert.equal(largeMoov.status,415);const moov=await largeMoov.json();assert.equal(moov.error,'audio_m4a_metadata_limit');assert.ok(moov.maximumRead<=8,'bound moov before Mediabunny allocates it');
    // Multiple tracks and nonzero presentation origins must not be silently normalized.
    for(const file of ['multi-aac.m4a','multi-audio.mp4','offset.mp4','encrypted.mp4']) {
      const bytes=await readFile(new URL('fixtures/'+file,import.meta.url));
      const r=await mf.dispatchFetch('http://test/?mime=audio/mp4',{method:'POST',body:bytes});assert.equal(r.status,415,file);
    }
  } finally { await mf.dispose(); }
});

test('AAC checkpoints restore LC, SBR and PS history byte identically in a fresh workerd Wasm instance', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const entry = `import {createAacFrameDecoder} from './src/aac-pcm.ts';
    export default {async fetch(request){let continuous,restored;try{
      const bytes=new Uint8Array(await request.arrayBuffer()),point=+new URL(request.url).searchParams.get('point');
      const frequency=(bytes[2]>>2)&15,channel=((bytes[2]&1)<<2)|(bytes[3]>>6),object=(bytes[2]>>6)+1;
      const asc=new Uint8Array([(object<<3)|(frequency>>1),((frequency&1)<<7)|(channel<<3)]),packets=[];
      for(let at=0;at<bytes.length;){
        const length=((bytes[at+3]&3)<<11)|(bytes[at+4]<<3)|(bytes[at+5]>>5);
        if(!(bytes[at]===255&&(bytes[at+1]&246)===240&&(bytes[at+1]&1)&&length>=7&&at+length<=bytes.length))throw Error('invalid_adts');
        packets.push(bytes.slice(at+7,at+length));at+=length;
      }
      continuous=await createAacFrameDecoder(asc);
      let checkpoint,expected=[],rate,channels;
      for(let i=0;i<packets.length;i++){
        const frame=continuous.decode(packets[i]);rate=frame.rate;channels=frame.channels;
        if(i===point)checkpoint=continuous.checkpoint();
        if(i>point)expected.push(new Uint8Array(frame.data.buffer,frame.data.byteOffset,frame.data.byteLength).slice());
      }
      continuous.free();continuous=undefined;
      restored=await createAacFrameDecoder(asc,checkpoint);
      let identical=true;
      for(let i=point+1;i<packets.length;i++){
        const frame=restored.decode(packets[i]),actual=new Uint8Array(frame.data.buffer,frame.data.byteOffset,frame.data.byteLength),want=expected[i-point-1];
        identical&&=frame.rate===rate&&frame.channels===channels&&actual.length===want.length&&actual.every((value,j)=>value===want[j]);
      }
      const damaged=checkpoint.slice();damaged[0]^=1;let rejected=false;
      try{await createAacFrameDecoder(asc,damaged)}catch(e){rejected=e.code==='audio_aac_checkpoint_invalid'}
      return Response.json({identical,rejected,compared:expected.length,checkpointBytes:checkpoint.length});
    }catch(e){return Response.json({error:e.message},{status:415})}finally{continuous?.free();restored?.free()}}};`;
  const result = await build({absWorkingDir:root,stdin:{contents:entry,resolveDir:root,sourcefile:'aac-checkpoint-test.js'},
    bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],
    plugins:[{name:'static-wasm',setup(b){b.onResolve({filter:/\.wasm$/},args=>({path:'./'+args.path.split('/').at(-1),external:true}));}}]});
  const mf = new Miniflare({workers:[{config:{name:'aac-checkpoint-test',compatibilityDate:'2026-10-19',manifest:{mainModule:'entry.js',modules:{
    'entry.js':{type:'esm',contents:result.outputFiles[0].text},
    'aac-decoder.wasm':{type:'wasm',contents:await readFile(new URL('../codecs/aac/aac-decoder.wasm',import.meta.url))},
  }}}}]});
  try {
    for (const file of ['tone.aac','tone-he.aac','tone-he-v2.aac']) {
      const bytes=await readFile(new URL('fixtures/'+file,import.meta.url));
      for(const point of [0,7,31]) {
        const r=await mf.dispatchFetch('http://test/?point='+point,{method:'POST',body:bytes});
        assert.equal(r.status,200,file+': '+await r.clone().text());
        const result=await r.json();assert.equal(result.identical,true,file+' packet '+point);
        assert.equal(result.rejected,true);assert.ok(result.compared>10);assert.ok(result.checkpointBytes<=64*1024*1024+65568);
      }
    }
  } finally {await mf.dispose();}
});
