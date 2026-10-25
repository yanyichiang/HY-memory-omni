import { MemoryError, text, record, type Principal } from './service.js';
import type { Store } from './storage.js';

interface Upload { id: string; key: string; uploadId: string; mimeType: string; state: 'open' | 'completing' | 'complete' | 'aborted'; operationId?: string }
/** Streams parts into an immutable, owner-scoped original. No whole video JSON/base64 body. */
export class VideoUploads {
  constructor(private readonly db: Store, private readonly bucket: R2Bucket, private readonly owner: Principal, private readonly kind: 'video' | 'audio' = 'video') {}
  async start(input: Record<string, unknown>) {
    const mimeType = text(input.mimeType, 80);
    if (!(this.kind === 'audio' ? ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac'] : ['video/mp4', 'video/quicktime']).includes(mimeType)) throw new MemoryError(`${this.kind}_required`, 415);
    const id = crypto.randomUUID(), key = `${encodeURIComponent(this.owner.ownerRef)}/${this.owner.scopeRef}/uploads/${id}`;
    const multipart = await this.bucket.createMultipartUpload(key, { httpMetadata: { contentType: mimeType } });
    const upload: Upload = { id, key, uploadId: multipart.uploadId, mimeType, state: 'open' };
    await this.db.set(`upload:${id}`, upload);
    return { uploadId: id, partBytes: 8 * 1024 * 1024 };
  }
  private async get(id: unknown) {
    const upload = await this.db.get<Upload>(`upload:${text(id, 160)}`);
    if (!upload) throw new MemoryError('upload_not_found', 404);
    if (!upload.mimeType.startsWith(`${this.kind}/`)) throw new MemoryError(`${this.kind}_required`, 415);
    return upload;
  }
  async part(id: unknown, partNumber: number, request: Request) {
    const upload = await this.get(id), size = Number(request.headers.get('content-length'));
    if (upload.state !== 'open') throw new MemoryError('upload_not_open');
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new MemoryError('invalid_part_number', 400);
    if (!request.body || !Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024 * 1024) throw new MemoryError('invalid_part_size', 413);
    const stream = new FixedLengthStream(size), pipe = request.body.pipeTo(stream.writable);
    const write = this.bucket.resumeMultipartUpload(upload.key, upload.uploadId).uploadPart(partNumber, stream.readable);
    const [, part] = await Promise.all([pipe, write]);
    this.db.check();
    return part;
  }
  async complete(input: Record<string, unknown>) {
    let upload = await this.get(input.uploadId);
    const operationId = text(input.operationId, 80);
    if (upload.operationId && upload.operationId !== operationId) throw new MemoryError('upload_source_already_bound');
    if (!upload.operationId) {
      upload = { ...upload, operationId };
      await this.db.set(`upload:${upload.id}`, upload);
    }
    if (upload.state === 'complete') return upload;
    if (upload.state === 'aborted') throw new MemoryError('upload_aborted');
    if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > 10000) throw new MemoryError('invalid_upload_parts', 400);
    const parts = input.parts.map((raw, index) => {
      const part = record(raw);
      if (part.partNumber !== index + 1) throw new MemoryError('invalid_upload_parts', 400);
      return { partNumber: index + 1, etag: text(part.etag, 200) };
    });
    // The final object key is unique and cannot be reused by another upload.
    // After an unknown completion, HEAD can establish that this same upload succeeded.
    const old = await this.bucket.head(upload.key);
    this.db.check();
    if (!old) {
      upload = { ...upload, state: 'completing' };
      await this.db.set(`upload:${upload.id}`, upload);
      await this.bucket.resumeMultipartUpload(upload.key, upload.uploadId).complete(parts);
      this.db.check();
    }
    upload = { ...upload, state: 'complete' };
    await this.db.set(`upload:${upload.id}`, upload);
    return upload;
  }
  async abort(id: unknown) {
    const upload = await this.get(id);
    if (upload.state === 'complete' || upload.state === 'completing') throw new MemoryError('upload_completion_requires_recovery');
    await this.bucket.resumeMultipartUpload(upload.key, upload.uploadId).abort();
    this.db.check();
    await this.db.set(`upload:${upload.id}`, { ...upload, state: 'aborted' });
    return { state: 'aborted' };
  }
}
