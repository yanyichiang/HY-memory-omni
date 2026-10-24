import test from 'node:test';
import assert from 'node:assert/strict';
import { PagedTree } from '../dist/paged-store.js';

class Pages {
  data = new Map(); reads = 0; fail = false; writesUntilFailure = Infinity; sequence = 0;
  async read(id) { this.reads++; return structuredClone(this.data.get(id)); }
  async write(value) {
    if (this.fail || this.writesUntilFailure-- <= 0) throw new Error('object write failed');
    const id = String(++this.sequence);
    this.data.set(id, structuredClone(value)); return id;
  }
}
const key = n => `row/${String(n).padStart(5, '0')}`;
async function all(tree, prefix = '', size = 29) {
  const entries = []; let cursor;
  do {
    const result = await tree.page(prefix, cursor, size);
    entries.push(...result.entries); cursor = result.nextCursor;
  } while (cursor !== undefined);
  return entries;
}

test('ordered and randomized insertion > 2000 rows, bounded lookup/range reads, immutable roots', async () => {
  const pages = new Pages(), tree = new PagedTree(pages);
  for (let n = 0; n < 1200; n++) await tree.set(key(n), { n });
  const oldRoot = tree.root;
  const shuffled = Array.from({ length: 1200 }, (_, i) => 1200 + i);
  let seed = 71;
  for (let i = shuffled.length - 1; i; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (const n of shuffled) await tree.set(key(n), { n });
  assert.deepEqual((await all(tree)).map(e => e.value.n), Array.from({ length: 2400 }, (_, i) => i));
  for (const n of [0, 31, 32, 500, 1199, 1200, 2399]) assert.deepEqual(await tree.get(key(n)), { n });
  const reopened = new PagedTree(pages, tree.root);
  pages.reads = 0;
  assert.deepEqual(await reopened.get(key(2300)), { n: 2300 });
  assert.ok(pages.reads < 10, `lookup read ${pages.reads} objects`);
  pages.reads = 0;
  assert.equal((await reopened.page('row/023', key(2300), 7)).entries.length, 7);
  assert.ok(pages.reads < 20, `range read ${pages.reads} objects`);
  await tree.set(key(50), { n: 'updated' });
  const snapshot = new PagedTree(pages, oldRoot);
  assert.deepEqual(await snapshot.get(key(50)), { n: 50 });
  assert.equal(await snapshot.get(key(1200)), undefined);
  assert.equal((await all(snapshot)).length, 1200);
  for (const value of pages.data.values()) {
    if (value.kind) {
      assert.ok(value.items.length <= 32);
      assert.ok(value.items.every(item => typeof item.id === 'string' && !('value' in item)));
    }
  }
});

test('mixed mutation agrees with Map; delete, collapse, empty, reopen and prefix edge cases', async () => {
  const pages = new Pages(), tree = new PagedTree(pages), expected = new Map();
  let seed = 19;
  for (let i = 0; i < 4000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const k = key(seed % 900);
    if (seed % 3 === 0) { await tree.delete(k); expected.delete(k); }
    else { await tree.set(k, i); expected.set(k, i); }
  }
  const root = tree.root;
  const reopened = new PagedTree(pages, root);
  assert.deepEqual(await all(reopened), [...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value })));
  assert.deepEqual(await reopened.page('absent', undefined, 1), { entries: [] });
  for (const k of expected.keys()) await tree.delete(k);
  assert.equal(tree.root, null);
  assert.deepEqual(await all(tree), []);
  assert.equal((await all(new PagedTree(pages, root))).length, expected.size);
  for (const k of ['', 'a', 'a\u0000', 'ab', 'ac', 'b', '\uffff', '\uffffx']) await tree.set(k, k);
  assert.deepEqual((await all(tree, 'a', 1)).map(e => e.key), ['a', 'a\u0000', 'ab', 'ac']);
  assert.deepEqual((await all(tree, '\uffff', 1)).map(e => e.key), ['\uffff', '\uffffx']);
  assert.deepEqual((await tree.page('a', 'abz', 5)).entries.map(e => e.key), ['ac']);
});

test('large values stay outside index pages; failed writes preserve root and invalid input fails', async () => {
  const pages = new Pages(), tree = new PagedTree(pages);
  const original = { nested: [1] };
  await tree.set('a', original); original.nested[0] = 9;
  assert.deepEqual(await tree.get('a'), { nested: [1] });
  await tree.set('large', 'x'.repeat(1024 * 1024 - 2));
  assert.equal((await tree.get('large')).length, 1024 * 1024 - 2);
  const root = tree.root;
  await assert.rejects(tree.set('too-large', 'x'.repeat(1024 * 1024)), /1 MiB/);
  await assert.rejects(tree.set('undefined', undefined), /JSON/);
  await assert.rejects(tree.set('k'.repeat(4097), 1), /4096/);
  pages.writesUntilFailure = 1; // value succeeds, changed index page fails
  await assert.rejects(tree.set('partially-written', 3), /object write failed/);
  assert.equal(tree.root, root);
  assert.equal(await tree.get('partially-written'), undefined);
  pages.writesUntilFailure = Infinity;
  pages.fail = true;
  await assert.rejects(tree.set('new', 3), /object write failed/);
  await assert.rejects(tree.delete('a'), /object write failed/);
  assert.equal(tree.root, root);
  assert.deepEqual(await tree.get('a'), { nested: [1] });
  await assert.rejects(tree.page('', undefined, 0), /limit/);
});

test('reclaiming superseded blobs after publication preserves all live pages and values', async () => {
  const pages = new Pages(), initial = new PagedTree(pages);
  for (let n = 0; n < 100; n++) await initial.set(key(n), { n });
  const tree = new PagedTree(pages, initial.root);
  const deletedValue = [...pages.data].find(([, value]) => value.n === 40)[0];
  await tree.set(key(10), { n: 'replacement' });
  await tree.set(key(100), { n: 100 });
  await tree.set(key(101), { n: 101 });
  await tree.delete(key(40));
  assert.ok(tree.garbageIds.includes(deletedValue));
  assert.ok(tree.createdIds.some(id => tree.garbageIds.includes(id)), 'intermediate COW pages are reclaimable');
  for (const id of tree.garbageIds) pages.data.delete(id);
  const reopened = new PagedTree(pages, tree.root);
  const expected = Array.from({ length: 102 }, (_, n) => n).filter(n => n !== 40).map(n => ({
    key: key(n), value: { n: n === 10 ? 'replacement' : n },
  }));
  assert.deepEqual(await all(reopened), expected);
  assert.equal(await reopened.get(key(40)), undefined);
  assert.equal(pages.data.has(deletedValue), false);
  // A failed mutation can expose created orphans but must never nominate live
  // objects for reclamation. Discard the failed instance rather than publish it.
  const failing = new PagedTree(pages, tree.root);
  pages.writesUntilFailure = 1;
  await assert.rejects(failing.set(key(10), 7), /object write failed/);
  assert.equal(failing.createdIds.length, 1);
  assert.deepEqual(failing.garbageIds, []);
  for (const id of failing.createdIds) pages.data.delete(id);
  assert.deepEqual(await new PagedTree(pages, tree.root).get(key(10)), { n: 'replacement' });
});
