import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore } from '../dist/storage.js';

function storage(backend = { rows: new Map(), tables: new Map() }) {
  return {
    backend,
    kv: {
      get: key => structuredClone(backend.rows.get(key)),
      put: (key, value) => backend.rows.set(key, structuredClone(value)),
      delete: key => backend.rows.delete(key),
    },
    sql: { exec(query, table) {
      if (query.includes('sqlite_master')) return { toArray: () => backend.tables.has(table) ? [{ name: table }] : [] };
      const name = /FROM "([^"]+)"/.exec(query)?.[1];
      return { toArray: () => backend.tables.get(name)?.length ? [{ present: 1 }] : [] };
    } },
    transactionSync(action) {
      const snapshot = structuredClone(backend.rows);
      try { return action(); } catch (error) { backend.rows = snapshot; throw error; }
    },
  };
}
class Bucket {
  objects = new Map(); sequence = 0; deletes = []; onPut; onDelete;
  async put(key, json, options) {
    const old = this.objects.get(key);
    if (options?.onlyIf?.etagMatches && old?.etag !== options.onlyIf.etagMatches) return null;
    if (this.onPut) await this.onPut(key, json);
    const object = { key, json, etag: String(++this.sequence) };
    this.objects.set(key, object); return object;
  }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { ...object, json: async () => JSON.parse(object.json) } : null;
  }
  async list({ prefix = '', cursor, startAfter, limit = 1000 }) {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix) && (!(cursor ?? startAfter) || key > (cursor ?? startAfter))).sort();
    const selected = keys.slice(0, limit);
    return { objects: selected.map(key => ({ key })), truncated: keys.length > limit,
      ...(keys.length > limit ? { cursor: selected.at(-1) } : {}) };
  }
  async delete(keys) {
    const values = Array.isArray(keys) ? keys : [keys];
    this.deletes.push(values);
    for (const key of values) this.objects.delete(key);
    if (this.onDelete) await this.onDelete(values);
  }
}
const pause = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function sweep(store, count = 20) { for (let i = 0; i < count; i++) await store.cleanup(); }

test('same-boot live writer is preserved; competing writer and stale cached view fail closed', async () => {
  const disk = storage(), bucket = new Bucket(), first = new ObjectStore(disk, bucket, 'db/');
  await first.set('stable', { kept: true });
  const second = new ObjectStore(disk, bucket, 'db/');
  assert.deepEqual(await second.get('stable'), { kept: true });
  const entered = pause(), release = pause();
  const pending = first.transaction(async () => { await first.set('added', 2); entered.resolve(); await release.promise; });
  await entered.promise;
  await second.cleanup(); // Must not abort first's open journal.
  await assert.rejects(second.set('competing', 3), /memory_writer_busy/);
  assert.ok([...bucket.objects.values()].some(o => o.key.includes('/journals/') && JSON.parse(o.json).state === 'open'));
  release.resolve(); await pending;
  await assert.rejects(second.get('stable'), /memory_view_changed/);
  await sweep(first);
  assert.deepEqual(await first.get('stable'), { kept: true });
  assert.equal(await first.get('added'), 2);
  assert.equal(await first.get('competing'), undefined);
});

test('restart fences a pending put; durable aborted-prefix sweep catches an effect arriving after cleanup', async () => {
  const disk = storage(), bucket = new Bucket(), first = new ObjectStore(disk, bucket, 'db/');
  const entered = pause(), release = pause(); let paused = false;
  bucket.onPut = async key => {
    if (key.includes('/data/') && !paused) { paused = true; entered.resolve(); await release.promise; }
  };
  const pending = first.set('never-published', 1);
  // Install rejection handling immediately; fencing is expected after release.
  const outcome = pending.then(() => null, error => error);
  await entered.promise;
  const restarted = new ObjectStore(storage(disk.backend), bucket, 'db/');
  await sweep(restarted, 3); // First pass sees no data: it must retain a sweep tombstone.
  assert.ok([...bucket.objects.values()].some(o => o.key.includes('/journals/') && JSON.parse(o.json).state === 'aborted'));
  release.resolve();
  assert.match(String(await outcome), /memory_view_changed/);
  assert.ok([...bucket.objects.keys()].some(key => key.includes('/data/')), 'late put really landed');
  await sweep(restarted, 3);
  assert.ok(![...bucket.objects.keys()].some(key => key.includes('/transactions/')));
  assert.equal(await restarted.get('never-published'), undefined);
});

test('CAS conflict after payload write never publishes candidate and its prefix remains reclaimable', async () => {
  const disk = storage(), bucket = new Bucket(), view = new ObjectStore(disk, bucket, 'db/');
  await view.set('winner', 'old-root');
  bucket.onPut = async key => {
    if (key.includes('/data/')) {
      bucket.onPut = undefined;
      const head = disk.kv.get('paged-head'); disk.kv.put('paged-head', { ...head, version: head.version + 1 });
    }
  };
  await assert.rejects(view.set('loser', 3), /memory_view_changed/);
  const winner = new ObjectStore(disk, bucket, 'db/');
  await sweep(winner);
  assert.equal(await winner.get('winner'), 'old-root');
  assert.equal(await winner.get('loser'), undefined);
});

test('paged GC resumes after delete failure/reentry, preserves shared live data and keeps DO head bounded', async () => {
  const disk = storage(), bucket = new Bucket(), store = new ObjectStore(disk, bucket, 'db/');
  await store.set('stable', { retained: 1 });
  await store.transaction(async () => {
    for (let n = 0; n < 90; n++) await store.set(`row/${String(n).padStart(3, '0')}`, n);
    await store.set('row/000', 'updated'); await store.delete('row/001');
  });
  assert.ok(JSON.stringify(disk.kv.get('paged-head')).length < 512);
  for (const object of bucket.objects.values()) if (object.key.includes('/meta/')) {
    assert.ok(JSON.parse(object.json).ids.length <= 32);
  }
  let failed = false;
  bucket.onDelete = async keys => {
    if (!failed && keys.some(key => key.includes('/data/'))) { failed = true; throw Error('crash after delete'); }
  };
  await assert.rejects(sweep(store), /crash after delete/);
  bucket.onDelete = undefined;
  await Promise.all([store.cleanup(), store.cleanup()]);
  await sweep(store, 50);
  assert.deepEqual(await store.get('stable'), { retained: 1 });
  assert.equal(await store.get('row/000'), 'updated');
  assert.equal(await store.get('row/001'), undefined);
  assert.equal((await store.page('row/', undefined, 100)).entries.length, 89);
  assert.ok(![...bucket.objects.keys()].some(key => key.includes('/journals/') || key.includes('/meta/')));
  assert.ok(bucket.deletes.every(keys => keys.length <= 64));
  assert.ok(disk.backend.rows.size <= 3, 'DO stores only fixed-count small pointers');
});

test('nonempty legacy SQLite tables explicitly require migration', () => {
  for (const table of ['memory_state', 'memory_nodes', 'memory_knowledge']) {
    const disk = storage(); disk.backend.tables.set(table, [{}]);
    assert.throws(() => new ObjectStore(disk, new Bucket(), 'db/'), /memory_legacy_sqlite_migration_required/);
  }
});

test('soft cleanup budget advances past the first jobs instead of starving later journals', async () => {
  const disk = storage(), bucket = new Bucket(), store = new ObjectStore(disk, bucket, 'db/');
  for (let n = 0; n < 7; n++) {
    const id = `aborted-${n}`;
    await bucket.put(`db/journals/${id}.json`, JSON.stringify({ id, epoch: 'old-boot', state: 'aborted', garbageHead: null }));
    await bucket.put(`db/transactions/${id}/data/orphan`, '1');
  }
  const realNow = Date.now; let fakeNow = 0;
  Date.now = () => (fakeNow += 600);
  try { await sweep(store, 7); } finally { Date.now = realNow; }
  assert.equal([...bucket.objects.keys()].filter(key => key.includes('/data/')).length, 0);
  assert.equal([...bucket.objects.keys()].filter(key => key.includes('/journals/')).length, 7, 'late-write sweep tombstones remain');
});
