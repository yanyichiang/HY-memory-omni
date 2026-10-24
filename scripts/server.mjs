// Copyright YY. Licensed under the Apache License, Version 2.0.
// Isolate Miniflare's process-level exit hooks from the state-lock supervisor.
let runtime;
let starting;
let stopping = false;
function report(type) {
  if (process.connected) process.send({ type }, () => {});
}
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await starting;
    if (runtime) await runtime.dispose();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.on('message', message => {
  if (message?.type === 'stop') { void stop(); return; }
  if (message?.type !== 'start' || starting || stopping) return;
  starting = (async () => {
    const { createRuntime } = await import('./runtime.mjs');
    runtime = await createRuntime({ config: message.config, persistence: message.persistence, port: message.port });
    if (!stopping) report('ready');
  })();
  starting.catch(() => {
    // Never send exception text/stacks or configuration over diagnostics.
    report('error');
    process.exit(1);
  });
});
process.on('disconnect', () => { void stop(); });
