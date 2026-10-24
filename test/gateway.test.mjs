// Copyright YY. Licensed under the Apache License, Version 2.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../gateway/worker.mjs';

const token = 'fixture-token-with-at-least-32-characters';
function fixture(overrides = {}) {
  const calls = [];
  const env = { HY_API_TOKEN: token, HY_OWNER_REF: 'trusted-owner', MEMORY: { fetch: async request => {
    calls.push(request);
    return Response.json({ accepted: true });
  } }, ...overrides };
  const request = (path, body = {}, headers = {}) => gateway.fetch(new Request(`https://public.example${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), env);
  return { calls, env, request };
}
test('gateway injects trusted identity and strips caller headers and query', async () => {
  const f = fixture();
  assert.equal((await f.request('/search?ownerRef=evil', { principal: { ownerRef: 'evil', scopeRef: 'shared' }, query: 'hello' }, {
    'memory-principal': '{"ownerRef":"evil"}', cookie: 'private=value',
  })).status, 200);
  assert.equal(f.calls.length, 1);
  const forwarded = f.calls[0];
  assert.equal(forwarded.url, 'https://memory/search');
  assert.deepEqual(await forwarded.json(), { principal: { ownerRef: 'trusted-owner', scopeRef: 'personal' }, query: 'hello' });
  for (const name of ['authorization', 'cookie', 'memory-principal']) assert.equal(forwarded.headers.get(name), null);
});
test('gateway fails closed for missing/weak configuration, auth, methods and private routes', async () => {
  const f = fixture();
  for (const authorization of ['', 'Bearer wrong', `bearer ${token}`]) assert.equal((await f.request('/revision', {}, { authorization })).status, 401);
  for (const path of ['/read-store', '/not-a-route', '/search/']) assert.equal((await f.request(path)).status, 404);
  assert.equal((await gateway.fetch(new Request('https://public.example/search'), f.env)).status, 405);
  for (const overrides of [{ HY_API_TOKEN: '' }, { HY_API_TOKEN: 'short' }, { HY_OWNER_REF: '' }, { MEMORY: undefined }]) {
    assert.equal((await fixture(overrides).request('/revision')).status, 503);
  }
  assert.equal(f.calls.length, 0);
  const health = await gateway.fetch(new Request('https://public.example/health'), {});
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), null);
});
test('gateway rejects invalid or oversized JSON before service invocation', async () => {
  const f = fixture();
  for (const body of ['{broken', 'null', '[]']) {
    const response = await gateway.fetch(new Request('https://public.example/search', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body }), f.env);
    assert.equal(response.status, 400);
  }
  assert.equal((await f.request('/search', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/search', { text: 'x'.repeat(12 * 1024 * 1024) })).status, 413);
  assert.equal(f.calls.length, 0);
});
for (const kind of ['video', 'audio']) test(`raw ${kind} bytes and upload metadata survive with only trusted principal`, async () => {
  const f = fixture(), bytes = new Uint8Array([0, 255, 3, 128]);
  const response = await gateway.fetch(new Request(`https://public.example/${kind}/part`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-length': String(bytes.length),
      'memory-upload': 'upload-1', 'memory-part': '2', 'memory-principal': '{"ownerRef":"evil"}' }, body: bytes }), f.env);
  assert.equal(response.status, 200);
  const forwarded = f.calls[0];
  assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), bytes);
  assert.equal(forwarded.headers.get('content-length'), '4');
  assert.equal(forwarded.headers.get('memory-upload'), 'upload-1');
  assert.equal(forwarded.headers.get('memory-part'), '2');
  assert.deepEqual(JSON.parse(forwarded.headers.get('memory-principal')), { ownerRef: 'trusted-owner', scopeRef: 'personal' });
});
test('raw video rejects false lengths and invalid metadata before service invocation', async () => {
  const f = fixture();
  for (const extra of [{ 'content-length': '9' }, { 'content-length': String(32 * 1024 * 1024 + 1) },
    { 'memory-part': '10001' }, { 'memory-upload': '' }]) {
    const response = await gateway.fetch(new Request('https://public.example/video/part', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-length': '1', 'memory-upload': 'upload-1', 'memory-part': '1', ...extra }, body: 'x' }), f.env);
    assert.ok(response.status >= 400);
  }
  assert.equal(f.calls.length, 0);
});
