// Copyright YY. Licensed under the Apache License, Version 2.0.
const JSON_LIMIT = 12 * 1024 * 1024;
const PART_LIMIT = 32 * 1024 * 1024;
const ROUTES = new Set([
  '/ingest', '/ingest-text', '/search', '/sources', '/validate', '/read',
  '/correct', '/reinspect', '/knowledge', '/delete', '/revoke', '/operation',
  '/recover', '/revision', '/video/upload', '/video/part', '/video/abort-upload',
  '/video/complete-upload', '/video/status', '/video/events', '/video/step',
  '/video/reason', '/video/recover',
  '/audio/upload', '/audio/part', '/audio/abort-upload', '/audio/complete-upload',
  '/audio/status', '/audio/events', '/audio/step', '/audio/reason', '/audio/recover',
]);
const encoder = new TextEncoder();
function error(code, status) {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function authorized(request, token) {
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ') || header.length > 8192) return false;
  // Hash both values to equal-length buffers before the runtime's constant-time compare.
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(actual, expected);
  // Portable runtimes: compare fixed-size digests without early exits.
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
async function readBounded(request, limit) {
  if (!request.body) return { failure: error('body_required', 400) };
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return { failure: error('request_too_large', 413) }; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (!ROUTES.has(url.pathname)) return error('route_not_found', 404);
    if (request.method !== 'POST') return error('method_not_allowed', 405);
    if (typeof env.HY_API_TOKEN !== 'string' || env.HY_API_TOKEN.length < 32 ||
        env.HY_API_TOKEN.length > 4096 || typeof env.HY_OWNER_REF !== 'string' ||
        !env.HY_OWNER_REF.trim() || env.HY_OWNER_REF.length > 160 || !env.MEMORY?.fetch) {
      return error('gateway_not_configured', 503);
    }
    if (!await authorized(request, env.HY_API_TOKEN)) return error('unauthorized', 401);
    const principal = { ownerRef: env.HY_OWNER_REF, scopeRef: 'personal' };
    const raw = url.pathname === '/video/part' || url.pathname === '/audio/part';
    const headers = new Headers();
    let declaredSize;
    if (raw) {
      const length = request.headers.get('content-length');
      const part = request.headers.get('memory-part');
      const upload = request.headers.get('memory-upload');
      declaredSize = Number(length);
      if (!length || !/^\d+$/.test(length) || !Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > PART_LIMIT) return error('invalid_part_size', 413);
      if (!part || !/^\d+$/.test(part) || Number(part) < 1 || Number(part) > 10000) return error('invalid_part_number', 400);
      if (!upload?.trim() || upload.length > 160) return error('invalid_upload_id', 400);
      headers.set('memory-part', part);
      headers.set('memory-upload', upload);
      headers.set('memory-principal', JSON.stringify(principal));
      headers.set('content-type', 'application/octet-stream');
    } else if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return error('json_required', 415);
    }
    const result = await readBounded(request, raw ? PART_LIMIT : JSON_LIMIT);
    if (result.failure) return result.failure;
    let body;
    if (raw) {
      if (result.bytes.byteLength !== declaredSize) return error('invalid_part_size', 413);
      body = result.bytes;
      headers.set('content-length', String(body.byteLength));
    } else {
      let input;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)); }
      catch { return error('invalid_json', 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return error('invalid_object', 400);
      body = JSON.stringify({ ...input, principal });
      // Injecting trusted identity must not push a previously accepted body over MemoryAPI's cap.
      if (encoder.encode(body).byteLength > JSON_LIMIT) return error('request_too_large', 413);
      headers.set('content-type', 'application/json');
    }
    // Construct afresh: caller credentials, host, cookies and internal headers never cross the boundary.
    return env.MEMORY.fetch(new Request(`https://memory${url.pathname}`, { method: 'POST', headers, body }));
  },
};
