import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { run, setup } from '../scripts/setup.mjs';

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'hy-setup-test-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function waitFor(path) {
  for (let i = 0; i < 100; i++) {
    try { await access(path); return; } catch { await delay(20); }
  }
  assert.fail('Fixture did not become ready');
}

test('already aborted commands and setup never spawn a process', async () => fixture(async directory => {
  const marker = join(directory, 'spawned');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`], directory, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(setup({ force: true, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(access(marker));
}));

test('cancellation waits for actual child shutdown and stops later setup stages', async () => fixture(async directory => {
  const executable = join(directory, 'uv-fixture.cjs');
  const calls = join(directory, 'calls');
  const ready = join(directory, 'ready');
  const stopped = join(directory, 'stopped');
  await writeFile(executable, `#!${process.execPath}\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');\nprocess.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, 'done'); process.exit(0); }, 150));\nfs.writeFileSync(${JSON.stringify(ready)}, 'ready');\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const previous = { UV: process.env.UV, HY_PYODIDE_MIRROR: process.env.HY_PYODIDE_MIRROR };
  process.env.UV = executable; process.env.HY_PYODIDE_MIRROR = 'fixture-mirror';
  const controller = new AbortController();
  try {
    const pending = setup({ force: true, signal: controller.signal });
    // Attach rejection handling before delivering cancellation.
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitFor(ready); controller.abort();
    await rejected;
    assert.equal(await readFile(stopped, 'utf8'), 'done');
    assert.equal(await readFile(calls, 'utf8'), 'call\n');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}));

test('command failure reports status without arguments and missing tools are actionable', async () => fixture(async directory => {
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)', 'private-argument'], directory), error => {
    assert.match(error.message, /failed \(7\)/); assert.doesNotMatch(error.message, /private-argument/); return true;
  });
  await assert.rejects(run(join(directory, 'missing'), [], directory), /Install uv >= 0.13.4/);
}));

test('cancellation reaches descendants in the command owned process group', { skip: process.platform === 'win32' }, async () => fixture(async directory => {
  const ready = join(directory, 'descendant-ready');
  const stopped = join(directory, 'descendant-stopped');
  const descendant = `const fs = require('fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); }); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;
  const script = `const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); process.on('SIGTERM', () => {}); child.on('exit', () => process.exit(0));`;
  const controller = new AbortController();
  const pending = assert.rejects(run(process.execPath, ['-e', script], directory, { signal: controller.signal }), { name: 'AbortError' });
  await waitFor(ready); controller.abort(); await pending;
  assert.equal(await readFile(stopped, 'utf8'), 'stopped');
}));

for (const command of ['start', 'setup', 'start-orphan']) {
  test(`CLI ${command} handles parent-only SIGTERM and awaits preparation exit`, async () => fixture(async directory => {
    const scripts = join(directory, 'scripts');
    const engine = join(directory, 'engine');
    const home = join(directory, 'state');
    await mkdir(scripts); await mkdir(engine); await mkdir(home);
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    for (const name of ['cli.mjs', 'config.mjs', 'setup.mjs']) {
      await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(scripts, name));
    }
    const config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
    Object.assign(config, { HY_API_TOKEN: 'synthetic-test-token-00000000000000', CF_ACCOUNT_ID: 'synthetic', MEMORY_GATEWAY_ID: 'synthetic', MEMORY_MODEL_TOKEN: 'synthetic' });
    await writeFile(join(directory, 'config.example.json'), JSON.stringify(config));
    await writeFile(join(home, 'config.json'), JSON.stringify(config));
    const ready = join(directory, 'ready');
    const stopping = join(directory, 'stopping');
    const stopped = join(directory, 'stopped');
    const executable = join(directory, 'uv-fixture.cjs');
    const orphan = command === 'start-orphan';
    const descendantPidFile = join(directory, 'descendant-pid');
    await writeFile(executable, `#!${process.execPath}\nconst fs = require('fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopping)}, 'stopping'); setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); }, 400); }); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`, { mode: 0o700 });
    if (orphan) {
      const descendant = `const fs = require('fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid)); fs.writeFileSync(${JSON.stringify(ready)}, String(process.ppid)); setInterval(() => {}, 1000);`;
      await writeFile(executable, `#!${process.execPath}\nconst fs = require('fs'); require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopping)}, 'stopping'); process.exit(0); });`);
    }
    const child = spawn(process.execPath, [join(scripts, 'cli.mjs'), orphan ? 'start' : command], { cwd: directory, env: { ...process.env, HY_CONFIG: join(home, 'config.json'), HY_HOME: home, UV: executable, HY_PYODIDE_MIRROR: 'fixture' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = ''; child.stderr.on('data', data => { diagnostic += data; });
    const exit = once(child, 'exit');
    let fixturePid;
    try {
      await waitFor(ready);
      fixturePid = Number(await readFile(ready, 'utf8'));
      const lock = join(home, 'runtime.lock');
      if (command !== 'setup') await access(lock);
      child.kill('SIGTERM');
      await waitFor(stopping);
      assert.equal(child.exitCode, null);
      if (command !== 'setup') await access(lock);
      if (orphan) {
        const descendantPid = Number(await readFile(descendantPidFile, 'utf8'));
        await delay(200);
        assert.equal(child.exitCode, null);
        await access(lock);
        process.kill(descendantPid, 0);
        const [code, signal] = await exit;
        assert.equal(signal, null);
        if (code === 0) {
          await assert.rejects(access(lock));
          assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
        } else {
          assert.equal(code, 1);
          await access(lock);
          assert.match(diagnostic, /Cannot confirm.*manually confirm/);
        }
        fixturePid = undefined;
        return;
      }
      const [code, signal] = await exit;
      assert.equal(code, 0); assert.equal(signal, null);
      assert.equal(await readFile(stopped, 'utf8'), 'stopped');
      assert.throws(() => process.kill(fixturePid, 0), { code: 'ESRCH' });
      fixturePid = undefined;
      await assert.rejects(access(lock));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (fixturePid) {
        try { process.kill(-fixturePid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }));
}
