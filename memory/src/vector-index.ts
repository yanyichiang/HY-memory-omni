/** Persistent bounded-leaf k-d partition index over unit vectors.
 * This is a budgeted approximate search, not an ANN quality guarantee. High
 * dimensions can exhaust the leaf budget. accept excludes revoked records but
 * stale records still occupy routing pages until an external rebuild/GC.
 * The caller serializes adds and atomically publishes the root with its data.
 * Use a distinct prefix for every embedding model/version and dimension space.
 */
export interface VectorIndexStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
type Entry = { id: string; vector: number[] };
type Bounds = { min: number[]; max: number[] };
type Page = Bounds & ({ entries: Entry[] } | { left: string; right: string; axis: number; pivot: number; pivotId?: string; hashIds?: boolean });
type Root = { page: string; dimensions: number };
export type VectorSearchOptions = { limit: number; maxLeaves?: number; maxNodes?: number; accept?: (id: string) => Promise<boolean> };
const LEAF_SIZE = 32;
function idHash(id: string): number {
  let hash = 2166136261;
  for (let i=0;i<id.length;i++) hash=Math.imul(hash ^ id.charCodeAt(i),16777619);
  return hash >>> 0;
}
function unit(input: number[]): number[] {
  if (!Array.isArray(input) || !input.length || input.some(x => !Number.isFinite(x))) throw new Error('VECTOR_INVALID');
  const scale = Math.max(...input.map(Math.abs));
  if (!scale) throw new Error('VECTOR_ZERO');
  const norm = Math.sqrt(input.reduce((sum, x) => sum + (x / scale) ** 2, 0));
  return input.map(x => x / scale / norm);
}
function bounds(entries: Entry[]): Bounds {
  const min = [...entries[0]!.vector], max = [...min];
  for (const { vector } of entries) for (let d = 0; d < min.length; d++) {
    min[d] = Math.min(min[d]!, vector[d]!); max[d] = Math.max(max[d]!, vector[d]!);
  }
  return { min, max };
}
function distance(query: number[], page: Bounds): number {
  return query.reduce((sum, x, d) => sum + Math.max(page.min[d]! - x, 0, x - page.max[d]!) ** 2, 0);
}
function order(a: { id: string; score: number }, b: { id: string; score: number }): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export class PersistentVectorIndex {
  constructor(private readonly store: VectorIndexStore, private readonly prefix: string) {
    if (!prefix) throw new Error('INDEX_NAMESPACE_REQUIRED');
  }
  private key(suffix: string): string { return `${this.prefix}/vector-index/${suffix}`; }
  private async page(key: string): Promise<Page> {
    const page = await this.store.get<Page>(key);
    if (!page) throw new Error('VECTOR_INDEX_PAGE_MISSING');
    return page;
  }
  private async save(page: Page, existingKey?: string): Promise<string> {
    // Stable logical page IDs: outer KV COW retains historical read views.
    const key = existingKey ?? this.key(`pages/${crypto.randomUUID()}`);
    await this.store.set(key, page); return key;
  }
  async add(id: string, input: number[]): Promise<void> {
    if (!id) throw new Error('VECTOR_ID_REQUIRED');
    const vector = unit(input), root = await this.store.get<Root>(this.key('root'));
    if (root && root.dimensions !== vector.length) throw new Error('VECTOR_DIMENSION_MISMATCH');
    const identity = this.key(`ids/${encodeURIComponent(id)}`);
    const previous = await this.store.get<number[]>(identity);
    if (previous) {
      if (previous.length !== vector.length || previous.some((x, i) => x !== vector[i])) throw new Error('VECTOR_ID_IMMUTABLE');
      return;
    }
    const entry = { id, vector };
    const page = root ? await this.insert(root.page, entry) : await this.save({ ...bounds([entry]), entries: [entry] });
    // These publications must share the caller's transaction/CAS protection.
    await this.store.set(identity, vector);
    await this.store.set(this.key('root'), { page, dimensions: vector.length });
  }
  private async insert(key: string, entry: Entry): Promise<string> {
    const page = await this.page(key);
    if ('entries' in page) {
      const entries = [...page.entries, entry];
      if (entries.length <= LEAF_SIZE) return this.save({ ...bounds(entries), entries }, key);
      const mean = entry.vector.map((_, d) => entries.reduce((s, e) => s + e.vector[d]!, 0) / entries.length);
      const variance = mean.map((m, d) => entries.reduce((s, e) => s + (e.vector[d]! - m) ** 2, 0));
      const axis = variance.indexOf(Math.max(...variance));
      const same = entries.every(e => e.vector.every((v,d) => v === entries[0]!.vector[d]));
      entries.sort((a, b) => (same ? idHash(a.id)-idHash(b.id) : a.vector[axis]! - b.vector[axis]!) || (a.id < b.id ? -1 : 1));
      const mid = Math.floor(entries.length / 2), pivot = entries[mid]!;
      const left = entries.slice(0, mid), right = entries.slice(mid);
      return this.save({ ...bounds(entries), axis, pivot: same ? idHash(pivot.id) : pivot.vector[axis]!, pivotId: pivot.id, hashIds: same,
        left: await this.save({ ...bounds(left), entries: left }), right: await this.save({ ...bounds(right), entries: right }) }, key);
    }
    const coordinate = page.hashIds ? idHash(entry.id) : entry.vector[page.axis]!;
    const goesLeft = coordinate < page.pivot ||
      (coordinate === page.pivot && entry.id < (page.pivotId ?? ''));
    const next = { ...page, min: page.min.map((x, d) => Math.min(x, entry.vector[d]!)), max: page.max.map((x, d) => Math.max(x, entry.vector[d]!)) };
    if (goesLeft) next.left = await this.insert(page.left, entry);
    else next.right = await this.insert(page.right, entry);
    return this.save(next, key);
  }
  async search(input: number[], { limit, maxLeaves = 64, maxNodes = maxLeaves * 8 + 64, accept }: VectorSearchOptions): Promise<{ hits: { id: string; score: number }[]; exhaustive: boolean; visitedLeaves: number; visitedNodes: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxLeaves) || maxLeaves < 1 || !Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new Error('VECTOR_SEARCH_LIMIT_INVALID');
    const query = unit(input), root = await this.store.get<Root>(this.key('root'));
    if (!root) return { hits: [], exhaustive: true, visitedLeaves: 0, visitedNodes: 0 };
    if (query.length !== root.dimensions) throw new Error('VECTOR_DIMENSION_MISMATCH');
    const first = await this.page(root.page);
    const queue = [{ key: root.page, page: first, lower: distance(query, first), depth: 0 }];
    const hits: { id: string; score: number }[] = [];
    let visitedLeaves = 0, visitedNodes = 0;
    while (queue.length && visitedNodes < maxNodes) {
      visitedNodes++;
      queue.sort((a, b) => a.lower - b.lower || b.depth - a.depth || (a.key < b.key ? -1 : 1));
      const candidate = queue.shift()!;
      // A conservative epsilon avoids pruning mathematically tied unit vectors.
      if (hits.length === limit && candidate.lower > 2 - 2 * hits[hits.length - 1]!.score + 1e-12) continue;
      if ('entries' in candidate.page) {
        if (visitedLeaves === maxLeaves) { queue.push(candidate); break; }
        visitedLeaves++;
        for (const entry of candidate.page.entries) {
          if (accept && !await accept(entry.id)) continue;
          const score = Math.max(-1, Math.min(1, query.reduce((s, x, d) => s + x * entry.vector[d]!, 0)));
          hits.push({ id: entry.id, score }); hits.sort(order);
          if (hits.length > limit) hits.pop();
        }
      } else {
        for (const key of [candidate.page.left, candidate.page.right]) {
          const page = await this.page(key); queue.push({ key, page, lower: distance(query, page), depth: candidate.depth + 1 });
        }
      }
    }
    return { hits, exhaustive: queue.length === 0, visitedLeaves, visitedNodes };
  }
}
