import { extendKnowledge } from './knowledge.js';
import { KnowledgeProjection, type ProjectionOptions } from './knowledge-projection.js';
import type { Claim, KnowledgeInput, KnowledgeModels, KnowledgeView } from './knowledge-types.js';
import type { SourceRef } from './service.js';
import type { Store } from './storage.js';
import { PersistentVectorIndex } from './vector-index.js';

const CANDIDATES = 64;
const component = (value: string) => encodeURIComponent(value);
const sourcePrefix = (id: string) => `source-claim:${component(id)}:`;
// Bounded normalized strings are recall buckets only. Collisions, paraphrases
// and event identity are resolved by the model, never by string equality.
const recallPart = (value: string) => component(Array.from(value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')).slice(0, 64).join(''));
const eventPrefix = (claim: Pick<Claim, 'subject' | 'event' | 'predicate'>) =>
  `event-claim:${recallPart(claim.subject)}:${recallPart(claim.event)}:${recallPart(claim.predicate)}:`;
const refKey = (ref: SourceRef) => JSON.stringify([ref.sourceId, ref.revision, ref.mediaRef]);

/**
 * Persisted claims and reverse relationship edges. add joins the caller's
 * transaction; it must not be invoked without one. It never nests transactions.
 * Comparison covers bounded subject/event/predicate recall buckets plus ANN
 * candidates. Neither a shared root nor these strings establish event identity.
 * A full candidate budget is recorded, never an ingestion size limit. Revoked
 * entries still occupy recall buckets until an external rebuild/GC.
 * Vector namespaces assume one fixed embedding model/version per Store.
 */
export class KnowledgeStore {
  private readonly index: PersistentVectorIndex;
  constructor(private readonly store: Store) {
    this.index = new PersistentVectorIndex(store, 'claim-vector');
  }

  async add(input: KnowledgeInput, models: KnowledgeModels, roots: string[], now: string,
    available: (ref: SourceRef) => Promise<boolean>, evidence: (ref: SourceRef) => Promise<string>): Promise<void> {
    const drafts = await models.extract(input);
    if (!Array.isArray(drafts) || drafts.length > CANDIDATES) throw Error('knowledge_invalid_claim_limit');
    const candidates = new Map<string, Claim>();
    const loaded = new Map<string, Claim | undefined>();
    const availability = new Map<string, boolean>();
    const isAvailable = async (ref: SourceRef) => {
      const key = refKey(ref);
      if (!availability.has(key)) availability.set(key, await available(ref));
      return availability.get(key)!;
    };
    const load = async (id: string) => {
      if (!loaded.has(id)) {
        loaded.set(id, await this.store.get<Claim>(`claim:${id}`));
        if (loaded.size > 256) loaded.delete(loaded.keys().next().value!);
      }
      return loaded.get(id);
    };
    let recallTruncated = false;
    const recallKeys = new Set<string>();
    for (const draft of drafts) {
      if (!draft || typeof draft.subject !== 'string' || typeof draft.event !== 'string' || typeof draft.predicate !== 'string') continue;
      recallKeys.add(eventPrefix(draft));
    }
    const perBucket = Math.max(1, Math.floor(32 / Math.max(1, recallKeys.size)));
    for (const prefix of recallKeys) {
      const page = await this.store.page<string>(prefix, undefined, perBucket);
      recallTruncated ||= page.nextCursor !== undefined;
      for (const { value: id } of page.entries) {
        const claim = await load(id);
        if (!claim) throw Error('knowledge_claim_missing');
        if (await isAvailable(claim.source) && candidates.size < 32) candidates.set(id, claim);
        else if (candidates.size >= 32) recallTruncated = true;
      }
    }
    const indexedCount = candidates.size;
    let exhaustiveSearch = true;
    const embeddings = new Map(input.nodes.map(node => [String(node.payload.node_id), node.embedding]));
    const queriedNodes = new Set<string>();
    const nearest = new Map<string, number>();
    for (const draft of drafts) {
      // Detailed draft/node/quote validation remains in extendKnowledge.
      if (!draft || typeof draft.nodeId !== 'string' || queriedNodes.has(draft.nodeId)) continue;
      const vector = embeddings.get(draft.nodeId);
      if (!vector) continue;
      queriedNodes.add(draft.nodeId);
      const result = await this.index.search(vector, { limit: CANDIDATES, maxLeaves: 64,
        accept: async id => { const claim = await load(id); return !!claim && await isAvailable(claim.source); } });
      exhaustiveSearch &&= result.exhaustive;
      for (const hit of result.hits) {
        nearest.set(hit.id, Math.max(nearest.get(hit.id) ?? -Infinity, hit.score));
        // Bound cross-node aggregation too; highest score is only a recall
        // heuristic and not a knowledge correctness judgment.
        if (nearest.size > CANDIDATES) {
          const worst = [...nearest].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]!;
          nearest.delete(worst[0]);
        }
      }
    }
    for (const [id] of [...nearest].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (candidates.size === CANDIDATES) break;
      const claim = await load(id);
      if (claim) candidates.set(id, claim);
    }
    const texts = new Map<string, string>();
    for (const claim of candidates.values()) {
      const key = refKey(claim.source);
      if (key !== refKey(input.source) && !texts.has(key)) texts.set(key, await evidence(claim.source));
    }
    const beforeIds = new Set(candidates.keys());
    const proposal = await extendKnowledge({ claims: [...candidates.values()], relations: [] }, input,
      { model: models.model, extract: async () => drafts, relate: (pairs, sources) => models.relate(pairs, sources) }, roots, now,
      ref => availability.get(refKey(ref)) ?? true,
      ref => { const text = texts.get(refKey(ref)); if (text === undefined) throw Error('knowledge_evidence_missing'); return text; });
    const freshClaims = proposal.claims.filter(claim => !beforeIds.has(claim.id));
    for (const claim of freshClaims) {
      await this.store.set(`claim:${claim.id}`, claim);
      await this.store.set(`${sourcePrefix(claim.source.sourceId)}${claim.source.revision}:${claim.id}`, claim.id);
      await this.store.set(`${eventPrefix(claim)}${claim.id}`, claim.id);
      await this.index.add(claim.id, embeddings.get(claim.nodeId)!);
    }
    await this.store.set(`active-source-claims:${component(input.source.sourceId)}`, {
      revision: input.source.revision, ids: freshClaims.map(claim => claim.id),
    });
    for (const relation of proposal.relations) {
      await this.store.set(`relation:${relation.id}`, relation);
      await this.store.set(`claim-edge:${relation.left}:${relation.id}`, relation.id);
      await this.store.set(`claim-edge:${relation.right}:${relation.id}`, relation.id);
    }
    await this.store.set(`knowledge-coverage:${component(input.source.sourceId)}:${input.source.revision}`, {
      kind: 'bounded-event-recall-and-nearest-neighbor', exhaustiveGlobalConflicts: false,
      candidateLimit: CANDIDATES, indexedCount, recallTruncated, comparedOldClaims: candidates.size,
      candidateBudgetReached: candidates.size === CANDIDATES,
      queriedNodes: queriedNodes.size, vectorSearchExhaustive: exhaustiveSearch,
    });
  }

  async view(sourceIds: string[] | undefined, revision: number,
    available: (ref: SourceRef) => Promise<boolean>,
    unavailableAt: (ref: SourceRef) => Promise<string | undefined>, options: ProjectionOptions = {}): Promise<KnowledgeView> {
    return new KnowledgeProjection(this.store).view(sourceIds, revision, available, unavailableAt, options);
  }
}
