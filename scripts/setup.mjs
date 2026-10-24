import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { root } from './config.mjs';
export async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.once('error', error => reject(error.code === 'ENOENT' ? new Error(`${command} not found. Install uv >= 0.13.4 (https://docs.astral.sh/uv/getting-started/installation/).`) : error));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}.`)));
  });
}
export async function setup({ force = false } = {}) {
  const engine = fileURLToPath(new URL('engine/', root));
  let ready = false;
  try { await access(new URL('engine/python_modules/workers/__init__.py', root)); ready = true; } catch {}
  if (force || !ready) {
    const mirror = process.env.HY_PYODIDE_MIRROR;
    if (mirror) await run(process.env.UV || 'uv', ['python', 'install', 'cpython-3.14.2-emscripten-wasm32-musl', '--pyodide-mirror', mirror], engine);
    await run(process.env.UV || 'uv', ['tool', 'run', '--from', 'workers-py==1.17.9', 'pywrangler', 'sync', '--allow-build'], engine);
  }
  await run(process.execPath, [fileURLToPath(new URL('memory/build.mjs', root))], fileURLToPath(root));
}
