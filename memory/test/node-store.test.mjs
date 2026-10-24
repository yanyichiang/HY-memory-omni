import test from 'node:test';
import assert from 'node:assert/strict';
import {NodeStore} from '../dist/node-store.js';
class KV {
 rows=new Map(); reads=0;
 async get(k){this.reads++;return structuredClone(this.rows.get(k));}
 async set(k,v){this.rows.set(k,structuredClone(v));}
 async delete(k){this.rows.delete(k);}
 async page(prefix,after,limit){const keys=[...this.rows.keys()].filter(k=>k.startsWith(prefix)&&(!after||k>after)).sort();return {entries:keys.slice(0,limit).map(key=>({key,value:structuredClone(this.rows.get(key))})),...(keys.length>limit?{nextCursor:keys[limit-1]}:{})};}
}
const principal={ownerRef:'owner',scopeRef:'personal'};
const row=(id,tokens=['meeting'],vector=[1,0])=>({payload:{node_id:id,user_id:'owner',agent_id:'personal',isolation_key:'owner::personal::s',content:tokens.join(' '),layer:'l2_fact',status:'active',is_latest:true},embedding:vector,lexicalTokens:tokens});
test('bounded keyword candidates use Hy tokens, original BM25 formula and stable IDs',async()=>{
 const kv=new KV(),store=new NodeStore(kv,'test',principal);
 await store.save([row('a',['run','run','meeting']),row('b',['run']),row('c',['else'])]);
 const hits=await store.read('keyword_search',{tokens:['run'],user_id:'owner',top_k:5},()=>true);
 // Candidate corpus contains the two posting matches; k1=1.5,b=.75, df=N=2.
 const idf=Math.log(1+0.5/2.5);
 const expectedA=idf*2*2.5/(2+1.5*(.25+.75*3/2));
 const expectedB=idf*2.5/(1+1.5*(.25+.75/2));
 assert.ok(Math.abs(hits.find(x=>x.node_id==='a').score-expectedA)<1e-12);
 assert.ok(Math.abs(hits.find(x=>x.node_id==='b').score-expectedB)<1e-12);
 assert.equal(store.lastCoverage.scoringCorpus,'bounded-posting-candidates');
 assert.equal((await store.read('keyword_search',{tokens:['run'],user_id:'owner'},r=>r.payload.node_id!=='a')).length,1);
});
test('keyset list and get preserve node id order, filters and authority scope',async()=>{
 const kv=new KV(),store=new NodeStore(kv,'test',principal);
 await store.save([row('z'),row('a'),row('m')]);
 const first=await store.read('list_by_user',{user_id:'owner',pageSize:1,with_vectors:false},()=>true);
 assert.equal(first.rows[0].payload.node_id,'a');assert.equal(first.rows[0].embedding,undefined);
 const next=await store.read('list_by_user',{user_id:'owner',pageSize:2,cursor:first.nextCursor},r=>r.payload.node_id!=='m');
 assert.deepEqual(next.rows.map(r=>r.payload.node_id),['z']);assert.equal(next.nextCursor,null);
 assert.equal(await store.get('z',()=>false),null);
 await assert.rejects(store.save([row('a',['changed'])]),/IMMUTABLE/);
 await assert.rejects(store.save([{...row('foreign'),payload:{...row('foreign').payload,user_id:'other'}}]),/SCOPE/);
 await assert.rejects(store.read('list_by_user',{user_id:'owner',cursor:'foreign/nodes/x'},()=>true),/CURSOR/);
});
test('over 2000 saved nodes remain independently accessible and bounded ANN excludes revoked rows',async()=>{
 const kv=new KV(),store=new NodeStore(kv,'model-v1',principal);
 for(let i=0;i<2050;i++)await store.save([row(String(i).padStart(4,'0'),['common'],[Math.cos(i*.01),Math.sin(i*.01),i/2050])]);
 assert.equal((await store.get('0000',()=>true)).payload.node_id,'0000');
 const found=await store.read('search',{query_embedding:[1,0,0],user_id:'owner',limit:1},r=>r.payload.node_id!=='0000');
 assert.notEqual(found[0].node_id,'0000');assert.ok(store.lastCoverage.visitedLeaves<=64);
 const keywords=await store.read('keyword_search',{tokens:['common'],user_id:'owner',top_k:2},()=>true);
 assert.equal(keywords.length,2);assert.equal(store.lastCoverage.exhaustive,false);
});
test('filtered historical pages return advancing empty cursors and eventually reach a valid row',async()=>{
 const kv=new KV(),store=new NodeStore(kv,'paging',principal);
 // Directly populate historical row keys: this test concerns filter pagination,
 // independently of ANN/posting construction already exercised above.
 for(let i=0;i<4200;i++)await kv.set(`paging/nodes/${String(i).padStart(5,'0')}`,row(String(i).padStart(5,'0')));
 let cursor=null,calls=0,found=[];
 do {
   const result=await store.read('list_by_user',{user_id:'owner',pageSize:1,cursor},r=>r.payload.node_id==='04199');
   if(calls===0){assert.deepEqual(result.rows,[]);assert.equal(store.lastCoverage.exhaustive,false);}
   if(result.nextCursor)assert.notEqual(result.nextCursor,cursor);
   cursor=result.nextCursor;found.push(...result.rows);calls++;
 }while(cursor);
 assert.deepEqual(found.map(r=>r.payload.node_id),['04199']);assert.ok(calls>1 && calls<30);
});
