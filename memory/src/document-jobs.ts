import { MemoryError, MemoryService, decode, sourceRef, text, type Source, type SourceRef } from './service.js';
import { DOCUMENT_UNIT_MIME, isDocument, prepareDocument, readDocumentUnit, type DocumentCoverage } from './document-media.js';

interface Job {
  operationId: string;
  ref: SourceRef;
  state: 'queued' | 'running' | 'unknown' | 'complete' | 'superseded';
  phase: 'prepare' | 'form';
  cursor: number;
  childOperationId?: string;
  error?: string;
}
interface UnitRecord {
  index: number;
  key: string;
  locator: Record<string, unknown>;
  coverage: DocumentCoverage;
  ref?: SourceRef;
  empty?:boolean;ownerCorrection?:string;
}
interface OperationReceipt { input: string; state: string; ref?: SourceRef }
interface RecoveryBinding { previousOperationId: string; acceptUnknown: true; ref: SourceRef }
const sameRef = (a: SourceRef, b: SourceRef) => a.sourceId === b.sourceId && a.revision === b.revision && a.mediaRef === b.mediaRef;
const unitPrefix = (ref: SourceRef) => `doc-unit:${ref.sourceId}@${ref.revision}:`;
const unitKey = (ref: SourceRef, index: number) => `${unitPrefix(ref)}${String(index).padStart(10, '0')}`;

/** A document root publishes only after every staged unit has completed formation. */
export class Documents {
  constructor(readonly service: MemoryService) {}

  private async job(id: string): Promise<Job> {
    const job = await this.service.db.get<Job>(`doc-job:${text(id, 160)}`);
    if (!job) throw new MemoryError('document_job_not_found', 404);
    return job;
  }

  private async root(job: Job) {
    const source = await this.service.source(job.ref, true);
    if (!source.document || source.documentUnit || !isDocument(source.mimeType)) throw new MemoryError('source_not_document', 400);
    return source;
  }

  private async executing(job: Job) {
    const current = await this.job(job.operationId);
    if (current.state !== 'running' || current.phase !== job.phase || current.cursor !== job.cursor || !sameRef(current.ref, job.ref)) {
      throw new MemoryError('document_job_no_longer_running');
    }
    return this.root(current);
  }

  private async queue(job: Job) {
    await this.service.db.set(`doc-job:${job.operationId}`, job);
    await this.service.db.set(`doc-work:${job.operationId}`, job.operationId);
  }

  private async unknown(job: Job, error: unknown) {
    await this.service.db.transaction(async () => {
      const current = await this.job(job.operationId);
      if (!sameRef(current.ref, job.ref) || current.state === 'complete' || current.state === 'superseded') return;
      await this.service.db.set(`doc-job:${job.operationId}`, {
        ...current, state: 'unknown', error: error instanceof Error ? error.message : 'document_interrupted_unknown',
      });
      await this.service.db.delete(`doc-work:${job.operationId}`);
      await this.service.finish(job.operationId, 'unknown');
    });
  }

  private async existing(operationId: string, binding: unknown) {
    const operation = await this.service.db.get<OperationReceipt>(`operation:${operationId}`);
    if (!operation) return undefined;
    if (operation.input !== JSON.stringify(binding)) throw new MemoryError('operation_conflict');
    const job = await this.service.db.get<Job>(`doc-job:${operationId}`);
    if (!job) return { operationId, state: 'unknown', error: 'document_admission_receipt_unknown' };
    if (!operation.ref || !sameRef(operation.ref, job.ref)) throw new MemoryError('operation_conflict');
    // Admission replay reports the existing job; it never parses, invalidates or calls a model again.
    return this.status(operationId);
  }

  async create(input: Record<string, unknown>) {
    const operationId = text(input.operationId, 80);
    const messageRef = text(input.messageRef, 160), sessionRef = text(input.sessionRef, 160);
    const mimeType = text(input.mimeType, 160);
    if (!isDocument(mimeType)) throw new MemoryError('document_mime_unsupported', 415);
    const bytes = decode(input.dataBase64);
    if (input.derivedFrom !== undefined && (!Array.isArray(input.derivedFrom) || input.derivedFrom.length > 20)) {
      throw new MemoryError('source_dependencies_invalid', 400);
    }
    const derivedFrom = ((input.derivedFrom ?? []) as unknown[]).map(sourceRef);
    for (const ref of derivedFrom) await this.service.source(ref);
    // Same upload request identity as MemoryService.ingest: bind bytes, not just operation ID.
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
    const binding = { messageRef, sessionRef, mimeType, digest, derivedFrom };
    await this.service.revision();
    const existing = await this.existing(operationId, binding);
    if (existing !== undefined) return existing;
    const id = crypto.randomUUID();
    const ref: SourceRef = { sourceId: id, revision: 1, mediaRef: `media://${id}` };
    const source: Source = {
      ref, messageRef, sessionRef, mimeType, derivedFrom, state: 'pending',
      key: `${encodeURIComponent(this.service.owner.ownerRef)}/${this.service.owner.scopeRef}/${id}`,
      observedAt: new Date().toISOString(),
      document: { units: 0, cursor: 0, complete: false, coverage: { unsupported: [] } },
    };
    const job: Job = { operationId, ref, state: 'running', phase: 'prepare', cursor: 0 };
    try {
      await this.service.db.transaction(async () => {
        await this.service.begin(operationId, binding);
        for (const parent of derivedFrom) await this.service.source(parent);
        await this.service.saveSource(source);
        await this.service.stage(operationId, ref, 'upload');
        await this.service.db.set(`doc-job:${operationId}`, job);
      });
      await this.executing(job);
      await this.service.blobs.put(source.key, bytes, source.mimeType);
      await this.executing(job);
      await this.prepare(job, bytes);
      return this.status(operationId);
    } catch (error) {
      const stored = await this.service.db.get<Job>(`doc-job:${operationId}`);
      if (stored && sameRef(stored.ref, job.ref)) await this.unknown(job, error);
      else {
        const replay = await this.existing(operationId, binding);
        if (replay !== undefined) return replay;
      }
      throw error;
    }
  }

  /** No model call: persist the complete parsed representation before exposing any work item. */
  private async prepare(job: Job, bytes: Uint8Array) {
    const source = await this.executing(job);
    const prepared = await prepareDocument(source.mimeType, bytes);
    const units=prepared.units.map(value=>{const unit=readDocumentUnit(value.bytes);return {...value,bytes:new TextEncoder().encode(JSON.stringify({...unit,original:source.ref})),empty:unit.empty===true,ownerCorrection:undefined as string|undefined};});
    if(source.correction!==undefined){
      const correction=`Authenticated Owner correction scoped only to document ${JSON.stringify(source.ref)}. Preserve stated page/block/cell/slide qualifiers; do not extend the correction to other units or unrelated documents. Owner statement: ${source.correction}`;
      const locator={kind:'owner-correction',scope:source.ref};
      units.push({bytes:new TextEncoder().encode(JSON.stringify({original:source.ref,locator,context:{ownerCorrection:source.correction,scope:source.ref},images:[],coverage:{unsupported:[]}})),locator,coverage:{unsupported:[]},empty:false,ownerCorrection:correction});
    }
    if(units.some(unit=>unit.bytes.length>8*1024*1024)||units.reduce((size,unit)=>size+unit.bytes.length,0)>24*1024*1024)throw new MemoryError('document_representation_limit',413);
    await this.executing(job);
    for (let index = 0; index < units.length; index++) {
      const unit = units[index]!;
      const key = `${source.key}.units/${source.ref.revision}/${index}.json`;
      await this.executing(job);
      await this.service.blobs.put(key, unit.bytes, DOCUMENT_UNIT_MIME);
      await this.executing(job);
      await this.service.db.transaction(async () => {
        await this.executing(job);
        await this.service.db.set(unitKey(source.ref, index), {
          index, key, locator: unit.locator, coverage: unit.coverage, ...(unit.empty?{empty:true}:{}), ...(unit.ownerCorrection?{ownerCorrection:unit.ownerCorrection}:{}),
        } satisfies UnitRecord);
      });
    }
    await this.service.db.transaction(async () => {
      const current = await this.executing(job);
      await this.service.saveSource({
        ...current,
        document: { units: units.length, cursor: 0, complete: false, coverage: prepared.coverage },
      });
      await this.queue({ ...job, state: 'queued', phase: 'form' });
    });
  }

  async status(id: string) {
    id = text(id, 160);
    const job = await this.service.db.get<Job>(`doc-job:${id}`);
    if (!job) {
      const operation = await this.service.db.get<OperationReceipt>(`operation:${id}`);
      if (!operation) throw new MemoryError('document_job_not_found', 404);
      return { operationId: id, state: operation.state === 'started' ? 'unknown' : operation.state,
        ...(operation.ref ? { ref: operation.ref } : {}), error: 'document_admission_receipt_unknown' };
    }
    let source: Source | undefined;
    let unavailable: string | undefined;
    try { source = await this.root(job); }
    catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      unavailable = error.code;
    }
    return {
      operationId: job.operationId, ref: job.ref, state: job.state, phase: job.phase, cursor: job.cursor,
      ...(source?.document ? { units: source.document.units, complete: source.document.complete, coverage: source.document.coverage } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(unavailable ? { sourceAvailable: false, sourceError: unavailable } : {}),
    };
  }

  async step(id: string) {
    id = text(id, 160);
    let job = await this.job(id);
    if (job.state === 'complete' || job.state === 'superseded' || job.state === 'unknown') return this.status(id);
    if (job.state !== 'queued' || job.phase !== 'form') {
      await this.unknown(job, new MemoryError('document_interrupted_unknown'));
      return this.status(id);
    }
    try {
      await this.service.db.transaction(async () => {
        const current = await this.job(id);
        if (current.state !== 'queued' || current.phase !== 'form') throw new MemoryError('document_job_not_queued');
        await this.root(current);
        job = { ...current, state: 'running' };
        await this.service.db.set(`doc-job:${id}`, job);
      });
      await this.formUnit(job);
      return this.status(id);
    } catch (error) { await this.unknown(job, error); throw error; }
  }

  private async formUnit(job: Job) {
    const source = await this.executing(job), plan = source.document!;
    if (job.cursor !== plan.cursor || job.cursor < 0 || job.cursor > plan.units) throw new MemoryError('document_coverage_incomplete');
    if (job.cursor === plan.units) { await this.publish(job); return; }
    const unit = await this.service.db.get<UnitRecord>(unitKey(job.ref, job.cursor));
    await this.executing(job);
    if (!unit || unit.index !== job.cursor || unit.ref) throw new MemoryError('document_unit_state_invalid');
    const bytes = await this.service.blobs.get(unit.key);
    await this.executing(job);
    if (!bytes) throw new MemoryError('document_unit_missing', 502);
    const ref: SourceRef = { sourceId: crypto.randomUUID(), revision: 1, mediaRef: crypto.randomUUID() };
    const child: Source = {
      ref, key: unit.key, mimeType: DOCUMENT_UNIT_MIME, state: 'pending',
      messageRef: source.messageRef, sessionRef: source.sessionRef, derivedFrom: [source.ref],
      documentUnit: { original: source.ref, index: unit.index, locator: unit.locator, coverage: unit.coverage,...(unit.empty?{empty:true}:{}),...(unit.ownerCorrection?{origin:'owner-correction' as const}:{}) },
      ...(unit.ownerCorrection === undefined ? {} : { correction: unit.ownerCorrection }),
      ...(source.reinspectionQuestion === undefined || unit.ownerCorrection !== undefined ? {} : { reinspectionQuestion: source.reinspectionQuestion }),
    };
    const childOperationId = `${job.operationId}:unit:${job.cursor}`;
    await this.service.begin(childOperationId, { root: job.ref, index: job.cursor });
    await this.executing(job);
    await this.service.db.transaction(async () => {
      await this.executing(job);
      await this.service.saveSource(child);
      await this.service.stage(childOperationId, ref, 'upload');
      await this.service.db.set(`doc-job:${job.operationId}`, { ...job, childOperationId });
    });
    await this.executing(job);
    if(unit.empty){
      await this.service.db.transaction(async()=>{
        await this.executing(job);await this.service.source(child.ref,true,new Set(),source.ref);
        await this.service.saveSource({...child,state:'active',perception:{kind:'document',model:'document-structure-inspection',configKey:'empty-native-unit-v1',text:'No native semantic content was present in this structural unit. Its original locator is retained; no memory fact was formed.'}});
        await this.service.db.set('revision',await this.service.revision()+1);
        await this.service.finish(childOperationId,'committed',{ref:child.ref,state:'active',empty:true});
      });
    } else await this.service.form(child, childOperationId, bytes, source.ref);
    await this.executing(job);
    const cursor = job.cursor + 1;
    await this.service.db.transaction(async () => {
      const current = await this.executing(job);
      await this.service.source(child.ref, false, new Set(), source.ref);
      await this.service.db.set(unitKey(job.ref, unit.index), { ...unit, ref } satisfies UnitRecord);
      await this.service.saveSource({ ...current, document: { ...current.document!, cursor } });
      await this.queue({ operationId: job.operationId, ref: job.ref, phase: 'form', cursor, state: 'queued' });
    });
    if (cursor === plan.units) await this.publish({ ...job, cursor });
  }

  private async publish(job: Job) {
    await this.service.db.transaction(async () => {
      const currentJob = await this.job(job.operationId);
      if (!sameRef(currentJob.ref, job.ref) || !['running', 'queued'].includes(currentJob.state)
          || currentJob.cursor !== job.cursor) throw new MemoryError('document_job_no_longer_running');
      const source = await this.root(currentJob), plan = source.document!;
      if (!plan.units || plan.cursor !== plan.units || job.cursor !== plan.units) throw new MemoryError('document_coverage_incomplete');
      await this.service.saveSource({ ...source, state: 'active', document: { ...plan, complete: true } });
      await this.service.db.set('revision', await this.service.revision() + 1);
      await this.service.finish(job.operationId, 'committed', { ref: job.ref, operationId: job.operationId, state: 'active', coverage: plan.coverage });
      await this.service.db.set(`doc-job:${job.operationId}`, { ...currentJob, state: 'complete' });
      await this.service.db.delete(`doc-work:${job.operationId}`);
    });
  }

  async rebuild(ref: SourceRef, operationId: string, question?: string, correction?: string) {
    ref = sourceRef(ref); operationId = text(operationId, 80);
    question = question === undefined ? undefined : text(question, 8000);
    correction = correction === undefined ? undefined : text(correction);
    return this.startRebuild(ref, operationId, { ref, question, correction }, question, correction);
  }

  private async startRebuild(ref: SourceRef, operationId: string, binding: unknown, question?: string, correction?: string, previous?: Job) {
    await this.service.revision();
    const existing = await this.existing(operationId, binding);
    if (existing !== undefined) return existing;
    let admitted = false;
    try {
      await this.service.db.transaction(async () => {
        const original = await this.service.source(ref, true);
        if (!original.document || original.documentUnit || !isDocument(original.mimeType)) throw new MemoryError('source_not_document', 400);
        await this.service.begin(operationId, binding);
        await this.service.stage(operationId, ref, 'upload');
        // This receipt binds the known original revision, not a predicted next one.
        // An interruption before invalidate can be explicitly recovered; a different
        // concurrent mutation makes this exact ref unavailable and is never adopted.
        await this.service.db.set(`doc-job:${operationId}`, {
          operationId, ref, state: 'running', phase: 'prepare', cursor: 0,
        } satisfies Job);
      });
      admitted = true;
      // invalidate owns the transaction. Its admission callback atomically binds the
      // actual new revision; never predict a ref or nest another Store transaction.
      await this.service.invalidate(ref, 'pending', correction, async next => {
        const source: Source = {
          ...next, document: { units: 0, cursor: 0, complete: false, coverage: { unsupported: [] } },
          ...(question === undefined ? {} : { reinspectionQuestion: question }),
        };
        if (previous) {
          const current = await this.job(previous.operationId);
          if (!sameRef(current.ref, previous.ref) || current.state === 'complete' || current.state === 'superseded') {
            throw new MemoryError('document_job_not_recoverable');
          }
          await this.service.db.set(`doc-job:${previous.operationId}`, { ...current, state: 'superseded' });
          await this.service.finish(previous.operationId, 'superseded');
          await this.service.db.delete(`doc-work:${previous.operationId}`);
        }
        const job: Job = { operationId, ref: source.ref, state: 'running', phase: 'prepare', cursor: 0 };
        await this.service.saveSource(source);
        await this.service.stage(operationId, source.ref, 'upload');
        await this.service.db.set(`doc-job:${operationId}`, job);
      });
      const job = await this.job(operationId);
      const source = await this.executing(job);
      const bytes = await this.service.blobs.get(source.key);
      await this.executing(job);
      if (!bytes) throw new MemoryError('original_missing', 502);
      await this.prepare(job, bytes);
      return this.status(operationId);
    } catch (error) {
      if (!admitted) {
        const replay = await this.existing(operationId, binding);
        if (replay !== undefined) return replay;
      } else {
        const stored = await this.service.db.get<Job>(`doc-job:${operationId}`);
        if (stored) await this.unknown(stored, error);
      }
      throw error;
    }
  }

  async recover(input: { previousOperationId: string; operationId: string; acceptUnknown: boolean }) {
    const previousOperationId = text(input.previousOperationId, 80), operationId = text(input.operationId, 80);
    if (input.acceptUnknown !== true || operationId === previousOperationId) throw new MemoryError('unknown_effect_requires_explicit_recovery', 400);
    const previous = await this.job(previousOperationId);
    const binding: RecoveryBinding = { previousOperationId, acceptUnknown: true, ref: previous.ref };
    const existing = await this.existing(operationId, binding);
    if (existing !== undefined) return existing;
    if (previous.state === 'complete' || previous.state === 'superseded') throw new MemoryError('document_job_not_recoverable');
    return this.startRebuild(previous.ref, operationId, binding, undefined, undefined, previous);
  }

  async units(ref: SourceRef, cursor?: string, limit = 32) {
    ref = sourceRef(ref);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new MemoryError('document_unit_page_invalid', 400);
    const source = await this.service.source(ref);
    if (!source.document?.complete || source.documentUnit) throw new MemoryError('source_not_complete_document', 400);
    const prefix = unitPrefix(ref);
    if (cursor !== undefined && !cursor.startsWith(prefix)) throw new MemoryError('document_unit_cursor_invalid', 400);
    const page = await this.service.db.page<UnitRecord>(prefix, cursor, limit);
    await this.service.source(ref);
    const units = [];
    for (const entry of page.entries) {
      const unit = entry.value;
      if (!unit.ref) throw new MemoryError('document_coverage_incomplete');
      const child = await this.service.source(unit.ref);
      if (!child.documentUnit || !sameRef(child.documentUnit.original, ref) || child.documentUnit.index !== unit.index) {
        throw new MemoryError('document_unit_state_invalid');
      }
      units.push({ key: entry.key, ref: unit.ref, index: unit.index, locator: unit.locator, coverage: unit.coverage,...(unit.empty?{empty:true}:{}),...(unit.ownerCorrection?{origin:'owner-correction'}:{}) });
    }
    await this.service.source(ref);
    return { ref, units, coverage: source.document.coverage, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
}
