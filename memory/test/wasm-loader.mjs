// Node-only test adapter for the precompiled modules statically imported by workerd.
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
registerHooks({load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.wasm')) return next(url, context);
  const base64 = readFileSync(new URL(url)).toString('base64');
  return {format: 'module', source: `export default new WebAssembly.Module(Buffer.from('${base64}', 'base64'));`, shortCircuit: true};
}});
