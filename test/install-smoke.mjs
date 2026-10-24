import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { modelFixture } from './model-fixture.mjs';
const packageRoot = resolve(process.env.HY_PACKAGE_ROOT || '.');
const home = await mkdtemp(join(tmpdir(), 'hy-omni-acceptance-'));
const cli = join(packageRoot, 'scripts/cli.mjs');
const exec = async args => {
  const child = spawn(process.execPath, [cli, ...args], { cwd: packageRoot, env: { ...process.env, HY_HOME: home }, stdio: 'inherit' });
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
};
let child, runtime;
try {
  await exec(['init']);
  const configPath = join(home, 'config.json');
  const values = JSON.parse(await readFile(configPath, 'utf8'));
  Object.assign(values, { CF_ACCOUNT_ID: 'synthetic-account', MEMORY_GATEWAY_ID: 'synthetic-gateway', MEMORY_MODEL_TOKEN: 'synthetic-token' });
  await writeFile(configPath, JSON.stringify(values));
  process.env.HY_HOME = home;
  const { readConfig } = await import(pathToFileURL(join(packageRoot, 'scripts/config.mjs')));
  const config = await readConfig();
  // Exercise the actual public startup command with production main.py.
  child = spawn('npm', ['start'], { cwd: packageRoot, detached: true, env: { ...process.env, PORT: '18787' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  const exit = once(child, 'exit');
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`npm start exited: ${log}`);
    if (log.includes('HY-memory-omni listening')) { ready = true; break; }
    await delay(1000);
  }
  assert.ok(ready, `Startup timeout: ${log}`);
  assert.equal((await fetch('http://127.0.0.1:18787/health')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:18787/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const empty = await fetch('http://127.0.0.1:18787/sources', { method: 'POST', headers: { Authorization: `Bearer ${config.HY_API_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(empty.status, 200, await empty.text());
  process.kill(-child.pid, 'SIGTERM'); await exit; child = undefined;
  for (let i = 0; i < 100; i++) {
    try { await access(join(home, 'runtime.lock')); } catch { break; }
    await delay(100);
  }
  await assert.rejects(access(join(home, 'runtime.lock')));
  console.log('PASS npm start: production Python entry loaded, health/auth/persistent store reachable, clean shutdown.');

  if (process.env.HY_STARTUP_ONLY !== '1') {
  const { createRuntime } = await import(pathToFileURL(join(packageRoot, 'scripts/runtime.mjs')));
  const persistence = join(home, 'fixture-storage');
  const start = () => createRuntime({ config, persistence, port: 0, fixture: true, outboundService: modelFixture });
  runtime = await start();
  const api = async (path, body) => {
    const response = await runtime.dispatchFetch(`https://memory.test${path}`, { method: 'POST', headers: { Authorization: `Bearer ${config.HY_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=';
  for (const [id, mimeType, dataBase64, text] of [
    ['text', 'text/plain', null, 'The test meeting is on Saturday.'],
    ['image', 'image/png', image],
    ['audio', 'audio/wav', (await readFile(new URL('../memory/test/fixtures/tone.wav', import.meta.url))).toString('base64')],
    ['video', 'video/mp4', (await readFile(new URL('../memory/test/fixtures/blue-tone.mp4', import.meta.url))).toString('base64')],
  ]) {
    const first = await api(text ? '/ingest-text' : '/ingest', { operationId: `create-${id}`, sessionRef: 'session-a', messageRef: id,
      ...(text ? { text } : { mimeType, dataBase64 }), principal: { ownerRef: 'attacker', scopeRef: 'work' } });
    assert.equal(first.state, 'active');
    await runtime.dispose(); runtime = await start();
    const recall = await api('/search', { query: 'Find the test source', sessionRef: 'session-b' });
    assert.ok(recall.items.length > 0, id);
    const read = await api('/read', { ref: first.ref });
    if (dataBase64) assert.equal(read.dataBase64, dataBase64);
    const corrected = await api('/correct', { ref: first.ref, text: 'Corrected fixture observation.', operationId: `correct-${id}` });
    assert.equal((await api('/validate', { refs: [first.ref] })).valid, false);
    await api('/revoke', { ref: corrected.ref, operationId: `revoke-${id}` });
    assert.equal((await api('/validate', { refs: [corrected.ref] })).valid, false);
    assert.deepEqual((await api('/search', { query: 'Find the test source', sessionRef: 'session-c' })).items, []);
    console.log(`PASS ${id}: authenticated ingest, restart, Hy retrieval, original read, correction, revocation.`);
  }
  const upload = await api('/video/upload', { mimeType: 'video/mp4' });
  const bytes = await readFile(new URL('../memory/test/fixtures/blue-tone.mp4', import.meta.url));
  const part = await runtime.dispatchFetch('https://memory.test/video/part', { method: 'POST', headers: { Authorization: `Bearer ${config.HY_API_TOKEN}`, 'memory-upload': upload.uploadId, 'memory-part': '1', 'content-length': String(bytes.byteLength), 'memory-principal': '{"ownerRef":"attacker"}' }, body: bytes });
  assert.equal(part.status, 200, await part.text());
  await api('/video/abort-upload', { uploadId: upload.uploadId });
  assert.equal((await runtime.dispatchFetch('https://memory.test/read-store', { method: 'POST' })).status, 404);
  console.log('PASS raw video upload and private callback boundary. Model HTTP was synthetic; no live-model quality claim.');
  }
} finally {
  if (child?.pid) process.kill(-child.pid, 'SIGTERM');
  if (runtime) await runtime.dispose();
  await rm(home, { recursive: true, force: true });
}
