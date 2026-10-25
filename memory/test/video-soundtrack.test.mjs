import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// This test bundles only the new helper; it does not change the production build.
test('actual Worker extracts presented AAC, MP3 and derived MOV PCM soundtrack without invented samples', {timeout:120000}, async () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const bundled=await build({absWorkingDir:root,stdin:{contents:"export {videoSoundtrack} from './src/video-soundtrack.ts'; export {inspectMedia} from './src/media.ts'; export {sliceVideo} from './src/video.ts'; export {CloudflareMemoryModels} from './src/models.ts';",resolveDir:root},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',alias:{mediabunny:join(root,'.generated/mediabunny/src/index.ts')},
    plugins:[{name:'static-wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}))}}]});
  const modules={'soundtrack.js':{type:'esm',contents:bundled.outputFiles[0].text}};
  for(const name of await readdir(new URL('../dist/',import.meta.url)))if(name.endsWith('.wasm'))modules[name]={type:'wasm',contents:await readFile(new URL('../dist/'+name,import.meta.url))};
  modules['test.js']={type:'esm',contents:`import{videoSoundtrack,inspectMedia,sliceVideo,CloudflareMemoryModels}from'./soundtrack.js';
    WebAssembly.compile=()=>{throw Error('runtime_compile_forbidden')};WebAssembly.compileStreaming=()=>{throw Error('runtime_compile_forbidden')};
    export default{async fetch(r){try{const bytes=new Uint8Array(await r.arrayBuffer());const url=new URL(r.url),mime=url.searchParams.get('mime');
    if(url.pathname==='/inspect')return Response.json(await inspectMedia(mime,bytes));
    if(url.pathname==='/slice'){const result=await sliceVideo(mime,{size:bytes.length,read:async(a,n)=>bytes.subarray(a,a+n)},{startMs:0,endMs:Number(url.searchParams.get('end'))});return Response.json({timeline:result.timeline})}
    if(url.pathname==='/embed'){let request;const models=new CloudflareMemoryModels({accountId:'test',gatewayId:'test',token:'fixture',mediaEmbeddingModel:'gemini-embedding-2'}, {},async(_u,init)=>{request=JSON.parse(init.body);return Response.json({embedding:{values:Array(1536).fill(0.1)}})});const vector=await models.embed({mimeType:mime,bytes});return Response.json({request,modalities:vector.modalities})}
    const result=await videoSoundtrack(mime,bytes);
    if(!result)return Response.json({absent:true});let data='';for(let at=0;at<result.bytes.length;at+=8192)data+=String.fromCharCode(...result.bytes.subarray(at,at+8192));
    return Response.json({...result,bytes:btoa(data)});}catch(e){return Response.json({error:e.message},{status:e.status||500})}}}`};
  const mf=new Miniflare({workers:[{config:{name:'video-soundtrack-test',compatibilityDate:'2026-10-19',manifest:{mainModule:'test.js',modules}}}]});
  const call=async(bytes,mime,path='/')=>{const r=await mf.dispatchFetch('http://test'+path+(path.includes('?')?'&':'?')+'mime='+encodeURIComponent(mime),{method:'POST',body:bytes});return{status:r.status,result:await r.json()}};
  const wave=result=>{
    const bytes=Buffer.from(result.bytes,'base64');assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');
    assert.equal(bytes.readUInt16LE(20),3);assert.equal(bytes.length,56+bytes.readUInt32LE(52));assert.ok(bytes.length<=8388608);
    const rate=bytes.readUInt32LE(24),channels=bytes.readUInt16LE(22),samples=bytes.readUInt32LE(44);
    assert.equal(samples*channels*4,bytes.readUInt32LE(52));assert.ok(Math.abs((result.endMs-result.startMs)/1000*rate-samples)<1e-6);
    for(let at=56;at<bytes.length;at+=4)assert.ok(Number.isFinite(bytes.readFloatLE(at)));
    return{bytes,rate,channels,samples};
  };
  try{
    for(const file of ['synthetic-meeting-m42.mp4','blue-tone.mp4']){
      const bytes=await readFile(new URL('fixtures/'+file,import.meta.url));const response=await call(bytes,'video/mp4');assert.equal(response.status,200,JSON.stringify(response.result));
      const wav=wave(response.result);assert.ok(wav.samples>0);assert.ok(wav.channels>=1&&wav.channels<=2);
      const embedded=await call(bytes,'video/mp4','/embed');assert.equal(embedded.status,200,JSON.stringify(embedded.result));
      assert.deepEqual(embedded.result.modalities,['video','audio']);
      const parts=embedded.result.request.content.parts;
      assert.equal(parts[0].inline_data.data,bytes.toString('base64'));
      assert.equal(parts.at(-1).inline_data.mime_type,'audio/wav');
      assert.equal(parts.at(-1).inline_data.data,response.result.bytes,'embedding must carry the actual presented soundtrack in the same request');
      if(file==='synthetic-meeting-m42.mp4'){
        // Existing fixture has AAC packet 165 shortened to only 65 presented samples.
        // Full-frame concatenation adds samples here; use the independently read container clock.
        const {Input,BufferSource,MP4,EncodedPacketSink}=await import('mediabunny');
        const input=new Input({formats:[MP4],source:new BufferSource(bytes)});
        try{const audio=await input.getPrimaryAudioTrack();let end=0,short=false;
          for await(const p of new EncodedPacketSink(audio).packets()){
            if(Math.round(p.duration*wav.rate)===65)short=true;
            end=Math.max(end,Math.round((p.timestamp+p.duration)*wav.rate));
          }
          assert.ok(short,'fixed M42 shortened packet must remain in this regression');assert.equal(wav.samples,end);assert.equal(response.result.startMs,0);
        }finally{input.dispose()}
      }
    }
    const silentVideo=await readFile(new URL('fixtures/blue.mp4',import.meta.url));
    assert.deepEqual((await call(silentVideo,'video/mp4')).result,{absent:true});
    if(process.env.HY_SOUNDTRACK_MOV_DIR){
      const files=(await readdir(process.env.HY_SOUNDTRACK_MOV_DIR)).filter(n=>n.endsWith('.mov'));
      assert.ok(files.length>=6,'actual Matroska MOV boundary fixtures required');
      let delayed=false;
      for(const name of files){
        const bytes=await readFile(join(process.env.HY_SOUNDTRACK_MOV_DIR,name));const response=await call(bytes,'video/quicktime');assert.equal(response.status,200,name+': '+JSON.stringify(response.result));
        const wav=wave(response.result);
        const {Input,BufferSource,QTFF,EncodedPacketSink}=await import('mediabunny');
        const source=new Input({formats:[QTFF],source:new BufferSource(bytes)});
        try{
          const audio=await source.getPrimaryAudioTrack();assert.equal(await audio.getCodec(),'pcm-f32');
          assert.equal(wav.rate,await audio.getSampleRate());assert.equal(wav.channels,await audio.getNumberOfChannels());
          const start=Math.round(response.result.startMs*wav.rate/1000),end=Math.round(response.result.endMs*wav.rate/1000);let matched=0;
          for await(const packet of new EncodedPacketSink(audio).packets()){
            const at=Math.round(packet.timestamp*wav.rate),count=Math.round(packet.duration*wav.rate);
            const from=Math.max(0,start-at),to=Math.min(count,end-at);
            if(to>from){assert.deepEqual(wav.bytes.subarray(56+(at+from-start)*wav.channels*4,56+(at+to-start)*wav.channels*4),Buffer.from(packet.data.subarray(from*wav.channels*4,to*wav.channels*4)));matched+=to-from;}
          }
          assert.equal(matched,wav.samples,'actual derived MOV PCM remains byte-exact at its presented sample positions');
        }finally{source.dispose()}

        if(response.result.startMs>0)delayed=true;
      }
      assert.ok(delayed,'actual MOV fixtures include a soundtrack starting after video origin');
    }
    const bad=await call(new Uint8Array([0,1,2]),'video/mp4');assert.notEqual(bad.status,200);
    const expanded=await readFile(new URL('fixtures/expansion-aac.mp4',import.meta.url));assert.ok(expanded.length<8388608);
    assert.equal((await call(expanded,'video/mp4','/inspect')).result.error,'media_inline_expansion_exceeded');
    assert.equal((await call(expanded,'video/mp4','/slice?end=30000')).result.error,'media_slice_too_large');
    assert.equal((await call(expanded,'video/mp4','/slice?end=10000')).status,200,'the same source succeeds as a bounded segment');
  }finally{await mf.dispose()}
});
