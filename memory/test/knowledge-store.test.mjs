import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeStore } from '../dist/knowledge-store.js';
import { MemoryStore } from '../dist/storage.js';

const ref = sourceId => ({ sourceId, revision: 1, mediaRef: `media-${sourceId}` });
const input = sourceId => ({ source: ref(sourceId), authority: 'observation',
  perception: { model: 'test', configKey: 'test', kind: 'text', text: `Quote ${sourceId}` },
  nodes: [{ payload: { node_id: 'node', layer: 'l2_fact' }, embedding: [1, 0] }] });
const draft = sourceId => ({ key: 'claim', nodeId: 'node', text: `Quote ${sourceId}`, subject: 'Team',
  event: 'Meeting', predicate: 'venue', value: sourceId, validTime: '', conditions: '', quote: `Quote ${sourceId}` });
const now = '2026-10-24T10:00:00Z';

test('bounded indexed comparisons allow more than 64 same-root/event claims without global scan or nested transaction', async () => {
  class TrackedStore extends MemoryStore {
    prefixes = [];
    async page(prefix, after, limit) { this.prefixes.push(prefix); return super.page(prefix, after, limit); }
    async transaction() { throw Error('nested transaction'); }
  }
  const store = new TrackedStore(), knowledge = new KnowledgeStore(store);
  let extractCalls = 0, largestOld = 0;
  for (let n = 0; n < 75; n++) {
    const id = `source-${n}`;
    await knowledge.add(input(id), { model: 'fixture', extract: async () => { extractCalls++; return [draft(id)]; },
      relate: async pairs => {
        largestOld = Math.max(largestOld, pairs.length);
        return pairs.map(({ left, right }) => ({ left: left.id, right: right.id, kind: 'different',
          reason: 'Fixture independent evidence', leftQuote: left.quote, rightQuote: right.quote }));
      } }, ['shared-video-root'], now, async () => true, async source => `Quote ${source.sourceId}`);
  }
  assert.equal(extractCalls, 75);
  assert.ok(largestOld <= 16, 'existing relation batch work budget remains enforced');
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('claim:')).length, 75);
  assert.ok(store.prefixes.every(prefix => prefix.startsWith('event-claim:')));
  const coverage = await store.get('knowledge-coverage:source-74:1');
  assert.equal(coverage.comparedOldClaims, 64);
  assert.equal(coverage.exhaustiveGlobalConflicts, false);
  assert.equal(coverage.candidateBudgetReached, true);
  assert.equal(coverage.recallTruncated, true);
  store.transaction = MemoryStore.prototype.transaction;
  const view = await knowledge.view(['source-74'], 8, async () => true, async () => undefined);
  assert.equal(view.claims.length, 1);
  assert.equal(view.claims[0].source.sourceId, 'source-74');
});

test('projection traverses withdrawn historical endpoints without exposing them or reviving old truth', async () => {
  const store = new MemoryStore(), knowledge = new KnowledgeStore(store);
  for (const id of ['old', 'fresh']) {
    const claim = { ...draft(id), id, source: ref(id), roots: [id], observedAt: now, authority: 'observation' };
    await store.set(`claim:${id}`, claim);
    await store.set(`source-claim:${id}:1:${id}`, id);
    await store.set(`active-source-claims:${id}`, { revision: 1, ids: [id] });
  }
  const relation = { id: 'revision', left: 'old', right: 'fresh', kind: 'revision',
    revisionKind: 'correction', superseded: 'left', reason: 'Exact correction',
    leftQuote: 'Quote old', rightQuote: 'Quote fresh', assessedAt: now, model: 'fixture' };
  await store.set('relation:revision', relation);
  await store.set('claim-edge:old:revision', 'revision');
  await store.set('claim-edge:fresh:revision', 'revision');
  const queried = [];
  const view = await knowledge.view(['old'], 9, async source => { queried.push(source.sourceId); return source.sourceId !== 'fresh'; },
    async () => '2026-10-24T11:00:00Z');
  assert.deepEqual(queried.sort(), ['fresh', 'old']);
  assert.equal(view.claims.length, 1);
  assert.equal(view.claims[0].status, 'unresolved');
  assert.equal(JSON.stringify(view).includes('Quote fresh'), false);
  assert.deepEqual(view.relations, []);
});

test('global projections are paginated from active sources rather than all historical revisions', async () => {
  const store = new MemoryStore(), knowledge = new KnowledgeStore(store);
  for (let n = 0; n < 2048; n++) await store.set(`source-claim:large:1:${String(n).padStart(4, '0')}`, String(n));
  const view = await knowledge.view(undefined, 1, async () => true, async () => undefined);
  assert.equal(view.coverage.complete, true);
  assert.deepEqual(view.claims, []);
});
