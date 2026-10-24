import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from '../dist/service.js';
import { MemoryStore } from '../dist/storage.js';
// Semantic judgments below are explicit fixtures; these tests verify authority/lifecycle, not model quality.
const owner = { ownerRef: 'knowledge-fixture-owner', scopeRef: 'personal' };
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=';
class Store extends MemoryStore {}
async function visibleNodes(x) {
  const {result}=await x.service.readStore({revision:await x.service.revision(),method:'list_by_user',args:{
    user_id:x.service.owner.ownerRef,agent_id:x.service.owner.scopeRef,pageSize:64,only_latest:true,layers:['l2_fact']}});
  assert.equal(result.nextCursor,null,'fixture inspection covers this small fixture');
  return result.rows;
}
function setup() {
  const db = new Store(), originals = new Map(), observations = [];
  const fixture = { relation: () => ({ kind: 'different', reason: 'Separate fixture propositions.' }),
    draft: input => ({ subject: 'Team', event: 'Meeting on 26 October', predicate: 'scheduled day', value: input.perception.text,
      validTime: '', conditions: '' }) };
  const models = {
    knowledge: { model: 'fixture-semantic-proposals', async extract(input) {
      const node = input.nodes.find(row => row.payload.layer === 'l2_fact');
      return [{ key: 'one', nodeId: node.payload.node_id, text: input.perception.text, quote: input.perception.text, ...fixture.draft(input) }];
    }, async relate(pairs) { return pairs.map(pair => ({ left: pair.left.id, right: pair.right.id,
      leftQuote: pair.left.quote, rightQuote: pair.right.quote, ...fixture.relation(pair) })); } },
    async perceive(mimeType, bytes, timeline, question) { observations.push({ mimeType, bytes: Buffer.from(bytes).toString('base64'), question });
      return { model: 'fixture-native', configKey: 'v1', kind: 'image', text: question ? 'Reinspection shows a blue badge.' : 'Initial observation shows a red badge.' }; },
    async matchImage() { return { matches: true, correctionRelevant: false, text: 'Fixture image evidence.', model: 'fixture', configKey: 'fixed' }; },
    async embed() { return { model: 'fixture-vector', values: [1, 0, 0] }; },
    async compute(body) {
      if (body.operation === 'search') {
        assert.equal(body.nodes,undefined,'search uses the authorized remote read view');
        const reader=new MemoryService(db,blobs,models,owner);
        const {result,coverage}=await reader.readStore({principal:body.principal,revision:body.readStore.revision,
          method:'list_by_user',args:{user_id:owner.ownerRef,agent_id:owner.scopeRef,pageSize:64,
            layers:['l2_fact'],status_filter:['active'],only_latest:true}});
        assert.equal(result.nextCursor,null);
        return {success:true,memories:result.rows.map(row=>({memory_id:row.payload.node_id})),retrievalCoverage:{exhaustive:coverage.exhaustive,calls:[coverage]}};
      }
      assert.ok(body.nodes.every(row=>row.payload.custom.meta.every(meta=>meta.sourceRef.sourceId===body.sourceRef.sourceId)));
      return { success: true, nodes: [...body.nodes, { payload: { node_id: body.requestId, user_id: owner.ownerRef,
        agent_id: owner.scopeRef, layer: 'l2_fact', status: 'active', is_latest: true, content: body.content,
        custom: { meta: [{ sourceRef: body.sourceRef }] } }, embedding: [1, 0, 0], lexicalTokens:['fixture','observation'] }] };
    },
  };
  const blobs = { async put(key, bytes) { originals.set(key, new Uint8Array(bytes)); }, async get(key) { return originals.get(key) ?? null; }, async delete(key) { originals.delete(key); } };
  const service = new MemoryService(db, blobs, models, owner);
  return { db, originals, observations, models, fixture, service, blobs };
}
const textInput = (id, text, extra = {}) => ({ operationId: id, sessionRef: 'owner-session', messageRef: id, text, ...extra });
const upload = id => ({ operationId: id, sessionRef: 'media-session', messageRef: id, mimeType: 'image/png', dataBase64: image });

test('text sources persist exact Owner statements and expose source-bound knowledge after restart', async () => {
  const x = setup(), statement = 'If approved, the meeting is not on Friday.';
  x.fixture.draft = () => ({ subject: 'Team', event: 'Meeting identity uncertain', predicate: 'scheduled day', value: 'not Friday', validTime: '', conditions: 'If approved' });
  const accepted = await x.service.ingest(textInput('text-1', statement), true);
  assert.equal(x.observations.length, 0);
  const restored = new MemoryService(x.db, x.blobs, x.models, owner);
  const read = await restored.read(accepted.ref);
  assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), statement);
  assert.equal(read.parser.kind, 'text');
  assert.equal(read.knowledge.claims[0].conditions, 'If approved');
  assert.equal(read.knowledge.claims[0].value, 'not Friday');
  assert.deepEqual(read.knowledge.claims[0].source, accepted.ref);
  const persistedClaims=(await x.db.page('claim:',undefined,64)).entries.map(entry=>entry.value);
  assert.equal(persistedClaims[0].authority, 'owner');
  const found = await restored.search({ query: 'meeting day', sessionRef: 'another-session' });
  assert.deepEqual(found.knowledge.claims, read.knowledge.claims);
});

test('conflicting sources remain disputed rather than latest-wins, and revocation removes unavailable evidence', async () => {
  const x = setup(); x.fixture.relation = () => ({ kind: 'conflict', reason: 'Same event and attribute, incompatible scheduled days.' });
  const a = await x.service.ingest(textInput('friday', 'The meeting is on Friday.'), true);
  const b = await x.service.ingest(textInput('monday', 'The meeting is on Monday.'), true);
  const conflicted = await x.service.knowledge();
  assert.deepEqual(conflicted.claims.map(claim => claim.status), ['disputed', 'disputed']);
  assert.equal(conflicted.relations[0].kind, 'conflict');
  await x.service.forget({ operationId: 'withdraw-monday', ref: b.ref }, true);
  const remaining = await x.service.knowledge();
  assert.deepEqual(remaining.claims.map(claim => claim.source), [a.ref]);
  assert.equal(remaining.claims[0].status, 'supported');
  assert.deepEqual(remaining.relations, []);
  assert.ok(!JSON.stringify(remaining).includes('The meeting is on Monday.'));
});

test('explicit effective-time rescheduling supersedes earlier claim without reviving it on withdrawal', async () => {
  const x = setup(); x.fixture.relation = () => ({ kind: 'revision', revisionKind: 'world-change', superseded: 'left', effectiveAt: '2020-10-26T00:00:00Z', effectiveTime: '26 October 2020', reason: 'Explicit change of this meeting, effective 26 October.' });
  const a = await x.service.ingest(textInput('old-plan', 'The meeting is on Friday.'), true);
  const b = await x.service.ingest(textInput('new-plan', 'Effective 26 October 2020 this meeting is postponed to Monday.'), true);
  const view = await x.service.knowledge();
  assert.equal(view.claims.find(claim => claim.source.sourceId === a.ref.sourceId).status, 'superseded');
  assert.equal(view.claims.find(claim => claim.source.sourceId === b.ref.sourceId).status, 'supported');
  assert.equal(view.relations[0].effectiveTime, '26 October 2020');
  await x.service.forget({ operationId: 'withdraw-revision', ref: b.ref }, true);
  const withdrawn = await x.service.knowledge();
  assert.equal(withdrawn.claims.length, 1); assert.equal(withdrawn.claims[0].status, 'unresolved');
  assert.deepEqual(withdrawn.relations, []);
});

test('reinspection reads the exact original and invalidates earlier reference before publishing revised observation', async () => {
  const x = setup(), first = await x.service.ingest(upload('native-source'));
  const result = await x.service.reinspect({ ref: first.ref, question: 'Check the badge color in the original.', operationId: 'inspect-again' });
  assert.equal(x.observations.length, 2);
  assert.equal(x.observations[1].bytes, image);
  assert.equal(x.observations[1].question, 'Check the badge color in the original.');
  assert.equal(result.ref.revision, first.ref.revision + 1);
  assert.equal((await x.service.validate([first.ref])).valid, false);
  await assert.rejects(x.service.read(first.ref), /source_changed/);
  const read = await x.service.read(result.ref);
  assert.match(read.verification.text, /blue/);
  assert.ok(read.knowledge.claims.every(claim => claim.source.revision === result.ref.revision));
  assert.ok(!JSON.stringify(read.knowledge).includes('Initial observation shows a red badge.'));
});

test('derived transcript keeps original roots and becomes unavailable when its source is revoked', async () => {
  const x = setup(), original = await x.service.ingest(upload('original'));
  const transcript = await x.service.ingest(textInput('transcript', 'Transcription of the badge label.', { derivedFrom: [original.ref] }), true);
  const view = await x.service.knowledge();
  const derived = view.claims.find(claim => claim.source.sourceId === transcript.ref.sourceId);
  assert.deepEqual(derived.roots, [original.ref.sourceId]);
  assert.ok(!derived.roots.includes(transcript.ref.sourceId));
  await x.service.forget({ operationId: 'withdraw-original', ref: original.ref }, true);
  assert.equal((await x.service.validate([transcript.ref])).valid, false);
  await assert.rejects(x.service.read(transcript.ref), /source_changed|source_unavailable/);
  assert.deepEqual((await x.service.knowledge()).claims, []);
});

test('concurrent knowledge model work cannot overwrite a newer committed snapshot or its claims', async () => {
  const x = setup(), extract = x.models.knowledge.extract;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  x.models.knowledge.extract = async input => {
    if (input.perception.text === 'Slow statement.') { enter(); await new Promise(resolve => { release = resolve; }); }
    return extract(input);
  };
  const slow = x.service.ingest(textInput('slow', 'Slow statement.'), true);
  await entered;
  const fast = await x.service.ingest(textInput('fast', 'Fast statement.'), true);
  release();
  await assert.rejects(slow, /memory_changed_during_formation/);
  assert.deepEqual((await x.service.knowledge()).claims.map(claim => claim.source), [fast.ref]);
  assert.deepEqual((await visibleNodes(x)).map(row => row.payload.node_id), ['fast']);
});

test('explicit recovery after reinspection perception failure still verifies original bytes and question', async () => {
  const x=setup(), first=await x.service.ingest(upload('inspect-failure'));
  const corrected=await x.service.correct({operationId:'owner-correction-before-inspect',ref:first.ref,text:'Owner says the badge is green.'});
  const perceive=x.models.perceive;let fail=true;
  x.models.perceive=async(...args)=>{if(fail)throw Error('perception interrupted');return perceive(...args);};
  await assert.rejects(x.service.reinspect({operationId:'failed-verification',ref:corrected.ref,question:'Check the badge against the original.'}),/interrupted/);
  fail=false;
  const restored=new MemoryService(x.db,x.blobs,x.models,owner);
  const recovered=await restored.recover({operationId:'recover-verification',previousOperationId:'failed-verification',acceptUnknown:true});
  const read=await restored.read(recovered.ref);
  assert.equal(x.observations.at(-1).bytes,image);
  assert.equal(x.observations.at(-1).question,'Check the badge against the original.');
  assert.match(read.verification.text,/blue/);
  assert.match(read.perceptionText,/Owner says the badge is green/);
  assert.equal((await x.db.get('source:'+recovered.ref.sourceId)).reinspectionQuestion,undefined);
  const calls=x.observations.length;
  assert.deepEqual(await restored.recover({operationId:'recover-verification',previousOperationId:'failed-verification',acceptUnknown:true}),recovered);
  assert.equal(x.observations.length,calls);
});
