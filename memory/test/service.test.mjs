import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from '../dist/service.js';
import { MemoryStore } from '../dist/storage.js';

const principal = { ownerRef: 'synthetic-owner', scopeRef: 'personal' };
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=';
class Database extends MemoryStore {
  async list(prefix) { return (await this.page(prefix,undefined,64)).entries.map(entry=>entry.value); }
}
async function visibleNodes(x) {
  const result=await x.service.readStore({revision:await x.service.revision(),method:'list_by_user',args:{
    user_id:principal.ownerRef,agent_id:principal.scopeRef,pageSize:64,only_latest:true,layers:['l2_fact']}});
  assert.equal(result.result.nextCursor,null,'fixture inspection must cover the entire small fixture');
  return result.result.rows;
}
function setup() {
  const db = new Database(), objects = new Map(), calls = [], knowledgeCalls = [];
  const blobs = { async put(key, bytes) { objects.set(key, bytes); }, async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); } };
  const models = {
    knowledge: {
      model: 'fixture-knowledge',
      async extract(input) {
        knowledgeCalls.push('extract');
        const node = input.nodes.find(row => row.payload.layer === 'l2_fact');
        return [{ key: 'fact', nodeId: node.payload.node_id, text: input.perception.text,
          subject: 'Observed badge', event: 'This source observation', predicate: 'description', value: input.perception.text,
          validTime: '', conditions: '', quote: input.perception.text }];
      },
      async relate(pairs) { knowledgeCalls.push('relate'); return pairs.map(({ left, right }) => ({ left: left.id, right: right.id, kind: 'different',
        reason: 'Independent fixture observations.', leftQuote: left.quote, rightQuote: right.quote })); },
    },
    async perceive(mimeType) { calls.push('perceive'); return { model: 'fixture-perception', configKey: 'fixed', kind: mimeType.startsWith('audio/') ? 'audio' : 'image', text: 'A red badge marked 17.' }; },
    async matchImage() { return { matches: true, correctionRelevant: false, text: 'Fixture image evidence.', model: 'fixture', configKey: 'fixed' }; },
    async embed(input) { calls.push('embed'); return { model: 'fixture-multimodal:3', values: [1, 0, 0] }; },
    async compute(body) {
      calls.push(body.operation);
      if (body.operation === 'search') {
        assert.equal(body.nodes,undefined,'reader must not receive a full node snapshot');
        assert.ok(Number.isSafeInteger(body.readStore.revision));
        // Recreate the callback endpoint over the same DB to exercise restart identity.
        const reader=new MemoryService(db,blobs,models,principal);
        const {result}=await reader.readStore({principal:body.principal,revision:body.readStore.revision,
          method:'list_by_user',args:{user_id:principal.ownerRef,agent_id:principal.scopeRef,pageSize:64,
            only_latest:true,layers:['l2_fact'],status_filter:['active']}});
        assert.equal(result.nextCursor,null,'fixtures fit one page');
        return { success:true,memories:result.rows.sort((a,b)=>a.payload.fixtureOrder-b.payload.fixtureOrder).map(row=>({memory_id:row.payload.node_id})) };
      }
      assert.ok(body.nodes.every(row=>row.payload.custom.meta.every(meta=>meta.sourceRef.sourceId===body.sourceRef.sourceId)),
        'writer receives only its current source batch');
      return { success: true, nodes: [...body.nodes, { payload: { node_id: body.requestId, user_id: principal.ownerRef,
        agent_id: principal.scopeRef, fixtureOrder:calls.filter(call=>call==='write').length, content: body.content, layer: 'l2_fact', status: 'active', is_latest: true, custom: { meta: [{ sourceRef: body.sourceRef }] } }, embedding: [1, 0, 0], lexicalTokens:['fixture','observation'] }] };
    },
  };
  return { db, blobs, models, objects, calls, knowledgeCalls, service: new MemoryService(db, blobs, models, principal) };
}
const upload = (id = 'first') => ({ operationId: id, sessionRef: 'session-1', messageRef: 'message-1', mimeType: 'image/png', dataBase64: image });

test('image plus text verifies both inputs and fills a rejected first candidate from the larger pool', async () => {
  const x = setup(), checked = [];
  const bad = await x.service.ingest(upload('similar-wrong-color'));
  // Distinct synthetic original bytes; the fixed verifier models wrong/right color judgments.
  const blueBytes = Buffer.concat([Buffer.from(image, 'base64'), Buffer.from([2])]);
  const good = await x.service.ingest({ ...upload('less-similar-blue'), dataBase64: blueBytes.toString('base64') });
  x.models.matchImage = async input => { checked.push(input); return { matches: input.bytes.at(-1) === 2,
    text: input.bytes.at(-1) === 2 ? 'Blue cup in the source image.' : 'Wrong color.', correctionRelevant: false, model: 'fixture', configKey: 'fixed' }; };
  const result = await x.service.search({ query: 'Use the shape as a reference, but only blue cups.', media: { mimeType: 'image/png', dataBase64: image }, limit: 1, sessionRef: 'query' });
  assert.deepEqual(result.items.map(item => item.refs), [[good.ref]]);
  assert.ok(!result.items.some(item => item.refs[0].sourceId === bad.ref.sourceId));
  assert.equal(checked.length, 2);
  assert.equal(checked[1].query, 'Use the shape as a reference, but only blue cups.');
  assert.equal(Buffer.from(checked[1].media.bytes).toString('base64'), image);
  assert.deepEqual(Buffer.from(checked[1].bytes), blueBytes);
  assert.equal(result.items[0].retrieval, 'verified-image');
  assert.deepEqual(result.items[0].imageEvidence[0].ref, good.ref);
  assert.equal(result.coverage.examinedSources, 2);
  assert.equal(result.coverage.returned, 1);
});
test('empty or limited retrieval never establishes absence, including when every candidate failed verification', async () => {
  const x = setup();
  const empty = await x.service.search({ query: 'Anything?', sessionRef: 'empty' });
  assert.equal(empty.coverage.absence, 'not-established');
  assert.equal(empty.coverage.exhaustive, false);
  await x.service.ingest(upload());
  x.models.matchImage = async () => ({ matches: false, correctionRelevant: false, text: 'Cannot establish that detail.', model: 'fixture', configKey: 'fixed' });
  const rejected = await x.service.search({ query: 'Is there a purple cup?', sessionRef: 'negative' });
  assert.deepEqual(rejected.items, []);
  assert.equal(rejected.coverage.examinedSources, 1);
  assert.equal(rejected.coverage.remainingCandidates, 0);
  assert.equal(rejected.coverage.absence, 'not-established');
  assert.equal(rejected.coverage.exhaustive, false);
});
test('Owner correction may be relevant without pretending the original image proves it', async () => {
  const x = setup(), first = await x.service.ingest(upload());
  const corrected = await x.service.correct({ operationId: 'change', ref: first.ref, text: 'The unseen other side has a blue mark.' });
  x.models.matchImage = async input => ({ matches: false, correctionRelevant: input.query === 'What did the Owner clarify?', text: 'Other side is not visible.', model: 'fixture', configKey: 'fixed' });
  const result = await x.service.search({ query: 'What did the Owner clarify?', sessionRef: 'correction' });
  assert.deepEqual(result.items[0].refs, [corrected.ref]);
  assert.equal(result.items[0].retrieval, 'owner-correction');
  assert.equal(result.items[0].imageEvidence, undefined);
  assert.deepEqual((await x.service.search({ query: 'Show original visual proof of blue on the other side.', sessionRef: 'proof' })).items, []);
});
test('image verification rechecks source revocation after the model await', async () => {
  const x = setup(), first = await x.service.ingest(upload());
  x.models.matchImage = async () => {
    await x.service.forget({ operationId: 'withdraw-during-check', ref: first.ref }, true);
    return { matches: true, correctionRelevant: false, text: 'Late image judgment.', model: 'fixture', configKey: 'fixed' };
  };
  await assert.rejects(x.service.search({ query: 'badge', sessionRef: 'late' }), /source_changed|source_unavailable/);
});

test('persists source, recalls across service/session restart, and reads exact original bytes', async () => {
  const x = setup(), accepted = await x.service.ingest(upload());
  const restored = new MemoryService(x.db, x.blobs, x.models, principal);
  const result = await restored.search({ query: 'Which badge?', sessionRef: 'another-session' });
  assert.equal(result.items[0].text, 'A red badge marked 17.');
  assert.deepEqual(result.items[0].refs, [accepted.ref]);
  assert.equal((await restored.read(accepted.ref)).dataBase64, image);
  const before = [...x.calls], knowledgeBefore = [...x.knowledgeCalls];
  assert.deepEqual(await restored.ingest(upload()), accepted);
  assert.deepEqual(x.calls, before, 'idempotent retry must not call providers');
  assert.deepEqual(x.knowledgeCalls, knowledgeBefore, 'idempotent retry must not re-extract or reassess knowledge');
  await assert.rejects(restored.ingest({ ...upload(), dataBase64: 'YWJj' }), /operation_conflict/);
});
test('formation failure publishes neither Hy nodes nor active source', async () => {
  const x = setup();
  x.models.compute = async () => ({ success: false, nodes: [{ payload: { content: 'partial' }, embedding: [1] }] });
  await assert.rejects(x.service.ingest(upload()), /hy_formation_failed/);
  assert.deepEqual(await visibleNodes(x), []);
  assert.equal((await x.db.list('source:'))[0].state, 'pending');
  assert.equal(await x.service.revision(), 1);
});
test('correction invalidates old source, nodes and original reference before publishing new facts', async () => {
  const x = setup(), first = await x.service.ingest(upload());
  const corrected = await x.service.correct({ operationId: 'correct-1', ref: first.ref, text: 'The badge is blue; the initial color observation was wrong.' });
  assert.equal(corrected.ref.revision, 2);
  assert.equal((await x.service.validate([first.ref])).valid, false);
  await assert.rejects(x.service.read(first.ref), /source_changed/);
  const found = await x.service.search({ query: 'Badge color?', sessionRef: 'new' });
  assert.equal(found.items.length, 1);
  assert.match(found.items[0].text, /blue/);
  assert.equal((await x.service.read(corrected.ref)).dataBase64, image);
});
test('delete removes original and every dependent node; revocation denies read without claiming blob deletion', async () => {
  const x = setup(), first = await x.service.ingest(upload());
  await x.service.forget({ operationId: 'delete-1', ref: first.ref });
  assert.equal(x.objects.size, 0);
  assert.deepEqual(await visibleNodes(x), []);
  assert.equal((await x.service.validate([first.ref])).valid, false);
  const other = await x.service.ingest(upload('second'));
  await x.service.forget({ operationId: 'revoke-1', ref: other.ref }, true);
  assert.equal(x.objects.size, 1);
  await assert.rejects(x.service.read(other.ref), /source_changed/);
});
test('delete while formation is awaiting a model prevents late publication', async () => {
  const x = setup();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  x.models.perceive = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { model: 'fixture', configKey: 'fixed', kind: 'image', text: 'Late observation' }; };
  const pending = x.service.ingest(upload());
  await started;
  const source = (await x.db.list('source:'))[0];
  await x.service.forget({ operationId: 'delete-pending', ref: source.ref });
  release();
  await assert.rejects(pending, /source_changed|source_unavailable/);
  assert.deepEqual(await visibleNodes(x), []);
  assert.equal(x.objects.size, 0);
});
test('read rechecks revocation after R2 await', async () => {
  const x = setup(), first = await x.service.ingest(upload());
  const get = x.blobs.get;
  x.blobs.get = async key => { const bytes = await get(key); await x.service.forget({ operationId: 'revoke-read', ref: first.ref }, true); return bytes; };
  await assert.rejects(x.service.read(first.ref), /source_changed/);
});
test('native image/audio query uses the original embedding path without pretending to be text retrieval', async () => {
  const x = setup();
  await x.service.ingest(upload());
  x.calls.length = 0;
  const result = await x.service.search({ media: { mimeType: 'image/png', dataBase64: image }, sessionRef: 'query-session' });
  assert.equal(result.items.length, 1);
  assert.deepEqual(x.calls, ['embed']);
});
test('untrusted or missing source metadata cannot enter the committed Hy snapshot', async () => {
  const x = setup();
  x.models.compute = async () => ({ success: true, nodes: [{ payload: { node_id: 'bad', user_id: 'someone-else', agent_id: 'personal', custom: { meta: [] } }, embedding: [1] }] });
  await assert.rejects(x.service.ingest(upload()), /hy_scope_invalid/);
  assert.deepEqual(await visibleNodes(x), []);
});
test('a concurrent committed write rejects a stale full-snapshot replacement', async () => {
  const x = setup(), compute = x.models.compute;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  x.models.compute = async body => {
    if (body.requestId === 'slow') { entered(); await new Promise(resolve => { release = resolve; }); }
    return compute(body);
  };
  const slow = x.service.ingest(upload('slow'));
  await started;
  const fast = await x.service.ingest(upload('fast'));
  release();
  await assert.rejects(slow, /memory_changed_during_formation/);
  assert.deepEqual((await visibleNodes(x)).map(row => row.payload.node_id), ['fast']);
  assert.equal((await x.service.validate([fast.ref])).valid, true);
});
test('failed correction exposes pending revision and explicit recovery reuses completed perception and embedding', async () => {
  const x = setup(), first = await x.service.ingest(upload()), compute = x.models.compute;
  x.models.compute = async () => { throw new Error('provider connection lost'); };
  await assert.rejects(x.service.correct({ operationId: 'correction', ref: first.ref, text: 'Actually blue.' }), /connection lost/);
  const operation = await x.service.operation('correction');
  assert.equal(operation.state, 'unknown');
  assert.equal(operation.ref.revision, 2);
  assert.equal(operation.stage, 'formation');
  assert.equal((await x.service.validate([first.ref])).valid, false);
  assert.deepEqual(await visibleNodes(x), []);
  await assert.rejects(x.service.recover({ operationId: 'resume', previousOperationId: 'correction' }), /explicit_recovery/);
  x.models.compute = compute; x.calls.length = 0;
  const recovered = await x.service.recover({ operationId: 'resume', previousOperationId: 'correction', acceptUnknown: true });
  assert.equal(recovered.ref.revision, 3);
  assert.deepEqual(x.calls, ['write']);
  assert.equal((await x.service.read(recovered.ref)).perceptionText, 'Actually blue.');
  assert.deepEqual(await x.service.recover({ operationId: 'resume', previousOperationId: 'correction', acceptUnknown: true }), recovered);
});
test('explicit recovery fences an old still-running invocation instead of inferring its termination', async () => {
  const x = setup(), perceive = x.models.perceive;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  x.models.perceive = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { model: 'fixture', configKey: 'old', kind: 'image', text: 'Late old result' }; };
  const old = x.service.ingest(upload('crashed'));
  await started;
  assert.equal((await x.service.operation('crashed')).state, 'unknown');
  x.models.perceive = perceive;
  const recovered = await x.service.recover({ operationId: 'recover', previousOperationId: 'crashed', acceptUnknown: true });
  release();
  await assert.rejects(old, /source_changed/);
  assert.equal((await x.service.operation('crashed')).state, 'superseded');
  assert.equal((await x.service.read(recovered.ref)).perceptionText, 'A red badge marked 17.');
});
test('failed original cleanup can be explicitly completed while old references remain denied', async () => {
  const x = setup(), first = await x.service.ingest(upload()), remove = x.blobs.delete;
  x.blobs.delete = async () => { throw new Error('R2 unavailable'); };
  await assert.rejects(x.service.forget({ operationId: 'remove', ref: first.ref }), /cleanup_pending/);
  assert.equal((await x.service.validate([first.ref])).valid, false);
  x.blobs.delete = remove;
  const result = await x.service.recover({ operationId: 'clean', previousOperationId: 'remove', acceptUnknown: true });
  assert.equal(result.state, 'deleted'); assert.equal(x.objects.size, 0);
});

function wav(seconds = 1) {
  const samples = seconds * 8000, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes.toString('base64');
}
const audioUpload = () => ({ ...upload('audio-1'), mimeType: 'audio/wav', dataBase64: wav() });
const observation = { startMs: 100, endMs: 900, text: 'A tone accompanies the spoken label.', model: 'fixed-temporal', configKey: 'fixed', basis: 'model-estimate', modalities: ['audio'] };
test('temporal retrieval uses original bytes, bounds its interval and reads the full versioned original', async () => {
  const x = setup(); let seen;
  x.models.locate = async input => { seen = input; return { intervals: [observation], correctionRelevant: false }; };
  const accepted = await x.service.ingest(audioUpload());
  const result = await x.service.search({ query: 'Find the tone', sessionRef: 'next' });
  assert.equal(result.items[0].retrieval, 'grounded');
  assert.deepEqual(result.items[0].groundings, [{ ...observation, ref: accepted.ref }]);
  assert.equal(seen.query, 'Find the tone');
  assert.equal(Buffer.from(seen.bytes).toString('base64'), wav());
  assert.deepEqual(seen.timeline, { durationMs: 1000, hasAudio: true, hasVideo: false });
  const range = { startMs: 100, endMs: 900 };
  const read = await x.service.read(accepted.ref, range);
  assert.deepEqual(read.selection, range); assert.equal(read.originalIsFullFile, true);
  assert.equal(read.dataBase64, wav());
  await assert.rejects(x.service.read(accepted.ref, { startMs: 900, endMs: 1001 }), /invalid_time_range/);
  await assert.rejects(x.service.read(accepted.ref, { startMs: 900, endMs: 100 }), /invalid_time_range/);
});
test('a transcription/vector candidate with no native match does not become a temporal hit', async () => {
  const x = setup(); x.models.locate = async () => ({ intervals: [], correctionRelevant: false });
  await x.service.ingest(audioUpload());
  assert.deepEqual((await x.service.search({ query: 'red button and spoken problem together', sessionRef: 'next' })).items, []);
});
test('provider interval and modality claims are checked against the actual container', async () => {
  const x = setup(); await x.service.ingest(audioUpload());
  x.models.locate = async () => ({ intervals: [{ ...observation, endMs: 1001 }], correctionRelevant: false });
  await assert.rejects(x.service.search({ query: 'tone', sessionRef: 'next' }), /grounding_range_invalid/);
  x.models.locate = async () => ({ intervals: [{ ...observation, modalities: ['video'] }], correctionRelevant: false });
  await assert.rejects(x.service.search({ query: 'tone', sessionRef: 'next' }), /grounding_modality_invalid/);
});
test('revocation during native temporal verification prevents a stale interval result', async () => {
  const x = setup(); const accepted = await x.service.ingest(audioUpload());
  x.models.locate = async () => { await x.service.forget({ operationId: 'revoke-locate', ref: accepted.ref }, true); return { intervals: [observation], correctionRelevant: false }; };
  await assert.rejects(x.service.search({ query: 'tone', sessionRef: 'next' }), /source_changed/);
});
test('Owner temporal correction survives unsupported model observation without fabricated timestamps', async () => {
  const x = setup(); const accepted = await x.service.ingest(audioUpload());
  const corrected = await x.service.correct({ operationId: 'audio-fix', ref: accepted.ref, text: 'Owner says the tone is a warning.' });
  x.models.locate = async input => { assert.equal(input.correction, 'Owner says the tone is a warning.'); return { intervals: [], correctionRelevant: true }; };
  const found = await x.service.search({ query: 'warning tone', sessionRef: 'next' });
  assert.equal(found.items[0].retrieval, 'owner-correction'); assert.deepEqual(found.items[0].groundings, []);
  assert.deepEqual(found.items[0].refs, [corrected.ref]);
  await assert.rejects(x.service.read(accepted.ref, { startMs: 100, endMs: 900 }), /source_changed/);
});
test('malformed temporal uploads are rejected before models or original storage are used', async () => {
  const x = setup();
  await assert.rejects(x.service.ingest({ ...audioUpload(), dataBase64: 'YWJj' }));
  assert.deepEqual(x.calls, []); assert.equal(x.objects.size, 0);
  assert.equal((await x.db.list('source:'))[0].state, 'pending');
});

test('an unrelated Owner correction cannot turn a native candidate into a hit', async () => {
  const x = setup(), accepted = await x.service.ingest(audioUpload());
  await x.service.correct({ operationId: 'audio-fix-unrelated', ref: accepted.ref, text: 'This tone is a warning.' });
  x.models.locate = async () => ({ intervals: [], correctionRelevant: false });
  assert.deepEqual((await x.service.search({ query: 'red button and spoken problem together', sessionRef: 'next' })).items, []);
});


test('revocation during knowledge relation model await prevents late candidate publication',async()=>{
  const x=setup(),first=await x.service.ingest(upload('knowledge-first'));
  const relate=x.models.knowledge.relate;
  let revoked;
  x.models.knowledge.relate=async pairs=>{
    const pending=(await x.db.list('source:')).find(source=>source.state==='pending');
    assert.ok(pending,'the new source is still pending during knowledge candidate construction');
    revoked=pending.ref;
    await x.service.forget({operationId:'revoke-during-knowledge',ref:pending.ref},true);
    return relate(pairs);
  };
  await assert.rejects(x.service.ingest(upload('knowledge-late')),/source_changed|source_unavailable|memory_changed_during_formation/);
  assert.ok(revoked);
  assert.equal((await x.service.validate([revoked])).valid,false);
  assert.equal((await x.service.validate([first.ref])).valid,true);
  assert.deepEqual((await visibleNodes(x)).map(row=>row.payload.node_id),['knowledge-first']);
});
