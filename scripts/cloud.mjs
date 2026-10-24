// Copyright YY. Licensed under the Apache License, Version 2.0.
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readConfig, stateDir, root } from './config.mjs';
const repository = fileURLToPath(root);
const require = createRequire(import.meta.url);
const names = ['engine-bootstrap', 'engine-secrets', 'store', 'store-secrets', 'engine', 'gateway-private', 'gateway-secrets', 'tags', 'gateway-public'];
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const load = async path => JSON.parse(await readFile(path, 'utf8'));
async function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(json(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function validateInstall(value) {
  if (!/^[a-z][a-z0-9-]{2,35}$/.test(value.name || '')) throw new Error('name must be 3–36 lowercase letters, digits or hyphens, starting with a letter.');
  if (!/^[a-f0-9]{32}$/.test(value.accountId || '')) throw new Error('account must be a 32-character Cloudflare account ID.');
  if (!['personal', 'company'].includes(value.ownership)) throw new Error('Specify ownership personal or company.');
  if (!value.tags || typeof value.tags !== 'object' || Array.isArray(value.tags) || !Object.keys(value.tags).length ||
      Object.entries(value.tags).some(([key, val]) => !key || typeof val !== 'string')) throw new Error('tags must be a nonempty string-valued object.');
  if (value.ownership === 'personal' && value.tags.Private !== '') throw new Error('Personal installations require the native Private key-only tag.');
  if (value.ownership === 'company' && (!value.tags.project || 'Private' in value.tags)) throw new Error('Company installations require a project tag and must not carry Private.');
  return value;
}
export async function initCloud({ directory, name, accountId, ownership, tags }) {
  const installation = validateInstall({ version: 1, name, accountId, ownership, tags: tags || (ownership === 'personal' ? { Private: '' } : undefined) });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, 'installation.json'), json(installation), { flag: 'wx', mode: 0o600 });
  return installation;
}
export function renderCloud(installation, config) {
  const i = validateInstall(installation);
  if (config.CF_ACCOUNT_ID !== i.accountId) throw new Error('Cloud installation account differs from model configuration account.');
  for (const key of ['HY_LLM_URL', 'HY_EMBED_URL']) {
    let endpoint;
    try { endpoint = new URL(config[key]); } catch { throw new Error(`${key} must be an HTTPS endpoint.`); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error(`${key} must be HTTPS without credentials, query or fragment; supply credentials through the key setting.`);
  }
  const common = { account_id: i.accountId, compatibility_date: '2026-10-19', workers_dev: false, preview_urls: false, observability: { enabled: false } };
  const engine = { ...common, name: `${i.name}-engine`, main: resolve(repository, 'engine/src/main.py'), compatibility_flags: ['python_workers'],
    python_modules: { exclude: ['**/*.pyc', 'jieba/lac_small/**'] },
    services: [{ binding: 'MEMORY_READ', service: `${i.name}-store`, entrypoint: 'MemoryReadAPI' }],
    vars: Object.fromEntries(['HY_LLM_URL', 'HY_LLM_MODEL', 'HY_EMBED_URL', 'HY_EMBED_MODEL', 'HY_EMBED_DIMS'].map(k => [k, config[k]])) };
  const store = { ...common, name: `${i.name}-store`, main: resolve(repository, 'memory/src/worker.ts'),
    build: { command: 'node scripts/prepare-mp3.mjs', cwd: resolve(repository, 'memory') },
    find_additional_modules: true, rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }],
    durable_objects: { bindings: [{ name: 'MEMORY', class_name: 'MemoryObject' }] }, migrations: [{ tag: 'hy-media-v1', new_sqlite_classes: ['MemoryObject'] }],
    r2_buckets: [{ binding: 'ORIGINALS', bucket_name: `${i.name}-originals` }], services: [{ binding: 'HY_ENGINE', service: engine.name }],
    vars: Object.fromEntries(['CF_ACCOUNT_ID', 'MEMORY_GATEWAY_ID', 'MEMORY_FORMATION_MODEL', 'MEMORY_TEXT_EMBEDDING_MODEL', 'MEMORY_MEDIA_EMBEDDING_MODEL', 'MEMORY_TEMPORAL_MODEL'].map(k => [k, config[k]])) };
  const gateway = { ...common, name: `${i.name}-gateway`, main: resolve(repository, 'gateway/worker.mjs'),
    services: [{ binding: 'MEMORY', service: store.name, entrypoint: 'MemoryAPI' }], vars: { HY_OWNER_REF: config.HY_OWNER_REF } };
  return { 'engine-bootstrap': { ...engine, services: [] }, engine, store, 'gateway-private': gateway, 'gateway-public': { ...gateway, workers_dev: true } };
}
export function deploymentPlan(installation) {
  const i = validateInstall(installation);
  return { accountId: i.accountId, ownership: i.ownership, tags: i.tags,
    resources: { workers: ['engine', 'store', 'gateway'].map(s => `${i.name}-${s}`), r2: `${i.name}-originals`, durableObject: `${i.name}-store/MemoryObject` },
    steps: ['preflight (reject existing resource names)', 'create R2 bucket', ...names],
    tools: { wrangler: '4.151.0', workersPy: '1.17.9' }, modelCalls: false };
}
export async function api(installation, path, { method = 'GET', body, fetcher = fetch } = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN for deployment (separate from model credentials).');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${installation.accountId}/${path}`, {
    method, redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Cloudflare ${method} ${path.split('?')[0]} returned invalid JSON (${response.status}); outcome may be unknown.`); }
  if (!response.ok || !result.success) throw Object.assign(new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (${response.status}); codes: ${(result.errors || []).map(e => e.code).join(',')}`), { status: response.status });
  return result;
}
async function all(installation, path, call = api) {
  const items = [];
  for (let page = 1; ; page++) {
    const data = await call(installation, `${path}?page=${page}&per_page=100`);
    if (!Array.isArray(data.result)) throw new Error('Expected paginated resource list.');
    items.push(...data.result);
    if (data.result.length === 0 || (Number.isInteger(data.result_info?.total_pages) ? page >= data.result_info.total_pages : data.result.length < 100)) return items;
    if (page >= 1000) throw new Error('Resource pagination exceeded safety limit.');
  }
}
export async function applyTags(installation, resources, call = api) {
  for (const resource of resources) {
    // List by exact ID avoids treating the beta's ambiguous GET /tags 500 as an empty tag set.
    const matches = [];
    const seen = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({ id: resource.resource_id, ...(cursor ? { cursor } : {}) });
      const page = await call(installation, `tags/resources?${query}`);
      if (!Array.isArray(page.result)) throw new Error('Unexpected tagged resource list.');
      matches.push(...page.result.filter(item => item.id === resource.resource_id && item.type === resource.resource_type));
      cursor = page.result_info?.cursor;
      if (cursor && seen.has(cursor)) throw new Error('Resource Tagging pagination repeated a cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (matches.length > 1 || (!matches.length && !resource.createdByInstallation)) throw new Error('Cannot establish existing resource tags.');
    const tags = matches[0]?.tags || {};
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) throw new Error('Unexpected Resource Tagging response.');
    const { createdByInstallation, ...identity } = resource;
    const merged = { ...tags, ...installation.tags };
    await call(installation, 'tags', { method: 'PUT', body: { ...identity, tags: merged } });
    const actual = (await call(installation, `tags?${new URLSearchParams(identity)}`)).result.tags;
    if (Object.entries(merged).some(([k, v]) => actual?.[k] !== v)) throw new Error(`Native resource tags failed readback for ${resource.resource_type}.`);
  }
}
async function runTool(command, args, cwd, input, { accountId } = {}) {
  // Do not echo subprocess output: provider errors can include secrets or request material.
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}), PATH: [dirname(process.execPath), ...(command.includes('/') || command.includes('\\') ? [dirname(command)] : []), process.env.PATH || ''].join(delimiter), WRANGLER_SEND_METRICS: 'false' }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => reject(new Error('Deployment tool could not start; check pinned Wrangler, uv and workers-py installation.')));
    child.on('close', code => code === 0 ? accept() : reject(new Error(`Deployment tool exited ${code}; inspect Cloudflare state before reconciling this step. Output suppressed to protect credentials.`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function checkpoint(directory, receipt, step, operation) {
  if (receipt.steps[step]?.status === 'done') return;
  if (receipt.steps[step]) throw new Error(`Step ${step} has an uncertain outcome. Inspect remote state and use reconcile; no automatic replay.`);
  receipt.steps[step] = { status: 'pending', startedAt: new Date().toISOString() };
  await save(resolve(directory, 'receipt.json'), receipt);
  await operation();
  receipt.steps[step] = { status: 'done', completedAt: new Date().toISOString() };
  await save(resolve(directory, 'receipt.json'), receipt);
}
export async function deployCloud({ directory, config, call = api, tool = runTool }) {
  const installation = validateInstall(await load(resolve(directory, 'installation.json')));
  const configs = renderCloud(installation, config);
  const lock = resolve(directory, 'deploy.lock');
  const handle = await open(lock, 'wx', 0o600).catch(() => { throw new Error('Deployment lock exists. Confirm the previous deploy process stopped before removing deploy.lock.'); });
  try {
    let receipt;
    try { receipt = await load(resolve(directory, 'receipt.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; receipt = { installation, steps: {} }; }
    if (receipt.configs && JSON.stringify(receipt.configs) !== JSON.stringify(configs)) throw new Error('Deployment configuration changed since deployment began; restore the original configuration before resuming.');
    receipt.configs = configs;
    if (JSON.stringify(receipt.installation) !== JSON.stringify(installation)) throw new Error('Installation differs from receipt; use a new installation directory.');
    const wranglerPackage = require.resolve('wrangler/package.json');
    const wrangler = resolve(dirname(wranglerPackage), 'bin/wrangler.js');
    const deploy = async key => {
      const path = resolve(directory, `${key}.json`);
      await save(path, configs[key]);
      if (key.startsWith('engine')) await tool(process.env.UV || 'uv', ['tool', 'run', '--from', 'workers-py==1.17.9', 'pywrangler', 'deploy', '--config', path], resolve(repository, 'engine'), undefined, { accountId: installation.accountId });
      else await tool(process.execPath, [wrangler, 'deploy', '--config', path], repository, undefined, { accountId: installation.accountId });
    };
    const secrets = async (key, values) => {
      const path = resolve(directory, `${key}.json`);
      await save(path, configs[key]);
      await tool(process.execPath, [wrangler, 'secret', 'bulk', '--config', path], repository, JSON.stringify(values), { accountId: installation.accountId });
    };
    if (!receipt.steps.preflight) {
      const workers = (await call(installation, 'workers/scripts')).result;
      if (!Array.isArray(workers)) throw new Error('Unexpected Worker script list.');
      const namespaces = await all(installation, 'workers/durable_objects/namespaces', call);
      let bucketExists = false;
      try { await call(installation, `r2/buckets/${installation.name}-originals`); bucketExists = true; } catch (error) { if (error.status !== 404) throw error; }
      if (workers.some(w => deploymentPlan(installation).resources.workers.includes(w.id)) || bucketExists || namespaces.some(n => n.script === `${installation.name}-store`)) throw new Error('Resource name collision; choose a new installation name. Existing resources are never adopted.');
      const version = await load(wranglerPackage);
      if (version.version !== '4.151.0') throw new Error('Run npm ci to install pinned Wrangler 4.151.0.');
      receipt.steps.preflight = { status: 'done' };
      await save(resolve(directory, 'receipt.json'), receipt);
    }
    await checkpoint(directory, receipt, 'r2', () => call(installation, 'r2/buckets', { method: 'POST', body: { name: `${installation.name}-originals` } }));
    await checkpoint(directory, receipt, 'engine-bootstrap', () => deploy('engine-bootstrap'));
    await checkpoint(directory, receipt, 'engine-secrets', () => secrets('engine', { HY_LLM_KEY: config.HY_LLM_KEY, HY_EMBED_KEY: config.HY_EMBED_KEY }));
    await checkpoint(directory, receipt, 'store', () => deploy('store'));
    await checkpoint(directory, receipt, 'store-secrets', () => secrets('store', { MEMORY_MODEL_TOKEN: config.MEMORY_MODEL_TOKEN }));
    await checkpoint(directory, receipt, 'engine', () => deploy('engine'));
    await checkpoint(directory, receipt, 'gateway-private', () => deploy('gateway-private'));
    await checkpoint(directory, receipt, 'gateway-secrets', () => secrets('gateway-private', { HY_API_TOKEN: config.HY_API_TOKEN }));
    await checkpoint(directory, receipt, 'tags', async () => {
      const namespaces = await all(installation, 'workers/durable_objects/namespaces', call);
      const workers = (await call(installation, 'workers/scripts')).result;
      if (!Array.isArray(workers)) throw new Error('Unexpected Worker script list.');
      const workerResources = deploymentPlan(installation).resources.workers.map(name => {
        const worker = workers.find(item => item.id === name);
        if (!worker?.tag) throw new Error('Could not resolve immutable Worker ID for native resource tagging.');
        return { resource_type: 'worker', resource_id: worker.tag, createdByInstallation: true };
      });
      const namespace = namespaces.find(n => n.script === `${installation.name}-store` && n.class === 'MemoryObject');
      if (!namespace?.id) throw new Error('Could not identify the MemoryObject namespace for native tagging.');
      await applyTags(installation, [
        ...workerResources,
        { resource_type: 'r2_bucket', resource_id: `${installation.name}-originals`, createdByInstallation: true },
        { resource_type: 'durable_object_namespace', resource_id: namespace.id, createdByInstallation: true },
      ], call);
    });
    await checkpoint(directory, receipt, 'gateway-public', () => deploy('gateway-public'));
    return { completed: true, next: 'Run cloud smoke --url https://YOUR-GATEWAY.YOUR-SUBDOMAIN.workers.dev; no models have been called.' };
  } finally { await handle.close(); await unlink(lock); }
}
export async function smokeCloud(url, token, fetcher = fetch) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Smoke URL must be an HTTPS origin.');
  const request = (path, authorized) => fetcher(new URL(path, base), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: '{}', signal: AbortSignal.timeout(30000) });
  const unauth = await request('/revision', false);
  if (unauth.status !== 401) throw new Error(`Expected unauthenticated 401, got ${unauth.status}.`);
  const internal = await request('/read-store', true);
  if (internal.status !== 404) throw new Error('Internal callback is not blocked.');
  const revision = await request('/revision', true);
  const body = await revision.json();
  if (!revision.ok || !Number.isSafeInteger(body.revision) || body.revision < 1) throw new Error('Authenticated gateway → MemoryAPI → Durable Object revision smoke failed.');
  return { ok: true, modelCalls: false, checked: ['unauthenticated 401', 'private callback 404', 'authenticated durable revision'], untested: ['engine/model calls', 'media upload/R2 processing'] };
}
export async function cloudMain(args) {
  const [command, ...rest] = args;
  const options = {};
  const allowed = { init: ['name', 'account', 'ownership', 'tags', 'directory'], plan: ['directory'], render: ['directory'], status: ['directory'], deploy: ['directory'], smoke: ['url', 'directory'], reconcile: ['step', 'outcome', 'evidence', 'directory'] }[command];
  if (!allowed) throw new Error('Usage: cloud init|plan|render|deploy|status|smoke|reconcile [--key value]. See docs/DEPLOY.md.');
  for (let n = 0; n < rest.length; n += 2) {
    if (!/^--[a-z-]+$/.test(rest[n]) || rest[n + 1] === undefined) throw new Error('Cloud arguments must be --key value pairs.');
    const key = rest[n].slice(2);
    if (!allowed.includes(key) || key in options || rest[n + 1].startsWith('--')) throw new Error(`Unknown, duplicate or missing cloud option: ${rest[n]}`);
    options[key] = rest[n + 1];
  }
  const directory = resolve(options.directory || resolve(stateDir(), 'cloud'));
  if (command === 'render') {
    const configs = renderCloud(await load(resolve(directory, 'installation.json')), await readConfig());
    for (const [key, config] of Object.entries(configs)) await save(resolve(directory, `${key}.json`), config);
    return { rendered: Object.keys(configs), directory, remoteChanges: false };
  }
  if (command === 'init') return initCloud({ directory, name: options.name, accountId: options.account, ownership: options.ownership, tags: options.tags ? JSON.parse(options.tags) : undefined });
  if (command === 'plan') return deploymentPlan(await load(resolve(directory, 'installation.json')));
  if (command === 'status') { try { return await load(resolve(directory, 'receipt.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; return { started: false }; } }
  if (command === 'deploy') return deployCloud({ directory, config: await readConfig() });
  if (command === 'smoke') return smokeCloud(options.url, (await readConfig()).HY_API_TOKEN);
  if (command === 'reconcile') {
    if (!options.step || !options.evidence || !['done', 'absent'].includes(options.outcome)) throw new Error('Reconcile needs --step NAME --outcome done|absent --evidence operator-verification-note. Never include credentials.');
    try { const lock = await open(resolve(directory, 'deploy.lock'), 'wx', 0o600); await lock.close(); } catch { throw new Error('Deployment is locked. Confirm the deploy process stopped first.'); }
    try {
      const receipt = await load(resolve(directory, 'receipt.json'));
      if (receipt.steps[options.step]?.status !== 'pending') throw new Error('Only uncertain pending steps can be reconciled.');
      receipt.reconciliations ||= [];
      receipt.reconciliations.push({ step: options.step, outcome: options.outcome, evidence: options.evidence, at: new Date().toISOString() });
      if (options.outcome === 'done') receipt.steps[options.step] = { status: 'done', operatorVerified: true };
      else delete receipt.steps[options.step];
      await save(resolve(directory, 'receipt.json'), receipt);
      return { reconciled: options.step, outcome: options.outcome };
    } finally { await unlink(resolve(directory, 'deploy.lock')); }
  }
  throw new Error('Usage: cloud init|plan|render|deploy|status|smoke|reconcile [--key value]. See docs/DEPLOY.md.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cloudMain(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
