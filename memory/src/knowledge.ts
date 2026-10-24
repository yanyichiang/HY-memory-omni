import type { SourceRef } from './service.js';
import type { Claim, ClaimDraft, Knowledge, KnowledgeInput, KnowledgeModels, KnowledgeView, Relation, RelationDraft, RelationKind, ClaimStatus } from './knowledge-types.js';

export function isKnowledgeInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  if (Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) return false;
  if (!value.endsWith('Z') && (Number(value.slice(-5,-3)) > 23 || Number(value.slice(-2)) > 59)) return false;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  const date = value.slice(0, 10);
  return new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
}
const MAX_EXTRACT_CLAIMS = 64;
const kinds = new Set<RelationKind>(['same', 'conflict', 'revision', 'different', 'uncertain']);
const draftFields = ['key', 'nodeId', 'text', 'subject', 'event', 'predicate', 'value', 'validTime', 'conditions', 'quote'] as const;
function invalid(detail: string): never { throw Error(`knowledge_invalid_${detail}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('object');
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > 8000 || (!allowEmpty && !value.trim())) invalid(field);
  return value;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('fields');
}
function refKey(ref: SourceRef): string { return JSON.stringify([ref.sourceId, ref.revision, ref.mediaRef]); }
function validateSource(ref: SourceRef): void {
  string(ref.sourceId, 'source'); string(ref.mediaRef, 'media_ref');
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) invalid('source_revision');
}

/** Stored evidence is append-only here; the caller's Memory transaction alone publishes this proposal. */
export async function extendKnowledge(before: Knowledge, input: KnowledgeInput, models: KnowledgeModels,
  roots: string[], now: string, isAvailable: (ref: SourceRef) => boolean = () => true,
  evidenceFor?: (ref: SourceRef) => string): Promise<Knowledge> {
  validateSource(input.source); string(now, 'observed_at'); string(models.model, 'model');
  if (!['owner', 'observation'].includes(input.authority)) invalid('authority');
  if (new Set(before.claims.map(claim => claim.id)).size !== before.claims.length) invalid('claims');
  if (!roots.length) invalid('roots');
  const sourceRoots = [...new Set(roots.map(root => string(root, 'root')))];
  const nodes = new Set(input.nodes.filter(node => node.payload.layer === 'l2_fact').map(node => node.payload.node_id));
  const drafts: unknown = await models.extract(input);
  if (!Array.isArray(drafts) || drafts.length > MAX_EXTRACT_CLAIMS) invalid('claim_limit');
  const keys = new Set<string>();
  const claims: Claim[] = drafts.map(value => {
    const draft = record(value); fields(draft, draftFields);
    const parsed = Object.fromEntries(draftFields.map(field => [field,
      string(draft[field], field, field === 'validTime' || field === 'conditions')])) as unknown as ClaimDraft;
    if (keys.has(parsed.key)) invalid('duplicate_key');
    keys.add(parsed.key);
    if (!nodes.has(parsed.nodeId)) invalid('node_id');
    if (!input.perception.text.includes(parsed.quote)) invalid('quote');
    return { ...parsed, id: crypto.randomUUID(), source: { ...input.source }, roots: [...sourceRoots], observedAt: now, authority: input.authority };
  });
  // Re-extraction may leave historical versions in before; they must never become current comparison material.
  const old = before.claims.filter(claim => isAvailable(claim.source));
  const relations: Relation[] = [];
  let batch: { left: Claim; right: Claim }[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const sources = [...new Map(batch.flatMap(pair => [pair.left.source, pair.right.source]).map(ref => [refKey(ref), ref])).values()];
    const evidence = evidenceFor ? sources.map(source => ({ source, text: refKey(source) === refKey(input.source) ? input.perception.text : evidenceFor(source) })) : undefined;
    const result: unknown = await models.relate(batch, evidence);
    if (!Array.isArray(result) || result.length !== batch.length) invalid('relation_count');
    const pending = new Map(batch.map(pair => [JSON.stringify([pair.left.id, pair.right.id]), pair]));
    for (const value of result) {
      const draft = record(value);
      fields(draft, ['left', 'right', 'kind', 'reason', 'leftQuote', 'rightQuote', 'revisionKind', 'effectiveTime', 'superseded', 'effectiveAt']);
      const left = string(draft.left, 'left'), right = string(draft.right, 'right');
      const pairKey = JSON.stringify([left, right]);
      const pair = pending.get(pairKey);
      if (!pair) invalid('relation_pair');
      pending.delete(pairKey);
      if (draft.leftQuote !== pair.left.quote || draft.rightQuote !== pair.right.quote) invalid('relation_quote');
      if (!kinds.has(draft.kind as RelationKind)) invalid('relation_kind');
      const relation: RelationDraft = { left, right, kind: draft.kind as RelationKind,
        reason: string(draft.reason, 'reason'), leftQuote: pair.left.quote, rightQuote: pair.right.quote };
      if (draft.revisionKind !== undefined) {
        if (draft.revisionKind !== 'correction' && draft.revisionKind !== 'world-change') invalid('revision_kind');
        relation.revisionKind = draft.revisionKind;
      }
      if (draft.effectiveTime !== undefined) relation.effectiveTime = string(draft.effectiveTime, 'effective_time');
      if (draft.superseded !== undefined) {
        if (draft.superseded !== 'left' && draft.superseded !== 'right') invalid('superseded');
        relation.superseded = draft.superseded;
      }
      if (draft.effectiveAt !== undefined) {
        if (draft.effectiveAt !== null && !isKnowledgeInstant(draft.effectiveAt)) invalid('effective_at');
        relation.effectiveAt = draft.effectiveAt as string | null;
      }
      if (relation.kind !== 'revision' && (draft.superseded !== undefined || draft.effectiveAt !== undefined || draft.revisionKind !== undefined || draft.effectiveTime !== undefined)) invalid('revision_fields');
      if (relation.kind === 'revision' && !relation.superseded) invalid('superseded');
      if (relation.kind === 'revision' && relation.revisionKind === 'world-change' && draft.effectiveAt === undefined) invalid('effective_at');
      if (relation.kind === 'revision' && (!relation.revisionKind
        || (relation.revisionKind === 'world-change' && !relation.effectiveTime))) {
        relation.kind = 'conflict';
        delete relation.revisionKind; delete relation.superseded; delete relation.effectiveTime; delete relation.effectiveAt;
        relation.reason += ' [Revision evidence incomplete: correction/world-change classification and an effective time for world-change are required.]';
      }
      // Natural-language event identity and revision evidence remain model judgments. Authority is provenance,
      // never a truth switch; media can establish a change when its exact quoted evidence supports it.
      if (relation.kind !== 'different') relations.push({ ...relation, id: crypto.randomUUID(), assessedAt: now, model: models.model });
    }
    if (pending.size) invalid('relation_missing');
    batch = [];
  };
  const add = async (left: Claim, right: Claim) => {
    batch.push({ left, right });
    if (batch.length === 16) await flush();
  };
  for (let index = 0; index < claims.length; index++) {
    const right = claims[index]!;
    for (const left of old) await add(left, right);
    for (let previous = 0; previous < index; previous++) await add(claims[previous]!, right);
  }
  await flush();
  return { claims: [...before.claims, ...claims], relations: [...before.relations, ...relations] };
}

/** Available evidence supports claims; no status is a verification of objective truth or a majority vote. */
export function projectKnowledge(knowledge: Knowledge, revision: number, isAvailable: (ref: SourceRef) => boolean,
  seedSourceIds?: string[], clock: string | (() => string) = () => new Date().toISOString(),
  unavailableAt?: (ref: SourceRef) => string | undefined): KnowledgeView {
  const now = typeof clock === 'function' ? clock() : clock;
  if (!isKnowledgeInstant(now)) invalid('projection_now');
  const temporal = (r: Relation): 'effective' | 'scheduled' | 'unresolved' => !r.superseded ? 'unresolved' : r.revisionKind !== 'world-change' ? 'effective'
    : !r.effectiveAt ? 'unresolved' : Date.parse(r.effectiveAt) > Date.parse(now) ? 'scheduled' : 'effective';
  const endpoints = (r: Relation) => r.superseded === 'right' ? [r.right, r.left] as const : [r.left, r.right] as const;
  const all = new Map(knowledge.claims.map(claim => [claim.id, claim]));
  const availability = new Map<string, boolean>();
  const available = (ref: SourceRef) => {
    const key = refKey(ref);
    if (!availability.has(key)) availability.set(key, isAvailable(ref));
    return availability.get(key)!;
  };
  const live = knowledge.claims.filter(claim => available(claim.source));
  const liveIds = new Set(live.map(claim => claim.id));
  const parent = new Map(live.map(claim => [claim.id, claim.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (id !== root) { const next = parent.get(id)!; parent.set(id, root); id = next; }
    return root;
  };
  const liveRelations = knowledge.relations.filter(relation => liveIds.has(relation.left) && liveIds.has(relation.right));
  for (const relation of liveRelations) if (relation.kind === 'same') parent.set(find(relation.left), find(relation.right));
  const components = new Set(live.map(claim => find(claim.id)));
  const disputed = new Set<string>(), uncertain = new Set<string>(), withdrawnRevision = new Set<string>();
  const scheduled = new Set<string>();
  const outgoing = new Map<string, Set<string>>([...components].map(id => [id, new Set<string>()]));
  for (const relation of liveRelations) {
    if (relation.kind === 'revision') {
      const [oldId, newId] = endpoints(relation), old = find(oldId), fresh = find(newId);
      const state = temporal(relation);
      if (state === 'effective') outgoing.get(old)!.add(fresh);
      else if (state === 'scheduled') scheduled.add(fresh);
      else { uncertain.add(old); uncertain.add(fresh); }
    }
  }
  // A correction can inherit its only temporal condition from another proposition.
  // Keep that dependency even after the intermediate evidence is withdrawn, without exposing it.
  const temporallyDerived = new Set(knowledge.relations.filter(relation => relation.kind === 'revision' && relation.revisionKind === 'world-change').map(relation => endpoints(relation)[1]));
  let dependencyChanged = true;
  while (dependencyChanged) {
    dependencyChanged = false;
    for (const relation of knowledge.relations) {
      const directions = relation.kind === 'same' ? [[relation.left, relation.right], [relation.right, relation.left]]
        : relation.kind === 'revision' && relation.revisionKind === 'correction' ? [endpoints(relation)] : [];
      for (const [old, fresh] of directions) if (temporallyDerived.has(old!) && !temporallyDerived.has(fresh!)) {
        temporallyDerived.add(fresh!); dependencyChanged = true;
      }
    }
  }
  // An independently available change can still establish the condition after another source is withdrawn.
  const anchored = new Set(liveRelations.filter(r => r.kind === 'revision' && r.revisionKind === 'world-change')
    .map(r => find(endpoints(r)[1])));
  dependencyChanged = true;
  while (dependencyChanged) {
    dependencyChanged = false;
    for (const relation of liveRelations) if (relation.kind === 'revision' && relation.revisionKind === 'correction') {
      const [old, fresh] = endpoints(relation);
      if (anchored.has(find(old)) && !anchored.has(find(fresh))) { anchored.add(find(fresh)); dependencyChanged = true; }
    }
  }
  const lostTemporal = new Set<string>();
  for (const relation of knowledge.relations) {
    const directions = relation.kind === 'same' ? [[relation.left, relation.right], [relation.right, relation.left]]
      : relation.kind === 'revision' && relation.revisionKind === 'correction' ? [endpoints(relation)] : [];
    for (const [old, fresh] of directions) if (temporallyDerived.has(old!) && !liveIds.has(old!) && liveIds.has(fresh!)
      && !anchored.has(find(fresh!))) lostTemporal.add(find(fresh!));
  }
  // Correcting a future plan does not remove the plan's effective-time condition.
  // Equivalent claims are already in one component; propagate through explicit corrections only.
  let inherited = true;
  while (inherited) {
    inherited = false;
    for (const relation of liveRelations) if (relation.kind === 'revision' && relation.revisionKind === 'correction') {
      const [oldId, newId] = endpoints(relation), old = find(oldId), fresh = find(newId);
      if (scheduled.has(old) && !scheduled.has(fresh)) { scheduled.add(fresh); inherited = true; }
      if (uncertain.has(old) && !uncertain.has(fresh)) { uncertain.add(fresh); inherited = true; }
      if (lostTemporal.has(old) && !anchored.has(fresh) && !lostTemporal.has(fresh)) { lostTemporal.add(fresh); inherited = true; }
    }
  }
  for (const id of lostTemporal) uncertain.add(id);
  // Do not revive a once-revised proposition just because its correction was later withdrawn.
  // The unavailable endpoint's text, quote, reason, and identity never enter the public view.
  for (const relation of knowledge.relations) if (relation.kind === 'revision' && temporal(relation) !== 'scheduled') {
    const [old, fresh] = endpoints(relation);
    if (liveIds.has(old) && all.has(fresh) && !liveIds.has(fresh)) {
      const invalidatedAt = unavailableAt?.(all.get(fresh)!.source);
      if (invalidatedAt !== undefined && !isKnowledgeInstant(invalidatedAt)) invalid('invalidated_at');
      // Only evidenced withdrawal before activation cancels a scheduled change. Missing history stays conservative.
      if (relation.revisionKind === 'world-change' && relation.effectiveAt && invalidatedAt
        && Date.parse(invalidatedAt) < Date.parse(relation.effectiveAt)) continue;
      withdrawnRevision.add(find(old));
    }
  }

  // A directed revision cycle has no grounded winner. Mark its entire same-equivalence components disputed.
  const colors = new Map<string, number>(), stack: string[] = [], positions = new Map<string, number>();
  const visit = (id: string): void => {
    colors.set(id, 1); positions.set(id, stack.length); stack.push(id);
    for (const next of outgoing.get(id)!) {
      if (!colors.has(next)) visit(next);
      else if (colors.get(next) === 1) for (let index = positions.get(next)!; index < stack.length; index++) disputed.add(stack[index]!);
    }
    stack.pop(); positions.delete(id); colors.set(id, 2);
  };
  for (const id of components) if (!colors.has(id)) visit(id);
  const statuses = new Map<string, ClaimStatus>(), terminals = new Map<string, Set<string>>();
  const resolve = (id: string): ClaimStatus => {
    const cached = statuses.get(id); if (cached) return cached;
    if (disputed.has(id)) { statuses.set(id, 'disputed'); return 'disputed'; }
    if (uncertain.has(id) || (withdrawnRevision.has(id) && !outgoing.get(id)!.size)) { statuses.set(id, 'unresolved'); return 'unresolved'; }
    const next = outgoing.get(id)!;
    if (!next.size) { const state = scheduled.has(id) ? 'scheduled' : 'supported'; statuses.set(id, state); terminals.set(id, new Set([id])); return state; }
    const ends = new Set<string>();
    let unresolved = false;
    for (const target of next) {
      const state = resolve(target);
      if (state !== 'supported' && state !== 'superseded') unresolved = true;
      for (const terminal of terminals.get(target) ?? []) ends.add(terminal);
    }
    const state = unresolved || ends.size !== 1 ? 'unresolved' : 'superseded';
    statuses.set(id, state); terminals.set(id, ends); return state;
  };
  for (const id of components) resolve(id);
  // A supported correction can settle an older conflict; conversely a disputed correction cannot
  // suppress that conflict. Conflict flags only accumulate, so this conservative fixed point terminates.
  let changed = true, passes = 0;
  while (changed) {
    if (++passes > components.size * 2 + 1) invalid('projection_convergence');
    changed = false;
    for (const relation of liveRelations) if (relation.kind === 'conflict' || relation.kind === 'uncertain') {
      const left = find(relation.left), right = find(relation.right);
      if (scheduled.has(left) || scheduled.has(right)) continue;
      if (statuses.get(left) === 'superseded' || statuses.get(right) === 'superseded') continue;
      const flags = relation.kind === 'conflict' ? disputed : uncertain;
      for (const id of [left, right]) if (!flags.has(id)) { flags.add(id); changed = true; }
    }
    if (changed) {
      statuses.clear(); terminals.clear();
      for (const id of components) resolve(id);
    }
  }

  let selected = liveIds;
  if (seedSourceIds !== undefined) {
    const seeds = new Set(seedSourceIds);
    selected = new Set(live.filter(claim => seeds.has(claim.source.sourceId)).map(claim => claim.id));
    // 'different' is an explicit non-link, otherwise all-pairs assessment would turn each retrieval into a dump.
    const links = new Map<string, string[]>();
    for (const relation of liveRelations) if (relation.kind !== 'different') {
      if (!links.has(relation.left)) links.set(relation.left, []);
      if (!links.has(relation.right)) links.set(relation.right, []);
      links.get(relation.left)!.push(relation.right); links.get(relation.right)!.push(relation.left);
    }
    const queue = [...selected];
    for (let index = 0; index < queue.length; index++) for (const next of links.get(queue[index]!) ?? []) {
      if (!selected.has(next)) { selected.add(next); queue.push(next); }
    }
  }
  const future = liveRelations.filter(r => r.kind === 'revision' && temporal(r) === 'scheduled').map(r => r.effectiveAt!).sort((a,b) => Date.parse(a)-Date.parse(b));
  return {
    revision, ...(future[0] ? { validUntil: future[0] } : {}),
    claims: live.filter(claim => selected.has(claim.id)).map(claim => ({ id: claim.id, text: claim.text,
      subject: claim.subject, event: claim.event, predicate: claim.predicate, value: claim.value,
      validTime: claim.validTime, conditions: claim.conditions, source: { ...claim.source }, status: statuses.get(find(claim.id))!,
      roots: [...new Set(claim.roots)] })),
    relations: liveRelations.filter(relation => selected.has(relation.left) && selected.has(relation.right)).map(relation => {
      const item: KnowledgeView['relations'][number] = { id: relation.id, left: relation.left, right: relation.right,
        kind: relation.kind, reason: relation.reason, active: relation.kind === 'same'
          || ((relation.kind === 'conflict' || relation.kind === 'uncertain')
            && !scheduled.has(find(relation.left)) && !scheduled.has(find(relation.right))
            && statuses.get(find(relation.left)) !== 'superseded' && statuses.get(find(relation.right)) !== 'superseded')
          || (relation.kind === 'revision' && temporal(relation) === 'effective' && statuses.get(find(endpoints(relation)[0])) === 'superseded') };
      if (relation.revisionKind !== undefined) item.revisionKind = relation.revisionKind;
      if (relation.effectiveTime !== undefined) item.effectiveTime = relation.effectiveTime;
      if (relation.superseded !== undefined) item.superseded = relation.superseded;
      if (relation.effectiveAt !== undefined) item.effectiveAt = relation.effectiveAt;
      if (relation.kind === 'revision') item.temporal = temporal(relation);
      return item;
    }),
  };
}
