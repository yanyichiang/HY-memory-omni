import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { MemoryError, MemoryService, principal, record, sourceRef, text, type Principal } from './service.js';
import { CloudflareMemoryModels } from './models.js';
import { ObjectStore } from './storage.js';
import { LongVideo } from './long-video.js';
import { Documents } from './document-jobs.js';
import { isDocument } from './document-media.js';
import { VideoUploads } from './uploads.js';

function errorResponse(error: unknown) {
  const known = error instanceof MemoryError;
  const internal = error instanceof Error && /^(memory_|video_|audio_|document_|knowledge_|NODE_|REMOTE_)/.test(error.message) ? error.message : 'memory_operation_unknown';
  return Response.json({ error: known ? error.code : internal }, { status: known ? error.status : 502, headers: { 'Cache-Control': 'no-store' } });
}
/** Only trusted service bindings reach these named entrypoints. No public route. */
export class MemoryAPI extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      if (['/video/part', '/audio/part'].includes(new URL(request.url).pathname)) {
        const owner = principal(JSON.parse(text(request.headers.get('memory-principal'), 1000)));
        return this.env.MEMORY.getByName(JSON.stringify(owner)).fetch(request);
      }
      const body = await boundedBody(request), owner = principal(body.principal);
      return this.env.MEMORY.getByName(JSON.stringify(owner)).fetch(new Request(request.url, { method: 'POST', body: JSON.stringify({ ...body, principal: owner }) }));
    } catch (error) { return errorResponse(error); }
  }
}
/** Python Reader can read only this fixed route, never ingest, revoke or upload. */
export class MemoryReadAPI extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/read-store') return new Response(null, { status: 404 });
    try {
      const body = await boundedBody(request), owner = principal(body.principal);
      return this.env.MEMORY.getByName(JSON.stringify(owner)).fetch(new Request('https://memory/read-store', { method: 'POST', body: JSON.stringify({ ...body, principal: owner }) }));
    } catch (error) { return errorResponse(error); }
  }
}
export class MemoryObject extends DurableObject<Cloudflare.Env> {
  private working = false;
  private activeRequests = 0;
  private maintenance: Promise<void> | undefined;
  private components(owner: Principal) {
    const old = this.ctx.storage.kv.get<Principal>('memory-owner');
    if (old && JSON.stringify(old) !== JSON.stringify(owner)) throw new MemoryError('principal_mismatch', 403);
    if (!old) this.ctx.storage.kv.put('memory-owner', owner);
    const db = new ObjectStore(this.ctx.storage, this.env.ORIGINALS, `memory-pages/${encodeURIComponent(owner.ownerRef)}/${owner.scopeRef}/`);
    const models = new CloudflareMemoryModels({ accountId: this.env.CF_ACCOUNT_ID, gatewayId: this.env.MEMORY_GATEWAY_ID,
      token: this.env.MEMORY_MODEL_TOKEN, formationModel: this.env.MEMORY_FORMATION_MODEL,
      textEmbeddingModel: this.env.MEMORY_TEXT_EMBEDDING_MODEL, mediaEmbeddingModel: this.env.MEMORY_MEDIA_EMBEDDING_MODEL,
      temporalModel: this.env.MEMORY_TEMPORAL_MODEL }, this.env.HY_ENGINE);
    const service = new MemoryService(db, {
      put: async (key, bytes, mimeType) => { await this.env.ORIGINALS.put(key, bytes, { httpMetadata: { contentType: mimeType } }); },
      get: async key => {
        const object = await this.env.ORIGINALS.get(key);
        if (!object) return null;
        if (object.size > 8 * 1024 * 1024) throw new MemoryError('video_range_required', 413);
        return new Uint8Array(await object.arrayBuffer());
      },
      delete: async key => { await this.env.ORIGINALS.delete(key); },
    }, models, owner);
    const video = new LongVideo(service, async key => {
      const object = await this.env.ORIGINALS.head(key);
      db.check();
      if (!object) throw new MemoryError('original_missing', 502);
      return { size: object.size, read: async (offset, length) => {
        const part = await this.env.ORIGINALS.get(key, { range: { offset, length }, onlyIf: { etagMatches: object.etag } });
        db.check();
        if (!part || !('body' in part)) throw new MemoryError('original_changed');
        return new Uint8Array(await part.arrayBuffer());
      } };
    });
    return { service, video, documents: new Documents(service), db, uploads: new VideoUploads(db, this.env.ORIGINALS, owner), audioUploads: new VideoUploads(db, this.env.ORIGINALS, owner, 'audio') };
  }
  async fetch(request: Request): Promise<Response> {
    try { await this.maintenance; } catch (error) { return errorResponse(error); }
    this.activeRequests++;
    try {
      const path = new URL(request.url).pathname;
      const body: Record<string, unknown> = ['/video/part', '/audio/part'].includes(path) ? { principal: JSON.parse(text(request.headers.get('memory-principal'), 1000)) } : await boundedBody(request);
      const { service, video, documents, db, uploads: videoUploads, audioUploads } = this.components(principal(body.principal));
      await service.revision();
      const uploads = path.startsWith('/audio/') ? audioUploads : videoUploads;
      let result: unknown;
      switch (path) {
        case '/ingest': result = typeof body.mimeType === 'string' && isDocument(body.mimeType) ? await documents.create(body) : await service.ingest(body); break;
        case '/ingest-text': result = await service.ingest(body, true); break;
        case '/search': result = await service.search(body); break;
        case '/read-store': result = await service.readStore(body); break;
        case '/sources': result = await service.listSources(body.cursor === undefined ? undefined : text(body.cursor), Number(body.limit ?? 64)); break;
        case '/validate': {
          if (!Array.isArray(body.refs) || body.refs.length > 100) throw new MemoryError('invalid_refs', 400);
          result = await service.validate(body.refs.map(sourceRef)); break;
        }
        case '/read': {
          const ref = sourceRef(body.ref), source = await service.source(ref);
          result = source.video ? await video.read(ref, body.range) : await service.read(ref, body.range); break;
        }
        case '/correct': case '/reinspect': {
          const ref = sourceRef(body.ref), source = await db.get<import('./service.js').Source>(`source:${ref.sourceId}`);
          if (source?.document) {
            result = await documents.rebuild(ref, text(body.operationId, 80), path === '/reinspect' ? text(body.question, 4096) : undefined,
              path === '/correct' ? text(body.text) : undefined);
          } else if (source?.video) {
            result = await video.rebuild(ref, text(body.operationId, 80), path === '/reinspect' ? text(body.question, 4096) : undefined,
              path === '/correct' ? text(body.text) : undefined);
          } else result = path === '/correct' ? await service.correct(body) : await service.reinspect(body);
          break;
        }
        case '/knowledge': {
          if (body.sourceIds !== undefined && (!Array.isArray(body.sourceIds) || body.sourceIds.length > 64)) throw new MemoryError('knowledge_source_ids_invalid', 400);
          result = await service.knowledge(body.sourceIds === undefined ? undefined : (body.sourceIds as unknown[]).map(value => text(value, 160)), {
            ...(body.continuation === undefined ? {} : { continuation: text(body.continuation, 4096) }),
            ...(body.limit === undefined ? {} : { limit: Number(body.limit) }),
            ...(body.workBudget === undefined ? {} : { workBudget: Number(body.workBudget) }),
          }); break;
        }
        case '/delete': result = await service.forget(body); break;
        case '/revoke': result = await service.forget(body, true); break;
        case '/operation': result = await service.operation(text(body.operationId, 160)); break;
        case '/recover': result = await service.recover(body); break;
        case '/revision': result = { revision: await service.revision() }; break;
        case '/audio/upload': case '/video/upload': result = await uploads.start(body); break;
        case '/audio/part': case '/video/part': result = await uploads.part(request.headers.get('memory-upload'), Number(request.headers.get('memory-part')), request); break;
        case '/audio/abort-upload': case '/video/abort-upload': result = await uploads.abort(body.uploadId); break;
        case '/audio/complete-upload': case '/video/complete-upload': {
          const uploaded = await uploads.complete(body);
          result = await video.create({ operationId: text(body.operationId, 80), messageRef: text(body.messageRef, 160), sessionRef: text(body.sessionRef, 160),
            key: uploaded.key, mimeType: uploaded.mimeType, strategy: body.strategy === undefined ? (path.startsWith('/audio/') ? 'fixed' : 'dynamic') : body.strategy as 'fixed' | 'dynamic',
            seconds: Number(body.seconds ?? (path.startsWith('/audio/') ? 20 : 10)), minDurationMs: Number(body.minDurationMs ?? 2000) }); break;
        }
        case '/document/status': result = await documents.status(text(body.operationId, 80)); break;
        case '/document/step': result = await documents.step(text(body.operationId, 80)); break;
        case '/document/recover': result = await documents.recover({ previousOperationId: text(body.previousOperationId, 80), operationId: text(body.operationId, 80), acceptUnknown: body.acceptUnknown === true }); break;
        case '/document/units': result = await documents.units(sourceRef(body.ref), body.cursor === undefined ? undefined : text(body.cursor, 1024), Number(body.limit ?? 32)); break;
        case '/audio/status': case '/video/status': result = await video.status(text(body.operationId, 80)); break;
        case '/audio/events': case '/video/events': result = await video.events(text(body.operationId, 80), body.cursor === undefined ? undefined : text(body.cursor, 1024), Number(body.limit ?? 32)); break;
        case '/audio/step': case '/video/step': result = await video.step(text(body.operationId, 80)); break;
        case '/audio/reason': case '/video/reason': result = await video.createReason({ ref: sourceRef(body.ref), query: text(body.query), operationId: text(body.operationId, 80) }); break;
        case '/audio/recover': case '/video/recover': result = await video.recover({ previousOperationId: text(body.previousOperationId, 80), operationId: text(body.operationId, 80), acceptUnknown: body.acceptUnknown === true }); break;
        default: throw new MemoryError('route_not_found', 404);
      }
      // R2 page cleanup is resumable and continues even when no media jobs remain.
      if (path !== '/read-store') {
        db.check();
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return errorResponse(error); }
    finally { this.activeRequests--; }
  }
  async alarm() {
    if (this.working || this.activeRequests) { await this.ctx.storage.setAlarm(Date.now() + 30_000); return; }
    const owner = this.ctx.storage.kv.get<Principal>('memory-owner');
    if (!owner) return;
    this.working = true;
    try {
      const { service, video, documents, db } = this.components(owner);
      await service.revision();
      const [work, documentWork] = await Promise.all([
        db.page<string>('work:', undefined, 1), db.page<string>('doc-work:', undefined, 1),
      ]);
      const next = this.ctx.storage.kv.get<string>('media-work-next') ?? 'document';
      const document = documentWork.entries[0], temporal = work.entries[0];
      // Persist the next modality before provider IO. A failed or interrupted job
      // cannot starve the other queue; each alarm still executes only one item.
      if (document && (next === 'document' || !temporal)) {
        this.ctx.storage.kv.put('media-work-next', 'video');
        await documents.step(document.value);
      } else if (temporal) {
        this.ctx.storage.kv.put('media-work-next', 'document');
        await video.step(temporal.value);
      }
    } finally {
      this.working = false;
      if (this.activeRequests) await this.ctx.storage.setAlarm(Date.now() + 30_000);
      else {
        // Maintenance never changes the root beneath a foreground request.
        // Python callbacks remain free during media/model work; only bounded GC
        // takes this local maintenance slot, with no provider call inside it.
        this.maintenance = this.maintain(owner);
        try { await this.maintenance; } finally { this.maintenance = undefined; }
      }
    }
  }
  private async maintain(owner: Principal) {
      const db = new ObjectStore(this.ctx.storage, this.env.ORIGINALS, `memory-pages/${encodeURIComponent(owner.ownerRef)}/${owner.scopeRef}/`);
      await db.cleanup();
      const projectionCursor = this.ctx.storage.kv.get<string>('projection-gc-cursor');
      const projections = await db.page<{ id: string; revision: number }>('projection-index:', projectionCursor, 1);
      const projection = projections.entries[0];
      if (projection) {
        if (projection.value.revision !== (await db.get<number>('revision') ?? 1)) {
          const records = await db.page(`projection-job:${projection.value.id}:`, undefined, 32);
          await db.transaction(async () => {
            for (const row of records.entries) await db.delete(row.key);
            if (!records.nextCursor) await db.delete(projection.key);
            else this.ctx.storage.kv.put('projection-gc-incomplete', true);
          });
        }
        this.ctx.storage.kv.put('projection-gc-cursor', projection.key);
      } else {
        this.ctx.storage.kv.delete('projection-gc-cursor');
        if (this.ctx.storage.kv.get<boolean>('projection-gc-incomplete')) this.ctx.storage.kv.delete('projection-gc-incomplete');
        else this.ctx.storage.kv.put('projection-gc-checked-revision', await db.get<number>('revision') ?? 1);
      }
      const cursor = this.ctx.storage.kv.get<string>('media-gc-cursor');
      const gc = await db.page<{ prefix: string }>('media-gc:', cursor, 1);
      const sweep = gc.entries[0];
      if (sweep) {
        const objects = await this.env.ORIGINALS.list({ prefix: sweep.value.prefix, limit: 64 });
        db.check();
        if (objects.objects.length) await this.env.ORIGINALS.delete(objects.objects.map(object => object.key));
        db.check();
        this.ctx.storage.kv.put('media-gc-cursor', sweep.key);
      } else this.ctx.storage.kv.delete('media-gc-cursor');
      const [work, documentWork] = await Promise.all([db.page('work:', undefined, 1), db.page('doc-work:', undefined, 1)]);
      const hasWork = work.entries.length > 0 || documentWork.entries.length > 0;
      const garbage = await this.env.ORIGINALS.list({ prefix: `memory-pages/${encodeURIComponent(owner.ownerRef)}/${owner.scopeRef}/journals/`, limit: 1 });
      const mediaGC = await db.page('media-gc:', undefined, 1);
      const remainingProjections = await db.page('projection-index:', undefined, 1);
      const currentRevision = await db.get<number>('revision') ?? 1;
      const checked = this.ctx.storage.kv.get<number>('projection-gc-checked-revision');
      if (hasWork || garbage.objects.length || mediaGC.entries.length || remainingProjections.entries.length && checked !== currentRevision) {
        await this.ctx.storage.setAlarm(Date.now() + (hasWork ? 1000 : 30_000));
      }
  }

}
async function boundedBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new MemoryError('body_required', 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new MemoryError('request_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return record(JSON.parse(new TextDecoder().decode(bytes)));
}
export default { fetch() { return new Response(null, { status: 404 }); } } satisfies ExportedHandler;
