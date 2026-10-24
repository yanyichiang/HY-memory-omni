import { MemoryError, MemoryService, encode, sourceRef, text, timeRange, type Source, type SourceRef, type TimeRange } from './service.js';
import { inspectLongVideo, nextFixedRange, sliceVideo, type RangeMedia } from './video.js';
import { inspectLongAudio, sliceLongAudio } from './long-audio.js';
import type { VideoEvidenceEvent, VideoReasonState } from './video-models.js';
interface Job {
  kind: 'ingest' | 'reason'; operationId: string; ref: SourceRef; state: 'queued' | 'running' | 'unknown' | 'complete' | 'superseded';
  cursorMs: number; memoryRevision?: number; ranges?: TimeRange[]; analysisWindow?: TimeRange; query?: string; after?: string; reasoning?: VideoReasonState; historyCounts?: { events: number; summaries: number }; reasonedClips?: number; error?: string;
}
interface RecoveryBinding { previousOperationId: string; acceptUnknown: true; kind: Job['kind']; ref: SourceRef; query?: string }
interface CreateInput { operationId: string; messageRef: string; sessionRef: string; mimeType: string; key: string; strategy: 'fixed' | 'dynamic'; seconds: number; minDurationMs: number }
const prefix = (ref: SourceRef) => `clip:${ref.sourceId}@${ref.revision}:`;
const identity = (a: SourceRef, b: SourceRef) => a.sourceId === b.sourceId && a.revision === b.revision && a.mediaRef === b.mediaRef;
export class LongVideo {
  constructor(readonly service: MemoryService, readonly range: (key: string) => Promise<RangeMedia>) {}
  private async job(id: string): Promise<Job> {
    const job = await this.service.db.get<Job>(`job:${text(id, 160)}`);
    if (!job) throw new MemoryError('video_job_not_found', 404);
    return job;
  }
  private async root(job: Job) {
    const source = await this.service.source(job.ref, job.kind === 'ingest');
    // This revision tracks source/knowledge authority, not ObjectStore page commits.
    // A child can be corrected or revoked while its root stays active.
    if (job.kind === 'reason' && job.memoryRevision !== await this.service.revision()) throw new MemoryError('video_reason_dependencies_changed');
    return source;
  }
  private async executing(job: Job) {
    const current = await this.job(job.operationId);
    if (current.state !== 'running' || !identity(current.ref, job.ref)) throw new MemoryError('video_job_no_longer_running');
    return this.root(job);
  }
  private async media(source: Source, pending = false): Promise<RangeMedia> {
    await this.service.source(source.ref, pending);
    const raw = await this.range(source.key);
    await this.service.source(source.ref, pending);
    return { size: raw.size, read: async (offset, length) => {
      await this.service.source(source.ref, pending);
      const bytes = await raw.read(offset, length);
      await this.service.source(source.ref, pending);
      return bytes;
    } };
  }
  private async slice(source: Source, requested: TimeRange, pending = false) {
    const media = await this.media(source, pending);
    return source.timeline!.hasVideo ? sliceVideo(source.mimeType, media, requested) : sliceLongAudio(source.mimeType, media, requested, source.timeline!);
  }
  private async queue(job: Job) {
    await this.service.db.set(`job:${job.operationId}`, job);
    await this.service.db.set(`work:${job.operationId}`, job.operationId);
  }
  async create(input: CreateInput) {
    const operationId = text(input.operationId, 80), key = text(input.key, 500), messageRef = text(input.messageRef, 160), sessionRef = text(input.sessionRef, 160);
    if (!['fixed', 'dynamic'].includes(input.strategy) || !Number.isFinite(input.seconds) || input.seconds <= 0
      || !Number.isFinite(input.minDurationMs) || input.minDurationMs <= 0) throw new MemoryError('video_plan_invalid', 400);
    if (input.mimeType.startsWith('audio/') && (input.seconds > 180 || input.minDurationMs > 180000)) throw new MemoryError('audio_segment_duration_limit', 400);
    const binding = { key, messageRef, sessionRef, mimeType: input.mimeType, strategy: input.strategy, seconds: input.seconds, minDurationMs: input.minDurationMs };
    let previous: { old?: unknown };
    try { previous = await this.service.begin(operationId, binding); }
    catch (error) {
      const operation = await this.service.db.get<{ input: string; state: string }>(`operation:${operationId}`);
      if (!operation || operation.input !== JSON.stringify(binding)) throw error;
      const existing = await this.service.db.get<Job>(`job:${operationId}`);
      if (existing) return this.status(operationId);
      // A lost create receipt must be queryable, never rerun the upload inspection.
      return { operationId, state: 'unknown', error: 'video_create_receipt_unknown' };
    }
    if (previous.old !== undefined) return previous.old;
    try {
      const timeline = await (input.mimeType.startsWith('audio/') ? inspectLongAudio : inspectLongVideo)(input.mimeType, await this.range(key));
      const ref = { sourceId: crypto.randomUUID(), revision: 1, mediaRef: crypto.randomUUID() };
      const source: Source = { ref, key, messageRef, sessionRef, mimeType: input.mimeType, timeline, state: 'pending', video: {
        strategy: input.strategy, seconds: input.seconds, minDurationMs: input.minDurationMs, cursorMs: 0, complete: false } };
      await this.service.db.transaction(async () => {
        await this.service.saveSource(source); await this.service.stage(operationId, ref, 'upload');
        await this.queue({ kind: 'ingest', operationId, ref, state: 'queued', cursorMs: 0 });
      });
      return { ref, state: 'queued', operationId };
    } catch (error) { await this.service.finish(operationId, 'unknown'); throw error; }
  }
  async status(id: string) {
    const job = await this.service.db.get<Job>(`job:${text(id, 160)}`);
    if (!job) {
      const operation = await this.service.db.get<{ state: string; ref?: SourceRef }>(`operation:${id}`);
      if (!operation) throw new MemoryError('video_job_not_found', 404);
      return { operationId: id, state: operation.state === 'started' ? 'unknown' : operation.state, ...(operation.ref ? { ref: operation.ref } : {}), error: 'video_create_receipt_unknown' };
    }
    if (job.state === 'superseded') return { operationId: job.operationId, ref: job.ref, kind: job.kind, state: job.state, cursorMs: job.cursorMs };
    await this.root(job);
    return { operationId: job.operationId, ref: job.ref, kind: job.kind, state: job.state, cursorMs: job.cursorMs,
      ...(job.analysisWindow ? { analysisWindow: job.analysisWindow } : {}), ...(job.error ? { error: job.error } : {}), ...(job.reasoning ? { memoryRevision: job.memoryRevision!, reasoning: { events: job.reasoning.events, conclusion: job.reasoning.conclusion, coverageIncomplete: job.reasoning.coverageIncomplete ?? false, incomplete: job.reasoning.incomplete, requireMore: job.reasoning.requireMore, model: job.reasoning.model, configKey: job.reasoning.configKey, ...(job.reasoning.summary ? { summary: job.reasoning.summary } : {}) }, historyCounts: job.historyCounts ?? { events: 0, summaries: 0 }, contextCoverage: { retainedEvents: job.reasoning.events.length, archivedEvents: job.historyCounts?.events ?? 0, summaryIsIndependentEvidence: false, complete: job.reasoning.coverageIncomplete !== true }, ...(job.reasoning.summary ? { summaryRef: job.reasoning.summary.ref } : {}), ...(job.state === 'complete' ? { coverageComplete: true } : {}) } : {}) };
  }
  private async unknown(job: Job, error?: unknown) {
    // Never resurrect a superseded/recovered job after an in-flight provider returns.
    await this.service.db.transaction(async () => {
      const current = await this.job(job.operationId);
      if (!identity(current.ref, job.ref) || ['complete', 'superseded'].includes(current.state)) return;
      try { await this.root(job); } catch { await this.service.db.set(`job:${job.operationId}`, { ...current, state: 'unknown', error: 'video_reason_dependencies_changed' }); await this.service.finish(job.operationId, 'unknown'); await this.service.db.delete(`work:${job.operationId}`); return; }
      await this.service.db.set(`job:${job.operationId}`, { ...current, state: 'unknown', error: error instanceof Error ? error.message : 'video_interrupted_unknown' });
      await this.service.db.delete(`work:${job.operationId}`);
      await this.service.finish(job.operationId, 'unknown');
    });
  }
  async step(id: string) {
    let job = await this.job(id);
    if (job.state === 'complete' || job.state === 'superseded') return this.status(id);
    if (job.state !== 'queued') { await this.unknown(job); return this.status(id); }
    await this.service.db.transaction(async () => {
      const latest = await this.job(id);
      if (latest.state !== 'queued') throw new MemoryError('video_job_not_queued');
      await this.root(latest);
      job = { ...latest, state: 'running' }; await this.service.db.set(`job:${id}`, job);
    });
    try {
      if (job.kind === 'reason') await this.reasonStep(job);
      else await this.ingestStep(job);
      return await this.status(id);
    } catch (error) { await this.unknown(job, error); throw error; }
  }
  private async ingestStep(job: Job) {
    const source = await this.executing(job), plan = source.video!, timeline = source.timeline!;
    let ranges = job.ranges ?? [];
    if (!ranges.length && job.cursorMs < timeline.durationMs) {
      let window = nextFixedRange(job.cursorMs, timeline.durationMs, plan.seconds)!;
      if (plan.strategy === 'fixed') ranges = [window];
      else {
        if (!this.service.models.segmentVideo) throw new MemoryError('video_dynamic_model_missing', 503);
        let clip: Awaited<ReturnType<LongVideo['slice']>>;
        for (;;) {
          try { clip = await this.slice(source, window, true); break; }
          catch (error) {
            await this.executing(job);
            if (!(error instanceof MemoryError) || error.code !== 'media_slice_too_large') throw error;
            const width = window.endMs - window.startMs;
            if (width <= plan.minDurationMs) throw new MemoryError('video_dynamic_minimum_window_too_large', 413);
            window = { startMs: window.startMs, endMs: window.startMs + Math.max(plan.minDurationMs, Math.floor(width / 2)) };
          }
        }
        job = { ...job, analysisWindow: window };
        await this.service.db.transaction(async () => { await this.executing(job); await this.service.db.set(`job:${job.operationId}`, job); });
        await this.executing(job);
        const proposed = await this.service.models.segmentVideo({ mimeType: clip.mimeType, bytes: clip.bytes, timeline: clip.timeline, minDurationMs: plan.minDurationMs, ref: source.ref });
        await this.executing(job);
        ranges = proposed.map(r => ({ startMs: Math.max(window.startMs, r.startMs + clip.offsetMs), endMs: Math.min(window.endMs, r.endMs + clip.offsetMs) })).filter(r => r.endMs > r.startMs);
        if (!ranges.length || ranges.length > 256 || ranges[0]!.startMs !== window.startMs || ranges.at(-1)!.endMs !== window.endMs
          || ranges.some((r, i) => i > 0 && r.startMs !== ranges[i - 1]!.endMs)) throw new MemoryError('video_dynamic_plan_invalid', 502);
        if (ranges.length > 1 && ranges[0]!.endMs - ranges[0]!.startMs < plan.minDurationMs) ranges.splice(0, 2, { startMs: ranges[0]!.startMs, endMs: ranges[1]!.endMs });
      }
      await this.service.db.transaction(async () => { await this.executing(job); await this.service.db.set(`job:${job.operationId}`, { ...job, ranges }); });
    }
    const logical = ranges[0];
    if (!logical) { await this.publish(job); return; }
    let clip: Awaited<ReturnType<LongVideo['slice']>>;
    try { clip = await this.slice(source, logical, true); }
    catch (error) {
      if (plan.strategy === 'fixed' && error instanceof MemoryError && error.code === 'media_slice_too_large') throw new MemoryError('video_fixed_window_too_large_reduce_seconds', 413);
      throw error;
    }
    await this.executing(job);
    const childId = crypto.randomUUID(), ref = { sourceId: childId, revision: 1, mediaRef: crypto.randomUUID() };
    const child: Source = { ref, key: `${source.key}.clips/${source.ref.revision}/${childId}.${clip.mimeType === 'audio/wav' ? 'wav' : 'mp4'}`, mimeType: clip.mimeType, messageRef: source.messageRef, sessionRef: source.sessionRef,
      timeline: clip.timeline, state: 'pending', derivedFrom: [source.ref], clip: { original: source.ref, logical, actual: clip.actual, offsetMs: clip.offsetMs },
      ...(source.correction ? { correction: source.correction } : {}), ...(source.reinspectionQuestion ? { reinspectionQuestion: source.reinspectionQuestion } : {}) };
    const clipOp = `${job.operationId}:clip:${logical.startMs}`;
    await this.service.begin(clipOp, { root: job.ref, logical });
    await this.executing(job);
    await this.service.saveSource(child);
    await this.service.stage(clipOp, ref, 'upload');
    await this.service.blobs.put(child.key, clip.bytes, clip.mimeType);
    await this.executing(job);
    await this.service.form(child, clipOp, clip.bytes, source.ref);
    await this.executing(job);
    await this.service.db.transaction(async () => {
      const current = await this.executing(job);
      await this.service.db.set(`${prefix(source.ref)}${String(logical.startMs).padStart(20, '0')}:${childId}`, ref);
      await this.service.saveSource({ ...current, video: { ...current.video!, cursorMs: logical.endMs } });
      await this.queue({ ...job, state: 'queued', cursorMs: logical.endMs, ranges: ranges.slice(1) });
    });
    if (logical.endMs === timeline.durationMs) await this.publish({ ...job, cursorMs: logical.endMs });
  }
  private async publish(job: Job) {
    await this.service.db.transaction(async () => {
      const currentJob = await this.job(job.operationId);
      if (!['queued', 'running'].includes(currentJob.state) || !identity(currentJob.ref, job.ref)) throw new MemoryError('video_job_no_longer_running');
      const source = await this.root(job);
      if (job.cursorMs !== source.timeline!.durationMs || source.video!.cursorMs !== job.cursorMs) throw new MemoryError('video_coverage_incomplete');
      await this.service.saveSource({ ...source, state: 'active', video: { ...source.video!, complete: true } });
      await this.service.db.set('revision', await this.service.revision() + 1);
      const result = { ref: source.ref, state: 'active', operationId: job.operationId };
      await this.service.finish(job.operationId, 'committed', result);
      await this.service.db.set(`job:${job.operationId}`, { ...job, ranges: [], state: 'complete' });
      await this.service.db.delete(`work:${job.operationId}`);
    });
  }
  async rebuild(ref: SourceRef, operationId: string, question?: string, correction?: string, recovery?: RecoveryBinding) {
    ref = sourceRef(ref); operationId = text(operationId, 80);
    const binding = recovery ?? { ref, question, correction };
    await this.service.revision();
    const operation = await this.service.db.get<{ input: string; state: string; ref?: SourceRef }>(`operation:${operationId}`);
    if (operation) {
      if (operation.input !== JSON.stringify(binding)) throw new MemoryError('operation_conflict');
      const job = await this.service.db.get<Job>(`job:${operationId}`);
      if (!job || job.operationId !== operationId || job.kind !== 'ingest' || !operation.ref || !identity(operation.ref, job.ref)
        || !(operation.state === 'started' && ['queued', 'running'].includes(job.state)
          || operation.state === 'committed' && job.state === 'complete')) throw new MemoryError(`operation_${operation.state}`);
      await this.root(job);
      // Replay admission, including after publish. Completion and explicit-range reads
      // remain on video/status and read; never repeat invalidation or model work.
      return { ref: job.ref, operationId, state: 'queued' };
    }
    await this.service.begin(operationId, binding);
    const original = await this.service.source(ref, true);
    if (!original.video) throw new MemoryError('source_not_long_video', 400);
    let source = await this.service.invalidate(ref, 'pending', correction);
    source = { ...source, ...(question ? { reinspectionQuestion: text(question, 8000) } : {}) };
    await this.service.db.transaction(async () => {
      await this.service.source(source.ref, true); await this.service.saveSource(source);
      await this.service.stage(operationId, source.ref, 'upload');
      await this.queue({ kind: 'ingest', operationId, ref: source.ref, state: 'queued', cursorMs: 0 });
    });
    return { ref: source.ref, operationId, state: 'queued' };
  }
  async recover(input: { previousOperationId: string; operationId: string; acceptUnknown: boolean }) {
    const previousOperationId = text(input.previousOperationId, 80), operationId = text(input.operationId, 80);
    if (input.acceptUnknown !== true || operationId === previousOperationId) throw new MemoryError('unknown_effect_requires_explicit_recovery', 400);
    const previous = await this.job(previousOperationId);
    const binding: RecoveryBinding = { previousOperationId, acceptUnknown: true, kind: previous.kind, ref: previous.ref, ...(previous.query === undefined ? {} : { query: previous.query }) };
    const operation = await this.service.db.get<{ input: string; state: string; ref?: SourceRef }>(`operation:${operationId}`);
    if (operation) {
      if (operation.input !== JSON.stringify(binding)) throw new MemoryError('operation_conflict');
      const job = await this.service.db.get<Job>(`job:${operationId}`);
      // An interrupted admission is observable but never permission to repeat work.
      if (!job) return { operationId, state: 'unknown', error: 'video_recovery_receipt_unknown' };
      if (job.operationId !== operationId || job.kind !== previous.kind || !operation.ref || !identity(operation.ref, job.ref)) throw new MemoryError('operation_conflict');
      return this.status(operationId);
    }
    if (previous.state === 'complete' || previous.state === 'superseded') throw new MemoryError('video_job_not_recoverable');
    if (previous.kind === 'reason') {
      const source = await this.service.source(previous.ref);
      if (!source.video?.complete) throw new MemoryError('source_not_complete_video', 400);
      await this.service.begin(operationId, binding);
      const reasoning: VideoReasonState = { events: [], conclusion: { text: 'Explicit recovery: not yet examined', status: 'unknown', support: [], opposition: [] }, incomplete: false, requireMore: false, model: 'pending', configKey: 'native-video-reason-v1' };
      await this.service.db.transaction(async () => {
        await this.service.source(previous.ref);
        const latest = await this.job(previous.operationId);
        if (latest.state === 'complete' || latest.state === 'superseded') throw new MemoryError('video_job_not_recoverable');
        await this.service.db.set(`job:${previous.operationId}`, { ...latest, state: 'superseded' });
        await this.service.finish(previous.operationId, 'superseded');
        await this.service.db.delete(`work:${previous.operationId}`);
        await this.service.stage(operationId, previous.ref, 'perception');
        await this.queue({ kind: 'reason', operationId, ref: previous.ref, query: previous.query!, cursorMs: 0, memoryRevision: await this.service.revision(), state: 'queued', reasoning });
      });
      return { ref: previous.ref, operationId, state: 'queued' };
    }
    const result = await this.rebuild(previous.ref, operationId, undefined, undefined, binding);
    await this.service.finish(previous.operationId, 'superseded');
    await this.service.db.set(`job:${previous.operationId}`, { ...previous, state: 'superseded' });
    await this.service.db.delete(`work:${previous.operationId}`);
    return result;
  }
  async read(ref: SourceRef, requested: unknown) {
    const source = await this.service.source(sourceRef(ref));
    if (!source.video?.complete || !source.timeline) throw new MemoryError('source_not_complete_video', 400);
    const selection = timeRange(requested, source.timeline);
    const clip = await this.slice(source, selection);
    await this.service.source(ref);
    return { ref: source.ref, mimeType: clip.mimeType, dataBase64: encode(clip.bytes), timeline: source.timeline, outputTimeline: clip.timeline,
      selection, actual: clip.actual, offsetMs: clip.offsetMs, originalIsFullFile: false, perceptionText: '',
      provenance: { roots: [source.ref.sourceId], derivedFrom: [], independence: 'not-established' },
      parser: { model: source.mimeType === 'audio/mpeg' ? 'mpg123-decoder/1.0.3' : 'container', configKey: source.timeline.hasVideo ? 'native-range-remux-v1' : 'native-audio-sample-range-v1', kind: source.timeline.hasVideo ? 'video' : 'audio' } };
  }
  async createReason(input: { ref: SourceRef; query: string; operationId: string }) {
    const ref = sourceRef(input.ref), query = text(input.query, 8000), operationId = text(input.operationId, 80);
    const source = await this.service.source(ref);
    if (!source.video?.complete) throw new MemoryError('source_not_complete_video', 400);
    const old = await this.service.begin(operationId, { ref, query });
    if (old.old !== undefined) return old.old;
    const reasoning: VideoReasonState = { events: [], conclusion: { text: 'Not yet examined', status: 'unknown', support: [], opposition: [] }, incomplete: false, requireMore: false, model: 'pending', configKey: 'native-video-reason-v1' };
    await this.service.db.transaction(async () => {
      await this.service.source(ref); await this.service.stage(operationId, ref, 'perception');
      await this.queue({ kind: 'reason', operationId, ref, query, cursorMs: 0, memoryRevision: await this.service.revision(), state: 'queued', reasoning });
    });
    return { operationId, ref, state: 'queued' };
  }
  async events(id: string, cursor?: string, limit = 32) {
    const job = await this.job(id);
    await this.root(job);
    if (job.kind !== 'reason' || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new MemoryError('video_event_page_invalid', 400);
    const eventPrefix = `job-event:${job.operationId}:`;
    if (cursor !== undefined && !cursor.startsWith(eventPrefix)) throw new MemoryError('video_event_cursor_invalid', 400);
    const page = await this.service.db.page<{ sequence: number; event: VideoEvidenceEvent; clipRef: SourceRef }>(eventPrefix, cursor, limit);
    await this.root(job);
    return { ref: job.ref, operationId: job.operationId, memoryRevision: job.memoryRevision!, events: page.entries.map(entry => ({ key: entry.key, ...entry.value })), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(job.reasoning?.summary ? { summaryRef: job.reasoning.summary.ref } : {}) };
  }
  private async archiveReason(job: Job, next: VideoReasonState, clipRef: SourceRef): Promise<Job> {
    const previous = new Map(job.reasoning!.events.map(event => [event.id, event]));
    const newEvents = next.events.filter(event => !previous.has(event.id));
    if (next.events.length > 64 || newEvents.length > 32 || new Set(next.events.map(event => event.id)).size !== next.events.length
      || [...previous].some(([id,event]) => JSON.stringify(next.events.find(candidate => candidate.id === id)) !== JSON.stringify(event))) throw new MemoryError('video_reason_events_invalid', 502);
    const counts = { events: (job.historyCounts?.events ?? 0) + newEvents.length, summaries: job.historyCounts?.summaries ?? 0 };
    await this.service.db.transaction(async () => {
      await this.executing(job);
      for (let index = 0; index < newEvents.length; index++) {
        const event = newEvents[index]!;
        if (!identity(event.ref, job.ref)) throw new MemoryError('video_reason_event_source_invalid', 502);
        const sequence = (job.historyCounts?.events ?? 0) + index;
        const key = `job-event:${job.operationId}:${String(sequence).padStart(20, '0')}`;
        if (await this.service.db.get(`job-event-id:${job.operationId}:${event.id}`)) throw new MemoryError('video_reason_event_duplicate', 502);
        await this.service.db.set(key, { sequence, event, clipRef });
        await this.service.db.set(`job-event-id:${job.operationId}:${event.id}`, key);
      }
      for (const id of [...next.conclusion.support, ...next.conclusion.opposition, ...next.events.flatMap(event => event.targets)]) {
        if (!await this.service.db.get(`job-event-id:${job.operationId}:${id}`)) throw new MemoryError('video_reason_evidence_missing', 502);
      }
      // Preserve the first native response independently of any later lossy synthesis.
      await this.service.db.set(`job-observation:${job.operationId}:${clipRef.sourceId}`, { clipRef, state: next, newEventIds: newEvents.map(event => event.id) });
      // Archive first, before text synthesis. On lost synthesis receipt these original observations remain queryable.
      await this.service.db.set(`job:${job.operationId}`, { ...job, historyCounts: counts });
    });
    return { ...job, historyCounts: counts };
  }
  private async compactReason(job: Job, state: VideoReasonState): Promise<VideoReasonState> {
    if (!this.service.models.compactVideoReason) throw new MemoryError('video_reason_compactor_missing', 503);
    const compacted = await this.service.models.compactVideoReason({ query: job.query!, ref: job.ref, state });
    await this.executing(job);
    if (compacted.retain.length > 32 || new Set(compacted.retain).size !== compacted.retain.length || compacted.retain.some(id => !state.events.some(event => event.id === id))) throw new MemoryError('video_reason_compaction_invalid', 502);
    const summaryRef = `job-summary:${job.operationId}:${String(job.historyCounts!.summaries).padStart(20, '0')}`;
    const next: VideoReasonState = { ...state, events: state.events.filter(event => compacted.retain.includes(event.id)), summary: { ref: summaryRef, ...compacted.summary },
      coverageIncomplete: state.coverageIncomplete === true || compacted.uncertain, incomplete: state.incomplete || state.coverageIncomplete === true || compacted.uncertain, requireMore: state.requireMore || state.coverageIncomplete === true || compacted.uncertain,
      conclusion: { ...state.conclusion, ...(compacted.uncertain || state.coverageIncomplete ? { status: 'unknown' as const } : {}) } };
    await this.service.db.transaction(async () => {
      await this.executing(job);
      const eventRefs: string[] = [];
      for (const event of state.events) {
        const key = await this.service.db.get<string>(`job-event-id:${job.operationId}:${event.id}`);
        if (!key) throw new MemoryError('video_reason_evidence_missing', 502); eventRefs.push(key);
      }
      for (const id of [...compacted.summary.support, ...compacted.summary.opposition, ...compacted.summary.unresolved, ...state.conclusion.support, ...state.conclusion.opposition]) {
        if (!await this.service.db.get(`job-event-id:${job.operationId}:${id}`)) throw new MemoryError('video_reason_evidence_missing', 502);
      }
      await this.service.db.set(summaryRef, { ref: summaryRef, ...(state.summary ? { previousSummaryRef: state.summary.ref } : {}), eventRefs, summary: compacted.summary, retainedEventIds: compacted.retain, uncertain: compacted.uncertain });
      job.historyCounts = { ...job.historyCounts!, summaries: job.historyCounts!.summaries + 1 };
      await this.service.db.set(`job:${job.operationId}`, { ...job, reasoning: next });
    });
    return next;
  }
  private async reasonStep(job: Job) {
    const source = await this.executing(job);
    if (!source.video?.complete || !this.service.models.reasonVideoClip) throw new MemoryError('video_reason_model_missing', 503);
    const page = await this.service.db.page<SourceRef>(prefix(job.ref), job.after, 1);
    await this.executing(job);
    const entry = page.entries[0];
    if (!entry) {
      if (job.cursorMs !== source.timeline!.durationMs) throw new MemoryError('video_coverage_incomplete');
      await this.service.db.transaction(async () => {
        await this.executing(job);
        const result = { ref: job.ref, reasoning: job.reasoning, coverageComplete: true };
        await this.service.finish(job.operationId, 'committed', result);
        await this.service.db.set(`job:${job.operationId}`, { ...job, state: 'complete' });
        await this.service.db.delete(`work:${job.operationId}`);
      });
      return;
    }
    const child = await this.service.source(entry.value), clip = child.clip;
    if (!clip || !identity(clip.original, job.ref) || clip.logical.startMs !== job.cursorMs) throw new MemoryError('video_coverage_incomplete');
    const bytes = await this.service.blobs.get(child.key);
    await this.service.source(child.ref); await this.executing(job);
    if (!bytes) throw new MemoryError('original_missing', 502);
    let reasoning = await this.service.models.reasonVideoClip({ query: job.query!, mimeType: child.mimeType, bytes, timeline: child.timeline!, logical: clip.logical, offsetMs: clip.offsetMs, prior: job.reasoning!, ref: job.ref });
    await this.service.source(child.ref); await this.executing(job);
    if (job.reasoning?.coverageIncomplete) reasoning = { ...reasoning, coverageIncomplete: true, incomplete: true, requireMore: true, conclusion: { ...reasoning.conclusion, status: 'unknown' } };
    job = await this.archiveReason(job, reasoning, child.ref);
    if (reasoning.events.length > 32 || (job.reasonedClips ?? 0) % 16 === 15) reasoning = await this.compactReason(job, reasoning);
    await this.service.db.transaction(async () => {
      await this.executing(job); await this.service.source(child.ref);
      await this.queue({ ...job, state: 'queued', reasoning, reasonedClips: (job.reasonedClips ?? 0) + 1, after: entry.key, cursorMs: clip.logical.endMs });
    });
  }
}
