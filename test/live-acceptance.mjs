// Explicit live-provider test. Uses production main.py and the authenticated gateway.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readConfig } from '../scripts/config.mjs';
import { createRuntime } from '../scripts/runtime.mjs';

const profile = process.env.HY_LIVE_PROFILE || 'all';
if (!['knowledge', 'media', 'formats', 'containers', 'container-search', 'images', 'documents', 'office-rendering', 'all'].includes(profile)) throw Error('HY_LIVE_PROFILE must be knowledge, media, formats, containers, container-search, images, documents, office-rendering or all.');
if (!process.env.HY_LIVE_OUTPUT) throw Error('Set HY_LIVE_OUTPUT to a new private results directory. This command calls your configured live models.');
const out = resolve(process.env.HY_LIVE_OUTPUT);
const reuseFrom = process.env.HY_LIVE_REUSE_FROM;
const stateFrom = process.env.HY_LIVE_STATE_FROM || reuseFrom;
const previousReport = reuseFrom ? JSON.parse(await readFile(join(resolve(reuseFrom),'report.json'),'utf8')) : undefined;
if (reuseFrom && !['container-search','images','office-rendering'].includes(profile)) throw Error('Reuse is limited to explicit container-query, image recovery, or Office job continuation.');
await mkdir(out, { mode: 0o700 }); // Never overwrite a first run or reuse its memory.
const config = await readConfig();
const report = { profile, startedAt: new Date().toISOString(), revision: process.env.HY_ACCEPTANCE_REVISION || 'working-tree',
  ...(reuseFrom ? { reuseFrom: resolve(reuseFrom), scope: profile==='office-rendering' ? 'Office continuation retains the original fixture bytes and persisted operation receipts. Unknown recovery requires HY_LIVE_ACCEPT_UNKNOWN=1; Original fixtures and expectations are retained; the acceptance revision identifies the code and prompt version used.' : profile==='images' ? 'Explicit recovery of the first failed image formation; retains successful first observation and embedding.' : 'Query-only continuation; no ingestion/reasoning replay.' } : {}),
  models: Object.fromEntries(Object.entries(config).filter(([k]) => k.endsWith('_MODEL'))),
  semanticReview: { status: 'required', note: 'Inspect first responses against fixture ground truth, including conclusion meaning, native evidence, explicit authority and revision targets. A matching word is not semantic proof.' },
  checks: [], failures: [], calls: 0, finished: false, ...(previousReport?.recoveries?{recoveries:[...previousReport.recoveries]}:{}) };
const save = () => writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
function redact(value, key = '') {
  if (/^(dataBase64|data|image_url)$/.test(key) && typeof value === 'string' && value.length > 512) return `<${value.length} characters>`;
  if (key === 'values' || key === 'embedding' && Array.isArray(value)) return `<${value.length} numbers>`;
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redact(v,k)]));
  return value;
}
const check = (name, passed, detail) => {
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  if (!passed) report.failures.push(name);
};
const transport = async request => {
  const id = ++report.calls, began = Date.now();
  const payload = await request.clone().json().catch(() => ({}));
  // Pass through unchanged. No fixture responses, alternate routes or retries.
  let response;
  try {
    response = await fetch(request.url, { method: request.method, headers: Object.fromEntries([...request.headers].filter(([key]) => !['connection','content-length','transfer-encoding','keep-alive','upgrade','trailer','te','host'].includes(key.toLowerCase()))), body: await request.arrayBuffer(), redirect: 'manual' });
  } catch (error) {
    await appendFile(join(out, 'model-first-responses.jsonl'), JSON.stringify({ id, transportError: error.message, cause: error.cause?.code, detail: error.cause?.message }) + '\n', { mode: 0o600 });
    throw error;
  }
  const result = await response.clone().json().catch(() => ({ unparsed: true }));
  await appendFile(join(out, 'model-first-responses.jsonl'), JSON.stringify({ id, model: payload.model,
    endpoint: new URL(request.url).pathname.split('/').slice(-2).join('/'), status: response.status, ms: Date.now() - began,
    request: redact(payload), response: redact(result) }) + '\n', { mode: 0o600 });
  await save();
  return response;
};
let runtime;
const start = () => createRuntime({ config, persistence: join(stateFrom ? resolve(stateFrom) : out, 'storage'), port: 0, outboundService: transport });
async function api(path, body = {}) {
  const response = await runtime.dispatchFetch(`https://acceptance.test${path}`, { method: 'POST', headers: {
    Authorization: `Bearer ${config.HY_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  await appendFile(join(out, 'api-first-responses.jsonl'), JSON.stringify({ path, status: response.status, result: redact(result) }) + '\n', { mode: 0o600 });
  if (!response.ok) throw Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
const refs = {}, source = id => refs[id].sourceId;
async function ingest(id, mimeType, bytes) {
  const result = await api('/ingest', { operationId: `ingest-${id}`, messageRef: id, sessionRef: 'synthetic-live', mimeType, dataBase64: bytes.toString('base64') });
  if (!result.ref || result.state !== 'active') throw Error(`Ingest ${id} did not publish an active source.`);
  refs[id] = result.ref; return result;
}
async function knowledge() {
  let continuation, claims = [], relations = [], pages = 0;
  do {
    const result = await api('/knowledge', continuation ? { continuation } : {});
    claims.push(...result.claims); relations.push(...result.relations); continuation = result.coverage?.continuation;
    if (++pages > 100) throw Error('Knowledge fixture did not finish pagination.');
  } while (continuation);
  return { claims: [...new Map(claims.map(v => [v.id,v])).values()], relations: [...new Map(relations.map(v => [v.id,v])).values()] };
}
function links(view, a, b, kinds) {
  const claims = new Map(view.claims.map(v => [v.id, v]));
  return view.relations.filter(r => r.active && kinds.includes(r.kind) &&
    [claims.get(r.left)?.source.sourceId, claims.get(r.right)?.source.sourceId].sort().join('|') === [source(a), source(b)].sort().join('|'));
}
async function knowledgeCases() {
  const ground = JSON.parse(await readFile(new URL('./live-fixtures/knowledge.json', import.meta.url)));
  const first = await api('/ingest-text', { operationId: 'ingest-A', messageRef: 'A', sessionRef: 'synthetic-live', text: ground.A.text });
  refs.A = first.ref;
  for (const id of ['B', 'C']) await ingest(id, 'image/png', await readFile(new URL(`./live-fixtures/${id}.png`, import.meta.url)));
  let view = await knowledge();
  const conflicts = links(view, 'A', 'B', ['conflict']);
  check('cross-source conflict retained', conflicts.length > 0);
  check('different meeting stays separate', view.claims.some(v => v.source.sourceId === source('C')) &&
    !links(view, 'A', 'C', ['same','conflict','revision','uncertain']).length && !links(view, 'B', 'C', ['same','conflict','revision','uncertain']).length);
  const recall = await api('/search', { query: 'M-17项目评审会哪天举行？', sessionRef: 'new-session' });
  check('text recall finds M-17 evidence', recall.items.some(v => v.refs?.some(r => [source('A'), source('B')].includes(r.sourceId))));
  await ingest('D', 'image/png', await readFile(new URL('./live-fixtures/D.png', import.meta.url)));
  view = await knowledge();
  check('explicit revision recognized', links(view, 'A', 'D', ['revision']).concat(links(view, 'B', 'D', ['revision'])).some(r => r.revisionKind === 'world-change'));
  await api('/revoke', { ref: refs.D, operationId: 'revoke-D' });
  view = await knowledge();
  check('withdraw revision restores conflict', links(view, 'A', 'B', ['conflict']).length > 0);
  check('revoked evidence disappears', !view.claims.some(v => v.source.sourceId === source('D')));
  await api('/revoke', { ref: refs.B, operationId: 'revoke-B' });
  view = await knowledge();
  check('withdraw conflict clears unavailable evidence', !view.claims.some(v => [source('B'),source('D')].includes(v.source.sourceId)) && !links(view, 'A','B',['conflict']).length);
  const old = refs.C, bytes = await readFile(new URL('./live-fixtures/C.png', import.meta.url));
  const revised = await api('/reinspect', { ref: old, operationId: 'reinspect-C', question: '请重新核对原图中的会议编号、日期和地点。' });
  refs.C = revised.ref;
  check('reinspection invalidates old version', revised.ref.sourceId === old.sourceId && revised.ref.revision === old.revision + 1 && !(await api('/validate', { refs: [old] })).valid);
  const read = await api('/read', { ref: revised.ref });
  check('reinspection preserves native original', Buffer.from(read.dataBase64, 'base64').equals(bytes));
  await runtime.dispose(); runtime = await start();
  check('current version survives restart', (await api('/validate', { refs: [revised.ref] })).valid);
  const query = await api('/search', { media: { mimeType: 'image/png', dataBase64: bytes.toString('base64') }, sessionRef: 'image-query-session' });
  check('native image query recalls current source', query.items.some(v => v.refs?.some(r => r.sourceId === source('C') && r.revision === refs.C.revision)));
  await save();
}
async function waitJob(path, operationId) {
  let progress, idlePolls=0;
  while (idlePolls < 600) {
    const status = await api(`/${path}/status`, { operationId });
    const current=JSON.stringify([status.ref,status.phase,status.cursor,status.units,report.calls]);
    if(current!==progress){progress=current;idlePolls=0;}else idlePolls++;
    if (status.state === 'complete') return status;
    if (!['queued','running'].includes(status.state)) throw Error(`Job ${operationId}: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error(`Job ${operationId} made no progress for 600 polls; retained state can be inspected, no automatic recovery.`);
}
async function recording(path, mimeType, bytes, seconds) {
  const upload = await api(`/${path}/upload`, { mimeType });
  const response = await runtime.dispatchFetch(`https://acceptance.test/${path}/part`, { method: 'POST', headers: {
    Authorization: `Bearer ${config.HY_API_TOKEN}`, 'memory-upload': upload.uploadId, 'memory-part': '1', 'content-length': String(bytes.length) }, body: bytes });
  const part = await response.json();
  if (!response.ok) throw Error(`Upload ${path} part: ${JSON.stringify(part)}`);
  const operationId = `multipart-${path}`;
  const created = await api(`/${path}/complete-upload`, { uploadId: upload.uploadId, parts: [part], operationId, sessionRef: 'synthetic-live', messageRef: path, strategy: 'fixed', seconds });
  const completed = await waitJob(path, operationId);
  check(`${path} multipart completes`, completed.ref.sourceId === created.ref.sourceId);
  return completed.ref;
}
async function mediaCases() {
  const tone = await readFile(new URL('../memory/test/fixtures/tone.wav', import.meta.url));
  await ingest('tone', 'audio/wav', tone);
  const read = await api('/read', { ref: refs.tone });
  check('native audio original readback', Buffer.from(read.dataBase64,'base64').equals(tone));
  const sound = await api('/search', { query: '持续的非语言音调，没有说话声', sessionRef: 'audio-recall' });
  check('audible tone retrieved', sound.items.some(v => v.groundings?.some(g => g.ref.sourceId === source('tone') && g.modalities.includes('audio'))));
  const absent = await api('/search', { query: '原始录音中有人清楚地说出了密码 alpha-seven', sessionRef: 'audio-negative' });
  check('unsupported speech not grounded', !absent.items.some(v => v.groundings?.some(g => g.ref.sourceId === source('tone'))));
  const video = await readFile(new URL('../memory/test/fixtures/synthetic-meeting-m42.mp4', import.meta.url));
  refs.video = await recording('video', 'video/mp4', video, 14);
  const reason = 'reason-video';
  await api('/video/reason', { ref: refs.video, operationId: reason, query: 'What day is meeting M42 scheduled for after the final explicit revision?' });
  const result = await waitJob('video', reason);
  check('cross-clip final revision is Sunday', /Sunday|周日|星期日|星期天|周天/i.test(result.reasoning?.conclusion?.text || ''), result.reasoning?.conclusion);
  check('cross-clip conclusion cites evidence', result.reasoning?.conclusion?.status === 'provisional' && !result.reasoning.incomplete && !result.reasoning.requireMore && !result.reasoning.coverageIncomplete && result.reasoning.conclusion.support.length > 0 && result.reasoning.conclusion.opposition.length === 0);
  const grouped = await api('/search', { query: 'M42 meeting schedule decision', sessionRef: 'grouped-video' });
  check('video clips grouped under original', grouped.videos?.some(v => v.ref?.sourceId === refs.video.sourceId && v.clips?.length));
  const spoken = await readFile(new URL('./live-fixtures/meeting.wav', import.meta.url));
  refs.audio = await recording('audio', 'audio/wav', spoken, 14);
  await api('/audio/reason', { ref: refs.audio, operationId: 'reason-audio', query: 'What day is meeting M42 scheduled for after the final explicit revision?' });
  const audioReason = await waitJob('audio', 'reason-audio');
  check('cross-clip audio final revision is Sunday', /Sunday|周日|星期日|星期天|周天/i.test(audioReason.reasoning?.conclusion?.text || '') && audioReason.reasoning.conclusion.status === 'provisional' && !audioReason.reasoning.incomplete && !audioReason.reasoning.requireMore && !audioReason.reasoning.coverageIncomplete && audioReason.reasoning.conclusion.support.length > 0 && audioReason.reasoning.conclusion.opposition.length === 0, audioReason.reasoning?.conclusion);
  const audioFound = await api('/search', { query: 'M42 meeting schedule decision', sessionRef: 'grouped-audio' });
  check('audio clips grouped under original', audioFound.audios?.some(v => v.ref.sourceId === refs.audio.sourceId && v.clips.length));
  const audioRead = await api('/read', { ref: refs.audio, range: { startMs: 0, endMs: 500 } });
  check('multipart audio native range readable', audioRead.mimeType === 'audio/wav' && audioRead.dataBase64?.length > 0);
  const oldAudio = refs.audio;
  const rebuilt = await api('/reinspect', { ref: oldAudio, operationId: 'reinspect-audio', question: 'Recheck the spoken meeting schedule and any explicit corrections.' });
  refs.audio = (await waitJob('audio', 'reinspect-audio')).ref;
  check('audio rebuild advances source version', refs.audio.revision === oldAudio.revision + 1 && !(await api('/validate', { refs: [oldAudio] })).valid);
  await api('/revoke', { ref: refs.audio, operationId: 'revoke-audio' });
  check('audio revocation invalidates rebuilt ref', !(await api('/validate', { refs: [refs.audio] })).valid);
  const revoked = refs.video;
  await api('/revoke', { ref: revoked, operationId: 'revoke-video' });
  check('recording root revocation invalidates ref', !(await api('/validate', { refs: [revoked] })).valid);
  const after = await api('/search', { query: 'M42 meeting schedule decision', sessionRef: 'revoked-video' });
  check('revoked recording no longer grouped', !after.videos?.some(v => v.ref?.sourceId === revoked.sourceId));
  check('revoked audio no longer grouped', !after.audios?.some(v => v.ref?.sourceId === refs.audio.sourceId));
  await save();
}
async function formatCases() {
  // Same scripted first utterance in four containers; answers are never supplied to the model.
  const original = await readFile(new URL('./live-fixtures/proposal.m4a', import.meta.url));
  await ingest('format-proposal', 'audio/mp4', original);
  const read = await api('/read', { ref: refs['format-proposal'] });
  check('M4A original bytes and MIME retained', read.mimeType === 'audio/mp4' && Buffer.from(read.dataBase64, 'base64').equals(original));
  for (const [file, mimeType] of [['proposal.opus', 'audio/ogg'], ['proposal.flac', 'audio/flac'], ['proposal.aac', 'audio/aac']]) {
    const bytes = await readFile(new URL('./live-fixtures/' + file, import.meta.url));
    const found = await api('/search', { query: 'The proposal to hold meeting M42 on Friday', sessionRef: 'format-' + file,
      media: { mimeType, dataBase64: bytes.toString('base64') } });
    check(`${mimeType} query grounds the original M4A proposal`, found.items.some(v => v.groundings?.some(g => g.ref.sourceId === source('format-proposal') && g.modalities.includes('audio'))));
  }
  const old = refs['format-proposal'];
  const revised = await api('/reinspect', { ref: old, operationId: 'reinspect-format', question: 'Recheck the audible meeting proposal.' });
  refs['format-proposal'] = revised.ref;
  const current = await api('/read', { ref: revised.ref });
  check('format reinspection preserves original and advances revision', revised.ref.sourceId === old.sourceId && revised.ref.revision === old.revision + 1 && current.mimeType === 'audio/mp4' && Buffer.from(current.dataBase64, 'base64').equals(original) && !(await api('/validate', { refs: [old] })).valid);
  await api('/revoke', { ref: revised.ref, operationId: 'revoke-format' });
  check('format revocation invalidates current reference', !(await api('/validate', { refs: [revised.ref] })).valid);
  await save();
}
async function containerQuery() {
  const query = await readFile(new URL('./live-fixtures/proposal.webm', import.meta.url));
  const native = await api('/search', { media: { mimeType: 'video/webm', dataBase64: query.toString('base64') }, sessionRef: 'native-webm' });
  check('native WebM query grounds MKV audio evidence', native.items.some(v => v.groundings?.some(g => g.modalities.includes('audio'))) && native.videos?.some(v => v.ref.sourceId === source('container') && v.clips.length));
  const clips = native.videos?.find(v => v.ref.sourceId === source('container'))?.clips ?? [];
  check('native WebM query excludes different meeting events', clips.length > 0 && clips.every(c => c.startMs < 7043 && c.endMs <= 7043), clips);
}
async function containerSearchCases() {
  if (reuseFrom) {
    const status = await api('/video/status', { operationId: 'multipart-video' });
    if (status.state !== 'complete' || !status.ref) throw Error('The reused recording must already be complete; no retry or recovery is performed.');
    refs.container = status.ref;
  } else {
    const original = await readFile(new URL('./live-fixtures/meeting.mkv', import.meta.url));
    refs.container = await recording('video', 'video/x-matroska', original, 15);
  }
  await containerQuery();
  await save();
}
async function containerCases() {
  // Existing scripted meeting: copied video and continuously encoded soundtrack
  // in MKV. The WebM query has a plain blue
  // image and the first spoken proposal, so grounding must use the soundtrack.
  const original = await readFile(new URL('./live-fixtures/meeting.mkv', import.meta.url));
  refs.container = await recording('video', 'video/x-matroska', original, 15);
  const range = await api('/read', { ref: refs.container, range: { startMs: 0, endMs: 1000 } });
  check('MKV range returns linked native MOV', range.mimeType === 'video/quicktime' && range.ref.sourceId === source('container') && range.originalIsFullFile === false && range.dataBase64.length > 0);
  await api('/video/reason', { ref: refs.container, operationId: 'reason-mkv', query: 'What day is meeting M42 scheduled for after the final explicit revision?' });
  const result = await waitJob('video', 'reason-mkv');
  check('MKV cross-clip final revision is Sunday', /Sunday|周日|星期日|星期天|周天/i.test(result.reasoning?.conclusion?.text || ''), result.reasoning?.conclusion);
  check('MKV conclusion cites complete native evidence', result.reasoning?.conclusion?.status === 'provisional' && !result.reasoning.incomplete && !result.reasoning.requireMore && !result.reasoning.coverageIncomplete && result.reasoning.conclusion.support.length > 0 && result.reasoning.conclusion.opposition.length === 0);
  const grouped = await api('/search', { query: 'M42 meeting schedule decision', sessionRef: 'grouped-mkv' });
  check('MKV clips grouped under original', grouped.videos?.some(v => v.ref.sourceId === source('container') && v.clips?.length));
  await containerQuery();
  const old = refs.container;
  await api('/reinspect', { ref: old, operationId: 'reinspect-mkv', question: 'Recheck the spoken meeting schedule and any explicit corrections.' });
  refs.container = (await waitJob('video', 'reinspect-mkv')).ref;
  check('MKV rebuild advances source and invalidates old reference', refs.container.sourceId === old.sourceId && refs.container.revision === old.revision + 1 && !(await api('/validate', { refs: [old] })).valid);
  await runtime.dispose(); runtime = await start();
  check('MKV rebuilt source survives restart', (await api('/validate', { refs: [refs.container] })).valid);
  await api('/revoke', { ref: refs.container, operationId: 'revoke-mkv' });
  check('MKV revocation invalidates rebuilt reference', !(await api('/validate', { refs: [refs.container] })).valid);
  const after = await api('/search', { query: 'M42 meeting schedule decision', sessionRef: 'revoked-mkv' });
  check('revoked MKV absent from grouped search', !after.videos?.some(v => v.ref.sourceId === source('container')));
  await save();
}
async function imageFormatCases() {
  const still = await readFile(new URL('./live-fixtures/C.avif', import.meta.url));
  const animated = await readFile(new URL('./live-fixtures/revision.gif', import.meta.url));
  if(reuseFrom) {
    const previous=await api('/operation',{operationId:'ingest-avif-notice'});
    if(previous.state!=='failed'||previous.stage!=='formation') throw Error('Image recovery requires the recorded deterministic formation failure.');
    const recovered=await api('/recover',{previousOperationId:'ingest-avif-notice',operationId:'recover-avif-notice'});
    refs['avif-notice']=recovered.ref;
  } else await ingest('avif-notice', 'image/avif', still);
  await ingest('animated-notices', 'image/gif', animated);
  const a=await api('/read',{ref:refs['avif-notice']}), g=await api('/read',{ref:refs['animated-notices']});
  check('AVIF original retained with explicit PNG representation', a.mimeType==='image/avif' && Buffer.from(a.dataBase64,'base64').equals(still) && a.representation?.kind==='still');
  check('GIF original and source cycle retained', g.mimeType==='image/gif' && Buffer.from(g.dataBase64,'base64').equals(animated) && g.timeline?.durationMs===6000 && g.timeline.animation.frames.length===2 && g.timeline.animation.frames[1].startMs===3000 && g.timeline.animation.loopCount===0);
  const nativeStill=await api('/search',{sessionRef:'avif-query',media:{mimeType:'image/avif',dataBase64:still.toString('base64')}});
  check('native AVIF query retrieves its own meeting', nativeStill.items.some(i=>i.refs.some(r=>r.sourceId===source('avif-notice'))) && !nativeStill.items.some(i=>i.refs.some(r=>r.sourceId===source('animated-notices'))));
  const nativeAnimation=await api('/search',{sessionRef:'gif-query',media:{mimeType:'image/gif',dataBase64:animated.toString('base64')}});
  check('native GIF query grounds its own timeline', nativeAnimation.items.some(i=>i.groundings?.some(g=>g.ref.sourceId===source('animated-notices')&&g.startMs>=0&&g.endMs<=6000)) && !nativeAnimation.items.some(i=>i.refs.some(r=>r.sourceId===source('avif-notice'))));
  const old=refs['avif-notice'];
  const rebuilt=await api('/reinspect',{ref:old,operationId:'reinspect-avif',question:'Recheck the meeting identifier, scheduled date and room from the retained original.'});
  refs['avif-notice']=rebuilt.ref;
  check('AVIF reinspection advances version and preserves original', rebuilt.ref.revision===old.revision+1 && !(await api('/validate',{refs:[old]})).valid && Buffer.from((await api('/read',{ref:rebuilt.ref})).dataBase64,'base64').equals(still));
  await api('/revoke',{ref:refs['animated-notices'],operationId:'revoke-gif'});
  check('GIF source revoked', !(await api('/validate',{refs:[refs['animated-notices']]})).valid);
  await save();
}
async function documentCases(){
  const {liveDocumentFixtures}=await import('./live-document-fixtures.mjs');
  const {fixtures,query}=await liveDocumentFixtures();
  const documents=[];
  for(const [index,fixture] of fixtures.entries()){
    await writeFile(join(out,fixture.name),fixture.bytes,{mode:0o600});
    const operationId=`document-${index}`;
    const created=await api('/ingest',{operationId,messageRef:fixture.name,sessionRef:'native-documents',mimeType:fixture.mimeType,dataBase64:Buffer.from(fixture.bytes).toString('base64')});
    const done=await waitJob('document',operationId),units=await api('/document/units',{ref:done.ref});
    const original=await api('/read',{ref:done.ref});
    check(`${fixture.name} original and units retained`,done.ref.sourceId===created.ref.sourceId&&units.units.filter(u=>u.locator.kind!=='office-rendered-page').length===fixture.units&&Buffer.from(original.dataBase64,'base64').equals(Buffer.from(fixture.bytes)));
    for(const unit of units.units){const read=await api('/read',{ref:unit.ref});check(`${fixture.name} unit ${unit.index} linked native evidence`,read.documentUnit?.original.sourceId===done.ref.sourceId&&read.documentUnit.locator.kind===unit.locator.kind&&read.provenance.roots.length===1&&read.provenance.roots[0]===done.ref.sourceId);}
    documents.push({fixture,ref:done.ref,units:units.units});
  }
  // Same retained slide original, interpreted again under the production reinspection path.
  const slide=documents[3],old=slide.ref;
  await api('/reinspect',{ref:old,operationId:'document-reinspect-slide',question:'Recheck the meeting identifier, scheduled date and room from the embedded original notice. Do not infer a decision from the unrelated heading.'});
  slide.ref=(await waitJob('document','document-reinspect-slide')).ref;
  const renewed=await api('/document/units',{ref:slide.ref});
  check('document rebuild invalidates original root and every old unit',(await api('/validate',{refs:[old,...slide.units.map(u=>u.ref)]})).invalid.length===slide.units.length+1&&slide.ref.revision===old.revision+1);
  slide.units=renewed.units;
  check('document rebuild reuses native original',Buffer.from((await api('/read',{ref:slide.ref})).dataBase64,'base64').equals(Buffer.from(slide.fixture.bytes)));
  await runtime.dispose();runtime=await start();
  const found=await api('/search',{sessionRef:'pdf-query',limit:20,query:'Find document units containing the same PROJECT REVIEW MEETING notice shown in the query PDF. Match the meeting ID, scheduled date/time and room; the surrounding page label is not part of the requested notice. Do not match a different meeting, a budget table or an unrelated proposal.',media:{mimeType:query.mimeType,dataBase64:Buffer.from(query.bytes).toString('base64')}});
  const expected=[documents[0].ref.sourceId,documents[1].ref.sourceId,documents[3].ref.sourceId];
  const evidence=found.items.flatMap(i=>i.documentEvidence??[]);
  check('text-scoped native PDF query grounds M-18 across three document formats',expected.every(id=>evidence.some(e=>e.original.sourceId===id))&&found.documents.length===3,evidence.map(e=>({original:e.original,locator:e.locator,text:e.text})));
  check('text-scoped native PDF query excludes M-17 and unrelated cells',evidence.filter(e=>e.locator.kind!=='office-rendered-page').length===3&&evidence.every(e=>expected.includes(e.original.sourceId))&&evidence.filter(e=>e.original.sourceId===documents[0].ref.sourceId).every(e=>e.locator.pageIndex===0)&&evidence.filter(e=>e.original.sourceId===documents[1].ref.sourceId&&e.locator.kind!=='office-rendered-page').every(e=>e.locator.blockIndex===0));
  // Revoking every root needs no further generative call to check eligibility.
  for(const [index,doc] of documents.entries())await api('/revoke',{ref:doc.ref,operationId:`document-revoke-${index}`});
  const after=await knowledge();
  check('revoked document roots remove all unit knowledge',after.claims.length===0&&after.relations.every(r=>!r.active));
  check('revoked roots and units are invalid',!(await api('/validate',{refs:documents.flatMap(d=>[d.ref,...d.units.map(u=>u.ref)])})).valid);
  await save();
}
async function officeRenderingCases(){
  const {officeRenderFixtures}=await import('../memory/test/office-render-fixtures.mjs');
  const documents=[];
  for(const [index,fixture] of officeRenderFixtures().entries()){
    if(reuseFrom){try{fixture.bytes=await readFile(join(resolve(reuseFrom),fixture.name));}catch(error){if(error.code!=='ENOENT')throw error;}}
    await writeFile(join(out,fixture.name),fixture.bytes,{mode:0o600});
    let operationId=`office-${index}`;
    let recovered=previousReport?.recoveries?.find(r=>r.previousOperationId===operationId);
    while(recovered){operationId=recovered.operationId;recovered=previousReport.recoveries.find(r=>r.previousOperationId===operationId);}
    const admitted=operationId===`office-${index}`
      ?await api('/ingest',{operationId,messageRef:fixture.name,sessionRef:'office-rendering',mimeType:fixture.mimeType,dataBase64:Buffer.from(fixture.bytes).toString('base64')})
      :await api('/document/status',{operationId});
    if(reuseFrom&&['running','unknown'].includes(admitted.state)){
      if(process.env.HY_LIVE_ACCEPT_UNKNOWN!=='1')throw Error('Retained Office operation needs explicit HY_LIVE_ACCEPT_UNKNOWN=1 recovery.');
      const previousOperationId=operationId;operationId+='-explicit-recovery';
      await api('/document/recover',{previousOperationId,operationId,acceptUnknown:true});
      report.recoveries??=[];report.recoveries.push({previousOperationId,operationId,reason:'Explicit continuation after the original harness stopped; first responses retained.'});await save();
    }
    const done=await waitJob('document',operationId),units=(await api('/document/units',{ref:done.ref})).units;
    const pages=units.filter(u=>u.locator.kind==='office-rendered-page');
    check(`${fixture.name} native units and two derived pages published`,pages.length===2&&units.length>pages.length&&done.complete);
    check(`${fixture.name} original bytes preserved`,Buffer.from((await api('/read',{ref:done.ref})).dataBase64,'base64').equals(Buffer.from(fixture.bytes)));
    for(const page of pages){
      const read=await api('/read',{ref:page.ref}),packed=JSON.parse(Buffer.from(read.dataBase64,'base64').toString());
      await writeFile(join(out,`${fixture.name}-page-${page.locator.page}.pdf`),Buffer.from(packed.derived.dataBase64,'base64'),{mode:0o600});
      check(`${fixture.name} page ${page.locator.page} linked render evidence`,read.provenance.roots.length===1&&read.provenance.roots[0]===done.ref.sourceId&&read.documentUnit.original.sourceId===done.ref.sourceId&&packed.context.rendering.officeIdentical===false&&packed.coverage.unsupported.some(c=>c.kind==='office-render-font-substitution'));
    }
    documents.push({fixture,ref:done.ref,units});
  }
  const cases=[
    {name:'Word rendered Chinese table',query:'Find a rendered Word document page that visibly shows the Chinese title 中文排版验证 and the two-cell table containing 项目 and 数值 42 on that same page.',document:0,page:1},
    {name:'Excel cached value remains 99',query:'Find the rendered spreadsheet page showing 缓存公式 with displayed cached value 99. Do not recalculate the formula to 2.',document:1,page:1},
    {name:'Excel hidden-row break carries to second page',query:'Find the rendered spreadsheet page with the repeated header 标题 / Value above both Second page / 42 and Last row / Done.',document:1,page:2},
  ];
  for(const c of cases){
    const found=await api('/search',{query:c.query,sessionRef:'office-layout-query',limit:20});
    const evidence=found.items.flatMap(i=>i.documentEvidence??[]);
    check(c.name,evidence.some(e=>e.original.sourceId===documents[c.document].ref.sourceId&&e.basis==='rendered-document-page'&&e.locator.page===c.page),evidence.map(e=>({original:e.original,locator:e.locator,basis:e.basis,text:e.text})));
  }
  const absent=await api('/search',{query:'Find a rendered spreadsheet page visibly displaying the exact text HIDDEN ROW or HIDDEN COLUMN. Text retained only in hidden native cells does not qualify.',sessionRef:'office-layout-negative',limit:20});
  check('hidden cells do not become visible page evidence',!absent.items.some(i=>i.documentEvidence?.some(e=>e.original.sourceId===documents[1].ref.sourceId)),absent.items.flatMap(i=>i.documentEvidence??[]));
  const office=documents[0],old=office.ref,oldUnits=office.units;
  await api('/reinspect',{ref:old,operationId:'office-reinspect',question:'Reinspect the retained original and derived pages: preserve the Chinese table, repeated header and explicit page break.'});
  office.ref=(await waitJob('document','office-reinspect')).ref;
  office.units=(await api('/document/units',{ref:office.ref})).units;
  check('whole source reinspection replaces native and rendered refs',(await api('/validate',{refs:[old,...oldUnits.map(u=>u.ref)]})).invalid.length===oldUnits.length+1&&office.ref.revision===old.revision+1&&office.units.filter(u=>u.locator.kind==='office-rendered-page').length===2);
  check('reinspection retains original bytes',Buffer.from((await api('/read',{ref:office.ref})).dataBase64,'base64').equals(Buffer.from(office.fixture.bytes)));
  await runtime.dispose();runtime=await start();
  check('rendered and native units survive runtime restart',(await api('/validate',{refs:documents.flatMap(d=>[d.ref,...d.units.map(u=>u.ref)])})).valid);
  for(const [index,d]of documents.entries())await api('/revoke',{ref:d.ref,operationId:`office-revoke-${index}`});
  const view=await knowledge();
  check('revocation removes native and rendered knowledge',view.claims.length===0&&view.relations.every(r=>!r.active));
  const allRefs=documents.flatMap(d=>[d.ref,...d.units.map(u=>u.ref)]);
  check('revocation invalidates every representation',(await api('/validate',{refs:allRefs})).invalid.length===allRefs.length);
  await save();
}
try {
  runtime = await start();
  check('unauthenticated API rejected', (await runtime.dispatchFetch('https://acceptance.test/revision', { method: 'POST', headers: { 'Content-Type':'application/json' }, body:'{}' })).status === 401);
  check('private read callback hidden', (await runtime.dispatchFetch('https://acceptance.test/read-store', { method: 'POST' })).status === 404);
  if (profile === 'all' || profile === 'knowledge') await knowledgeCases();
  if (profile === 'all' || profile === 'media') await mediaCases();
  if (profile === 'formats') await formatCases();
  if (profile === 'containers') await containerCases();
  if (profile === 'container-search') await containerSearchCases();
  if (profile === 'images') await imageFormatCases();
  if (profile === 'documents') await documentCases();
  if (profile === 'office-rendering') await officeRenderingCases();
  report.finished = true;
} catch (error) {
  report.failures.push(error.message); report.error = error.message;
} finally {
  if (runtime) await runtime.dispose();
  report.finishedAt = new Date().toISOString();
  await save();
}
console.log(JSON.stringify({ output: out, calls: report.calls, checks: report.checks.length, failures: report.failures, finished: report.finished, semanticReview: report.semanticReview }));
if (report.failures.length) process.exitCode = 1;
