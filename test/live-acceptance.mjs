// Explicit live-provider test. Uses production main.py and the authenticated gateway.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readConfig } from '../scripts/config.mjs';
import { createRuntime } from '../scripts/runtime.mjs';

const profile = process.env.HY_LIVE_PROFILE || 'all';
if (!['knowledge', 'media', 'formats', 'containers', 'container-search', 'all'].includes(profile)) throw Error('HY_LIVE_PROFILE must be knowledge, media, formats, containers, container-search or all.');
if (!process.env.HY_LIVE_OUTPUT) throw Error('Set HY_LIVE_OUTPUT to a new private results directory. This command calls your configured live models.');
const out = resolve(process.env.HY_LIVE_OUTPUT);
const reuseFrom = process.env.HY_LIVE_REUSE_FROM;
if (reuseFrom && profile !== 'container-search') throw Error('Reuse is limited to the query-only container-search continuation.');
await mkdir(out, { mode: 0o700 }); // Never overwrite a first run or reuse its memory.
const config = await readConfig();
const report = { profile, startedAt: new Date().toISOString(), revision: process.env.HY_ACCEPTANCE_REVISION || 'working-tree',
  ...(reuseFrom ? { reuseFrom: resolve(reuseFrom), scope: 'Query-only continuation; no ingestion/reasoning replay.' } : {}),
  models: Object.fromEntries(Object.entries(config).filter(([k]) => k.endsWith('_MODEL'))),
  semanticReview: { status: 'required', note: 'Inspect first responses against fixture ground truth, including conclusion meaning, native evidence, explicit authority and revision targets. A matching word is not semantic proof.' },
  checks: [], failures: [], calls: 0, finished: false };
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
const start = () => createRuntime({ config, persistence: join(reuseFrom ? resolve(reuseFrom) : out, 'storage'), port: 0, outboundService: transport });
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
  for (let i = 0; i < 600; i++) {
    const status = await api(`/${path}/status`, { operationId });
    if (status.state === 'complete') return status;
    if (!['queued','running'].includes(status.state)) throw Error(`Job ${operationId}: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error(`Job ${operationId} timed out; retained state can be inspected, no automatic recovery.`);
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
try {
  runtime = await start();
  check('unauthenticated API rejected', (await runtime.dispatchFetch('https://acceptance.test/revision', { method: 'POST', headers: { 'Content-Type':'application/json' }, body:'{}' })).status === 401);
  check('private read callback hidden', (await runtime.dispatchFetch('https://acceptance.test/read-store', { method: 'POST' })).status === 404);
  if (profile === 'all' || profile === 'knowledge') await knowledgeCases();
  if (profile === 'all' || profile === 'media') await mediaCases();
  if (profile === 'formats') await formatCases();
  if (profile === 'containers') await containerCases();
  if (profile === 'container-search') await containerSearchCases();
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
