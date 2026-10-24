// Copyright YY. Licensed under the Apache License, Version 2.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { initCloud, renderCloud, deploymentPlan, applyTags, smokeCloud, deployCloud, cloudMain } from '../scripts/cloud.mjs';
const installation = { version: 1, name: 'fixture-memory', accountId: 'a'.repeat(32), ownership: 'personal', tags: { Private: '' } };
const config = Object.fromEntries(['HY_LLM_URL', 'HY_LLM_MODEL', 'HY_EMBED_URL', 'HY_EMBED_MODEL', 'HY_EMBED_DIMS', 'MEMORY_GATEWAY_ID', 'MEMORY_FORMATION_MODEL', 'MEMORY_TEXT_EMBEDDING_MODEL', 'MEMORY_MEDIA_EMBEDDING_MODEL', 'MEMORY_TEMPORAL_MODEL', 'HY_OWNER_REF'].map(key => [key, `fixture-${key}`]));
Object.assign(config, { HY_LLM_URL: 'https://models.example/v1', HY_EMBED_URL: 'https://embeddings.example/v1', CF_ACCOUNT_ID: installation.accountId, HY_LLM_KEY: 'secret-llm', HY_EMBED_KEY: 'secret-embed', HY_API_TOKEN: 'secret-public-token-with-32-characters', MEMORY_MODEL_TOKEN: 'secret-model' });
async function temporary(fn) {
  const dir = await mkdtemp(resolve(tmpdir(), 'hy-cloud-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('cloud init refuses overwrite, invalid ownership and account mismatch; plans are credential-free', async () => temporary(async directory => {
  await initCloud({ directory, ...installation });
  await assert.rejects(initCloud({ directory, ...installation }), { code: 'EEXIST' });
  assert.throws(() => renderCloud({ ...installation, ownership: 'company' }, config), /Company/);
  assert.throws(() => renderCloud(installation, { ...config, CF_ACCOUNT_ID: 'wrong' }), /account differs/);
  assert.throws(() => renderCloud(installation, { ...config, HY_LLM_URL: 'https://models.example/v1?key=secret' }), /without credentials/);
  const plan = deploymentPlan(installation);
  assert.equal(plan.resources.workers.length, 3);
  assert.equal(JSON.stringify(plan).includes(config.HY_API_TOKEN), false);
}));
test('rendered configs close all public paths until authenticated gateway activation and exclude every secret', () => {
  const rendered = renderCloud(installation, config);
  assert.deepEqual(rendered['engine-bootstrap'].services, []);
  assert.equal(rendered.engine.services[0].entrypoint, 'MemoryReadAPI');
  assert.equal(rendered.store.services[0].service, rendered.engine.name);
  assert.equal(rendered['gateway-private'].services[0].entrypoint, 'MemoryAPI');
  assert.equal(rendered['gateway-private'].workers_dev, false);
  assert.equal(rendered['gateway-public'].workers_dev, true);
  for (const item of Object.values(rendered)) assert.equal(item.preview_urls, false);
  for (const key of ['HY_LLM_KEY', 'HY_EMBED_KEY', 'HY_API_TOKEN', 'MEMORY_MODEL_TOKEN']) assert.equal(JSON.stringify(rendered).includes(config[key]), false);
});
test('native tags merge existing tags using exact IDs and verify readback; ambiguous 500 never overwrites tags', async () => {
  const writes = [];
  const resource = { resource_type: 'worker', resource_id: 'fixture-worker', createdByInstallation: true };
  await applyTags(installation, [resource], async (_i, path, options) => {
    if (path.startsWith('tags/resources?')) return { result: [{ id: resource.resource_id, type: 'worker', tags: { existing: 'preserved' } }] };
    if (path === 'tags') { writes.push(options.body); return { success: true }; }
    return { result: { tags: { existing: 'preserved', Private: '' } } };
  });
  assert.deepEqual(writes, [{ resource_type: 'worker', resource_id: 'fixture-worker', tags: { existing: 'preserved', Private: '' } }]);
  await assert.rejects(applyTags(installation, [resource], async () => { throw Object.assign(new Error('server error'), { status: 500 }); }), /server error/);
  await assert.rejects(applyTags(installation, [resource], async (_i, path) => path.startsWith('tags/resources?') ? { result: [] } : { result: { tags: {} } }), /readback/);
});
test('smoke traverses authenticated revision without model operations or following credential redirects', async () => {
  const requests = [];
  const result = await smokeCloud('https://fixture.workers.dev', config.HY_API_TOKEN, async (url, options) => {
    requests.push({ path: url.pathname, ...options });
    if (url.pathname === '/read-store') return new Response(null, { status: 404 });
    if (!options.headers.authorization) return new Response(null, { status: 401 });
    return Response.json({ revision: 1 });
  });
  assert.equal(result.modelCalls, false);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.redirect === 'error'));
  await assert.rejects(smokeCloud('http://fixture.test', config.HY_API_TOKEN), /HTTPS/);
});
test('uncertain resource creation is recorded before effect and never blindly replayed', async () => temporary(async directory => {
  await initCloud({ directory, ...installation });
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ installation, steps: { preflight: { status: 'done' } } }));
  let writes = 0;
  const call = async () => { writes++; throw new Error('connection lost after request'); };
  await assert.rejects(deployCloud({ directory, config, call }), /connection lost/);
  const receipt = JSON.parse(await readFile(resolve(directory, 'receipt.json')));
  assert.equal(receipt.steps.r2.status, 'pending');
  assert.equal(JSON.stringify(receipt).includes('secret-'), false);
  await assert.rejects(deployCloud({ directory, config, call }), /uncertain outcome/);
  assert.equal(writes, 1);
  await assert.rejects(deployCloud({ directory, config: { ...config, HY_OWNER_REF: 'changed' }, call }), /configuration changed/);
}));
test('ordered installation keeps gateway private until all secrets and resource tags finish', async () => temporary(async directory => {
  await initCloud({ directory, ...installation });
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ installation, steps: { preflight: { status: 'done' } } }));
  const events = [];
  const call = async (_i, path, options) => {
    events.push(path);
    if (path === 'workers/scripts') return { result: ['engine', 'store', 'gateway'].map(part => ({ id: `fixture-memory-${part}`, tag: `immutable-${part}` })) };
    if (path.startsWith('workers/durable_objects')) return { result: [{ script: 'fixture-memory-store', class: 'MemoryObject', id: 'fixture-namespace' }] };
    if (path.startsWith('tags/resources?')) return { result: [] };
    if (path.startsWith('tags?')) return { result: { tags: { Private: '' } } };
    return { result: {} };
  };
  const tool = async (_command, args, _cwd, input) => {
    const cfg = JSON.parse(await readFile(args.at(-1)));
    events.push({ name: cfg.name, public: cfg.workers_dev, secrets: input ? Object.keys(JSON.parse(input)) : [] });
  };
  assert.equal((await deployCloud({ directory, config, call, tool })).completed, true);
  const publicAt = events.findIndex(event => event.public === true);
  assert.equal(publicAt, events.length - 1);
  assert.ok(events.slice(0, publicAt).some(event => event.secrets?.includes('HY_API_TOKEN')));
  assert.ok(events.slice(0, publicAt).some(event => typeof event === 'string' && event.startsWith('tags?')));
  const count = events.length;
  await deployCloud({ directory, config, call, tool });
  assert.equal(events.length, count);
}));

test('unknown flags never turn a requested dry run into a deployment', async () => {
  await assert.rejects(cloudMain(['deploy', '--dry-run', 'true']), /Unknown/);
  await assert.rejects(cloudMain(['deploy', '--directory', '/tmp/example', '--directory', '/tmp/other']), /duplicate/);
  await assert.rejects(cloudMain(['unknown']), /Usage/);
});
