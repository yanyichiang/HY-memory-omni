import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LongVideo } from '../dist/long-video.js';
import { MemoryError } from '../dist/service.js';
const bytes = new Uint8Array(readFileSync(new URL('fixtures/blue-tone.mp4', import.meta.url)));
function harness() {
  const rows = new Map(), blobs = new Map([['root.mp4', bytes]]), calls = [];
  const db = { async get(k) { return structuredClone(rows.get(k)); }, async set(k,v) { rows.set(k,structuredClone(v)); }, async delete(k) { rows.delete(k); }, async transaction(fn) { const before = structuredClone(rows); try { return await fn(); } catch(e) { rows.clear(); for(const [k,v] of before) rows.set(k,v); throw e; } }, async page(prefix, after, limit) { calls.push({prefix,limit}); const keys = [...rows.keys()].filter(k => k.startsWith(prefix) && (!after || k > after)).sort(); return {entries:keys.slice(0,limit).map(key=>({key,value:structuredClone(rows.get(key))})),...(keys.length>limit?{nextCursor:keys[limit-1]}:{})}; } };
  const service = { db, blobs:{async put(k,b){blobs.set(k,b)},async get(k){return blobs.get(k)??null}}, models:{},
    async source(ref,pending=false) { const s=await db.get(`source:${ref.sourceId}`); if(!s||JSON.stringify(s.ref)!==JSON.stringify(ref)) throw Error('source_changed'); if(s.state!=='active'&&!(pending&&s.state==='pending'))throw Error('source_unavailable'); return s; },
    async saveSource(s){await db.set(`source:${s.ref.sourceId}`,s)}, async revision(){return await db.get('revision')??1},
    async begin(id,input){const old=await db.get(`operation:${id}`);if(old){if(old.input!==JSON.stringify(input))throw Error('operation_conflict');if(old.state==='committed')return{old:old.result};throw Error('operation_unknown')}await db.set(`operation:${id}`,{input:JSON.stringify(input),state:'started'});return{}},
    async stage(id,ref,stage){const o=await db.get(`operation:${id}`);await db.set(`operation:${id}`,{...o,ref,stage})},
    async finish(id,state,result){const o=await db.get(`operation:${id}`);await db.set(`operation:${id}`,{...o,state,result})},
    async form(s,op,b,root){calls.push({form:s.clip.logical});await service.source(root,true);await service.saveSource({...s,state:'active'});await service.finish(op,'committed',{ref:s.ref})},
    async invalidate(ref,state){const s=await service.source(ref,true);const next={...s,state,ref:{...ref,revision:ref.revision+1},video:{...s.video,cursorMs:0,complete:false}};await service.saveSource(next);return next}
  };
  const manager=new LongVideo(service,async key=>({size:blobs.get(key).length,read:async(o,n)=>blobs.get(key).slice(o,o+n)}));
  return {manager,service,db,rows,calls};
}
const create = {operationId:'upload',messageRef:'message',sessionRef:'session',mimeType:'video/mp4',key:'root.mp4',strategy:'fixed',seconds:.4,minDurationMs:100};
test('one-step clips remain hidden behind pending root, publish atomically, then reason with page-one coverage',async()=>{
  const h=harness(),result=await h.manager.create(create),ref=result.ref;
  await h.manager.step('upload');assert.equal((await h.service.source(ref,true)).state,'pending');assert.equal((await h.manager.status('upload')).cursorMs,400);
  await assert.rejects(h.manager.read(ref,{startMs:0,endMs:300}),/source_unavailable/);
  await h.manager.step('upload');await h.manager.step('upload');
  assert.equal((await h.manager.status('upload')).state,'complete');assert.equal((await h.service.source(ref)).video.complete,true);
  assert.equal(h.calls.filter(c=>c.form).length,3);
  const read=await h.manager.read(ref,{startMs:300,endMs:700});assert.equal(read.originalIsFullFile,false);assert.equal(read.offsetMs,0);assert.equal(read.timeline.durationMs,1026);
  h.service.models.reasonVideoClip=async i=>({...i.prior,model:'stub'});
  await h.manager.createReason({ref,query:'Final decision?',operationId:'reason'});
  for(let n=0;n<4;n++)await h.manager.step('reason');
  assert.equal((await h.manager.status('reason')).state,'complete');
  assert.equal((await h.db.get('operation:reason')).result.coverageComplete,true);
  assert.equal((await h.db.get('operation:reason')).result.reasoning.conclusion.status,'unknown');
  assert.ok(h.calls.filter(c=>c.prefix).every(c=>c.limit===1));
});
test('running and unknown work never automatically repeats a model call; recovery fences the whole source',async()=>{
  const h=harness(),{ref}=await h.manager.create(create);
  h.service.form=async()=>{throw Error('provider_receipt_lost')};
  await assert.rejects(h.manager.step('upload'),/provider_receipt_lost/);
  assert.equal((await h.manager.status('upload')).state,'unknown');assert.equal(await h.db.get('work:upload'),undefined);
  let attempts=0;h.service.form=async()=>{attempts++};await h.manager.step('upload');assert.equal(attempts,0);
  const recovered=await h.manager.recover({previousOperationId:'upload',operationId:'repair',acceptUnknown:true});
  assert.equal(recovered.ref.revision,ref.revision+1);await assert.rejects(h.service.source(ref,true),/source_changed/);
  assert.equal((await h.db.get('job:repair')).cursorMs,0);
});
test('dynamic plans persist remaining boundaries and interruption blocks native-state publication',async()=>{
  const h=harness();let segments=0;
  h.service.models.segmentVideo=async i=>{segments++;return[{startMs:0,endMs:500},{startMs:500,endMs:i.timeline.durationMs}]};
  const {ref}=await h.manager.create({...create,strategy:'dynamic',seconds:2});
  await h.manager.step('upload');assert.equal(segments,1);assert.equal((await h.db.get('job:upload')).ranges.length,1);
  await h.manager.step('upload');assert.equal(segments,1);
  h.service.models.reasonVideoClip=async i=>{await h.service.invalidate(ref,'pending');return i.prior};
  await h.manager.createReason({ref,query:'What happened?',operationId:'reason'});
  await assert.rejects(h.manager.step('reason'),/source_changed/);
  assert.equal((await h.db.get('job:reason')).reasoning.events.length,0);assert.equal(await h.db.get('work:reason'),undefined);
});
test('a second step observing running fences a late formation result instead of requeuing it',async()=>{
  const h=harness();await h.manager.create(create);
  let enter,release;const entered=new Promise(r=>{enter=r}),blocked=new Promise(r=>{release=r});
  h.service.form=async()=>{enter();await blocked};
  const first=h.manager.step('upload');await entered;
  assert.equal((await h.manager.step('upload')).state,'unknown');
  release();await assert.rejects(first,/video_job_no_longer_running/);
  assert.equal((await h.manager.status('upload')).state,'unknown');
  assert.equal((await h.manager.status('upload')).cursorMs,0);
  assert.equal(await h.db.get('work:upload'),undefined);
});

test('dynamic oversized analysis shrinks only before native calls and persists the actual window',async()=>{
  const h=harness();await h.manager.create({...create,strategy:'dynamic',seconds:2});
  const originalRange=h.manager.range;let failures=0,calls=0;
  h.manager.range=async key=>{const media=await originalRange(key);return {...media,async read(o,n){if(failures<2){failures++;throw new MemoryError('media_slice_too_large',413)}return media.read(o,n)}}};
  h.service.models.segmentVideo=async i=>{calls++;assert.equal(failures,2);return[{startMs:0,endMs:i.timeline.durationMs}]};
  await h.manager.step('upload');
  const job=await h.db.get('job:upload');
  assert.deepEqual(job.analysisWindow,{startMs:0,endMs:256});assert.equal(job.cursorMs,256);assert.equal(calls,1);
  assert.equal((await h.service.source(job.ref,true)).video.strategy,'dynamic');
});
test('minimum dynamic window and fixed oversize stop explicitly without a provider call',async()=>{
  for(const strategy of ['dynamic','fixed']){
    const h=harness();await h.manager.create({...create,strategy,seconds:2});let calls=0;
    h.service.models.segmentVideo=async()=>{calls++;return[]};
    const originalRange=h.manager.range;
    h.manager.range=async key=>({...await originalRange(key),async read(){throw new MemoryError('media_slice_too_large',413)}});
    await assert.rejects(h.manager.step('upload'),strategy==='dynamic'?/video_dynamic_minimum_window_too_large/:/video_fixed_window_too_large_reduce_seconds/);
    assert.equal(calls,0);assert.equal((await h.manager.status('upload')).state,'unknown');
  }
});
test('duplicate create receipts return durable status without inspecting or repeating provider work',async()=>{
  const h=harness();await h.manager.create(create);
  h.manager.range=async()=>{throw Error('must_not_inspect_twice')};
  assert.equal((await h.manager.create(create)).state,'queued');
  await assert.rejects(h.manager.create({...create,key:'different.mp4'}),/operation_conflict/);
  const incomplete=harness();await incomplete.service.begin('upload',{key:create.key,messageRef:create.messageRef,sessionRef:create.sessionRef,mimeType:create.mimeType,strategy:create.strategy,seconds:create.seconds,minDurationMs:create.minDurationMs});
  incomplete.manager.range=async()=>{throw Error('must_not_inspect_unknown')};
  assert.equal((await incomplete.manager.create(create)).state,'unknown');
});
test('explicit reason recovery restarts same root and supersedes an old in-flight response',async()=>{
  const h=harness(),{ref}=await h.manager.create(create);for(let n=0;n<3;n++)await h.manager.step('upload');
  await h.manager.createReason({ref,query:'Decision?',operationId:'reason'});
  let enter,release;const entered=new Promise(r=>{enter=r}),blocked=new Promise(r=>{release=r});
  h.service.models.reasonVideoClip=async i=>{enter();await blocked;return i.prior};
  const first=h.manager.step('reason');await entered;
  await assert.rejects(h.manager.recover({previousOperationId:'reason',operationId:'redo',acceptUnknown:false}),/unknown_effect_requires_explicit_recovery/);
  const recovered=await h.manager.recover({previousOperationId:'reason',operationId:'redo',acceptUnknown:true});
  assert.deepEqual(recovered.ref,ref);assert.equal((await h.service.source(ref)).state,'active');assert.equal((await h.manager.status('reason')).state,'superseded');
  release();await assert.rejects(first,/video_job_no_longer_running/);
  assert.equal((await h.manager.status('reason')).state,'superseded');assert.equal((await h.manager.status('redo')).cursorMs,0);
});
test('native history grows beyond 32 while rolling context compacts and every original event remains pageable',async()=>{
  const h=harness(),{ref}=await h.manager.create(create);
  while((await h.manager.status('upload')).state!=='complete')await h.manager.step('upload');
  // Synthetic clip index expands the history workload; each child still reads a real remuxed fixture.
  const clipPrefix=`clip:${ref.sourceId}@${ref.revision}:`, existing=await h.db.page(clipPrefix,undefined,64);
  const originalChild=await h.service.source(existing.entries[0].value);
  for(const row of existing.entries)await h.db.delete(row.key);
  for(let start=0,index=0;start<1026;start+=25,index++){
    const child={...originalChild,ref:{...originalChild.ref,sourceId:`history-child-${index}`},clip:{...originalChild.clip,logical:{startMs:start,endMs:Math.min(1026,start+25)}}};
    await h.service.saveSource(child);await h.db.set(`${clipPrefix}${String(start).padStart(20,'0')}:${index}`,child.ref);
  }
  let observations=0,compactions=0;
  h.service.models.reasonVideoClip=async i=>{
    assert.ok(i.prior.events.length<=32);
    const id=`event-${observations++}`,ev={id,ref,startMs:i.logical.startMs,endMs:i.logical.endMs,quote:`Original observation ${id}`,speaker:'unknown',speechAct:'observation',authority:'unknown',targets:[]};
    return{...i.prior,events:[...i.prior.events,ev],conclusion:{text:'Original first observation remains a provisional cue.',status:'provisional',support:['event-0'],opposition:[]},model:'stub'};
  };
  h.service.models.compactVideoReason=async({state})=>{compactions++;return{summary:{text:'Original observations summarized; no independent evidence or final decision.',support:['event-0'],opposition:[],unresolved:[]},retain:state.events.slice(-8).map(e=>e.id),uncertain:false}};
  await h.manager.createReason({ref,query:'What happened throughout?',operationId:'reason-history'});
  while((await h.manager.status('reason-history')).state!=='complete')await h.manager.step('reason-history');
  const status=await h.manager.status('reason-history');assert.ok(observations>32);assert.ok(compactions>=2);assert.equal(status.historyCounts.events,observations);assert.ok(status.reasoning.events.length<=32);assert.equal(status.contextCoverage.summaryIsIndependentEvidence,false);assert.ok(status.summaryRef);
  const archived=[];let cursor;
  do{const page=await h.manager.events('reason-history',cursor,7);archived.push(...page.events);cursor=page.nextCursor}while(cursor);
  assert.equal(archived.length,observations);assert.equal(archived[0].event.quote,'Original observation event-0');assert.equal(new Set(archived.map(r=>r.event.id)).size,observations);
  const summary=await h.db.get(status.summaryRef);assert.ok(summary.previousSummaryRef);assert.ok(summary.eventRefs.length<=64);assert.deepEqual(status.reasoning.conclusion.support,['event-0']);
});
test('lost compaction receipt preserves first native events with old cursor and explicit unknown state',async()=>{
  const h=harness(),{ref}=await h.manager.create({...create,seconds:.05});while((await h.manager.status('upload')).state!=='complete')await h.manager.step('upload');
  let count=0;h.service.models.reasonVideoClip=async i=>({...i.prior,events:[...i.prior.events,{id:`native-${count++}`,ref,startMs:i.logical.startMs,endMs:i.logical.endMs,quote:'Original evidence',speaker:'unknown',speechAct:'observation',authority:'unknown',targets:[]}],model:'stub'});
  h.service.models.compactVideoReason=async()=>{throw Error('text_synthesis_receipt_lost')};
  await h.manager.createReason({ref,query:'Explain sequence',operationId:'reason-lost'});for(let n=0;n<15;n++)await h.manager.step('reason-lost');
  const before=(await h.manager.status('reason-lost')).cursorMs;await assert.rejects(h.manager.step('reason-lost'),/text_synthesis_receipt_lost/);
  const status=await h.manager.status('reason-lost');assert.equal(status.state,'unknown');assert.equal(status.cursorMs,before);assert.equal(status.historyCounts.events,16);
  const page=await h.manager.events('reason-lost',undefined,64);assert.equal(page.events.length,16);assert.equal(page.events.at(-1).event.id,'native-15');
});

test('completed reasoning rejects child correction or revocation through logical authority revision fencing',async()=>{
  for(const state of ['revoked','pending']){
    const h=harness(),{ref}=await h.manager.create(create);for(let n=0;n<3;n++)await h.manager.step('upload');
    h.service.models.reasonVideoClip=async i=>({...i.prior,model:'stub'});await h.manager.createReason({ref,query:'Explain',operationId:'reason-dependencies'});
    for(let n=0;n<4;n++)await h.manager.step('reason-dependencies');
    const child=(await h.db.page(`clip:${ref.sourceId}@${ref.revision}:`,undefined,1)).entries[0].value;
    await h.service.invalidate(child,state);await h.db.set('revision',await h.service.revision()+1);
    await assert.rejects(h.manager.status('reason-dependencies'),/video_reason_dependencies_changed/);
    await assert.rejects(h.manager.events('reason-dependencies'),/video_reason_dependencies_changed/);
    assert.equal((await h.service.source(ref)).state,'active');
  }
});
test('child authority changes while native reasoning awaits block late evidence and cursor publication',async()=>{
  const h=harness(),{ref}=await h.manager.create(create);for(let n=0;n<3;n++)await h.manager.step('upload');
  h.service.models.reasonVideoClip=async i=>{await h.db.set('revision',await h.service.revision()+1);return {...i.prior,events:[{id:'late',ref,startMs:0,endMs:10,quote:'late observation',speaker:'unknown',speechAct:'observation',authority:'unknown',targets:[]}]}};
  await h.manager.createReason({ref,query:'Explain',operationId:'reason-late'});await assert.rejects(h.manager.step('reason-late'),/video_reason_dependencies_changed/);
  const job=await h.db.get('job:reason-late');assert.equal(job.state,'unknown');assert.equal(job.cursorMs,0);assert.equal((await h.db.page('job-event:reason-late:',undefined,64)).entries.length,0);assert.equal(await h.db.get('work:reason-late'),undefined);
});
test('uncertain compaction marks application coverage loss sticky while later clips still archive and advance',async()=>{
  const h=harness(),{ref}=await h.manager.create({...create,seconds:.05});while((await h.manager.status('upload')).state!=='complete')await h.manager.step('upload');
  let count=0;h.service.models.reasonVideoClip=async i=>{const id=`e-${count++}`;return{...i.prior,coverageIncomplete:false,incomplete:false,requireMore:false,events:[...i.prior.events,{id,ref,startMs:i.logical.startMs,endMs:i.logical.endMs,quote:'Observed evidence',speaker:'unknown',speechAct:'observation',authority:'unknown',targets:[]}],conclusion:{text:'A provisional observation',status:'provisional',support:[id],opposition:[]}}};
  h.service.models.compactVideoReason=async({state})=>({summary:{text:'Some necessary semantic distinctions cannot be retained safely.',support:state.conclusion.support,opposition:[],unresolved:[]},retain:state.events.slice(-8).map(e=>e.id),uncertain:true});
  await h.manager.createReason({ref,query:'Explain',operationId:'reason-loss'});
  for(let n=0;n<16;n++)await h.manager.step('reason-loss');
  const before=await h.manager.status('reason-loss');assert.equal(before.reasoning.coverageIncomplete,true);assert.equal(before.contextCoverage.complete,false);
  await h.manager.step('reason-loss');const after=await h.manager.status('reason-loss');
  assert.ok(after.cursorMs>before.cursorMs);assert.equal(after.reasoning.coverageIncomplete,true);assert.equal(after.reasoning.incomplete,true);assert.equal(after.reasoning.requireMore,true);assert.equal(after.reasoning.conclusion.status,'unknown');assert.equal(after.historyCounts.events,17);
});
