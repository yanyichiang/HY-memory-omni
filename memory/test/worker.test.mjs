import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('real Worker entrypoint + SQLite DO + R2 preserve source through restart, correction and deletion', { timeout: process.env.HY_ENGINE_PYTHON_DIR ? 300000 : 60000 }, async () => {
  const persistence = await mkdtemp(join(tmpdir(), 'hy-media-worker-'));
  const principal = { ownerRef: 'fixture-owner', scopeRef: 'personal' };
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=';
  const engine = async request => {
    if (process.env.HY_ENGINE_FIXTURE_URL) {
      const target = new URL(process.env.HY_ENGINE_FIXTURE_URL);
      if (target.hostname !== '127.0.0.1') throw new Error('combined fixture must be loopback');
      return fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: await request.text() });
    }
    const body = await request.json();
    if (body.operation === 'search') {
      assert.equal(body.nodes,undefined,'search receives an authorized read view, not the entire node library');
      const callback=await mf.getWorker('read-caller');
      const response=await callback.fetch('https://memory/read-store',{method:'POST',body:JSON.stringify({
        principal:body.principal,revision:body.readStore.revision,method:'list_by_user',
        args:{user_id:body.principal.ownerRef,agent_id:body.principal.scopeRef,pageSize:64,layers:['l2_fact'],status_filter:['active'],only_latest:true}})});
      const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
      assert.equal(result.result.nextCursor,null,'fixture data fits a single read page');
      return Response.json({success:true,memories:result.result.rows.map(row=>({memory_id:row.payload.node_id})),
        retrievalCoverage:{exhaustive:result.coverage.exhaustive,calls:[result.coverage]}});
    }
    return Response.json({ success: true, nodes: [...body.nodes, { payload: { node_id: body.requestId, user_id: body.principal.ownerRef,
      agent_id: body.principal.scopeRef, content: body.content, layer: 'l2_fact', status: 'active', is_latest: true, custom: { meta: [{ sourceRef: body.sourceRef }] } }, embedding: [1, 0, 0], lexicalTokens:['fixture','observation'] }] });
  };
  const outbound = async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/chat/completions')) {
      const body = await request.json();
      let content = 'A red badge marked 17.';
      if (body.messages[0].content.startsWith('Verify image retrieval')) {
        content = JSON.stringify({ matches: true, text: 'Visible fixture badge.', correctionRelevant: false });
      } else if (body.messages[0].content.startsWith('Project the supplied current Hy L2 memories')) {
        const input = JSON.parse(body.messages[1].content);
        assert.ok(input.nodes.length);
        content = JSON.stringify({ claims: [{ key: 'observed', nodeId: input.nodes[0].nodeId, text: input.perception.text,
          subject: 'Source observation', event: 'This recording', predicate: 'description', value: input.perception.text,
          validTime: '', conditions: '', quote: input.perception.text }] });
      } else if (body.messages[0].content.startsWith('Assess EACH supplied ordered pair')) {
        const input = JSON.parse(body.messages[1].content);
        content = JSON.stringify({ relations: input.pairs.map(({ left, right }) => ({ left: left.id, right: right.id,
          kind: 'different', reason: 'Independent fixture sources.' })) });
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    }
    if (url.pathname.endsWith(':embedContent')) return Response.json({ embedding: { values: [1, ...Array(1535).fill(0)] } });
    if (url.pathname.endsWith('/ai/run')) {
      const envelope = await request.json();
      assert.equal(envelope.model, 'google/gemini-2.5-flash');
      const body = envelope.input;
      const schema = body.generationConfig.responseSchema;
      if (schema?.properties.windows || schema?.properties.matches) {
        const ids = body.contents[0].parts.flatMap(part => /^SOURCE WINDOW (w\d+)\./.exec(part.text ?? '')?.slice(1) ?? []);
        assert.ok(ids.length);
        const items = ids.map(id => ({ id, text: 'An audible synthetic tone.' }));
        const answer = schema.properties.windows ? { windows: items } : { matches: items, correctionRelevant: false };
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer) }] } }] });
      }
      const native = body.contents[0].parts[0].inlineData;
      assert.ok(native.data.length > 100);
      const audioOnly = native.mimeType.startsWith('audio/');
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: body.generationConfig.responseSchema
        ? JSON.stringify({ correctionRelevant: false, intervals: [{ startMs: 100, endMs: 800, text: 'A blue frame and a synthetic tone.', modalities: audioOnly ? ['audio'] : ['video', 'audio'] }] })
        : 'A blue frame and a synthetic tone.' }] } }] });
    }
    throw new Error(`unexpected outbound ${url.pathname}`);
  };
  const directory = new URL('../dist/', import.meta.url), modules = {};
  for (const name of await readdir(directory)) {
    if (name.endsWith('.js')) modules[name] = { type: 'esm', contents: await readFile(new URL(name, directory), 'utf8') };
    if (name.endsWith('.wasm')) modules[name] = { type: 'wasm', contents: await readFile(new URL(name, directory)) };
  }
  // Optional real Python/workerd arm. The fixture entrypoint replaces only
  // model HTTP with MockTransport; production main.py and named callback run.
  let pythonManifest;
  if(process.env.HY_ENGINE_PYTHON_DIR) {
    const root=process.env.HY_ENGINE_PYTHON_DIR, pythonModules={};
    const collect=async(base,prefix,vendor=false)=>{
      for(const entry of await readdir(base,{withFileTypes:true})) {
        if(entry.name==='__pycache__'||entry.name==='lac_small'||entry.name.endsWith('.pyc'))continue;
        const path=join(base,entry.name),name=prefix+entry.name;
        if(entry.isDirectory())await collect(path,name+'/',vendor);
        else if(vendor || entry.name.endsWith('.py'))pythonModules[name]={
          type:vendor ? name.startsWith('python_modules/workers/')&&entry.name.endsWith('.js')?'esm':'data':'python',
          contents:await readFile(path)};
      }
    };
    await collect(join(root,'src'),'');await collect(join(root,'python_modules'),'python_modules/',true);
    pythonManifest={mainModule:'fixture_worker.py',modulesRoot:join(root,'src'),modules:pythonModules};
  }
  const create = () => {
    const options = convertV4MiniflareOptions({ resourcePersistencePath: persistence, workers: [
    { name: 'caller', modules: true, compatibilityDate: '2026-10-19', script: 'export default {fetch(request, env) { return env.MEMORY.fetch(request); }}',
      serviceBindings: { MEMORY: { name: 'memory', entrypoint: 'MemoryAPI' } } },
    {name:'read-caller',modules:true,compatibilityDate:'2026-10-19',script:`let methods=[],covered=0;export default {async fetch(request,env){
        if(new URL(request.url).pathname==='/__fixture-callbacks')return Response.json({methods,covered});
        const body=await request.clone().json();methods.push(body.method);
        const response=await env.MEMORY_READ.fetch(request);
        const result=await response.clone().json();if(result.coverage&&typeof result.coverage.exhaustive==='boolean')covered++;
        return response;
      }}`,
      serviceBindings:{MEMORY_READ:{name:'memory',entrypoint:'MemoryReadAPI'}}},
    { name: 'memory', modules: true, compatibilityDate: '2026-10-19', scriptPath: fileURLToPath(new URL('../dist/worker.js', import.meta.url)),
      durableObjects: { MEMORY: { className: 'MemoryObject', useSQLite: true } }, r2Buckets: ['ORIGINALS'],
      serviceBindings: { HY_ENGINE: pythonManifest ? {name:'python-engine'} : engine }, outboundService: outbound,
      bindings: { CF_ACCOUNT_ID: 'synthetic-account', MEMORY_GATEWAY_ID: 'synthetic-gateway', MEMORY_MODEL_TOKEN: 'synthetic-token',
        MEMORY_FORMATION_MODEL: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', MEMORY_TEXT_EMBEDDING_MODEL: '@cf/qwen/qwen3-embedding-0.6b', MEMORY_MEDIA_EMBEDDING_MODEL: 'gemini-embedding-2', MEMORY_TEMPORAL_MODEL: 'gemini-2.5-flash' } },
    ...(pythonManifest ? [{name:'python-engine',modules:true,compatibilityDate:'2026-10-19',compatibilityFlags:['python_workers'],
      script:'export default {}',serviceBindings:{MEMORY_READ:{name:'read-caller'}},
      bindings:Object.fromEntries(['HY_LLM_URL','HY_LLM_MODEL','HY_LLM_KEY','HY_EMBED_URL','HY_EMBED_MODEL','HY_EMBED_KEY','HY_EMBED_DIMS'].map(key=>[key,'synthetic']))}] : []),
  ] });
    options.workers[2].config.manifest = { mainModule: 'worker.js', modulesRoot: fileURLToPath(directory), modules };
    if(pythonManifest)options.workers[3].config.manifest=pythonManifest;
    return new Miniflare(options);
  };
  let mf = create();
  const api = async (path, body) => {
    const response = await mf.dispatchFetch(`https://memory.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, principal }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    if(pythonManifest)console.info(`Python/workerd fixture ${path}: ${response.status}`);
    return result;
  };
  try {
    const first = await api('/ingest', { operationId: 'image-1', sessionRef: 'session-a', messageRef: 'message-1', mimeType: 'image/png', dataBase64: image });
    assert.equal(first.state, 'active');
    await mf.dispose(); mf = create();
    const recalled = await api('/search', { query: 'The numbered badge', sessionRef: 'session-b' });
    assert.deepEqual(recalled.items[0].refs, [first.ref]);
    if(pythonManifest) {
      const callback=await mf.getWorker('read-caller');
      const proof=await (await callback.fetch('https://fixture/__fixture-callbacks')).json();
      assert.ok(proof.methods.includes('search'),'production Python Reader must call the actual TS named read entrypoint');
      assert.equal(proof.covered,proof.methods.length,'every actual callback must carry coverage accepted by Python');
      console.info(`Python/workerd named callback proof: ${JSON.stringify(proof)}`);
    }
    assert.equal((await api('/read', { ref: first.ref })).dataBase64, image);
    const next = await api('/correct', { operationId: 'fix-1', ref: first.ref, text: 'The badge was blue.' });
    assert.equal((await api('/validate', { refs: [first.ref] })).valid, false);
    const corrected = await api('/search', { query: 'badge color', sessionRef: 'session-c' });
    assert.ok(corrected.items.length > 0);
    assert.ok(corrected.items.every(item => item.refs.every(ref => ref.revision === next.ref.revision)));
    assert.equal((await api('/read', { ref: next.ref })).perceptionText, 'The badge was blue.');
    await api('/delete', { operationId: 'delete-1', ref: next.ref });
    assert.equal((await api('/validate', { refs: [next.ref] })).valid, false);
    assert.deepEqual((await api('/search', { query: 'badge', sessionRef: 'session-d' })).items, []);
    for (const [file, mimeType] of [['blue-tone.mp4', 'video/mp4'], ['tone.wav', 'audio/wav']]) {
      const original = (await readFile(new URL(`fixtures/${file}`, import.meta.url))).toString('base64');
      const temporal = await api('/ingest', { operationId: file, sessionRef: 'session-av', messageRef: file, mimeType, dataBase64: original });
      await mf.dispose(); mf = create();
      const recalled = await api('/search', { query: mimeType.startsWith('audio/') ? 'Find the audible tone' : 'Find the tone with the blue screen', sessionRef: 'session-next' });
      assert.ok(recalled.items.length > 0);
      assert.equal(recalled.items[0].retrieval, 'grounded');
      const grounding = recalled.items[0].groundings[0];
      assert.deepEqual(grounding.ref, temporal.ref);
      assert.equal(grounding.basis, mimeType.startsWith('audio/') ? 'sample-window' : 'model-estimate');
      assert.deepEqual(grounding.modalities, mimeType.startsWith('video/') ? ['video', 'audio'] : ['audio']);
      const range = { startMs: grounding.startMs, endMs: grounding.endMs };
      const read = await api('/read', { ref: temporal.ref, range });
      assert.deepEqual(read.selection, range); assert.equal(read.originalIsFullFile, true);
      assert.equal(read.dataBase64, original); assert.ok(read.timeline.durationMs >= 1000);
      await api('/delete', { operationId: `delete-${file}`, ref: temporal.ref });
      assert.equal((await api('/validate', { refs: [temporal.ref] })).valid, false);
    }
    const publicWorker = await mf.getWorker('memory');
    assert.equal((await publicWorker.fetch('https://memory.test/search')).status, 404);
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
