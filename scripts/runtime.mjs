import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './config.mjs';

// Fixture model interception is supplied only by tests; the CLI always uses main.py.
export async function createRuntime({ config, persistence, port = 8787, fixture = false, outboundService }) {
  await mkdir(persistence, { recursive: true, mode: 0o700 });
  const dist = fileURLToPath(new URL('memory/dist/', root)), engine = fileURLToPath(new URL('engine/', root));
  const modules = {}, pythonModules = {};
  for (const name of await readdir(dist)) {
    if (name.endsWith('.js')) modules[name] = { type: 'esm', contents: await readFile(join(dist, name), 'utf8') };
    if (name.endsWith('.wasm')) modules[name] = { type: 'wasm', contents: await readFile(join(dist, name)) };
  }
  const collect = async (directory, prefix, vendor = false) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === 'lac_small' || entry.name.endsWith('.pyc')) continue;
      if (!vendor && !fixture && /^(fixture_|test_|worker_probe)/.test(entry.name)) continue;
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) await collect(path, name + '/', vendor);
      else if (vendor || entry.name.endsWith('.py')) pythonModules[name] = { type: vendor ? name.startsWith('python_modules/workers/') && entry.name.endsWith('.js') ? 'esm' : 'data' : 'python', contents: await readFile(path) };
    }
  };
  await collect(join(engine, 'src'), '');
  await collect(join(engine, 'python_modules'), 'python_modules/', true);
  const options = convertV4MiniflareOptions({ host: '127.0.0.1', port, resourcePersistencePath: persistence, workers: [
    { name: 'gateway', modules: true, compatibilityDate: '2026-10-19', scriptPath: fileURLToPath(new URL('gateway/worker.mjs', root)),
      bindings: { HY_API_TOKEN: config.HY_API_TOKEN, HY_OWNER_REF: config.HY_OWNER_REF }, serviceBindings: { MEMORY: { name: 'memory', entrypoint: 'MemoryAPI' } } },
    { name: 'memory', modules: true, compatibilityDate: '2026-10-19', scriptPath: join(dist, 'worker.js'),
      durableObjects: { MEMORY: { className: 'MemoryObject', useSQLite: true } }, r2Buckets: ['ORIGINALS'],
      serviceBindings: { HY_ENGINE: { name: 'python-engine' } }, bindings: Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith('MEMORY_') || key === 'CF_ACCOUNT_ID')),
      ...(outboundService ? { outboundService } : {}) },
    { name: 'python-engine', modules: true, compatibilityDate: '2026-10-19', compatibilityFlags: ['python_workers'], script: 'export default {}',
      serviceBindings: { MEMORY_READ: { name: 'memory', entrypoint: 'MemoryReadAPI' } },
      bindings: Object.fromEntries(Object.entries(config).filter(([key]) => /^HY_(LLM|EMBED)_/.test(key))) }
  ] });
  options.workers[1].config.manifest = { mainModule: 'worker.js', modulesRoot: dist, modules };
  options.workers[2].config.manifest = { mainModule: fixture ? 'fixture_worker.py' : 'main.py', modulesRoot: join(engine, 'src'), modules: pythonModules };
  const runtime = new Miniflare(options);
  try {
    await runtime.ready;
    if (!fixture) {
      // Initialize Python imports before advertising readiness; this path never calls a model.
      const python = await runtime.getWorker('python-engine');
      const probe = await python.fetch('https://engine/__startup_probe');
      if (probe.status !== 404) throw new Error('Python engine did not initialize. Run npm run setup.');
    }
    return runtime;
  }
  catch (error) { await runtime.dispose(); throw error; }
}
