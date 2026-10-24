import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Native input/container/storage paths are real. Every model judgment is a
// fixed synthetic fixture, not evidence of recognition or semantic quality.
test('real multipart fixed video publishes all clips, groups original times, reads a range, and revokes descendants; upload identity cannot create another root', {timeout:60000},async()=>{
 const principal={ownerRef:'long-video-fixture-owner',scopeRef:'personal'};
 const persistence=await mkdtemp(join(tmpdir(),'hy-long-video-worker-'));
 const bytes=await readFile(new URL('fixtures/blue-tone-2s.mp4',import.meta.url));
 const formed=[],nativeInputs=[];
 let mf;
 const engine=async request=>{
   const body=await request.json();
   if(body.operation==='search'){
     assert.equal(body.nodes,undefined);
     const caller=await mf.getWorker('read-caller');
     const response=await caller.fetch('https://memory/read-store',{method:'POST',body:JSON.stringify({principal,
       revision:body.readStore.revision,method:'list_by_user',args:{user_id:principal.ownerRef,agent_id:principal.scopeRef,
         pageSize:64,layers:['l2_fact'],status_filter:['active'],only_latest:true}})});
     const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.result.nextCursor,null);
     return Response.json({success:true,memories:value.result.rows.map(row=>({memory_id:row.payload.node_id})),
       retrievalCoverage:{exhaustive:value.coverage.exhaustive,calls:[value.coverage]}});
   }
   assert.deepEqual(body.nodes,[],'each clip forms only its source-local batch');
   formed.push(body.sourceRef);
   return Response.json({success:true,nodes:[{payload:{node_id:body.requestId,user_id:principal.ownerRef,agent_id:principal.scopeRef,
     content:body.content,layer:'l2_fact',status:'active',is_latest:true,custom:{meta:[{sourceRef:body.sourceRef}]}},
     embedding:[1,0,0],lexicalTokens:['synthetic','blue','tone']}]});
 };
 const outbound=async request=>{
   const url=new URL(request.url),body=await request.json();
   if(url.pathname.endsWith(':embedContent')){
     if(body.content.parts[0].inline_data)assert.ok(body.content.parts[0].inline_data.data.length>100);
     return Response.json({embedding:{values:[1,...Array(1535).fill(0)]}});
   }
   if(url.pathname.endsWith('/chat/completions')){
     const input=JSON.parse(body.messages[1].content);
     let content;
     if(body.messages[0].content.startsWith('Project the supplied current Hy L2 memories'))content={claims:[{
       key:'clip',nodeId:input.nodes[0].nodeId,text:input.perception.text,subject:'Synthetic video',event:'This two second fixture',
       predicate:'recording',value:input.perception.text,validTime:'',conditions:'',quote:input.perception.text}]};
     else if(body.messages[0].content.startsWith('Assess EACH supplied ordered pair'))content={relations:input.pairs.map(({left,right})=>({
       left:left.id,right:right.id,kind:'different',reason:'Fixed fixture treats clips as separate observations.'}))};
     else throw Error('unexpected fixture chat prompt');
     return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]});
   }
   if(url.pathname.endsWith('/ai/run')){
     assert.equal(body.model,'google/gemini-2.5-flash');
     const input=body.input,native=input.contents[0].parts[0].inlineData;
     assert.equal(native.mimeType,'video/mp4');assert.ok(native.data.length>100);
     nativeInputs.push(native.data.length);
     const schema=input.generationConfig.responseSchema;
     let text='Synthetic blue frames with a generated tone.';
     if(schema){
       assert.ok(schema.properties.intervals,'fixed segmentation must not invoke dynamic segmentation or reasoning');
       const prompt=input.contents[0].parts.find(p=>typeof p.text==='string').text;
       const duration=Number(/duration (\d+) milliseconds/.exec(prompt)?.[1]);assert.ok(duration>0);
       text=JSON.stringify({...(schema.properties.correctionRelevant?{correctionRelevant:false}:{}),intervals:[{startMs:0,endMs:duration,text:'Fixed synthetic joint blue/tone match.',modalities:['video','audio']}]});
     }
     return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});
   }
   throw Error(`unexpected outbound path ${url.pathname}`);
 };
 const directory=new URL('../dist/',import.meta.url),modules={};
 for(const name of await readdir(directory)){
   if(name.endsWith('.js'))modules[name]={type:'esm',contents:await readFile(new URL(name,directory),'utf8')};
   if(name.endsWith('.wasm'))modules[name]={type:'wasm',contents:await readFile(new URL(name,directory))};
 }
 const options=convertV4MiniflareOptions({resourcePersistencePath:persistence,workers:[
   {name:'caller',modules:true,compatibilityDate:'2026-10-19',script:'export default {fetch(request,env){return env.MEMORY.fetch(request)}}',
    serviceBindings:{MEMORY:{name:'memory',entrypoint:'MemoryAPI'}}},
   {name:'read-caller',modules:true,compatibilityDate:'2026-10-19',script:'export default {fetch(request,env){return env.MEMORY_READ.fetch(request)}}',
    serviceBindings:{MEMORY_READ:{name:'memory',entrypoint:'MemoryReadAPI'}}},
   {name:'memory',modules:true,compatibilityDate:'2026-10-19',scriptPath:fileURLToPath(new URL('../dist/worker.js',import.meta.url)),
    durableObjects:{MEMORY:{className:'MemoryObject',useSQLite:true}},r2Buckets:['ORIGINALS'],serviceBindings:{HY_ENGINE:engine},outboundService:outbound,
    bindings:{CF_ACCOUNT_ID:'synthetic-account',MEMORY_GATEWAY_ID:'synthetic-gateway',MEMORY_MODEL_TOKEN:'synthetic-token',
      MEMORY_FORMATION_MODEL:'@cf/deepseek-ai/deepseek-v4.1-flash-1017',MEMORY_TEXT_EMBEDDING_MODEL:'@cf/qwen/qwen3-embedding-0.6b',
      MEMORY_MEDIA_EMBEDDING_MODEL:'gemini-embedding-2',MEMORY_TEMPORAL_MODEL:'gemini-2.5-flash'}}]});
 options.workers[2].config.manifest={mainModule:'worker.js',modulesRoot:fileURLToPath(directory),modules};
 mf=new Miniflare(options);
 const api=async(path,body,status=200)=>{
   const response=await mf.dispatchFetch(`https://memory.test${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,principal})});
   const result=await response.json();assert.equal(response.status,status,`${path}: ${JSON.stringify(result)}`);return result;
 };
 try{
   const upload=await api('/video/upload',{mimeType:'video/mp4'});
   const partResponse=await mf.dispatchFetch('https://memory.test/video/part',{method:'POST',headers:{
     'memory-principal':JSON.stringify(principal),'memory-upload':upload.uploadId,'memory-part':'1','content-length':String(bytes.length)},body:bytes});
   const part=await partResponse.json();assert.equal(partResponse.status,200,JSON.stringify(part));assert.equal(part.partNumber,1);assert.ok(part.etag);
   const completion={uploadId:upload.uploadId,operationId:'fixed-root',messageRef:'tiny-video',sessionRef:'video-session',
     strategy:'fixed',seconds:.5,minDurationMs:100,parts:[part]};
   const queued=await api('/video/complete-upload',completion);assert.equal(queued.state,'queued');
   const duplicate=await api('/video/complete-upload',{...completion,operationId:'alien-root'},409);
   assert.equal(duplicate.error,'upload_source_already_bound');
   assert.equal((await api('/operation',{operationId:'alien-root'},404)).error,'operation_not_found');
   let state=await api('/video/status',{operationId:'fixed-root'});
   for(let step=0;state.state!=='complete'&&step<8;step++){
     assert.equal(state.state,'queued',JSON.stringify(state));
     state=await api('/video/step',{operationId:'fixed-root'});
   }
   assert.equal(state.state,'complete',JSON.stringify(state));assert.ok(state.cursorMs>=2000&&state.cursorMs<2100);
   const sources=(await api('/sources',{limit:64})).items;
   assert.equal(sources.filter(s=>s.video).length,1,'one upload cannot create multiple roots sharing its key');
   const clips=sources.filter(s=>s.clip).sort((a,b)=>a.clip.logical.startMs-b.clip.logical.startMs);
   assert.equal(clips.length,Math.ceil(state.cursorMs/500));assert.equal(formed.length,clips.length);
   assert.equal(clips[0].clip.logical.startMs,0);assert.equal(clips.at(-1).clip.logical.endMs,state.cursorMs);
   for(let i=0;i<clips.length;i++){
     assert.deepEqual(clips[i].clip.original,queued.ref);
     if(i)assert.equal(clips[i-1].clip.logical.endMs,clips[i].clip.logical.startMs);
   }
   const found=await api('/search',{query:'Find the blue frames together with the tone',sessionRef:'query',limit:20});
   assert.equal(found.videos.length,1);assert.deepEqual(found.videos[0].ref,queued.ref);
   assert.equal(new Set(found.videos[0].clips.map(c=>c.ref.sourceId)).size,clips.length);
   for(const hit of found.videos[0].clips){const source=clips.find(c=>c.ref.sourceId===hit.ref.sourceId);assert.ok(hit.startMs>=source.clip.logical.startMs&&hit.endMs<=source.clip.logical.endMs);}
   const range={startMs:550,endMs:900};
   const read=await api('/read',{ref:queued.ref,range});assert.equal(read.originalIsFullFile,false);assert.deepEqual(read.selection,range);
   assert.equal(read.parser.configKey,'native-range-remux-v1');assert.ok(read.dataBase64.length>100);assert.ok(read.outputTimeline.hasAudio&&read.outputTimeline.hasVideo);
   assert.ok(nativeInputs.length>=clips.length*2,'formation and query verification receive actual clip bytes');
   await api('/revoke',{operationId:'withdraw-root',ref:queued.ref});
   for(const clip of clips){assert.equal((await api('/validate',{refs:[clip.ref]})).valid,false);await api('/read',{ref:clip.ref},409);}
   assert.deepEqual((await api('/search',{query:'blue tone',sessionRef:'after-revoke'})).items,[]);
 }finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
