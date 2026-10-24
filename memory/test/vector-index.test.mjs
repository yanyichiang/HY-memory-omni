import test from 'node:test';
import assert from 'node:assert/strict';
import { PersistentVectorIndex } from '../dist/vector-index.js';
class Store {
  rows=new Map();
  async get(key){return structuredClone(this.rows.get(key));}
  async set(key,value){this.rows.set(key,structuredClone(value));}
  async delete(key){this.rows.delete(key);}
}
const vector=i=>[Math.cos(i*0.037),Math.sin(i*0.037),Math.sin(i*0.071),Math.cos(i*0.113)];
test('incremental paged index exceeds 2000 entries and retrieves early and late records',async()=>{
  const store=new Store(), index=new PersistentVectorIndex(store,'model-a/v1');
  for(let i=0;i<2050;i++) await index.add(`id-${String(i).padStart(4,'0')}`,vector(i));
  for(const i of [0,1,31,777,2049]) {
    const found=await index.search(vector(i),{limit:1});
    assert.equal(found.hits[0].id,`id-${String(i).padStart(4,'0')}`);
    assert.ok(found.visitedLeaves<=64);
  }
  for(const value of store.rows.values()) if(value?.entries) assert.ok(value.entries.length<=32);
  const pageKeys=[...store.rows.keys()].filter(k=>k.includes('/pages/'));
  const seen=new Set();
  const visit=key=>{seen.add(key);const p=store.rows.get(key);if(p.left){visit(p.left);visit(p.right);}};
  visit(store.rows.get('model-a/v1/vector-index/root').page);
  assert.equal(seen.size,pageKeys.length,'no replaced path pages remain in the authority KV');
  const small=await index.search(vector(5),{limit:2000,maxLeaves:1});
  assert.equal(small.visitedLeaves,1);assert.equal(small.exhaustive,false);
});
test('identical vectors split bounded leaves, rank ties by id, and report incomplete coverage',async()=>{
  const store=new Store(),index=new PersistentVectorIndex(store,'model-a/v1');
  for(let i=100;i>=0;i--) await index.add(String(i).padStart(3,'0'),[1,0]);
  const all=await index.search([1,0],{limit:3});
  assert.deepEqual(all.hits.map(x=>x.id),['000','001','002']);assert.equal(all.exhaustive,true);
  const limited=await index.search([1,0],{limit:3,maxLeaves:1});assert.equal(limited.exhaustive,false);
  for(const value of store.rows.values()) if(value?.entries) assert.ok(value.entries.length<=32);
  const filtered=await index.search([1,0],{limit:2,accept:async id=>id>'098'});
  assert.deepEqual(filtered.hits.map(x=>x.id),['099','100']);
});
test('model namespaces, dimensions, immutable identities and idempotent upserts',async()=>{
  const store=new Store(),a=new PersistentVectorIndex(store,'model-a/v1'),b=new PersistentVectorIndex(store,'model-b/v1');
  await a.add('same',[1,0]); const size=store.rows.size;await a.add('same',[1,0]);assert.equal(store.rows.size,size);
  await assert.rejects(a.add('same',[0,1]),/VECTOR_ID_IMMUTABLE/);
  await assert.rejects(a.add('other',[1,0,0]),/DIMENSION/);
  await assert.rejects(a.search([1,0,0],{limit:1}),/DIMENSION/);
  await b.add('same',[0,1,0]);assert.equal((await b.search([0,1,0],{limit:1})).hits[0].id,'same');
  await assert.rejects(a.add('zero',[0,0]),/VECTOR_ZERO/);
});
test('ascending IDs with identical vectors avoid a linear tree and obey node budget',async()=>{
 const store=new Store(),index=new PersistentVectorIndex(store,'same-vector');
 for(let i=0;i<2050;i++) await index.add(String(i).padStart(6,'0'),[1,0]);
 const root=store.rows.get('same-vector/vector-index/root');
 const depth=key=>{const p=store.rows.get(key);return p.entries?1:1+Math.max(depth(p.left),depth(p.right));};
 assert.ok(depth(root.page)<25);
 const budget=await index.search([1,0],{limit:2,maxNodes:3});
 assert.ok(budget.visitedNodes<=3);assert.equal(budget.exhaustive,false);
});
