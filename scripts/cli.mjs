#!/usr/bin/env node
import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { root, stateDir, readConfig } from './config.mjs';
import { setup } from './setup.mjs';
const command = process.argv[2] || 'start';
async function main() {
  if (command === 'init') {
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    const config = JSON.parse(await readFile(new URL('config.example.json', root), 'utf8'));
    config.HY_API_TOKEN = randomBytes(32).toString('hex');
    await writeFile(resolve(stateDir(), 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Created ${resolve(stateDir(), 'config.json')}. Set the three REPLACE_ values, then run npm start. Your API token is in that file.`);
    return;
  }
  if (command === 'setup') { await setup({ force: true }); console.log('Runtime dependencies and Worker bundle ready.'); return; }
  if (command !== 'start') throw new Error('Usage: hy-memory-omni [init|setup|start]');
  const config = await readConfig();
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  // A second process must never open the same SQLite/R2 state concurrently.
  const lockPath = resolve(stateDir(), 'runtime.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('This state directory is locked. Stop its running instance. After an unclean exit, verify it is stopped before removing runtime.lock.'); throw error; }
  let child;
  let stopping = false;
  let stopTimer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'stop' }, () => {});
      // Request termination if initialization is stuck. Wait for
      // actual child exit before releasing it, including signal shutdown.
      stopTimer = setTimeout(() => {
        child.kill('SIGTERM');
      }, 10000);
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await lock.writeFile(`${process.pid}\n`);
    await setup();
    if (stopping) return;
    // The supervisor must never load Miniflare: its process exit hook can exit
    // synchronously on a signal before async lock cleanup finishes.
    child = fork(new URL('./server.mjs', import.meta.url), [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    const completion = new Promise((resolveChild, rejectChild) => {
      let startupError;
      child.on('message', message => {
        if (message?.type === 'ready' && !stopping) {
          console.log(`HY-memory-omni listening at http://127.0.0.1:${port} (authenticated API; persistent local Workers storage).`);
        } else if (message?.type === 'error') {
          startupError = new Error('Runtime startup failed. Run npm run setup and verify local runtime dependencies.');
        }
      });
      child.once('error', () => rejectChild(new Error('Could not start the runtime process.')));
      child.once('exit', (code, signal) => {
        if (stopping) resolveChild();
        else if (startupError) rejectChild(startupError);
        else rejectChild(new Error(`Runtime process exited unexpectedly (${signal || code}).`));
      });
    });
    child.send({ type: 'start', config, persistence: resolve(stateDir(), 'storage'), port }, error => {
      if (error && !stopping) child.kill('SIGTERM');
    });
    await completion;
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    clearTimeout(stopTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try { await lock.close(); } finally { await unlink(lockPath); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
