import { PagedTree } from './paged-store.js';

export interface Page<T> { entries: { key: string; value: T }[]; nextCursor?: string }
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  page<T>(prefix: string, after?: string, limit?: number): Promise<Page<T>>;
  transaction<T>(action: () => Promise<T>): Promise<T>;
  check(): void;
}
interface Head { root: string | null; version: number; committedTx?: string }
interface Writer { id: string; epoch: string }
interface Journal { id: string; epoch: string; state: 'open' | 'committed' | 'aborted'; garbageHead: string | null }
interface GarbagePage { ids: string[]; next: string | null }
interface Runtime { epoch: string; cleaning: boolean }
const runtimes = new WeakMap<DurableObjectStorage, Runtime>();
const JSON_OPTIONS = { httpMetadata: { contentType: 'application/json' } };

/** R2 transaction prefixes are the durable creation journal: the descriptor is
 * written before any payload, so even a put whose result is lost is enumerable.
 * DO metadata consists only of root/version, one writer fence, a runtime fence,
 * and a bounded R2 listing cursor. Garbage IDs live in 32-ID R2 manifest pages.
 *
 * Aborted descriptors deliberately remain as small sweep tombstones. A crashed
 * R2 put can finish after an earlier delete; revisiting the prefix reclaims it.
 * No finite quiet interval proves that an unknown external write has finished.
 * These R2 tombstones require an explicit external retention decision to purge.
 * No DO transaction or input lock spans R2 IO or the caller's model callbacks.
 */
export class ObjectStore implements Store {
  private head: Head;
  private tree: PagedTree;
  private writing: Writer | undefined;
  private readonly runtime: Runtime;
  constructor(private readonly storage: DurableObjectStorage, private readonly bucket: R2Bucket,
    private readonly prefix: string) {
    for (const table of ['memory_state', 'memory_nodes', 'memory_knowledge']) {
      const exists = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).toArray().length;
      if (exists && storage.sql.exec(`SELECT 1 AS present FROM "${table}" LIMIT 1`).toArray().length) {
        throw Error('memory_legacy_sqlite_migration_required');
      }
    }
    const previous = storage.kv.get<Head & { garbage?: string[] }>('paged-head');
    if (previous?.garbage?.length) throw Error('memory_legacy_gc_migration_required');
    let runtime = runtimes.get(storage);
    if (!runtime) {
      runtime = { epoch: crypto.randomUUID(), cleaning: false };
      storage.kv.put('paged-runtime', runtime.epoch);
      runtimes.set(storage, runtime);
    }
    this.runtime = runtime;
    this.head = previous ?? { root: null, version: 0 };
    this.tree = this.open(this.head.root);
  }
  private journalKey(id: string) { return `${this.prefix}journals/${id}.json`; }
  private transactionPrefix(id: string) { return `transactions/${id}/`; }
  private async putJSON(key: string, value: unknown, etag?: string) {
    return this.bucket.put(key, JSON.stringify(value), { ...JSON_OPTIONS,
      ...(etag ? { onlyIf: { etagMatches: etag } } : {}) });
  }
  private async journal(id: string): Promise<{ value: Journal; etag: string } | undefined> {
    const object = await this.bucket.get(this.journalKey(id));
    this.check();
    return object ? { value: await object.json<Journal>(), etag: object.etag } : undefined;
  }
  private open(root: string | null) {
    return new PagedTree({
      read: async id => {
        const object = await this.bucket.get(this.prefix + id);
        this.check();
        if (!object) throw Error('memory_page_missing');
        return object.json();
      },
      write: async value => {
        this.assertWriter();
        // The durable descriptor precedes this put. Do not rely on PagedTree's
        // returned-ID tracker: a successful put can be followed by a fence error.
        const id = `${this.transactionPrefix(this.writing!.id)}data/${crypto.randomUUID()}`;
        await this.putJSON(this.prefix + id, value);
        this.assertWriter();
        return id;
      },
    }, root);
  }
  check() {
    const current = this.storage.kv.get<Head>('paged-head');
    if (this.storage.kv.get<string>('paged-runtime') !== this.runtime.epoch
      || (current?.version ?? 0) !== this.head.version) throw Error('memory_view_changed');
  }
  private assertWriter() {
    this.check();
    const writer = this.storage.kv.get<Writer>('paged-writer');
    if (!this.writing || writer?.id !== this.writing.id || writer.epoch !== this.runtime.epoch) throw Error('memory_writer_changed');
  }
  async get<T>(key: string) { this.check(); const value = await this.tree.get<T>(key); this.check(); return value; }
  async page<T>(prefix: string, after?: string, limit = 64) {
    this.check(); const page = await this.tree.page<T>(prefix, after, limit); this.check(); return page;
  }
  async set(key: string, value: unknown) {
    if (this.writing) { this.assertWriter(); await this.tree.set(key, value); return; }
    await this.transaction(async () => { await this.tree.set(key, value); });
  }
  async delete(key: string) {
    if (this.writing) { this.assertWriter(); await this.tree.delete(key); return; }
    await this.transaction(async () => { await this.tree.delete(key); });
  }
  // A latest commit's durable head receipt must be copied into its R2 journal
  // before a later commit replaces that receipt. ETag CAS tolerates GC reentry.
  private async sealLatestCommit() {
    if (!this.head.committedTx) return;
    const journal = await this.journal(this.head.committedTx);
    if (!journal || journal.value.state === 'committed') return;
    if (journal.value.state === 'aborted') throw Error('memory_journal_state_invalid');
    const saved = await this.putJSON(this.journalKey(journal.value.id), { ...journal.value, state: 'committed' }, journal.etag);
    this.check();
    if (!saved) throw Error('memory_gc_changed');
  }
  async transaction<T>(action: () => Promise<T>): Promise<T> {
    if (this.writing) throw Error('nested_memory_transaction');
    this.check();
    await this.sealLatestCommit();
    const before = this.head;
    const writer: Writer = { id: crypto.randomUUID(), epoch: this.runtime.epoch };
    this.storage.transactionSync(() => {
      this.check();
      const current = this.storage.kv.get<Writer>('paged-writer');
      if (current?.epoch === this.runtime.epoch) throw Error('memory_writer_busy');
      this.storage.kv.put('paged-writer', writer);
    });
    this.writing = writer;
    this.tree = this.open(before.root);
    let committed = false;
    try {
      const initial: Journal = { ...writer, state: 'open', garbageHead: null };
      const descriptor = await this.putJSON(this.journalKey(writer.id), initial);
      this.assertWriter();
      if (!descriptor) throw Error('memory_journal_write_failed');
      const result = await action();
      this.assertWriter();
      let garbageHead: string | null = null;
      const garbage = this.tree.garbageIds;
      for (let offset = 0; offset < garbage.length; offset += 32) {
        const id = `${this.transactionPrefix(writer.id)}meta/${crypto.randomUUID()}`;
        await this.putJSON(this.prefix + id, { ids: garbage.slice(offset, offset + 32), next: garbageHead });
        this.assertWriter(); garbageHead = id;
      }
      const prepared = await this.putJSON(this.journalKey(writer.id), { ...initial, garbageHead }, descriptor.etag);
      this.assertWriter();
      if (!prepared) throw Error('memory_gc_changed');
      const next: Head = { root: this.tree.root, version: before.version + 1, committedTx: writer.id };
      this.storage.transactionSync(() => {
        this.assertWriter();
        this.storage.kv.put('paged-head', next);
        this.storage.kv.delete('paged-writer');
      });
      this.head = next; committed = true;
      return result;
    } finally {
      // A storage failure reporting an ambiguous outcome must never cause
      // deletion of an actually committed candidate's payloads.
      const durable = this.storage.kv.get<Head>('paged-head');
      if (durable?.committedTx === writer.id) { committed = true; this.head = durable; }
      if (!committed) {
        this.storage.transactionSync(() => {
          const current = this.storage.kv.get<Writer>('paged-writer');
          if (current?.id === writer.id) this.storage.kv.delete('paged-writer');
        });
        this.tree = this.open(before.root);
        // The journal is now abandoned. cleanup determines abort from the
        // durable writer/head receipt, including after a process restart.
      }
      this.writing = undefined;
    }
  }

  /** At most four jobs, one 32-ID manifest or 64-object sweep per job, and
   * a 250ms soft budget between jobs. One bounded job always gets a turn even
   * when R2 latency exceeds the budget. No network operation has a wall-time
   * guarantee. Repeated invocation resumes durable round-robin progress.
   * The caller must schedule continued cleanup; one call never claims a drain.
   */
  async cleanup() {
    this.check();
    if (this.runtime.cleaning) return;
    this.runtime.cleaning = true;
    const deadline = Date.now() + 250;
    try {
      const after = this.storage.kv.get<string>('paged-gc-after');
      const jobs = await this.bucket.list({ prefix: `${this.prefix}journals/`, limit: 4, ...(after ? { startAfter: after } : {}) });
      this.check();
      let processed = 0;
      for (const object of jobs.objects) {
        if (processed && Date.now() >= deadline) break;
        await this.cleanJob(object.key);
        this.check();
        this.storage.kv.put('paged-gc-after', object.key);
        processed++;
      }
      this.check();
      if (processed === jobs.objects.length && !jobs.truncated) this.storage.kv.delete('paged-gc-after');
    } finally { this.runtime.cleaning = false; }
  }
  private async cleanJob(key: string) {
    const object = await this.bucket.get(key); this.check();
    if (!object) return;
    const journal = await object.json<Journal>();
    const writer = this.storage.kv.get<Writer>('paged-writer');
    const head = this.storage.kv.get<Head>('paged-head');
    let state = journal.state;
    if (head?.committedTx === journal.id) state = 'committed';
    else if (state === 'open') {
      if (writer?.id === journal.id && writer.epoch === this.runtime.epoch) return;
      state = 'aborted';
    }
    if (state !== journal.state) {
      const updated = await this.putJSON(key, { ...journal, state }, object.etag); this.check();
      if (!updated) return;
      // Persist classification before deletion, then continue on a later call.
      return;
    }
    if (state === 'aborted') {
      const listed = await this.bucket.list({ prefix: this.prefix + this.transactionPrefix(journal.id), limit: 64 });
      this.check();
      if (listed.objects.length) await this.bucket.delete(listed.objects.map(item => item.key));
      this.check();
      return; // Keep the tombstone to discover a late, previously unknown put.
    }
    if (journal.garbageHead) {
      const manifest = await this.bucket.get(this.prefix + journal.garbageHead); this.check();
      if (!manifest) throw Error('memory_gc_manifest_missing');
      const page = await manifest.json<GarbagePage>();
      if (!Array.isArray(page.ids) || page.ids.length > 32 || page.ids.some(id => typeof id !== 'string')) throw Error('memory_gc_manifest_invalid');
      await this.bucket.delete(page.ids.map(id => this.prefix + id)); this.check();
      // The old manifest stays until metadata sweeping. Repeating a deletion
      // after a crash is safe, and stale CAS updates cannot regress the cursor.
      await this.putJSON(key, { ...journal, garbageHead: page.next }, object.etag); this.check();
      return;
    }
    const metadata = await this.bucket.list({ prefix: `${this.prefix}${this.transactionPrefix(journal.id)}meta/`, limit: 64 });
    this.check();
    if (metadata.objects.length) { await this.bucket.delete(metadata.objects.map(item => item.key)); this.check(); return; }
    await this.bucket.delete(key); this.check();
  }
}

/** Test/dev adapter uses the same asynchronous transaction and keyset-page contract. */
export class MemoryStore implements Store {
  rows = new Map<string, unknown>();
  check() {}
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.rows.get(key)) as T | undefined; }
  async set(key: string, value: unknown) { this.rows.set(key, structuredClone(value)); }
  async delete(key: string) { this.rows.delete(key); }
  async page<T>(prefix: string, after?: string, limit = 64): Promise<Page<T>> {
    const keys = [...this.rows.keys()].filter(key => key.startsWith(prefix) && (after === undefined || key > after)).sort().slice(0, limit + 1);
    const selected = keys.slice(0, limit);
    return { entries: selected.map(key => ({ key, value: structuredClone(this.rows.get(key)) as T })),
      ...(keys.length > limit ? { nextCursor: selected.at(-1)! } : {}) };
  }
  async transaction<T>(action: () => Promise<T>) {
    const before = structuredClone(this.rows);
    try { return await action(); } catch (error) { this.rows = before; throw error; }
  }
}
