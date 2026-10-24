import test from 'node:test';
import assert from 'node:assert/strict';
import { extendKnowledge, projectKnowledge } from '../dist/knowledge.js';
const ref=(sourceId,revision=1)=>({sourceId,revision,mediaRef:'media-'+sourceId});
const draft=(key,value=key)=>({key,nodeId:'current-l2',text:`Meeting venue: ${value}`,subject:'weekly planning team',event:'meeting week 1',predicate:'venue',value,validTime:'',conditions:'',quote:value});
const claim=(id,extra={})=>({...draft(id),id,source:ref(id),roots:[id],observedAt:'2026-10-24',authority:'observation',...extra});
const input=(sourceId='new',text='new')=>({source:ref(sourceId),perception:{model:'perceiver',configKey:'test',kind:'image',text},nodes:[{payload:{node_id:'current-l2',layer:'l2_fact'},embedding:[1]}],authority:'observation'});
const relation=(left,right,kind,extra={})=>({id:`${left}-${right}-${kind}`,left,right,kind,reason:'The quoted event evidence supports this assessment.',leftQuote:left,rightQuote:right,assessedAt:'2026-10-24',model:'relation-model',...extra});
const model=(drafts,kind='conflict',extra={})=>({model:'test-model',async extract(){return drafts;},async relate(pairs){return pairs.map(({left,right})=>({left:left.id,right:right.id,kind,reason:'Specific same-event quoted evidence.',leftQuote:left.quote,rightQuote:right.quote,...extra}));}});
const statuses=view=>Object.fromEntries(view.claims.map(c=>[c.id,c.status]));
const available=()=>true;

test('same-event disagreement retains independent modal text and quote-linked conflict',async()=>{
  const old=claim('old');const before={claims:[old],relations:[]};
  const result=await extendKnowledge(before,input('new','new venue'),model([draft('a','new venue')]),['original-media'],'2026-10-24');
  assert.equal(before.claims.length,1);assert.equal(result.claims.length,2);
  assert.notEqual(result.claims[1].id,'a');assert.equal(result.claims[1].source.sourceId,'new');
  assert.equal(result.relations[0].leftQuote,old.quote);
  assert.deepEqual(projectKnowledge(result,3,available).claims.map(c=>c.status),['disputed','disputed']);
});

test('different meetings never merge; uncertain correspondence stays unresolved; paraphrase same preserves text',()=>{
  const a=claim('a'),b=claim('b',{event:'another week meeting',text:'Another meeting says b'});
  const before={claims:[a,b],relations:[relation('a','b','different')]};
  assert.deepEqual(Object.values(statuses(projectKnowledge(before,1,available))),['supported','supported']);
  assert.equal(projectKnowledge(before,1,available,['a']).claims.length,1);
  before.relations=[relation('a','b','uncertain')];
  assert.deepEqual(Object.values(statuses(projectKnowledge(before,1,available))),['unresolved','unresolved']);
  before.relations=[relation('a','b','same')];
  const view=projectKnowledge(before,1,available);
  assert.deepEqual(view.claims.map(c=>c.text),[a.text,b.text]);
});

test('a quote-backed observation can revise; missing world-change time downgrades to conflict',async()=>{
  const before={claims:[claim('old')],relations:[]};
  const corrected=await extendKnowledge(before,input('new','new'),model([draft('a','new')],'revision',{revisionKind:'correction',superseded:'left'}),['root'],'2026-10-24');
  assert.deepEqual(projectKnowledge(corrected,1,available).claims.map(c=>c.status),['superseded','supported']);
  assert.equal(corrected.claims[1].authority,'observation');
  const incomplete=await extendKnowledge(before,input(),model([draft('a','new')],'revision',{revisionKind:'world-change',superseded:'left',effectiveAt:'2026-10-24T00:00:00Z'}),['root'],'2026-10-24');
  assert.equal(incomplete.relations[0].kind,'conflict');assert.match(incomplete.relations[0].reason,/incomplete/);
  const changed=await extendKnowledge(before,input(),model([draft('a','new')],'revision',{revisionKind:'world-change',superseded:'left',effectiveAt:'2026-10-24T00:00:00Z',effectiveTime:'2026-10-24'}),['root'],'2026-10-24');
  assert.equal(changed.relations[0].kind,'revision');
});

test('revocation hides unavailable text/relations and does not revive an old revised claim',()=>{
  const before={claims:[claim('old'),claim('secret',{text:'SECRET',quote:'SECRET'})],relations:[relation('old','secret','revision',{revisionKind:'correction',superseded:'left',reason:'SECRET'})]};
  const view=projectKnowledge(before,9,r=>r.sourceId!=='secret');
  assert.deepEqual(statuses(view),{old:'unresolved'});assert.equal(view.relations.length,0);
  assert.ok(!JSON.stringify(view).includes('SECRET'));assert.ok(!JSON.stringify(view).includes('secret'));
  before.relations=[relation('old','secret','conflict')];
  assert.deepEqual(statuses(projectKnowledge(before,10,r=>r.sourceId!=='secret')),{old:'supported'});
});

test('same equivalence propagates conflict, revision, and withdrawn correction without manufacturing votes',()=>{
  const before={claims:[claim('a',{roots:['original','original']}),claim('transcript',{roots:['original']}),claim('b')],
    relations:[relation('a','transcript','same'),relation('a','b','conflict')]};
  const view=projectKnowledge(before,1,available);
  assert.deepEqual(view.claims.map(c=>c.status),['disputed','disputed','disputed']);
  assert.deepEqual(view.claims[0].roots,['original']);assert.deepEqual(view.claims[1].roots,['original']);
  before.relations[1]=relation('a','b','revision',{revisionKind:'correction',superseded:'left'});
  assert.deepEqual(projectKnowledge(before,2,available).claims.map(c=>c.status),['superseded','superseded','supported']);
  assert.deepEqual(projectKnowledge(before,3,r=>r.sourceId!=='b').claims.map(c=>c.status),['unresolved','unresolved']);
});

test('valid correction can settle historical conflict; disputed reviser cannot choose a winner',()=>{
  const before={claims:[claim('a'),claim('b'),claim('c')],relations:[relation('a','b','conflict'),relation('a','c','revision',{revisionKind:'correction',superseded:'left'}),relation('b','c','same')]};
  assert.deepEqual(statuses(projectKnowledge(before,1,available)),{a:'superseded',b:'supported',c:'supported'});
  assert.equal(projectKnowledge(before,1,available).relations[0].active,false);
  before.relations.push(relation('c','b','conflict'));
  assert.ok(projectKnowledge(before,1,available).claims.every(c=>c.status==='disputed'||c.status==='unresolved'));
});

test('revision cycles and revision inside same component never create a winner',()=>{
  const before={claims:[claim('a'),claim('b'),claim('c')],relations:[relation('a','b','revision',{revisionKind:'correction',superseded:'left'}),relation('b','c','revision',{revisionKind:'correction',superseded:'left'}),relation('c','a','revision',{revisionKind:'correction',superseded:'left'})]};
  assert.ok(projectKnowledge(before,1,available).claims.every(c=>c.status==='disputed'));
  before.relations=[relation('a','b','same'),relation('a','b','revision',{revisionKind:'correction',superseded:'left'})];
  assert.deepEqual(statuses(projectKnowledge(before,1,available)),{a:'disputed',b:'disputed',c:'supported'});
});

test('retrieval closure includes available dispute and same context, excludes unavailable and explicit different',()=>{
  const before={claims:['a','b','c','d','secret'].map(id=>claim(id)),relations:[relation('a','b','conflict'),relation('b','c','same'),relation('c','d','different'),relation('c','secret','conflict',{reason:'SECRET'})]};
  const view=projectKnowledge(before,5,r=>r.sourceId!=='secret',['a']);
  assert.deepEqual(view.claims.map(c=>c.id),['a','b','c']);assert.equal(view.relations.length,2);
  assert.ok(!JSON.stringify(view).includes('SECRET'));
});

test('all new/available-old pairs are assessed once in batches no larger than sixteen, retaining old history',async()=>{
  const before={claims:Array.from({length:18},(_,i)=>claim('old'+i)),relations:[]};
  const drafts=[draft('one','one'),draft('two','two')],batches=[];
  const models=model(drafts,'different');const relate=models.relate;
  models.relate=async pairs=>{batches.push(pairs);return relate(pairs);};
  const result=await extendKnowledge(before,input('new','one and two'),models,['media','media'],'2026-10-24',r=>r.sourceId!=='old0');
  assert.equal(result.claims.length,20);assert.equal(result.relations.length,0);assert.equal(batches.flat().length,35);
  assert.ok(batches.every(batch=>batch.length<=16));
  assert.ok(batches.flat().every(pair=>pair.left.id!=='old0'));
  assert.deepEqual(result.claims.at(-1).roots,['media']);
});

test('draft/node/quote/cap and complete relation-pair checks reject model contract violations',async()=>{
  for(const bad of [{...draft('x'),nodeId:'not-current'},{...draft('x'),quote:'not-present'},{...draft('x'),extra:true}]){
    await assert.rejects(extendKnowledge({claims:[],relations:[]},input(),model([bad]),['root'],'now'),/knowledge_invalid_/);
  }
  await assert.rejects(extendKnowledge({claims:[],relations:[]},input(),model([draft('x','new'),draft('x','new')]),['root'],'now'),/duplicate_key/);
  const before={claims:[claim('a'),claim('b')],relations:[]};
  for(const mutate of [r=>r.slice(1),r=>[r[0],r[0]],r=>r.map((x,i)=>i?x:{...x,leftQuote:'fabricated'}),r=>r.map((x,i)=>i?x:{...x,left:'unknown'})]){
    const models=model([draft('x','new')]);const original=models.relate;models.relate=async pairs=>mutate(await original(pairs));
    await assert.rejects(extendKnowledge(before,input(),models,['root'],'now'),/knowledge_invalid_/);
  }
  const full={claims:Array.from({length:2000},(_,i)=>claim('c'+i)),relations:[]};
  const grown=await extendKnowledge(full,input(),model([draft('x','new')]),['root'],'now');
  assert.equal(grown.claims.length,2001);
  assert.deepEqual(grown.claims.slice(0,2000).map(c=>c.id),full.claims.map(c=>c.id));
  assert.equal(grown.claims[2000].value,'new');
  await assert.rejects(extendKnowledge({claims:[],relations:[]},input(),model(Array.from({length:65},(_,i)=>draft('batch-'+i,'new'))),['root'],'now'),/claim_limit/);
});


test('revision direction follows evidence under reverse import, never pair ordering', () => {
  const k={claims:[claim('new'),claim('old')],relations:[relation('new','old','revision',{revisionKind:'correction',superseded:'right'})]};
  assert.deepEqual(statuses(projectKnowledge(k,1,available)),{new:'supported',old:'superseded'});
  assert.equal(projectKnowledge(k,1,available).relations[0].superseded,'right');
});

test('world change schedules future claims then activates at the evidence instant', () => {
  const k={claims:[claim('old'),claim('new')],relations:[relation('old','new','revision',{revisionKind:'world-change',superseded:'left',effectiveTime:'26 October midnight UTC',effectiveAt:'2026-10-26T00:00:00Z'})]};
  const before=projectKnowledge(k,1,available,undefined,'2026-10-25T23:59:59Z');
  assert.deepEqual(statuses(before),{old:'supported',new:'scheduled'});
  assert.equal(before.validUntil,'2026-10-26T00:00:00Z');
  assert.equal(before.relations[0].active,false); assert.equal(before.relations[0].temporal,'scheduled');
  const after=projectKnowledge(k,1,available,undefined,'2026-10-26T00:00:00Z');
  assert.deepEqual(statuses(after),{old:'superseded',new:'supported'});
  assert.equal(after.validUntil,undefined); assert.equal(after.relations[0].temporal,'effective');
  const withdrawn=ref=>ref.sourceId==='old';
  assert.deepEqual(statuses(projectKnowledge(k,1,withdrawn,undefined,'2026-10-25T00:00:00Z')),{old:'supported'});
  assert.deepEqual(statuses(projectKnowledge(k,1,withdrawn,undefined,'2026-10-27T00:00:00Z')),{old:'unresolved'});
  assert.deepEqual(statuses(projectKnowledge(k,1,withdrawn,undefined,'2026-10-27T00:00:00Z',()=> '2026-10-25T00:00:00Z')),{old:'supported'});
  assert.deepEqual(statuses(projectKnowledge(k,1,withdrawn,undefined,'2026-10-27T00:00:00Z',()=> '2026-10-26T00:00:00Z')),{old:'unresolved'});
  assert.deepEqual(statuses(projectKnowledge(k,1,withdrawn,undefined,'2026-10-27T00:00:00Z',()=> '2026-10-27T00:00:00Z')),{old:'unresolved'});
  k.relations[0].effectiveAt=null;
  const unknown=projectKnowledge(k,1,available,undefined,'2026-10-27T00:00:00Z');
  assert.deepEqual(statuses(unknown),{old:'unresolved',new:'unresolved'});
  assert.equal(unknown.relations[0].temporal,'unresolved'); assert.equal(unknown.relations[0].active,false);
});

test('correcting a scheduled future plan retains its temporal condition through the correction chain', () => {
  const k={claims:['current','future','corrected'].map(id=>claim(id)),relations:[
    relation('current','future','revision',{revisionKind:'world-change',superseded:'left',effectiveTime:'1 December midnight UTC',effectiveAt:'2026-12-01T00:00:00Z'}),
    relation('future','corrected','revision',{revisionKind:'correction',superseded:'left'}),
    relation('current','corrected','conflict'),
  ]};
  const before=projectKnowledge(k,1,available,undefined,'2026-11-01T00:00:00Z');
  assert.equal(statuses(before).current,'supported');
  assert.equal(statuses(before).corrected,'scheduled');
  assert.equal(before.relations.find(r=>r.kind==='conflict').active,false);
  const after=projectKnowledge(k,1,available,undefined,'2026-12-01T00:00:00Z');
  assert.deepEqual(statuses(after),{current:'superseded',future:'superseded',corrected:'supported'});
});


test('withdrawing the only inherited future-time evidence never promotes its corrected plan to current truth', () => {
  const k={claims:['current','future','corrected'].map(id=>claim(id)),relations:[
    relation('current','future','revision',{revisionKind:'world-change',superseded:'left',effectiveTime:'1 December midnight UTC',effectiveAt:'2026-12-01T00:00:00Z'}),
    relation('future','corrected','revision',{revisionKind:'correction',superseded:'left'}),
  ]};
  const live=ref=>ref.sourceId!=='future';
  for(const now of ['2026-11-01T00:00:00Z','2026-12-02T00:00:00Z']) {
    const view=projectKnowledge(k,2,live,undefined,now,()=> '2026-10-31T00:00:00Z');
    assert.deepEqual(statuses(view),{current:'supported',corrected:'unresolved'});
    assert.equal(view.relations.length,0);
  }
});

test('future conditions survive withdrawal across historical same and correction links, retaining independent anchors', () => {
  const k={claims:['current','future','copy','corrected'].map(id=>claim(id)),relations:[
    relation('current','future','revision',{revisionKind:'world-change',superseded:'left',effectiveTime:'1 December midnight UTC',effectiveAt:'2026-12-01T00:00:00Z'}),
    relation('future','copy','same'),
    relation('copy','corrected','revision',{revisionKind:'correction',superseded:'left'}),
  ]};
  assert.equal(statuses(projectKnowledge(k,1,available,undefined,'2026-11-01T00:00:00Z')).corrected,'scheduled');
  const live=ref=>ref.sourceId!=='future';
  for(const now of ['2026-11-01T00:00:00Z','2026-12-02T00:00:00Z']) {
    const view=projectKnowledge(k,2,live,undefined,now,()=> '2026-10-31T00:00:00Z');
    assert.deepEqual(statuses(view),{current:'supported',copy:'unresolved',corrected:'unresolved'});
    assert.ok(!JSON.stringify(view).includes('media-future'));
  }
  k.relations.push(relation('current','copy','revision',{revisionKind:'world-change',superseded:'left',effectiveTime:'1 December midnight UTC',effectiveAt:'2026-12-01T00:00:00Z'}));
  assert.equal(statuses(projectKnowledge(k,3,live,undefined,'2026-11-01T00:00:00Z',()=> '2026-10-31T00:00:00Z')).corrected,'scheduled');
  assert.deepEqual(statuses(projectKnowledge(k,3,live,undefined,'2026-12-02T00:00:00Z',()=> '2026-10-31T00:00:00Z')),
    {current:'superseded',copy:'superseded',corrected:'supported'});
});

test('a correction with its own live time anchor does not inherit uncertainty from a withdrawn ancestor', () => {
  const k={claims:['current','future','copy','corrected'].map(id=>claim(id)),relations:[
    relation('current','future','revision',{revisionKind:'world-change',superseded:'left',effectiveTime:'1 December midnight UTC',effectiveAt:'2026-12-01T00:00:00Z'}),
    relation('future','copy','same'),
    relation('copy','corrected','revision',{revisionKind:'correction',superseded:'left'}),
    relation('current','corrected','revision',{revisionKind:'world-change',superseded:'left',effectiveTime:'1 November midnight UTC',effectiveAt:'2026-11-01T00:00:00Z'}),
  ]};
  const live=ref=>ref.sourceId!=='future';
  const view=projectKnowledge(k,2,live,undefined,'2026-11-02T00:00:00Z',()=> '2026-10-31T00:00:00Z');
  assert.deepEqual(statuses(view),{current:'superseded',copy:'unresolved',corrected:'supported'});
  k.relations.at(-1).effectiveAt=null;
  assert.equal(statuses(projectKnowledge(k,3,live,undefined,'2026-11-02T00:00:00Z',()=> '2026-10-31T00:00:00Z')).corrected,'unresolved');
});
