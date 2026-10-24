/** Immutable object storage. write must allocate a fresh, durable object ID. */
export interface BlobPages {
  read(id: string): Promise<unknown | undefined>;
  write(value: unknown): Promise<string>;
}

type Ref = { key: string; id: string };
type Node = { kind: 'leaf' | 'branch'; items: Ref[] };
const FANOUT = 32;
const CACHE_PAGES = 128;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 4096;

/**
 * Copy-on-write B+ tree. The caller publishes root atomically and serializes
 * writers. Failed writes leave unreachable objects, never a partially new root.
 * After any mutation failure, discard this instance and reclaim createdIds;
 * do not publish earlier mutations from the failed candidate transaction.
 * Values are JSON blobs, separate from index pages; no database-wide snapshot
 * is materialized. Old roots remain readable until their objects are collected.
 */
export class PagedTree {
  private currentRoot: string | null;
  private readonly cache = new Map<string, Node>();
  private readonly created = new Set<string>();
  private readonly garbage = new Set<string>();

  constructor(private readonly pages: BlobPages, root: string | null = null) {
    this.currentRoot = root;
  }

  get root(): string | null { return this.currentRoot; }

  /** Successful writes, including objects produced before an operation failed. */
  get createdIds(): readonly string[] { return [...this.created]; }

  /**
   * Objects superseded by successful mutations in this instance. Only reclaim
   * after publishing root and invalidating every reader of superseded roots.
   */
  get garbageIds(): readonly string[] { return [...this.garbage]; }

  private async write(value: unknown): Promise<string> {
    const id = await this.pages.write(value);
    this.created.add(id);
    return id;
  }

  private remember(id: string, node: Node): Node {
    this.cache.delete(id);
    this.cache.set(id, node);
    if (this.cache.size > CACHE_PAGES) this.cache.delete(this.cache.keys().next().value!);
    return node;
  }

  private async node(id: string): Promise<Node> {
    const cached = this.cache.get(id);
    if (cached) return this.remember(id, cached);
    const raw = await this.pages.read(id);
    if (!raw || typeof raw !== 'object') throw new Error(`Missing tree page: ${id}`);
    const value = raw as Node;
    if ((value.kind !== 'leaf' && value.kind !== 'branch') || !Array.isArray(value.items)
      || !value.items.length || value.items.length > FANOUT
      || value.items.some((item, i) => !item || typeof item.key !== 'string'
        || typeof item.id !== 'string' || (i > 0 && value.items[i - 1]!.key >= item.key))) {
      throw new Error(`Invalid tree page: ${id}`);
    }
    return this.remember(id, value);
  }

  private async save(kind: Node['kind'], items: Ref[]): Promise<Ref[]> {
    if (!items.length) return [];
    const chunks = items.length <= FANOUT ? [items] : [items.slice(0, items.length >> 1), items.slice(items.length >> 1)];
    const refs: Ref[] = [];
    for (const chunk of chunks) {
      const node: Node = { kind, items: chunk };
      const id = await this.write(node);
      this.remember(id, node);
      refs.push({ key: chunk[0]!.key, id });
    }
    return refs;
  }

  // Last child whose minimum key is <= the lookup key (or first child).
  private child(items: Ref[], key: string): number {
    let low = 0, high = items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (items[mid]!.key <= key) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  }

  async get<T>(key: string): Promise<T | undefined> {
    let id = this.currentRoot;
    while (id) {
      const node = await this.node(id);
      const item = node.items[this.child(node.items, key)]!;
      if (node.kind === 'branch') id = item.id;
      else {
        if (item.key !== key) return undefined;
        const value = await this.pages.read(item.id);
        if (value === undefined) throw new Error(`Missing value blob: ${item.id}`);
        return value as T;
      }
    }
    return undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) throw new RangeError('Tree key exceeds 4096 UTF-8 bytes');
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Tree values must be JSON serializable');
    if (new TextEncoder().encode(json).length > MAX_VALUE_BYTES) throw new RangeError('Tree value exceeds 1 MiB');
    // Parse once to detach caller-owned objects and preserve the JSON contract.
    const id = await this.write(JSON.parse(json));
    const garbage = new Set<string>();
    const refs = this.currentRoot
      ? await this.change(this.currentRoot, key, garbage, id)
      : await this.save('leaf', [{ key, id }]);
    this.currentRoot = refs.length === 1 ? refs[0]!.id : (await this.save('branch', refs))[0]!.id;
    for (const oldId of garbage) this.garbage.add(oldId);
  }

  private async change(id: string, key: string, garbage: Set<string>, valueId?: string): Promise<Ref[]> {
    const node = await this.node(id);
    const items = node.items.slice();
    const index = this.child(items, key);
    if (node.kind === 'branch') {
      const replacement = await this.change(items[index]!.id, key, garbage, valueId);
      if (replacement.length === 1 && replacement[0]!.id === items[index]!.id) return [{ key: items[0]!.key, id }];
      items.splice(index, 1, ...replacement);
    } else {
      const found = items[index]!.key === key;
      if (valueId === undefined) {
        if (!found) return [{ key: items[0]!.key, id }];
        garbage.add(items[index]!.id);
        items.splice(index, 1);
      } else if (found) {
        garbage.add(items[index]!.id);
        items[index] = { key, id: valueId };
      }
      else items.splice(items[index]!.key < key ? index + 1 : index, 0, { key, id: valueId });
    }
    // Underfull pages are valid: removal never rewrites unrelated subtrees.
    garbage.add(id);
    return this.save(node.kind, items);
  }

  async delete(key: string): Promise<void> {
    if (!this.currentRoot) return;
    const garbage = new Set<string>();
    const refs = await this.change(this.currentRoot, key, garbage);
    let root = refs[0]?.id ?? null;
    while (root) {
      const node = await this.node(root);
      if (node.kind !== 'branch' || node.items.length !== 1) break;
      garbage.add(root);
      root = node.items[0]!.id;
    }
    this.currentRoot = root;
    for (const oldId of garbage) this.garbage.add(oldId);
  }

  /** Cursor is an exclusive key within this root snapshot, ordered by JS UTF-16. */
  async page<T>(prefix: string, after: string | undefined, limit: number): Promise<{ entries: { key: string; value: T }[]; nextCursor?: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Page limit must be between 1 and 1000');
    const refs: Ref[] = [];
    const lower = after !== undefined && after > prefix ? after : prefix;
    const visit = async (id: string): Promise<void> => {
      const node = await this.node(id);
      if (node.kind === 'leaf') {
        for (const item of node.items) {
          if (item.key < prefix || (after !== undefined && item.key <= after)) continue;
          if (!item.key.startsWith(prefix)) break;
          refs.push(item);
          if (refs.length > limit) break;
        }
      } else {
        for (let i = this.child(node.items, lower); i < node.items.length; i++) {
          const item = node.items[i]!;
          if (item.key > prefix && !item.key.startsWith(prefix)) break;
          await visit(item.id);
          if (refs.length > limit) break;
        }
      }
    };
    // Capture one root for the entire traversal; pagination across mutations is
    // intentionally the caller's snapshot responsibility.
    const root = this.currentRoot;
    if (root) await visit(root);
    const more = refs.length > limit;
    const entries: { key: string; value: T }[] = [];
    for (const ref of refs.slice(0, limit)) {
      const value = await this.pages.read(ref.id);
      if (value === undefined) throw new Error(`Missing value blob: ${ref.id}`);
      entries.push({ key: ref.key, value: value as T });
    }
    return { entries, ...(more ? { nextCursor: entries[entries.length - 1]!.key } : {}) };
  }
}
