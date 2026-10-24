import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeStore } from '../dist/knowledge-store.js';
import { MemoryStore } from '../dist/storage.js';
import { projectKnowledge } from '../dist/knowledge.js';

const time = new Date().toISOString();
const past = new Date(Date.now() - 86400000).toISOString();
const future = new Date(Date.now() + 86400000).toISOString();
const source = id => ({ sourceId: id, revision: 1, mediaRef: `media-${id}` });
const claim = id => ({ id, key: id, nodeId: id, text: `Claim ${id}`, subject: 'Team', event: 'Meeting', predicate: 'venue',
  value: id, validTime: '', conditions: '', quote: id, source: source(id), roots: [id], observedAt: time, authority: 'observation' });
const relation = (id, left, right, kind, extra = {}) => ({ id, left, right, kind, reason: `Evidence ${id}`,
  leftQuote: left, rightQuote: right, model: 'fixture', assessedAt: time, ...extra });
const normalize = values => values.sort((a, b) => a.id.localeCompare(b.id));
async function install(store, knowledge) {
  for (const c of knowledge.claims) {
    await store.set(`claim:${c.id}`, c);
    await store.set(`active-source-claims:${c.source.sourceId}`, { revision: c.source.revision, ids: [c.id] });
  }
  for (const r of knowledge.relations) {
    await store.set(`relation:${r.id}`, r);
    await store.set(`claim-edge:${r.left}:${r.id}`, r.id);
    await store.set(`claim-edge:${r.right}:${r.id}`, r.id);
  }
}
async function finish(store, sources, available = () => true, unavailableAt = () => undefined, budget = 64, revision = 1) {
  const api = new KnowledgeStore(store), claims = new Map(), relations = new Map();
  let continuation, evaluatedAt, partial = 0, pages = 0;
  do {
    const view = await api.view(sources, revision, async ref => available(ref), async ref => unavailableAt(ref),
      { workBudget: budget, limit: 2, ...(continuation ? { continuation } : {}) });
    evaluatedAt = view.coverage.evaluatedAt; pages++;
    assert.equal(view.coverage.exhaustiveGlobalConflicts, false);
    assert.equal(view.coverage.candidateRecallLimited, true);
    assert.ok(pages < 5000, 'incremental algorithm converges');
    if (!view.coverage.complete) {
      partial++;
      assert.equal(view.coverage.reason, 'relationship-closure-paged');
      assert.ok(view.claims.every(c => c.status === 'unresolved'));
      assert.ok(view.relations.every(r => !r.active && view.claims.some(c => c.id === r.left) && view.claims.some(c => c.id === r.right)));
    } else {
      for (const c of view.claims) claims.set(c.id, c);
      for (const r of view.relations) relations.set(r.id, r);
    }
    continuation = view.coverage.continuation;
  } while (continuation);
  return { claims: normalize([...claims.values()]), relations: normalize([...relations.values()]), evaluatedAt, partial, pages };
}

test('incremental temporal, withdrawal, correction and cyclic projections match original semantic oracle', async () => {
  const fixtures = [
    { claims: ['a', 'b', 'c', 'd'].map(claim), relations: [relation('ab', 'a', 'b', 'conflict'),
      relation('ac', 'a', 'c', 'revision', { revisionKind: 'correction', superseded: 'left' }), relation('cd', 'c', 'd', 'same')] },
    { claims: ['a', 'b', 'c', 'd'].map(claim), relations: [relation('ab', 'a', 'b', 'revision', { revisionKind: 'correction', superseded: 'left' }),
      relation('bc', 'b', 'c', 'revision', { revisionKind: 'correction', superseded: 'left' }),
      relation('ca', 'c', 'a', 'revision', { revisionKind: 'correction', superseded: 'left' }), relation('cd', 'c', 'd', 'same')] },
    { claims: ['a', 'b', 'c', 'd'].map(claim), relations: [relation('ab', 'a', 'b', 'revision', { revisionKind: 'world-change', superseded: 'left', effectiveAt: future, effectiveTime: 'tomorrow' }),
      relation('bc', 'b', 'c', 'revision', { revisionKind: 'correction', superseded: 'left' }), relation('cd', 'c', 'd', 'conflict')] },
    { claims: ['a', 'b', 'c', 'd'].map(claim), relations: [relation('ab', 'a', 'b', 'revision', { revisionKind: 'world-change', superseded: 'left', effectiveAt: past, effectiveTime: 'yesterday' }),
      relation('bc', 'b', 'c', 'revision', { revisionKind: 'correction', superseded: 'left' }), relation('cd', 'c', 'd', 'same')] },
  ];
  for (const knowledge of fixtures) for (const withdrawn of [new Set(), new Set(['b']), new Set(['c'])]) {
    const store = new MemoryStore(); await install(store, knowledge);
    const available = ref => !withdrawn.has(ref.sourceId), unavailableAt = () => past;
    const actual = await finish(store, ['a'], available, unavailableAt, 7);
    const expected = projectKnowledge(knowledge, 1, available, ['a'], actual.evaluatedAt, unavailableAt);
    assert.deepEqual(actual.claims, normalize(expected.claims));
    assert.deepEqual(actual.relations, normalize(expected.relations));
    assert.ok(actual.partial > 0);
  }
});

test('fixed-seed small random graphs differentially preserve status and relation semantics', async () => {
  let seed = 137;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % max; };
  for (let sample = 0; sample < 20; sample++) {
    const claims = Array.from({ length: 6 }, (_, i) => claim(String(i))), relations = [];
    for (let n = 0; n < 10; n++) {
      const left = String(random(6)), right = String(random(6));
      const kind = ['same', 'conflict', 'uncertain', 'revision'][random(4)];
      const extra = kind === 'revision' ? { revisionKind: random(2) ? 'correction' : 'world-change', superseded: random(2) ? 'left' : 'right' } : {};
      if (extra.revisionKind === 'world-change') { extra.effectiveAt = [past, future, null][random(3)]; extra.effectiveTime = 'event time'; }
      relations.push(relation(`r${n}`, left, right, kind, extra));
    }
    const withdrawn = new Set(claims.filter(() => random(4) === 0).map(c => c.id));
    const knowledge = { claims, relations }, store = new MemoryStore(); await install(store, knowledge);
    const available = ref => !withdrawn.has(ref.sourceId), unavailableAt = () => past;
    const actual = await finish(store, undefined, available, unavailableAt, 64);
    const expected = projectKnowledge(knowledge, 1, available, undefined, actual.evaluatedAt, unavailableAt);
    assert.deepEqual(actual.claims, normalize(expected.claims), `sample ${sample}`);
    assert.deepEqual(actual.relations, normalize(expected.relations), `sample ${sample}`);
  }
});

test('old source revisions do not enlarge active seeds; cursor identity rejects revision/source changes', async () => {
  const store = new MemoryStore(); await install(store, { claims: [claim('current')], relations: [] });
  for (let n = 0; n < 2200; n++) await store.set(`source-claim:current:${n}:old`, 'missing-history-row');
  const api = new KnowledgeStore(store);
  const first = await api.view(['current'], 1, async () => true, async () => undefined, { workBudget: 1 });
  assert.equal(first.coverage.complete, false);
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('projection-index:')).length, 1);
  await assert.rejects(api.view(['current'], 2, async () => true, async () => undefined, { continuation: first.coverage.continuation }), /cursor_changed/);
  await assert.rejects(api.view(['other'], 1, async () => true, async () => undefined, { continuation: first.coverage.continuation }), /cursor_changed/);
  const done = await finish(store, ['current']);
  assert.equal(done.claims.length, 1);
  assert.equal(done.claims[0].status, 'supported');
});

test('a connected graph larger than the old projection ceiling completes server-side and returns exact paged statuses', async () => {
  // Ordered index for this algorithm-only fixture keeps thousands of bounded
  // pages lightweight; no whole-map sort or transaction copy per server step.
  class IndexedStore extends MemoryStore {
    keys = [];
    async set(key, value) {
      if (!this.rows.has(key)) {
        let low = 0, high = this.keys.length;
        while (low < high) { const mid = (low + high) >>> 1; if (this.keys[mid] < key) low = mid + 1; else high = mid; }
        this.keys.splice(low, 0, key);
      }
      await super.set(key, value);
    }
    async delete(key) { await super.delete(key); const i = this.keys.indexOf(key); if (i >= 0) this.keys.splice(i, 1); }
    async page(prefix, after, limit = 64) {
      const lower = after !== undefined && after > prefix ? after : prefix;
      let low = 0, high = this.keys.length;
      while (low < high) { const mid = (low + high) >>> 1; if (this.keys[mid] < lower || (after !== undefined && this.keys[mid] <= after)) low = mid + 1; else high = mid; }
      const selected = [];
      for (let i = low; i < this.keys.length && selected.length <= limit && this.keys[i].startsWith(prefix); i++) selected.push(this.keys[i]);
      return { entries: selected.slice(0, limit).map(key => ({ key, value: structuredClone(this.rows.get(key)) })),
        ...(selected.length > limit ? { nextCursor: selected[limit - 1] } : {}) };
    }
    async transaction(action) { return action(); }
  }
  const store = new IndexedStore();
  const ids = Array.from({ length: 2050 }, (_, n) => `claim-${String(n).padStart(4, '0')}`);
  await install(store, { claims: ids.map(claim), relations: ids.slice(1).map((id, n) => relation(`edge-${String(n).padStart(4, '0')}`, ids[n], id, 'same')) });
  const result = await finish(store, [ids[0]], () => true, () => undefined, 256);
  assert.equal(result.claims.length, 2050);
  assert.equal(result.relations.length, 2049);
  assert.ok(result.claims.every(c => c.status === 'supported'));
  assert.ok(result.relations.every(r => r.active));
  assert.ok(result.partial > 1);
});
