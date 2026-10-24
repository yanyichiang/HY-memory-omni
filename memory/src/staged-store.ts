import type { Page, Store } from './storage.js';

/** One formation batch. Provider calls mutate this bounded working set only;
 * the persistent writer is acquired afterwards, for publication. */
export class StagedStore implements Store {
  private readonly changes = new Map<string, unknown | undefined>();
  constructor(private readonly base: Store) {}
  check() { this.base.check(); }
  async get<T>(key: string): Promise<T | undefined> {
    this.check();
    return this.changes.has(key) ? structuredClone(this.changes.get(key)) as T | undefined : this.base.get<T>(key);
  }
  async set(key: string, value: unknown) { this.check(); this.changes.set(key, structuredClone(value)); }
  async delete(key: string) { this.check(); this.changes.set(key, undefined); }
  async page<T>(prefix: string, after?: string, limit = 64): Promise<Page<T>> {
    const values = new Map<string, T>();
    let cursor = after;
    do {
      const page = await this.base.page<T>(prefix, cursor, limit + 1);
      for (const entry of page.entries) if (!this.changes.has(entry.key)) values.set(entry.key, entry.value);
      cursor = page.nextCursor;
    } while (cursor !== undefined && values.size <= limit);
    for (const [key, value] of this.changes) if (key.startsWith(prefix) && (after === undefined || key > after) && value !== undefined) values.set(key, value as T);
    const sorted = [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), selected = sorted.slice(0, limit);
    return { entries: selected.map(([key, value]) => ({ key, value })),
      ...(sorted.length > limit || cursor !== undefined ? { nextCursor: selected.at(-1)![0] } : {}) };
  }
  async transaction<T>(action: () => Promise<T>): Promise<T> { return action(); }
  async publish() {
    this.check();
    for (const [key, value] of this.changes) {
      if (value === undefined) await this.base.delete(key); else await this.base.set(key, value);
    }
  }
}
