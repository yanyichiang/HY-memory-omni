import type { Claim, ClaimStatus, KnowledgeView, Relation } from './knowledge-types.js';
import type { SourceRef } from './service.js';
import type { Store } from './storage.js';
import { StagedStore } from './staged-store.js';
import { isKnowledgeInstant } from './knowledge.js';

export interface ProjectionOptions { continuation?: string; workBudget?: number; limit?: number }
type Phase = 'closure' | 'union' | 'components' | 'flags' | 'derived' | 'anchored' | 'lost' | 'conditions' | 'lost-flags' | 'cycles' | 'reset' | 'resolve' | 'conflicts' | 'select-seeds' | 'select' | 'output';
type Terminal = 'none' | 'one' | 'many';
interface Node { claim: Claim; live: boolean; invalidated?: string; label: string; derived?: boolean; selected?: boolean }
interface Component {
  scheduled?: boolean; uncertain?: boolean; withdrawn?: boolean; anchored?: boolean; lost?: boolean; disputed?: boolean;
  color?: number; position?: number; status?: ClaimStatus; terminal?: Terminal; terminalId?: string;
}
interface Frame { label: string; after?: string; pending?: string; started?: boolean; unresolved?: boolean; terminal?: Terminal; terminalId?: string }
interface Job {
  id: string; revision: number; now: string; sources?: string[]; phase: Phase;
  sourceIndex: number; sourceAfter?: string; seeded: boolean; head: number; tail: number; edgeAfter?: string;
  seedIds?: string[];
  scan?: string; changed: boolean; depth: number; mark?: number; selectHead: number; selectTail: number;
  previewAfter?: string; validUntil?: string;
}
interface Cursor { id: string; revision: number; claimAfter?: string; relationAfter?: string; claimsDone?: boolean; relationsDone?: boolean }
const encode = (value: string) => encodeURIComponent(value);
const index = (value: number) => String(value).padStart(16, '0');
const token = (cursor: Cursor) => encodeURIComponent(JSON.stringify(cursor));
const endpoints = (r: Relation): [string, string] => r.superseded === 'right' ? [r.right, r.left] : [r.left, r.right];
const directions = (r: Relation): [string, string][] => r.kind === 'same' ? [[r.left, r.right], [r.right, r.left]]
  : r.kind === 'revision' && r.revisionKind === 'correction' ? [endpoints(r)] : [];

/** Incremental equivalent of projectKnowledge. All unbounded graph, DFS stack,
 * labels and fixed-point state live as individual records in the same Store.
 * Each request stages bounded work and publishes it in a short transaction;
 * provider/availability callbacks never run with a persistent writer held.
 * Jobs are derived views, never claim authority. Their cursors are bound to the
 * supplied knowledge revision, source selection and captured evaluation time.
 */
export class KnowledgeProjection {
  private db!: StagedStore;
  private job!: Job;
  private available!: (ref: SourceRef) => Promise<boolean>;
  private unavailableAt!: (ref: SourceRef) => Promise<string | undefined>;
  constructor(private readonly store: Store) {}
  private key(kind: string, id = '') { return `projection-job:${this.job.id}:${kind}:${id}`; }
  private async get<T>(kind: string, id: string) { return this.db.get<T>(this.key(kind, id)); }
  private async set(kind: string, id: string, value: unknown) { await this.db.set(this.key(kind, id), value); }
  private async node(id: string): Promise<Node> {
    const node = await this.get<Node>('node', id);
    if (!node) throw Error('knowledge_projection_node_missing');
    return node;
  }
  private async comp(label: string): Promise<Component> { return await this.get<Component>('component', label) ?? {}; }
  private async pair(left: string, right: string): Promise<[Component, Component]> {
    const a = await this.comp(left); return [a, left === right ? a : await this.comp(right)];
  }
  private temporal(r: Relation): 'effective' | 'scheduled' | 'unresolved' {
    return !r.superseded ? 'unresolved' : r.revisionKind !== 'world-change' ? 'effective'
      : !r.effectiveAt ? 'unresolved' : Date.parse(r.effectiveAt) > Date.parse(this.job.now) ? 'scheduled' : 'effective';
  }
  private next(phase: Phase) { this.job.phase = phase; delete this.job.scan; this.job.changed = false; this.job.depth = 0; }
  private async scan<T>(kind: string) {
    const page = await this.db.page<T>(this.key(kind), this.job.scan, 1);
    const entry = page.entries[0];
    if (entry) this.job.scan = entry.key;
    return entry;
  }
  private async enqueue(id: string) {
    if (await this.get<boolean>('queued', id)) return;
    await this.set('queued', id, true);
    await this.set('queue', index(this.job.tail++), id);
  }
  private async enqueueSelected(id: string) {
    const node = await this.node(id); if (!node.live || node.selected) return;
    node.selected = true; await this.set('node', id, node);
    await this.set('select-queue', index(this.job.selectTail++), id);
  }
  private async closure() {
    if (!this.job.seeded) {
      if (this.job.seedIds?.length) {
        await this.enqueue(this.job.seedIds.shift()!);
        if (!this.job.seedIds.length) delete this.job.seedIds;
        return;
      }
      let ids: string[] = [];
      if (this.job.sources) {
        const source = this.job.sources[this.job.sourceIndex++];
        if (source === undefined) { this.job.seeded = true; return; }
        ids = (await this.db.get<{ ids: string[] }>(`active-source-claims:${encode(source)}`))?.ids ?? [];
      } else {
        const page = await this.db.page<{ ids: string[] }>('active-source-claims:', this.job.sourceAfter, 1);
        const entry = page.entries[0];
        if (!entry) { this.job.seeded = true; return; }
        this.job.sourceAfter = entry.key; ids = entry.value.ids;
      }
      // Active source records are one extract (<=64 IDs). Drain one ID per
      // step so a request cannot stage budget*64 queue insertions at once.
      this.job.seedIds = ids;
      return;
    }
    if (this.job.head === this.job.tail) { this.next('union'); return; }
    const id = await this.get<string>('queue', index(this.job.head));
    if (id === undefined) throw Error('knowledge_projection_queue_missing');
    if (!await this.get<Node>('node', id)) {
      const claim = await this.db.get<Claim>(`claim:${id}`);
      if (!claim) throw Error('knowledge_claim_missing');
      const live = await this.available(claim.source);
      const invalidated = live ? undefined : await this.unavailableAt(claim.source);
      await this.set('node', id, { claim, live, label: id, ...(invalidated === undefined ? {} : { invalidated }) });
    }
    const page = await this.db.page<string>(`claim-edge:${id}:`, this.job.edgeAfter, 1);
    const entry = page.entries[0];
    if (!entry) { this.job.head++; delete this.job.edgeAfter; return; }
    this.job.edgeAfter = entry.key;
    if (await this.get<Relation>('relation', entry.value)) return;
    const relation = await this.db.get<Relation>(`relation:${entry.value}`);
    if (!relation) throw Error('knowledge_relation_missing');
    await this.set('relation', relation.id, relation);
    await this.set(`adjacency:${relation.left}`, relation.id, relation.id);
    await this.set(`adjacency:${relation.right}`, relation.id, relation.id);
    await this.enqueue(relation.left); await this.enqueue(relation.right);
  }
  private async union() {
    const entry = await this.scan<Relation>('relation');
    if (!entry) { if (this.job.changed) { delete this.job.scan; this.job.changed = false; } else this.next('components'); return; }
    const r = entry.value; if (r.kind !== 'same') return;
    const a = await this.node(r.left), b = await this.node(r.right);
    if (!a.live || !b.live) return;
    const label = a.label < b.label ? a.label : b.label;
    if (a.label !== label) { a.label = label; await this.set('node', r.left, a); this.job.changed = true; }
    if (b.label !== label) { b.label = label; await this.set('node', r.right, b); this.job.changed = true; }
  }
  private async components() {
    const entry = await this.scan<Node>('node');
    if (!entry) { this.next('flags'); return; }
    if (entry.value.live) await this.set('component', entry.value.label, await this.comp(entry.value.label));
  }
  private async flags() {
    const entry = await this.scan<Relation>('relation');
    if (!entry) { this.next('derived'); return; }
    const r = entry.value, [oldId, freshId] = endpoints(r);
    const old = await this.node(oldId), fresh = await this.node(freshId);
    if (r.kind !== 'revision') return;
    const state = this.temporal(r);
    if (r.revisionKind === 'world-change') { fresh.derived = true; await this.set('node', freshId, fresh); }
    if (old.live && fresh.live) {
      const [a, b] = await this.pair(old.label, fresh.label);
      if (state === 'effective') await this.set(`out:${old.label}`, fresh.label, fresh.label);
      else if (state === 'scheduled') {
        b.scheduled = true;
        if (r.effectiveAt && (!this.job.validUntil || Date.parse(r.effectiveAt) < Date.parse(this.job.validUntil))) this.job.validUntil = r.effectiveAt;
      } else { a.uncertain = true; b.uncertain = true; }
      if (r.revisionKind === 'world-change') b.anchored = true;
      await this.set('component', old.label, a); await this.set('component', fresh.label, b);
    } else if (old.live && !fresh.live && state !== 'scheduled') {
      if (fresh.invalidated !== undefined && !isKnowledgeInstant(fresh.invalidated)) throw Error('knowledge_invalid_invalidated_at');
      if (r.revisionKind === 'world-change' && r.effectiveAt && fresh.invalidated
        && Date.parse(fresh.invalidated) < Date.parse(r.effectiveAt)) return;
      const component = await this.comp(old.label); component.withdrawn = true; await this.set('component', old.label, component);
    }
  }
  private async propagation(phase: 'derived' | 'anchored' | 'lost' | 'conditions') {
    const entry = await this.scan<Relation>('relation');
    if (!entry) {
      if (this.job.changed && phase !== 'lost') { delete this.job.scan; this.job.changed = false; }
      else this.next(phase === 'derived' ? 'anchored' : phase === 'anchored' ? 'lost' : phase === 'lost' ? 'conditions' : 'lost-flags');
      return;
    }
    const r = entry.value;
    const links = phase === 'derived' || phase === 'lost' ? directions(r)
      : r.kind === 'revision' && r.revisionKind === 'correction' ? [endpoints(r)] : [];
    for (const [oldId, freshId] of links) {
      const old = await this.node(oldId), fresh = await this.node(freshId);
      if (phase === 'derived') {
        if (old.derived && !fresh.derived) { fresh.derived = true; await this.set('node', freshId, fresh); this.job.changed = true; }
      } else if (phase === 'lost') {
        if (!old.derived || old.live || !fresh.live) continue;
        const target = await this.comp(fresh.label);
        if (!target.anchored) { target.lost = true; await this.set('component', fresh.label, target); }
      } else {
        if (!old.live || !fresh.live) continue;
        const [a, b] = await this.pair(old.label, fresh.label);
        let changed = false;
        if (phase === 'anchored') { if (a.anchored && !b.anchored) { b.anchored = true; changed = true; } }
        else {
          for (const flag of ['scheduled', 'uncertain'] as const) if (a[flag] && !b[flag]) { b[flag] = true; changed = true; }
          if (a.lost && !b.anchored && !b.lost) { b.lost = true; changed = true; }
        }
        if (changed) { await this.set('component', fresh.label, b); this.job.changed = true; }
      }
    }
  }
  private async lostFlags() {
    const entry = await this.scan<Component>('component');
    if (!entry) { this.next('cycles'); return; }
    if (entry.value.lost) { entry.value.uncertain = true; await this.db.set(entry.key, entry.value); }
  }
  private async cycles() {
    if (this.job.mark !== undefined) {
      if (this.job.mark >= this.job.depth) { delete this.job.mark; return; }
      const frame = await this.get<Frame>('cycle-stack', index(this.job.mark++));
      if (!frame) throw Error('knowledge_projection_stack_missing');
      const c = await this.comp(frame.label); c.disputed = true; await this.set('component', frame.label, c); return;
    }
    if (!this.job.depth) {
      const entry = await this.scan<Component>('component');
      if (!entry) { this.next('reset'); return; }
      if (entry.value.color) return;
      const label = entry.key.slice(this.key('component').length);
      entry.value.color = 1; entry.value.position = 0;
      await this.db.set(entry.key, entry.value); await this.set('cycle-stack', index(0), { label }); this.job.depth = 1; return;
    }
    const position = this.job.depth - 1, frame = await this.get<Frame>('cycle-stack', index(position));
    if (!frame) throw Error('knowledge_projection_stack_missing');
    const edge = (await this.db.page<string>(this.key(`out:${frame.label}`), frame.after, 1)).entries[0];
    if (!edge) {
      const c = await this.comp(frame.label); c.color = 2; await this.set('component', frame.label, c);
      await this.db.delete(this.key('cycle-stack', index(position))); this.job.depth--; return;
    }
    frame.after = edge.key; await this.set('cycle-stack', index(position), frame);
    const c = await this.comp(edge.value);
    if (!c.color) {
      c.color = 1; c.position = this.job.depth; await this.set('component', edge.value, c);
      await this.set('cycle-stack', index(this.job.depth++), { label: edge.value });
    } else if (c.color === 1) this.job.mark = c.position!;
  }
  private async reset() {
    const entry = await this.scan<Component>('component');
    if (!entry) { this.next('resolve'); return; }
    delete entry.value.status; delete entry.value.terminal; delete entry.value.terminalId;
    await this.db.set(entry.key, entry.value);
  }
  private combine(frame: Frame, component: Component) {
    if (component.status !== 'supported' && component.status !== 'superseded') frame.unresolved = true;
    const incoming = component.terminal ?? 'none';
    if (incoming === 'none' || frame.terminal === 'many') return;
    if (incoming === 'many') { frame.terminal = 'many'; delete frame.terminalId; }
    else if (!frame.terminal || frame.terminal === 'none') { frame.terminal = 'one'; frame.terminalId = component.terminalId!; }
    else if (frame.terminalId !== component.terminalId) { frame.terminal = 'many'; delete frame.terminalId; }
  }
  private async finish(frame: Frame, component: Component, status: ClaimStatus, terminal: Terminal, terminalId?: string) {
    component.status = status; component.terminal = terminal;
    if (terminalId === undefined) delete component.terminalId; else component.terminalId = terminalId;
    await this.set('component', frame.label, component);
    await this.db.delete(this.key('resolve-stack', index(--this.job.depth)));
  }
  private async resolve() {
    if (!this.job.depth) {
      const entry = await this.scan<Component>('component');
      if (!entry) { this.next('conflicts'); return; }
      if (entry.value.status) return;
      const label = entry.key.slice(this.key('component').length);
      await this.set('resolve-stack', index(0), { label }); this.job.depth = 1; return;
    }
    const position = this.job.depth - 1, frame = await this.get<Frame>('resolve-stack', index(position));
    if (!frame) throw Error('knowledge_projection_stack_missing');
    const c = await this.comp(frame.label);
    if (!frame.started) {
      const hasOut = (await this.db.page<string>(this.key(`out:${frame.label}`), undefined, 1)).entries.length > 0;
      if (c.disputed) { await this.finish(frame, c, 'disputed', 'none'); return; }
      if (c.uncertain || (c.withdrawn && !hasOut)) { await this.finish(frame, c, 'unresolved', 'none'); return; }
      if (!hasOut) { await this.finish(frame, c, c.scheduled ? 'scheduled' : 'supported', 'one', frame.label); return; }
      frame.started = true; frame.terminal = 'none';
    }
    if (frame.pending) {
      const child = await this.comp(frame.pending);
      if (!child.status) throw Error('knowledge_projection_resolution_invalid');
      this.combine(frame, child); delete frame.pending;
      await this.set('resolve-stack', index(position), frame); return;
    }
    const edge = (await this.db.page<string>(this.key(`out:${frame.label}`), frame.after, 1)).entries[0];
    if (!edge) { await this.finish(frame, c, frame.unresolved || frame.terminal !== 'one' ? 'unresolved' : 'superseded', frame.terminal ?? 'none', frame.terminalId); return; }
    frame.after = edge.key; frame.pending = edge.value; await this.set('resolve-stack', index(position), frame);
    const child = await this.comp(edge.value);
    if (!child.status) await this.set('resolve-stack', index(this.job.depth++), { label: edge.value });
  }
  private async conflicts() {
    const entry = await this.scan<Relation>('relation');
    if (!entry) { this.next(this.job.changed ? 'reset' : 'select-seeds'); return; }
    const r = entry.value; if (r.kind !== 'conflict' && r.kind !== 'uncertain') return;
    const a = await this.node(r.left), b = await this.node(r.right); if (!a.live || !b.live) return;
    const [left, right] = await this.pair(a.label, b.label);
    if (left.scheduled || right.scheduled || left.status === 'superseded' || right.status === 'superseded') return;
    const flag = r.kind === 'conflict' ? 'disputed' : 'uncertain';
    for (const [label, c] of [[a.label, left], [b.label, right]] as const) if (!c[flag]) {
      c[flag] = true; this.job.changed = true; await this.set('component', label, c);
    }
  }
  private async selectSeeds() {
    const entry = await this.scan<Node>('node');
    if (!entry) { this.next('select'); return; }
    const node = entry.value;
    if (node.live && (!this.job.sources || this.job.sources.includes(node.claim.source.sourceId))) await this.enqueueSelected(node.claim.id);
  }
  private async select() {
    if (this.job.selectHead === this.job.selectTail) { this.next('output'); return; }
    const id = await this.get<string>('select-queue', index(this.job.selectHead));
    if (id === undefined) throw Error('knowledge_projection_queue_missing');
    const entry = (await this.db.page<string>(this.key(`adjacency:${id}`), this.job.edgeAfter, 1)).entries[0];
    if (!entry) { this.job.selectHead++; delete this.job.edgeAfter; return; }
    this.job.edgeAfter = entry.key;
    const r = await this.get<Relation>('relation', entry.value);
    if (!r || r.kind === 'different') return;
    const a = await this.node(r.left), b = await this.node(r.right);
    if (a.live && b.live) { await this.enqueueSelected(r.left); await this.enqueueSelected(r.right); }
  }
  private async step() {
    switch (this.job.phase) {
      case 'closure': return this.closure();
      case 'union': return this.union();
      case 'components': return this.components();
      case 'flags': return this.flags();
      case 'derived': case 'anchored': case 'lost': case 'conditions': return this.propagation(this.job.phase);
      case 'lost-flags': return this.lostFlags();
      case 'cycles': return this.cycles();
      case 'reset': return this.reset();
      case 'resolve': return this.resolve();
      case 'conflicts': return this.conflicts();
      case 'select-seeds': return this.selectSeeds();
      case 'select': return this.select();
      case 'output': return;
    }
  }
  private async claimView(node: Node, complete: boolean): Promise<KnowledgeView['claims'][number]> {
    const c = node.claim;
    return { id: c.id, text: c.text, subject: c.subject, event: c.event, predicate: c.predicate, value: c.value,
      validTime: c.validTime, conditions: c.conditions, source: { ...c.source }, roots: [...new Set(c.roots)],
      status: complete ? (await this.comp(node.label)).status! : 'unresolved' };
  }
  private async relationView(r: Relation, complete: boolean): Promise<KnowledgeView['relations'][number]> {
    const old = await this.node(endpoints(r)[0]), a = await this.node(r.left), b = await this.node(r.right);
    const [left, right] = await this.pair(a.label, b.label);
    const state = this.temporal(r);
    const active = complete && (r.kind === 'same' || ((r.kind === 'conflict' || r.kind === 'uncertain')
      && !left.scheduled && !right.scheduled && left.status !== 'superseded' && right.status !== 'superseded')
      || (r.kind === 'revision' && state === 'effective' && (await this.comp(old.label)).status === 'superseded'));
    return { id: r.id, left: r.left, right: r.right, kind: r.kind, reason: r.reason, active,
      ...(r.revisionKind === undefined ? {} : { revisionKind: r.revisionKind }),
      ...(r.effectiveTime === undefined ? {} : { effectiveTime: r.effectiveTime }),
      ...(r.superseded === undefined ? {} : { superseded: r.superseded }),
      ...(r.effectiveAt === undefined ? {} : { effectiveAt: r.effectiveAt }),
      ...(r.kind === 'revision' ? { temporal: state } : {}) };
  }
  private async output(cursor: Cursor, limit: number): Promise<KnowledgeView> {
    const complete = this.job.phase === 'output';
    const claims = new Map<string, KnowledgeView['claims'][number]>(), relations: KnowledgeView['relations'] = [];
    let claimAfter = complete ? cursor.claimAfter : this.job.previewAfter;
    let relationAfter = cursor.relationAfter, claimsDone = !!cursor.claimsDone, relationsDone = !!cursor.relationsDone;
    if (!claimsDone || !complete) {
      const page = await this.db.page<Node>(this.key('node'), claimAfter, limit);
      for (const entry of page.entries) if (entry.value.live && (!complete || entry.value.selected)) {
        claims.set(entry.value.claim.id, await this.claimView(entry.value, complete));
      }
      claimAfter = page.entries.at(-1)?.key ?? claimAfter;
      claimsDone = !page.nextCursor;
      if (!complete && claimAfter !== undefined) this.job.previewAfter = claimAfter;
    }
    if (complete && !relationsDone) {
      const page = await this.db.page<Relation>(this.key('relation'), relationAfter, Math.max(1, Math.floor(limit / 2)));
      for (const entry of page.entries) {
        const r = entry.value, a = await this.node(r.left), b = await this.node(r.right);
        if (!a.live || !b.live || !a.selected || !b.selected) continue;
        claims.set(a.claim.id, await this.claimView(a, true)); claims.set(b.claim.id, await this.claimView(b, true));
        relations.push(await this.relationView(r, true));
      }
      relationAfter = page.entries.at(-1)?.key ?? relationAfter; relationsDone = !page.nextCursor;
    }
    const next: Cursor = { id: this.job.id, revision: this.job.revision,
      ...(complete && claimAfter !== undefined ? { claimAfter } : {}), ...(complete && relationAfter !== undefined ? { relationAfter } : {}),
      ...(complete ? { claimsDone, relationsDone } : {}) };
    return { revision: this.job.revision, claims: [...claims.values()], relations,
      ...(this.job.validUntil ? { validUntil: this.job.validUntil } : {}),
      coverage: { complete, exhaustiveGlobalConflicts: false, candidateRecallLimited: true,
        evaluatedAt: this.job.now, phase: this.job.phase,
        ...(!complete ? { reason: 'relationship-closure-paged' as const } : {}),
        ...(!complete || !claimsDone || !relationsDone ? { continuation: token(next) } : {}) } };
  }
  async view(sources: string[] | undefined, revision: number, available: (ref: SourceRef) => Promise<boolean>,
    unavailableAt: (ref: SourceRef) => Promise<string | undefined>, options: ProjectionOptions = {}): Promise<KnowledgeView> {
    const budget = options.workBudget ?? 256, limit = options.limit ?? 64;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw Error('knowledge_projection_budget_invalid');
    this.db = new StagedStore(this.store); this.available = available; this.unavailableAt = unavailableAt;
    let cursor: Cursor;
    const selection = sources === undefined ? undefined : [...new Set(sources)].sort();
    if (options.continuation) {
      try { cursor = JSON.parse(decodeURIComponent(options.continuation)) as Cursor; } catch { throw Error('knowledge_projection_cursor_invalid'); }
      if (!cursor || typeof cursor.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(cursor.id) || cursor.revision !== revision) throw Error('knowledge_projection_cursor_changed');
      const job = await this.db.get<Job>(`projection-job:${cursor.id}:meta`);
      if (!job || job.revision !== revision || JSON.stringify(job.sources) !== JSON.stringify(selection)) throw Error('knowledge_projection_cursor_changed');
      this.job = job;
      if (job.validUntil && Date.parse(job.validUntil) <= Date.now()) throw Error('knowledge_projection_cursor_expired');
    } else {
      this.job = { id: crypto.randomUUID(), revision, now: new Date().toISOString(), ...(selection === undefined ? {} : { sources: selection }),
        phase: 'closure', sourceIndex: 0, seeded: false, head: 0, tail: 0, changed: false, depth: 0, selectHead: 0, selectTail: 0 };
      cursor = { id: this.job.id, revision };
      await this.db.set(`projection-index:${this.job.id}`, { id: this.job.id, revision });
    }
    for (let step = 0; step < budget && this.job.phase !== 'output'; step++) await this.step();
    const result = await this.output(cursor, limit);
    await this.db.set(`projection-job:${this.job.id}:meta`, this.job);
    // Only bounded derived-state writes occur under the durable writer.
    await this.store.transaction(() => this.db.publish());
    return result;
  }
}
