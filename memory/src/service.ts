import { inspectMedia } from './media.js';
import { KnowledgeStore } from './knowledge-store.js';
import type { ProjectionOptions } from './knowledge-projection.js';
import { StagedStore } from './staged-store.js';
import type { VideoReasonState, VideoReasonCompaction } from './video-models.js';
import { NodeStore } from './node-store.js';
import { PersistentVectorIndex } from './vector-index.js';
import type { Store } from './storage.js';
export type { Store } from './storage.js';
import type { KnowledgeModels } from './knowledge-types.js';
/** Media authority. Hy computes a candidate snapshot; only this transaction domain publishes it. */
export interface Principal { ownerRef: string; scopeRef: 'personal' }
export interface SourceRef { sourceId: string; revision: number; mediaRef: string }
export interface Perception { model: string; configKey: string; kind: 'text' | 'image' | 'audio' | 'video'; text: string }
export interface Timeline { durationMs: number; hasAudio: boolean; hasVideo: boolean }
export interface TimeRange { startMs: number; endMs: number }
export interface Grounding extends TimeRange {
  text: string; model: string; configKey: string; basis: 'model-estimate' | 'sample-window'; modalities: ('audio' | 'video')[];
}
export interface TemporalMatch { intervals: Grounding[]; correctionRelevant: boolean }
export interface ImageMatch { matches: boolean; text: string; correctionRelevant: boolean; model: string; configKey: string }
export interface NodeRow { payload: Record<string, unknown>; embedding: number[]; lexicalTokens?: string[] }
export interface Vector { model: string; values: number[] }
export interface Source {
  ref: SourceRef; messageRef: string; sessionRef: string; mimeType: string; key: string;
  state: 'pending' | 'active' | 'deleted' | 'revoked'; perception?: Perception;
  vector?: Vector; correction?: string; cleanupPending?: boolean; timeline?: Timeline;
  clip?: { original: SourceRef; logical: TimeRange; actual: TimeRange; offsetMs: number };
  video?: { strategy: 'fixed' | 'dynamic'; seconds: number; minDurationMs: number; cursorMs: number; complete: boolean };
  derivedFrom?: SourceRef[]; verification?: Perception; observedAt?: string; reinspectionQuestion?: string;
}
export interface MediaObjects {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}
export interface Models {
  knowledge: KnowledgeModels;
  compactVideoReason?(input: { query: string; ref: SourceRef; state: VideoReasonState }): Promise<VideoReasonCompaction>;
  segmentVideo?(input: { mimeType: string; bytes: Uint8Array; timeline: Timeline; minDurationMs: number; ref: SourceRef }): Promise<TimeRange[]>;
  reasonVideoClip?(input: { query: string; mimeType: string; bytes: Uint8Array; timeline: Timeline; logical: TimeRange; offsetMs: number; prior: VideoReasonState; ref: SourceRef }): Promise<VideoReasonState>;
  perceive(mimeType: string, bytes: Uint8Array, timeline?: Timeline, question?: string): Promise<Perception>;
  embed(input: { text: string } | { mimeType: string; bytes: Uint8Array }): Promise<Vector>;
  locate(input: { query?: string; media?: { mimeType: string; bytes: Uint8Array }; mimeType: string; bytes: Uint8Array; timeline: Timeline; correction?: string }): Promise<TemporalMatch>;
  matchImage(input: { query?: string; media?: { mimeType: string; bytes: Uint8Array }; mimeType: string; bytes: Uint8Array; correction?: string }): Promise<ImageMatch>;
  compute(body: Record<string, unknown>): Promise<unknown>;
}
interface Operation {
  input: string; state: 'started' | 'unknown' | 'failed' | 'committed' | 'superseded'; result?: unknown;
  ref?: SourceRef; stage?: 'upload' | 'perception' | 'embedding' | 'formation' | 'cleanup';
}
export class MemoryError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryError('invalid_object', 400);
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MemoryError('invalid_text', 400);
  return value;
}
export function principal(value: unknown): Principal {
  const p = record(value);
  if (p.scopeRef !== 'personal') throw new MemoryError('unsupported_scope', 403);
  return { ownerRef: text(p.ownerRef, 160), scopeRef: 'personal' };
}
export function sourceRef(value: unknown): SourceRef {
  const v = record(value);
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1) throw new MemoryError('invalid_revision', 400);
  return { sourceId: text(v.sourceId, 160), revision: Number(v.revision), mediaRef: text(v.mediaRef, 200) };
}
function mediaType(value: unknown): string {
  const type = text(value, 80);
  if (!['image/png', 'image/jpeg', 'image/webp', 'audio/wav', 'audio/mpeg', 'video/mp4', 'video/quicktime'].includes(type)) throw new MemoryError('unsupported_media', 415);
  return type;
}
export function timeRange(value: unknown, timeline: Timeline): TimeRange {
  const range = record(value);
  if (Object.keys(range).some(key => key !== 'startMs' && key !== 'endMs') ||
      !Number.isSafeInteger(range.startMs) || !Number.isSafeInteger(range.endMs) ||
      Number(range.startMs) < 0 || Number(range.startMs) >= Number(range.endMs) || Number(range.endMs) > timeline.durationMs) {
    throw new MemoryError('invalid_time_range', 400);
  }
  return { startMs: Number(range.startMs), endMs: Number(range.endMs) };
}
function checkedGroundings(value: Grounding[], timeline: Timeline): Grounding[] {
  if (!Array.isArray(value) || value.length > 3) throw new MemoryError('grounding_invalid', 502);
  return value.map(item => {
    const g = record(item);
    let range: TimeRange;
    try { range = timeRange({ startMs: g.startMs, endMs: g.endMs }, timeline); }
    catch { throw new MemoryError('grounding_range_invalid', 502); }
    if ((g.basis !== 'model-estimate' && g.basis !== 'sample-window') || !Array.isArray(g.modalities) || !g.modalities.length || g.modalities.length > 2 ||
        (g.basis === 'sample-window' && (timeline.hasVideo || g.modalities.length !== 1 || g.modalities[0] !== 'audio')) ||
        new Set(g.modalities).size !== g.modalities.length || g.modalities.some(m => (m !== 'audio' && m !== 'video') ||
          (m === 'audio' && !timeline.hasAudio) || (m === 'video' && !timeline.hasVideo))) throw new MemoryError('grounding_modality_invalid', 502);
    return { ...range, text: text(g.text), model: text(g.model, 200), configKey: text(g.configKey, 200), basis: g.basis, modalities: g.modalities as ('audio' | 'video')[] };
  });
}
function refsOf(payload: Record<string, unknown>): SourceRef[] {
  const custom = record(payload.custom);
  if (!Array.isArray(custom.meta) || custom.meta.length === 0) throw new MemoryError('hy_source_missing', 502);
  const refs = custom.meta.map(meta => sourceRef(record(meta).sourceRef));
  return [...new Map(refs.map(ref => [JSON.stringify(ref), ref])).values()];
}
function nodeRows(value: unknown, p: Principal): NodeRow[] {
  if (!Array.isArray(value) || value.length > 2000) throw new MemoryError('hy_snapshot_invalid', 502);
  const ids = new Set<string>();
  return value.map(item => {
    const row = record(item), payload = record(row.payload), id = text(payload.node_id, 160);
    if (ids.has(id) || payload.user_id !== p.ownerRef || payload.agent_id !== p.scopeRef) throw new MemoryError('hy_scope_invalid', 502);
    ids.add(id);
    refsOf(payload);
    if (!Array.isArray(row.embedding) || !row.embedding.length || row.embedding.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new MemoryError('hy_vector_invalid', 502);
    return { payload, embedding: row.embedding as number[], ...(Array.isArray(row.lexicalTokens) && row.lexicalTokens.every(t => typeof t === 'string') ? { lexicalTokens: row.lexicalTokens as string[] } : {}) };
  });
}
export function decode(data: unknown, maxBytes = 8 * 1024 * 1024): Uint8Array<ArrayBuffer> {
  const encoded = text(data, Math.ceil(maxBytes / 3) * 4);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new MemoryError('invalid_base64', 400);
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > maxBytes) throw new MemoryError('media_too_large', 413);
  return bytes;
}
export function encode(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
const sourceKey = (ref: SourceRef) => `${ref.sourceId}@${ref.revision}`;
export class MemoryService {
  private readonly ready: Promise<void>;
  private readonly nodeStore: NodeStore;
  constructor(readonly db: Store, readonly blobs: MediaObjects, readonly models: Models, readonly owner: Principal) {
    this.nodeStore = new NodeStore(db, 'hy-node', owner);
    this.ready = (async () => {
      const old = await db.get<Principal>('principal');
      if (old && JSON.stringify(old) !== JSON.stringify(owner)) throw new MemoryError('principal_mismatch', 403);
      if (!old) await db.set('principal', owner);
    })();
  }
  async revision(): Promise<number> { await this.ready; return await this.db.get<number>('revision') ?? 1; }
  async source(ref: SourceRef, pending = false, ancestry = new Set<string>(), stagingRoot?: SourceRef): Promise<Source> {
    await this.ready;
    const source = await this.db.get<Source>(`source:${ref.sourceId}`);
    if (!source || source.ref.mediaRef !== ref.mediaRef) throw new MemoryError('source_not_found', 404);
    if (source.ref.revision !== ref.revision) throw new MemoryError('source_changed');
    const rootPending = stagingRoot && JSON.stringify(ref) === JSON.stringify(stagingRoot);
    if (source.state !== 'active' && !((pending || rootPending) && source.state === 'pending')) throw new MemoryError('source_unavailable', 410);
    if (ancestry.has(ref.sourceId)) throw new MemoryError('source_dependency_cycle', 502);
    const visited = new Set(ancestry).add(ref.sourceId);
    for (const parent of source.derivedFrom ?? []) await this.source(parent, false, visited, stagingRoot);
    return source;
  }
  available = async (ref: SourceRef): Promise<boolean> => {
    try { await this.source(ref); return true; } catch (error) { if (error instanceof MemoryError) return false; throw error; }
  };
  async unavailableAt(ref: SourceRef, seen = new Set<string>()): Promise<string | undefined> {
    if (seen.has(sourceKey(ref))) throw new MemoryError('source_dependency_cycle', 502);
    seen.add(sourceKey(ref));
    const direct = await this.db.get<string>(`source-invalidated:${ref.sourceId}:${ref.revision}`);
    const source = await this.db.get<Source>(`source-version:${sourceKey(ref)}`);
    const times = direct ? [direct] : [];
    for (const parent of source?.derivedFrom ?? []) {
      const at = await this.unavailableAt(parent, new Set(seen)); if (at) times.push(at);
    }
    return times.sort()[0];
  }
  async knowledge(sourceIds?: string[], options: ProjectionOptions = {}) {
    return new KnowledgeStore(this.db).view(sourceIds, await this.revision(), this.available, ref => this.unavailableAt(ref), options);
  }
  async roots(source: Source, stagingRoot?: SourceRef): Promise<string[]> {
    const roots = async (ref: SourceRef): Promise<string[]> => {
      const parent = await this.source(ref, false, new Set(), stagingRoot);
      return parent.derivedFrom?.length ? (await Promise.all(parent.derivedFrom.map(roots))).flat() : [parent.ref.sourceId];
    };
    return [...new Set(source.derivedFrom?.length ? (await Promise.all(source.derivedFrom.map(roots))).flat() : [source.ref.sourceId])];
  }
  async validate(refs: SourceRef[]) {
    const invalid: SourceRef[] = [];
    for (const ref of refs) if (!await this.available(ref)) invalid.push(ref);
    return { valid: !invalid.length, revision: await this.revision(), invalid };
  }
  async saveSource(source: Source) {
    await this.db.set(`source:${source.ref.sourceId}`, source);
    await this.db.set(`source-version:${sourceKey(source.ref)}`, source);
  }
  async begin(id: string, input: unknown): Promise<{ old?: unknown }> {
    await this.ready;
    const encoded = JSON.stringify(input), old = await this.db.get<Operation>(`operation:${id}`);
    if (old) {
      if (old.input !== encoded) throw new MemoryError('operation_conflict');
      if (old.state === 'committed') return { old: old.result };
      throw new MemoryError(`operation_${old.state}`);
    }
    await this.db.set(`operation:${id}`, { input: encoded, state: 'started' } satisfies Operation);
    return {};
  }
  async finish(id: string, state: Operation['state'], result?: unknown) {
    const operation = await this.db.get<Operation>(`operation:${id}`);
    if (!operation) throw new MemoryError('operation_missing');
    if (operation.state === 'superseded') return;
    await this.db.set(`operation:${id}`, { ...operation, state, ...(result === undefined ? {} : { result }) });
  }
  async stage(id: string, ref: SourceRef, stage: Operation['stage']) {
    const operation = await this.db.get<Operation>(`operation:${id}`);
    if (!operation || operation.state !== 'started') throw new MemoryError('operation_not_running');
    await this.db.set(`operation:${id}`, { ...operation, ref, stage });
  }
  async operation(id: string) {
    await this.ready;
    const operation = await this.db.get<Operation>(`operation:${text(id, 160)}`);
    if (!operation) throw new MemoryError('operation_not_found', 404);
    return { state: operation.state === 'started' ? 'unknown' : operation.state,
      ref: operation.ref, stage: operation.stage, result: operation.result };
  }
  async listSources(after?: string, limit = 64) {
    await this.ready;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new MemoryError('invalid_limit', 400);
    const page = await this.db.page<Source>('source:', after, limit), items: Source[] = [];
    for (const { value } of page.entries) if (await this.available(value.ref)) items.push(value);
    return { items: items.map(({ ref, mimeType, timeline, clip, video }) => ({ ref, mimeType, timeline, clip, video })), nextCursor: page.nextCursor };
  }
  async readStore(input: Record<string, unknown>) {
    if (input.revision !== await this.revision()) throw new MemoryError('memory_view_changed');
    const result = await this.nodeStore.read(text(input.method, 40), record(input.args), async row => {
      for (const ref of refsOf(row.payload)) if (!await this.available(ref)) return false;
      return true;
    });
    if (input.revision !== await this.revision()) throw new MemoryError('memory_view_changed');
    return { result, coverage: this.nodeStore.lastCoverage };
  }
  async ingest(input: Record<string, unknown>, ownerText = false): Promise<unknown> {
    const operationId = text(input.operationId, 160), messageRef = text(input.messageRef, 160), sessionRef = text(input.sessionRef, 160);
    const mimeType = ownerText ? 'text/plain' : mediaType(input.mimeType);
    const bytes = ownerText ? new TextEncoder().encode(text(input.text, 65536)) : decode(input.dataBase64);
    if (input.derivedFrom !== undefined && (!Array.isArray(input.derivedFrom) || input.derivedFrom.length > 20)) throw new MemoryError('source_dependencies_invalid', 400);
    const derivedFrom = ((input.derivedFrom ?? []) as unknown[]).map(sourceRef);
    for (const ref of derivedFrom) await this.source(ref);
    // Request identity must bind the actual upload bytes: an operation primary key alone cannot detect a changed retry body.
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
    const previous = await this.begin(operationId, { messageRef, sessionRef, mimeType, digest, derivedFrom });
    if (previous.old !== undefined) return previous.old;
    const id = crypto.randomUUID(), ref: SourceRef = { sourceId: id, revision: 1, mediaRef: `media://${id}` };
    const source: Source = { ref, messageRef, sessionRef, mimeType, key: `${encodeURIComponent(this.owner.ownerRef)}/${this.owner.scopeRef}/${id}`, state: 'pending', derivedFrom, observedAt: new Date().toISOString() };
    await this.saveSource(source);
    await this.stage(operationId, ref, 'upload');
    try {
      // Packet timestamps and track presence come from the actual container, never caller/model claims.
      const timeline = ownerText ? undefined : await inspectMedia(mimeType, bytes);
      if (timeline) source.timeline = timeline;
      await this.source(ref, true);
      await this.saveSource(source);
      await this.blobs.put(source.key, bytes, mimeType);
      const current = await this.db.get<Source>(`source:${id}`);
      if (current?.state === 'deleted') {
        await this.blobs.delete(source.key);
        await this.db.set(`source:${id}`, { ...current, cleanupPending: false });
      }
      await this.source(ref, true);
      const result = await this.form(source, operationId, bytes);
      return result;
    } catch (error) {
      if ((await this.db.get<Operation>(`operation:${operationId}`))?.state !== 'superseded') await this.finish(operationId, error instanceof MemoryError ? 'failed' : 'unknown');
      throw error;
    }
  }
  async form(source: Source, operationId: string, bytes: Uint8Array, stagingRoot?: SourceRef): Promise<unknown> {
    await this.source(source.ref, true, new Set(), stagingRoot); // R2 reads may yield to revocation before any model receives the original.
    const revision = await this.revision();
    const nodes: NodeRow[] = []; // Hy formation is a source-local working set; persisted history is read on demand.
    await this.stage(operationId, source.ref, 'perception');
    if (source.reinspectionQuestion !== undefined) {
      const verification = source.mimeType === 'text/plain'
        ? { model: source.derivedFrom?.length ? 'derived-text' : 'owner-statement', configKey: 'owner-text-v1', kind: 'text' as const, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        : await this.models.perceive(source.mimeType, bytes, source.timeline, source.reinspectionQuestion);
      await this.source(source.ref, true, new Set(), stagingRoot);
      const { reinspectionQuestion: _question, ...verified } = source;
      source = { ...verified, verification, ...(source.correction === undefined ? { perception: verification } : {}) };
      await this.saveSource(source);
    }
    const perception = source.perception ?? (source.correction === undefined ? source.mimeType === 'text/plain'
      ? { model: source.derivedFrom?.length ? 'derived-text' : 'owner-statement', configKey: 'owner-text-v1', kind: 'text' as const, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      : await this.models.perceive(source.mimeType, bytes, source.timeline) : {
      model: 'owner-correction', configKey: 'owner-revision', kind: source.mimeType.split('/')[0] as Perception['kind'], text: source.correction,
    });
    text(perception.text, 65536); text(perception.model, 200); text(perception.configKey, 200);
    if (perception.kind !== source.mimeType.split('/')[0]) throw new MemoryError('perception_kind_invalid', 502);
    if (source.correction === undefined && perception.model === 'owner-correction') throw new MemoryError('invalid_perception_authority', 502);
    await this.source(source.ref, true, new Set(), stagingRoot);
    source = { ...source, perception };
    await this.saveSource(source);
    await this.stage(operationId, source.ref, 'embedding');
    const vector = source.vector ?? await this.models.embed(source.mimeType === 'text/plain' ? { text: new TextDecoder().decode(bytes) } : { mimeType: source.mimeType, bytes });
    if (!vector.model || !vector.values.length || vector.values.some(v => !Number.isFinite(v))) throw new MemoryError('media_vector_invalid', 502);
    await this.source(source.ref, true, new Set(), stagingRoot);
    source = { ...source, vector };
    await this.saveSource(source);
    await this.stage(operationId, source.ref, 'formation');
    const output = record(await this.models.compute({ operation: 'write', principal: this.owner, requestId: operationId,
      sessionRef: source.sessionRef, nodes, content: perception.text, sourceRef: source.ref, perception }));
    if (output.success !== true) throw new MemoryError('hy_formation_failed', 502);
    const staged = nodeRows(output.nodes, this.owner);
    for (const node of staged) for (const ref of refsOf(node.payload)) {
      if (JSON.stringify(ref) !== JSON.stringify(source.ref)) throw new MemoryError('hy_foreign_formation_source', 502);
      await this.source(ref, true, new Set(), stagingRoot);
    }
    const roots = await this.roots(source, stagingRoot);
    const candidate = new StagedStore(this.db);
      const formationAvailable = async (ref: SourceRef) => {
        try { await this.source(ref, false, new Set(), stagingRoot); return true; }
        catch (error) { if (error instanceof MemoryError) return false; throw error; }
      };
      await new KnowledgeStore(candidate).add({ source: source.ref, perception, nodes: staged,
        authority: perception.model === 'owner-correction' || perception.model === 'owner-statement' ? 'owner' : 'observation',
        ...(source.timeline ? { timeline: source.timeline } : {}), ...(source.clip ? { clip: source.clip } : {}) }, this.models.knowledge, roots, new Date().toISOString(), formationAvailable,
        async ref => (await this.source(ref, false, new Set(), stagingRoot)).perception?.text ?? '');
      await this.source(source.ref, true, new Set(), stagingRoot);
      await new NodeStore(candidate, 'hy-node', this.owner).save(staged);
      const vectorId = sourceKey(source.ref);
      const oldModel = await this.db.get<string>('media-vector-model');
      if (oldModel && oldModel !== vector.model) throw new MemoryError('media_vector_space_mismatch', 502);
      await candidate.set('media-vector-model', vector.model);
      await candidate.set(`media-vector-ref:${vectorId}`, source.ref);
      await new PersistentVectorIndex(candidate, 'media-vector').add(vectorId, vector.values);
    return this.db.transaction(async () => {
      if (await this.revision() !== revision) throw new MemoryError('memory_changed_during_formation');
      await this.source(source.ref, true, new Set(), stagingRoot);
      await candidate.publish();
      await this.saveSource({ ...source, perception, vector, state: 'active' });
      await this.db.set('revision', revision + 1);
      const result = { ref: source.ref, revision: revision + 1, state: 'active' };
      await this.finish(operationId, 'committed', result);
      return result;
    });
  }
  async read(ref: SourceRef, range?: unknown) {
    const source = await this.source(ref);
    if (range !== undefined && !source.timeline) throw new MemoryError('source_has_no_timeline', 400);
    const selection = range === undefined ? undefined : timeRange(range, source.timeline!);
    if (source.video) throw new MemoryError('video_range_required', 400);
    const bytes = await this.blobs.get(source.key);
    await this.source(ref); // Revocation can run while R2 is awaited.
    if (!bytes) throw new MemoryError('original_missing', 502);
    return { ref, mimeType: source.mimeType, dataBase64: encode(bytes), perceptionText: source.perception?.text ?? '',
      knowledge: await this.knowledge([ref.sourceId]), ...(source.clip ? { clip: source.clip } : {}), ...(source.verification ? { verification: source.verification } : {}),
      provenance: { roots: await this.roots(source), derivedFrom: source.derivedFrom ?? [], independence: 'not-established' as const },
      parser: source.perception && { model: source.perception.model, configKey: source.perception.configKey, kind: source.perception.kind },
      ...(source.timeline ? { timeline: source.timeline, originalIsFullFile: true, ...(selection ? { selection } : {}) } : {}) };
  }
  async search(input: Record<string, unknown>) {
    const query = input.query === undefined ? undefined : text(input.query), sessionRef = text(input.sessionRef, 160);
    const media = input.media === undefined ? undefined : record(input.media);
    if (!query && !media) throw new MemoryError('query_required', 400);
    const limit = input.limit ?? 5;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw new MemoryError('invalid_limit', 400);
    // Query media stays smaller than stored originals so two native inputs fit in one Worker request.
    const queryMedia = media === undefined ? undefined : { mimeType: mediaType(media.mimeType), bytes: decode(media.dataBase64, 2 * 1024 * 1024) };
    if (queryMedia) await inspectMedia(queryMedia.mimeType, queryMedia.bytes);
    const revision = await this.revision();
    const output = query === undefined ? { success: true, memories: [] } : record(await this.models.compute({ operation: 'search', principal: this.owner, requestId: crypto.randomUUID(), sessionRef,
      readStore: { revision }, query, limit: 20 }));
    if (output.success !== true || !Array.isArray(output.memories)) throw new MemoryError('hy_retrieval_failed', 502);
    const vector = queryMedia === undefined ? await this.models.embed({ text: query! }) : await this.models.embed(queryMedia);
    if (revision !== await this.revision()) throw new MemoryError('memory_changed_during_search');
    const items = new Map<string, { id: string; text: string; refs: SourceRef[]; score: number; perception?: Omit<Perception, 'text'> }>();
    for (const [rank, item] of output.memories.entries()) {
      const hit = record(item), id = text(hit.memory_id, 160);
      const node = await this.nodeStore.get(id, async row => (await this.validate(refsOf(row.payload))).valid);
      if (!node) throw new MemoryError('hy_unknown_result', 502);
      const refs = refsOf(node.payload);
      items.set(id, { id, text: text(node.payload.content), refs, score: 1 / (60 + rank + 1) });
    }
    const indexedModel = await this.db.get<string>('media-vector-model');
    if (indexedModel && indexedModel !== vector.model) throw new MemoryError('media_vector_space_mismatch', 502);
    const native = await new PersistentVectorIndex(this.db, 'media-vector').search(vector.values, { limit: 20, maxLeaves: 64,
      accept: async id => { const ref = await this.db.get<SourceRef>(`media-vector-ref:${id}`); return !!ref && await this.available(ref); } });
    for (const [rank, hit] of native.hits.entries()) {
      if (hit.score <= 0) continue;
      const ref = await this.db.get<SourceRef>(`media-vector-ref:${hit.id}`);
      if (!ref) throw new MemoryError('media_vector_source_missing', 502);
      const source = await this.source(ref);
      const existing = [...items.values()].find(item => item.refs.some(r => r.sourceId === ref.sourceId));
      if (existing) existing.score += 1 / (60 + rank + 1);
      else items.set(ref.sourceId, { id: ref.sourceId, text: source.perception?.text ?? 'Media original', refs: [ref],
        score: 1 / (60 + rank + 1), ...(source.perception ? { perception: { model: source.perception.model, configKey: source.perception.configKey, kind: source.perception.kind } } : {}) });
    }
    // Candidate and presentation limits are distinct. Rejected originals free a result slot.
    const ranked = [...items.values()].sort((a, b) => b.score - a.score);
    const grounded = new Map<string, TemporalMatch>(), images = new Map<string, ImageMatch>();
    const results = [];
    let examinedCandidates = 0;
    const limitations = ['Semantic candidate retrieval is not exhaustive; no returned match does not prove absence.', 'Text keyword scores use a bounded posting candidate corpus; persisted vector search uses a bounded tree traversal.'];
    if (output.retrievalCoverage !== undefined && record(output.retrievalCoverage).exhaustive !== true) limitations.push('Hy Reader callbacks report incomplete candidate coverage.');
    for (const { score: _score, ...item } of ranked) {
      if (results.length >= Number(limit) || examinedCandidates >= 20) break;
      const unseenOriginals: SourceRef[] = [];
      for (const ref of item.refs) {
        const source = await this.source(ref), key = JSON.stringify(ref);
        if ((source.timeline || source.mimeType.startsWith('image/')) && !grounded.has(key) && !images.has(key)) unseenOriginals.push(ref);
      }
      if (grounded.size + images.size + unseenOriginals.length > 20) break;
      examinedCandidates++;
      const matches: (Grounding & { ref: SourceRef })[] = [];
      const imageEvidence: { ref: SourceRef; text: string; model: string; configKey: string; basis: 'original-image' }[] = [];
      let temporal = false, unmatched = false, corrected = false;
      for (const ref of item.refs) {
        const source = await this.source(ref), key = JSON.stringify(ref);
        const isImage = source.mimeType.startsWith('image/');
        if (!source.timeline && !isImage) continue;
        temporal ||= !!source.timeline;
        if (!grounded.has(key) && !images.has(key)) {
          const bytes = await this.blobs.get(source.key);
          await this.source(ref);
          if (revision !== await this.revision()) throw new MemoryError('memory_changed_during_search');
          if (!bytes) throw new MemoryError('original_missing', 502);
          const input = { ...(query === undefined ? {} : { query }), ...(queryMedia ? { media: queryMedia } : {}),
            mimeType: source.mimeType, bytes, ...(source.correction === undefined ? {} : { correction: source.correction }) };
          if (isImage) {
            const match = await this.models.matchImage(input);
            if (typeof match.matches !== 'boolean' || typeof match.correctionRelevant !== 'boolean' || match.correctionRelevant && source.correction === undefined) throw new MemoryError('image_match_invalid', 502);
            text(match.text); text(match.model, 200); text(match.configKey, 200);
            images.set(key, match);
          } else {
            const match = await this.models.locate({ ...input, timeline: source.timeline! });
            if (typeof match.correctionRelevant !== 'boolean' || match.correctionRelevant && source.correction === undefined) throw new MemoryError('grounding_correction_invalid', 502);
            grounded.set(key, { intervals: checkedGroundings(match.intervals, source.timeline!), correctionRelevant: match.correctionRelevant });
            limitations.push(source.timeline!.hasVideo
              ? 'Video candidate vectors omit soundtrack and sample frames; returned video times are model estimates.'
              : 'Audio matches identify sampled excerpt bounds, not exact event boundaries; events crossing windows may be missed.');
          }
          await this.source(ref);
          if (revision !== await this.revision()) throw new MemoryError('memory_changed_during_search');
        }
        if (isImage) {
          const match = images.get(key)!;
          if (match.matches) imageEvidence.push({ ref, text: match.text, model: match.model, configKey: match.configKey, basis: 'original-image' });
          else if (match.correctionRelevant) corrected = true;
          else unmatched = true;
        } else {
          const match = grounded.get(key)!;
          matches.push(...match.intervals.map(observation => ({ ...observation, ref })));
          if (!match.intervals.length) { if (match.correctionRelevant) corrected = true; else unmatched = true; }
        }
      }
      if (!unmatched) results.push({ ...item,
        ...(temporal ? { groundings: matches } : {}), ...(imageEvidence.length ? { imageEvidence } : {}),
        retrieval: corrected ? 'owner-correction' as const : temporal ? 'grounded' as const : imageEvidence.length ? 'verified-image' as const : 'native-candidate' as const });
    }
    if (revision !== await this.revision()) throw new MemoryError('memory_changed_during_search');
    const knowledge = await this.knowledge(results.flatMap(item => item.refs.map(ref => ref.sourceId)));
    const videos = new Map<string, { ref: SourceRef; clips: { ref: SourceRef; startMs: number; endMs: number; rank: number; text: string }[] }>();
    for (const [rank, item] of results.entries()) for (const ref of item.refs) {
      const source = await this.source(ref);
      if (!source.clip) continue;
      const original = source.clip.original, key = sourceKey(original);
      const group = videos.get(key) ?? { ref: original, clips: [] };
      const observations = item.groundings?.filter(g => g.ref.sourceId === ref.sourceId) ?? [];
      for (const match of observations) {
        const startMs = Math.max(source.clip.logical.startMs, Math.floor(match.startMs + source.clip.offsetMs));
        const endMs = Math.min(source.clip.logical.endMs, Math.ceil(match.endMs + source.clip.offsetMs));
        if (startMs < endMs && !group.clips.some(c => c.ref.sourceId === ref.sourceId && c.startMs === startMs && c.endMs === endMs)) group.clips.push({ ref, startMs, endMs, rank: rank + 1, text: match.text });
      }
      if (group.clips.length) videos.set(key, group);
    }
    return { revision, items: results, knowledge, videos: [...videos.values()], coverage: { scope: 'retrieved-candidates' as const, exhaustive: false as const,
      candidateLimit: 20 as const, candidates: ranked.length, examinedSources: grounded.size + images.size, returned: results.length,
      remainingCandidates: ranked.length - examinedCandidates, absence: 'not-established' as const, limitations: [...new Set(limitations)] } };
  }

  async invalidate(ref: SourceRef, state: Source['state'], correction?: string): Promise<Source> {
    return this.db.transaction(async () => {
      const source = await this.source(ref, true);
      const { perception: _perception, vector: _vector, ...retained } = source;
      const next: Source = { ...retained, ref: { ...ref, revision: ref.revision + 1 }, state,
        ...(source.video ? { video: { ...source.video, cursorMs: 0, complete: false } } : {}),
        ...(correction === undefined ? {} : { correction }), ...(state === 'deleted' ? { cleanupPending: true } : {}) };
      // Dependency resolution invalidates every descendant without enumerating the corpus.
      await this.db.set(`source-invalidated:${ref.sourceId}:${ref.revision}`, new Date().toISOString());
      if (source.video) await this.db.set(`media-gc:${crypto.randomUUID()}`, { prefix: `${source.key}.clips/${state === 'deleted' ? '' : ref.revision + '/'}` });
      await this.saveSource(next);
      await this.db.set('revision', await this.revision() + 1);
      return next;
    });
  }
  async correct(input: Record<string, unknown>) {
    const ref = sourceRef(input.ref), correction = text(input.text), operationId = text(input.operationId, 160);
    const old = await this.begin(operationId, { ref, correction });
    if (old.old !== undefined) return old.old;
    try {
      const source = await this.invalidate(ref, 'pending', correction);
      await this.stage(operationId, source.ref, 'perception');
      const bytes = await this.blobs.get(source.key);
      if (!bytes) throw new MemoryError('original_missing', 502);
      return await this.form(source, operationId, bytes);
    } catch (error) { await this.finish(operationId, error instanceof MemoryError ? 'failed' : 'unknown'); throw error; }
  }
  /** Re-read original bytes. A new source revision invalidates every old interpretation. */
  async reinspect(input: Record<string, unknown>) {
    const ref = sourceRef(input.ref), question = text(input.question, 4096), operationId = text(input.operationId, 160);
    const old = await this.begin(operationId, { ref, question });
    if (old.old !== undefined) return old.old;
    try {
      const source = { ...(await this.invalidate(ref, 'pending')), reinspectionQuestion: question };
      await this.saveSource(source);
      await this.stage(operationId, source.ref, 'perception');
      const bytes = await this.blobs.get(source.key);
      if (!bytes) throw new MemoryError('original_missing', 502);
      return await this.form(source, operationId, bytes);
    } catch (error) { await this.finish(operationId, error instanceof MemoryError ? 'failed' : 'unknown'); throw error; }
  }
  async forget(input: Record<string, unknown>, revoke = false) {
    const ref = sourceRef(input.ref), operationId = text(input.operationId, 160);
    const old = await this.begin(operationId, { ref, revoke });
    if (old.old !== undefined) return old.old;
    let source: Source;
    try { source = await this.invalidate(ref, revoke ? 'revoked' : 'deleted'); }
    catch (error) { await this.finish(operationId, 'failed'); throw error; }
    await this.stage(operationId, source.ref, 'cleanup');
    const result = { ref: source.ref, revision: await this.revision(), state: source.state };
    if (!revoke) {
      try { await this.blobs.delete(source.key); }
      catch { await this.finish(operationId, 'unknown'); throw new MemoryError('original_cleanup_pending', 503); }
      await this.db.set(`source:${ref.sourceId}`, { ...source, cleanupPending: false });
    }
    await this.finish(operationId, 'committed', result);
    return result;
  }
  /** Owner recovery is explicit. A new source revision fences any late response from the old invocation. */
  async recover(input: Record<string, unknown>) {
    const previousId = text(input.previousOperationId, 160), operationId = text(input.operationId, 160);
    if (previousId === operationId) throw new MemoryError('recovery_requires_new_operation', 400);
    const previous = await this.db.get<Operation>(`operation:${previousId}`);
    if (!previous?.ref) throw new MemoryError('operation_not_recoverable');
    const own = await this.db.get<Operation>(`operation:${operationId}`);
    if (own?.state === 'committed') {
      const expected = JSON.stringify({ previousId, acceptUnknown: input.acceptUnknown === true });
      if (own.input !== expected) throw new MemoryError('operation_conflict');
      return own.result;
    }
    if (['committed', 'superseded'].includes(previous.state)) throw new MemoryError('operation_not_recoverable');
    if ((previous.state === 'started' || previous.state === 'unknown') && input.acceptUnknown !== true) throw new MemoryError('unknown_effect_requires_explicit_recovery');
    const old = await this.begin(operationId, { previousId, acceptUnknown: input.acceptUnknown === true });
    if (old.old !== undefined) return old.old;
    try {
      let source = await this.db.get<Source>(`source:${previous.ref.sourceId}`);
      if (!source || JSON.stringify(source.ref) !== JSON.stringify(previous.ref)) throw new MemoryError('source_changed');
      if (source.state === 'deleted' && source.cleanupPending) {
        await this.stage(operationId, source.ref, 'cleanup');
        await this.blobs.delete(source.key);
        source = { ...source, cleanupPending: false };
        await this.saveSource(source);
        const result = { ref: source.ref, revision: await this.revision(), state: 'deleted' };
        await this.finish(previousId, 'superseded'); await this.finish(operationId, 'committed', result);
        return result;
      }
      if (source.state !== 'pending') throw new MemoryError('source_not_pending');
      source = await this.db.transaction(async () => {
        const next: Source = { ...source!, ref: { ...source!.ref, revision: source!.ref.revision + 1 } };
        await this.saveSource(next);
        await this.db.set('revision', await this.revision() + 1);
        await this.finish(previousId, 'superseded');
        await this.stage(operationId, next.ref, 'upload');
        return next;
      });
      const bytes = await this.blobs.get(source.key);
      if (!bytes) throw new MemoryError('original_missing', 502);
      return await this.form(source, operationId, bytes);
    } catch (error) { await this.finish(operationId, error instanceof MemoryError ? 'failed' : 'unknown'); throw error; }
  }
}
