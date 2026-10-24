import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { root } from './config.mjs';
export async function run(command, args, cwd, { signal } = {}) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    // Own a separate group so cancellation reaches uv's build subprocesses too.
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env, detached: grouped });
    let failure;
    let cancellation;
    const uncertain = () => Object.assign(new Error('Cannot confirm runtime preparation processes stopped. Keep runtime.lock and manually confirm the previous instance has stopped before recovery.'), { retainLock: true });
    const terminate = sig => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const groupExists = () => {
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const abort = () => {
      if (cancellation) return;
      cancellation = (async () => {
        try {
          terminate('SIGTERM');
          if (!grouped || !child.pid) return;
          const deadline = Date.now() + 10000;
          while (groupExists()) {
            if (Date.now() >= deadline) {
              terminate('SIGKILL');
              const killDeadline = Date.now() + 1000;
              while (groupExists()) {
                if (Date.now() >= killDeadline) return uncertain();
                await delay(50);
              }
              return;
            }
            await delay(50);
          }
        } catch { return uncertain(); }
      })();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => {
      failure = error.code === 'ENOENT'
        ? new Error('Runtime tool not found. Install uv >= 0.13.4 (https://docs.astral.sh/uv/getting-started/installation/).')
        : error;
    });
    // Abort must not settle this promise before the process actually closes.
    child.once('close', async (code, exitSignal) => {
      const cancellationError = await cancellation;
      signal?.removeEventListener('abort', abort);
      if (cancellationError) reject(cancellationError);
      else if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`Runtime preparation failed (${exitSignal || code}). Review the tool output above; for Pyodide download failures, see HY_PYODIDE_MIRROR in README.`));
    });
    if (signal?.aborted) abort();
  });
}
export async function setup({ force = false, signal } = {}) {
  signal?.throwIfAborted();
  const engine = fileURLToPath(new URL('engine/', root));
  let ready = false;
  try { await access(new URL('engine/python_modules/workers/__init__.py', root)); ready = true; } catch {}
  if (force || !ready) {
    const mirror = process.env.HY_PYODIDE_MIRROR;
    if (mirror) await run(process.env.UV || 'uv', ['python', 'install', 'cpython-3.14.2-emscripten-wasm32-musl', '--pyodide-mirror', mirror], engine, { signal });
    await run(process.env.UV || 'uv', ['tool', 'run', '--from', 'workers-py==1.17.9', 'pywrangler', 'sync', '--allow-build'], engine, { signal });
  }
  await run(process.execPath, [fileURLToPath(new URL('memory/build.mjs', root))], fileURLToPath(root), { signal });
}
