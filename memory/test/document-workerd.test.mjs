import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { documentFixtures, emptyDocumentFixtures } from './document-fixtures.mjs';
import { preparePdf } from '../scripts/prepare-pdf.mjs';

test('actual SQLite/R2 Worker publishes document units atomically and fences rebuild/recovery/revocation', { timeout: 180000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), wasms = new Map();
  const bundled = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export {MemoryService} from './src/service.ts';
    export {Documents} from './src/document-jobs.ts';
    export {ObjectStore} from './src/storage.ts';
    export {CloudflareMemoryModels} from './src/models.ts';` },
  write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  alias: { mediabunny: join(root, '.generated/mediabunny/src/index.ts'), 'pdf-lib': await preparePdf() },
  plugins: [{ name: 'document-static-wasm', setup(b) { b.onResolve({ filter: /\.wasm$/ }, a => {
    const path = resolve(a.resolveDir, a.path), name = basename(path);
    if (wasms.has(name)) assert.equal(wasms.get(name), path); wasms.set(name, path);
    return { path: './' + name, external: true };
  }); } }] });
  const modules = { 'production.js': { type: 'esm', contents: bundled.outputFiles[0].text } };
  for (const [name, path] of wasms) modules[name] = { type: 'wasm', contents: await readFile(path) };
  modules['test.js'] = { type: 'esm', contents: `
    import {DurableObject} from 'cloudflare:workers';
    import {MemoryService,Documents,ObjectStore,CloudflareMemoryModels} from './production.js';
    WebAssembly.compile=WebAssembly.compileStreaming=()=>{throw Error('runtime_compile_forbidden')};
    export class DocumentTest extends DurableObject {
      constructor(ctx,env){super(ctx,env);this.wire=[];this.engineCalls=0;this.hold=false;this.waiting=false;
        const db=new ObjectStore(ctx.storage,env.ORIGINALS,'document-fixture-pages/');
        const models=new CloudflareMemoryModels({accountId:'fixture',gatewayId:'fixture',token:'fixture',formationModel:'fixture-formation',
          temporalModel:'gemini-2.5-flash',textEmbeddingModel:'fixture-text',mediaEmbeddingModel:'gemini-embedding-2'},
          {fetch:async r=>{this.engineCalls++;const b=await r.json();
            if(b.operation==='search')return Response.json({success:true,memories:[]});
            return Response.json({success:true,nodes:[{payload:{node_id:b.requestId,user_id:b.principal.ownerRef,agent_id:b.principal.scopeRef,
              content:b.content,layer:'l2_fact',status:'active',is_latest:true,custom:{meta:[{sourceRef:b.sourceRef}]}},embedding:[1,0,0],lexicalTokens:['synthetic','document']}]});
          }},async(url,init)=>{
            const b=JSON.parse(init.body);this.wire.push({url,body:b});
            if(url.includes(':embedContent'))return Response.json({embedding:{values:[1,...Array(1535).fill(0)]}});
            if(b.input){
              if(this.hold){this.hold=false;this.waiting=true;this.entered?.();await new Promise(resolve=>this.release=resolve);this.waiting=false;}
              const schema=b.input.generationConfig?.responseSchema;
              const text=schema?.properties?.matches?JSON.stringify({matches:true,text:'Synthetic document unit supports the fixture query.',...(schema.properties.correctionRelevant?{correctionRelevant:true}:{})}):'Synthetic document observation: Friday proposal and budget evidence.';
              return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});
            }
            const system=b.messages?.[0]?.content??'';let content='Synthetic document observation.';
            if(system.startsWith('Project the supplied')){const input=JSON.parse(b.messages[1].content);content=JSON.stringify({claims:[{key:'observed',nodeId:input.nodes[0].nodeId,text:input.perception.text,
              subject:'Synthetic source',event:'Document fixture',predicate:'observation',value:input.perception.text,validTime:'',conditions:'',quote:input.perception.text}]});}
            else if(system.startsWith('Assess EACH supplied')){const input=JSON.parse(b.messages[1].content);content=JSON.stringify({relations:input.pairs.map(p=>({left:p.left.id,right:p.right.id,kind:'different',reason:'Separate synthetic source observations.'}))});}
            return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
          });
        const blobs={put:async(k,b,m)=>{await env.ORIGINALS.put(k,b,{httpMetadata:{contentType:m}})},get:async k=>{const o=await env.ORIGINALS.get(k);return o?new Uint8Array(await o.arrayBuffer()):null},delete:async k=>{await env.ORIGINALS.delete(k)}};
        this.service=new MemoryService(db,blobs,models,{ownerRef:'document-fixture-owner',scopeRef:'personal'});this.documents=new Documents(this.service);
      }
      async fetch(request){try{const p=new URL(request.url).pathname,b=await request.json();let result;
        switch(p){
          case '/create':result=await this.documents.create(b);break;
          case '/step':result=await this.documents.step(b.operationId);break;
          case '/status':result=await this.documents.status(b.operationId);break;
          case '/units':result=await this.documents.units(b.ref);break;
          case '/rebuild':result=await this.documents.rebuild(b.ref,b.operationId,b.question,b.correction);break;
          case '/document-recover':result=await this.documents.recover(b);break;
          case '/read':result=await this.service.read(b.ref);break;
          case '/search':result=await this.service.search({query:'Synthetic document',sessionRef:'query',limit:20});break;
          case '/knowledge':result=await this.service.knowledge();break;
          case '/claim-authorities':{const view=await this.service.knowledge();result=await Promise.all(view.claims.map(c=>this.service.db.get('claim:'+c.id)));break;}
          case '/source-flags':{const source=await this.service.db.get('source:'+b.ref.sourceId);result={vectorPresent:!!source?.vector};break;}
          case '/stats':result={modelCalls:this.wire.length,engineCalls:this.engineCalls};break;
          case '/correct-child':result=await this.service.correct(b);break;
          case '/reinspect-child':result=await this.service.reinspect(b);break;
          case '/recover-child':result=await this.service.recover(b);break;
          case '/delete':result=await this.service.forget(b);break;
          case '/revoke':result=await this.service.forget(b,true);break;
          case '/validate':result=await this.service.validate(b.refs);break;
          case '/wire':result=this.wire;break;
          case '/hold':this.hold=true;this.holdEntered=new Promise(resolve=>this.entered=resolve);result={};break;
          case '/waiting':await this.holdEntered;result={waiting:this.waiting};break;
          case '/release':this.release?.();result={};break;
          default:throw Error('fixture_route_unknown');
        }
        return Response.json(result);
      }catch(e){return Response.json({error:e.code??e.message},{status:e.status??409})}}
    }
    export default{fetch(r,env){return env.TEST.getByName('document-fixture').fetch(r)}};` };
  const persistence = await mkdtemp(join(tmpdir(), 'hy-documents-worker-'));
  const create = () => {
    const options = convertV4MiniflareOptions({ resourcePersistencePath: persistence, workers: [{ name: 'document-fixture', modules: true,
      script: 'export default {}', compatibilityDate: '2026-10-19', durableObjects: { TEST: { className: 'DocumentTest', useSQLite: true } }, r2Buckets: ['ORIGINALS'] }] });
    options.workers[0].config.manifest = { mainModule: 'test.js', modules };
    return new Miniflare(options);
  };
  let mf = create();
  const request = async (path, body = {}) => {
    const response = await mf.dispatchFetch('https://fixture' + path, { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, result: await response.json() };
  };
  const api = async (path, body) => { const r = await request(path, body); assert.equal(r.status, 200, path + ': ' + JSON.stringify(r.result)); return r.result; };
  const reject = async (path, body, error) => { const r = await request(path, body); assert.notEqual(r.status, 200, path); assert.equal(r.result.error, error, path); };
  const finish = async id => { let state; for (let i = 0; i < 258; i++) { state = await api('/step', { operationId: id }); if (state.state === 'complete') return state; assert.equal(state.state, 'queued'); } assert.fail('document job did not finish within unit bound'); };
  try {
    const fixtures = await documentFixtures(), roots = [];
    for (const [index, fixture] of fixtures.entries()) {
      const operationId = 'document-' + index;
      const input = { operationId, messageRef: operationId, sessionRef: 'fixture', mimeType: fixture.mimeType, dataBase64: Buffer.from(fixture.bytes).toString('base64') };
      const queued = await api('/create', input); assert.equal(queued.state, 'queued'); assert.ok(queued.units >= fixture.units);
      assert.deepEqual((await api('/create', input)).ref, queued.ref, 'admission receipt must not create a second root');
      assert.equal((await api('/validate', { refs: [queued.ref] })).valid, false);
      const pending = await api('/search'); assert.ok(!pending.documents?.some(d => d.original?.sourceId === queued.ref.sourceId || d.ref?.sourceId === queued.ref.sourceId));
      const wireBefore = (await api('/wire')).length;
      await api('/step', { operationId });
      if (fixture.units > 1) {
        assert.equal((await api('/validate', { refs: [queued.ref] })).valid, false, 'first unit must not publish the root');
        const partial = await api('/search');
        assert.ok(!JSON.stringify(partial).includes(queued.ref.sourceId), 'partial unit must not enter search/knowledge');
      }
      await finish(operationId);
      const page = await api('/units', { ref: queued.ref }); assert.equal(page.units.length, queued.units);
      const rendered=page.units.filter(u=>u.locator.kind==='office-rendered-page');
      assert.equal(page.units.length-rendered.length,fixture.units);
      assert.equal(rendered.length>0,/docx|xlsx/.test(fixture.name));
      for (const u of page.units) {
        const read = await api('/read', { ref: u.ref }); assert.deepEqual(read.documentUnit.original, queued.ref); assert.deepEqual(read.documentUnit.locator, u.locator);
        if(u.locator.kind==='office-rendered-page'){const unit=JSON.parse(atob(read.dataBase64));assert.equal(unit.derived.mimeType,'application/pdf');assert.ok(unit.context.rendering);assert.ok(unit.coverage.unsupported.length>0);}
        assert.ok(read.provenance.derivedFrom.some(r => r.sourceId === queued.ref.sourceId));
        assert.deepEqual(read.provenance.roots, [queued.ref.sourceId], 'same document units are not independent roots');
        assert.equal(read.provenance.independence, 'not-established');
        assert.ok(read.knowledge.claims.length > 0, 'fixture must publish claims before testing eligibility');
        assert.ok(read.knowledge.claims.every(c => c.roots.length === 1 && c.roots[0] === queued.ref.sourceId), 'knowledge must not promote child refs to independent evidence roots');
      }
      const original = await api('/read', { ref: queued.ref }); assert.equal(original.mimeType, fixture.mimeType); assert.equal(original.dataBase64, input.dataBase64);
      const wire = (await api('/wire')).slice(wireBefore);
      const parts = wire.flatMap(w => w.body.input?.contents?.flatMap(c => c.parts) ?? []);
      assert.ok(parts.some(p => p.text?.includes('sourceLocator')), 'native locator/structure must reach perception');
      if (fixture.mimeType === 'application/pdf') assert.ok(parts.some(p => p.inlineData?.mimeType === 'application/pdf' && Buffer.from(p.inlineData.data, 'base64').subarray(0, 5).toString() === '%PDF-'));
      else assert.ok(parts.some(p => p.inlineData?.mimeType === 'image/png'), 'embedded native image must reach perception');
      const embedding = wire.filter(w => w.url.includes(':embedContent')).flatMap(w => w.body.content.parts);
      assert.ok(embedding.some(p => p.inline_data?.mime_type === (fixture.mimeType === 'application/pdf' ? 'application/pdf' : 'image/png')), 'unit native media must reach embedding');
      const search = await api('/search'); assert.ok(search.items.some(i => i.documentEvidence?.some(e => e.original.sourceId === queued.ref.sourceId)), 'source-bound document evidence missing');
      const groups = search.documents.filter(d => d.ref.sourceId === queued.ref.sourceId);
      assert.equal(groups.length, 1, 'several units must remain one root group'); assert.equal(groups[0].units.length, queued.units);
      for(const evidence of search.items.flatMap(i=>i.documentEvidence??[])){assert.equal(evidence.basis,evidence.locator.kind==='office-rendered-page'?'rendered-document-page':'native-document-unit');}
      roots.push({ ...queued, input, child: page.units[0].ref, operationId });
    }
    // Durable restart must preserve the original and unit locators.
    await mf.dispose(); mf = create();
    const first = roots[0]; assert.equal((await api('/read', { ref: first.ref })).dataBase64, first.input.dataBase64);
    for (const [path, extra] of [['/correct-child', { text: 'Owner correction' }], ['/reinspect-child', { question: 'Recheck original' }], ['/delete', {}], ['/revoke', {}]]) {
      await reject(path, { ref: first.child, operationId: 'denied-' + path.slice(1), ...extra }, 'document_root_required');
    }
    await reject('/recover-child', { previousOperationId: first.operationId + ':unit:0', operationId: 'denied-recover', acceptUnknown: true }, 'document_root_required');
    const correction = 'Only the proposal on PDF page 1 is pending; this statement does not revise page 2.';
    const corrected = await api('/rebuild', { ref: first.ref, operationId: 'correct-document', correction });
    assert.equal((await api('/validate', { refs: [first.ref, first.child] })).invalid.length, 2, 'both old root and old child must be unavailable'); await finish('correct-document');
    const correctedUnits = (await api('/units', { ref: corrected.ref })).units;
    const nativeUnits = correctedUnits.filter(u => u.locator.kind === 'pdf-page'), ownerUnits = correctedUnits.filter(u => u.locator.kind === 'owner-correction');
    assert.equal(nativeUnits.length, 2, 'local correction must preserve both original page observations');
    assert.equal(ownerUnits.length, 1, 'Owner statement must be one separately scoped unit');
    const authorities = await api('/claim-authorities');
    for (const unit of nativeUnits) {
      const read = await api('/read', { ref: unit.ref });
      assert.equal(read.parser.model, 'google-ai-studio/gemini-2.5-flash');
      assert.ok(!read.perceptionText.includes(correction), 'native page must not become copied Owner text');
      const claims = authorities.filter(c => c.source.sourceId === unit.ref.sourceId);
      assert.ok(claims.length > 0); assert.ok(claims.every(c => c.authority === 'observation'));
    }
    const annotation = await api('/read', { ref: ownerUnits[0].ref });
    assert.equal(annotation.parser.model, 'owner-correction');
    assert.deepEqual(ownerUnits[0].locator.scope, corrected.ref);
    assert.equal(JSON.parse(Buffer.from(annotation.dataBase64, 'base64').toString()).context.ownerCorrection, correction);
    const ownerClaims = authorities.filter(c => c.source.sourceId === ownerUnits[0].ref.sourceId);
    assert.ok(ownerClaims.length > 0); assert.ok(ownerClaims.every(c => c.authority === 'owner'));
    const correctedSearch = await api('/search');
    const annotationHit = correctedSearch.items.find(i => i.refs.some(r => r.sourceId === ownerUnits[0].ref.sourceId));
    assert.ok(annotationHit); assert.equal(annotationHit.retrieval, 'owner-correction');
    assert.ok(!annotationHit.documentEvidence?.length, 'Owner statement must not be promoted to native evidence even when model stub says matches:true');
    const reinspected = await api('/rebuild', { ref: corrected.ref, operationId: 'reinspect-document', question: 'Inspect the same original pages.' });
    await finish('reinspect-document'); assert.equal((await api('/validate', { refs: [corrected.ref] })).valid, false);
    assert.equal((await api('/read', { ref: reinspected.ref })).dataBase64, first.input.dataBase64);
    roots[0].ref = reinspected.ref;

    // Rebuild the actual Office source and both representations, preserving a single root.
    const office=roots[1], oldOffice=office.ref, oldOfficeUnits=(await api('/units',{ref:oldOffice})).units;
    assert.ok(oldOfficeUnits.some(u=>u.locator.kind==='office-rendered-page'));
    const rebuiltOffice=await api('/rebuild',{ref:oldOffice,operationId:'reinspect-office',question:'Recheck the displayed table in the rendered pages and original structure.'});
    assert.equal((await api('/validate',{refs:[oldOffice,...oldOfficeUnits.map(u=>u.ref)]})).invalid.length,oldOfficeUnits.length+1);
    await finish('reinspect-office');
    const newOfficeUnits=(await api('/units',{ref:rebuiltOffice.ref})).units;
    assert.deepEqual(newOfficeUnits.map(u=>u.locator),oldOfficeUnits.map(u=>u.locator));
    for(const unit of newOfficeUnits){const read=await api('/read',{ref:unit.ref});assert.deepEqual(read.documentUnit.original,rebuiltOffice.ref);assert.deepEqual(read.provenance.roots,[rebuiltOffice.ref.sourceId]);}
    assert.equal((await api('/read',{ref:rebuiltOffice.ref})).dataBase64,office.input.dataBase64);
    office.ref=rebuiltOffice.ref;

    for (const [index, fixture] of (await emptyDocumentFixtures()).entries()) {
      const stats = await api('/stats'), operationId = 'empty-document-' + index;
      const queued = await api('/create', { operationId, messageRef: operationId, sessionRef: 'empty-fixture', mimeType: fixture.mimeType, dataBase64: Buffer.from(fixture.bytes).toString('base64') });
      await finish(operationId);
      const emptyUnits = (await api('/units', { ref: queued.ref })).units; assert.equal(emptyUnits.length, 1); assert.equal(emptyUnits[0].empty, true);
      const read = await api('/read', { ref: emptyUnits[0].ref }); assert.equal(read.documentUnit.empty, true); assert.equal(read.parser.model, 'document-structure-inspection');
      assert.equal(read.knowledge.claims.length, 0); assert.equal((await api('/source-flags', { ref: emptyUnits[0].ref })).vectorPresent, false);
      assert.deepEqual(await api('/stats'), stats, 'empty structural unit must not call perception/embed/Hy/knowledge models');
      assert.equal((await api('/read', { ref: queued.ref })).dataBase64, Buffer.from(fixture.bytes).toString('base64'));
      roots.push(queued);
    }

    // A second invocation while provider IO is held marks the first invocation unknown.
    const unknown = await api('/create', { ...first.input, operationId: 'unknown-document', messageRef: 'unknown-document' });
    await api('/hold'); const late = request('/step', { operationId: 'unknown-document' });
    assert.equal((await api('/waiting')).waiting, true);
    assert.equal((await api('/step', { operationId: 'unknown-document' })).state, 'unknown');
    const count = (await api('/wire')).length;
    assert.equal((await api('/step', { operationId: 'unknown-document' })).state, 'unknown'); assert.equal((await api('/wire')).length, count, 'unknown must not automatically replay');
    await reject('/document-recover', { previousOperationId: 'unknown-document', operationId: 'recover-document', acceptUnknown: false }, 'unknown_effect_requires_explicit_recovery');
    const recovered = await api('/document-recover', { previousOperationId: 'unknown-document', operationId: 'recover-document', acceptUnknown: true });
    assert.notDeepEqual(recovered.ref, unknown.ref); await api('/release'); assert.notEqual((await late).status, 200, 'late old model response must be fenced');
    await finish('recover-document'); assert.equal((await api('/validate', { refs: [unknown.ref] })).valid, false);
    assert.deepEqual((await api('/document-recover', { previousOperationId: 'unknown-document', operationId: 'recover-document', acceptUnknown: true })).ref, recovered.ref);
    roots.push(recovered);
    for (const [index, root] of roots.entries()) {
      const children = (await api('/units', { ref: root.ref })).units.map(u => u.ref);
      await api('/revoke', { ref: root.ref, operationId: 'revoke-document-' + index });
      assert.equal((await api('/validate', { refs: [root.ref, ...children] })).invalid.length, children.length + 1, 'revocation must invalidate root and every child');
    }
    const revoked = await api('/search'); assert.equal(revoked.items.length, 0); assert.equal(revoked.documents.length, 0); assert.equal(revoked.knowledge.claims.length, 0);
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
