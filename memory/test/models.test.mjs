import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectMedia } from '../dist/media.js';
import { CloudflareMemoryModels } from '../dist/models.js';
const settings = { accountId: 'account', gatewayId: 'gateway', token: 'fixture-token', formationModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  temporalModel: 'gemini-2.5-flash', textEmbeddingModel: '@cf/qwen/qwen3-embedding-0.6b', mediaEmbeddingModel: 'gemini-embedding-2' };
const timeline = { durationMs: 1000, hasAudio: true, hasVideo: true };
const temporal = text => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
const engine = { fetch: async () => Response.json({ success: true }) };
test('image matching sends original and cue images with all text constraints to Workers AI', async () => {
  let sent;
  const models = new CloudflareMemoryModels(settings, engine, async (url, init) => {
    assert.ok(url.includes('/ai/v1/chat/completions')); sent = JSON.parse(init.body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ matches: false, text: 'Source is red, while the query requires blue.', correctionRelevant: false }) } }] });
  });
  const result = await models.matchImage({ mimeType: 'image/png', bytes: Uint8Array.of(1), query: 'Only blue cups', media: { mimeType: 'image/png', bytes: Uint8Array.of(2) } });
  assert.equal(result.matches, false);
  const images = sent.messages[1].content.filter(item => item.type === 'image_url');
  assert.equal(images[0].image_url.url, 'data:image/png;base64,AQ==');
  assert.equal(images[1].image_url.url, 'data:image/png;base64,Ag==');
  assert.match(sent.messages[1].content.at(-1).text, /Only blue cups/);
  assert.equal(sent.reasoning_effort, 'none');
});
test('image matching keeps audio query native on the configured AV route and rejects invented correction authority', async () => {
  let sent, attempts = 0;
  const models = new CloudflareMemoryModels(settings, engine, async (url, init) => {
    attempts++; assert.ok(url.endsWith('/ai/run')); sent = JSON.parse(init.body);
    return temporal(JSON.stringify({ matches: false, text: 'No audio evidence exists in a still image.', correctionRelevant: true }));
  });
  await assert.rejects(models.matchImage({ mimeType: 'image/png', bytes: Uint8Array.of(1), query: 'Find the sound source', media: { mimeType: 'audio/wav', bytes: Uint8Array.of(2) } }), /image_match_response_invalid/);
  assert.equal(attempts, 1);
  assert.equal(sent.model, 'google/gemini-2.5-flash');
  assert.equal(sent.input.contents[0].parts[3].inlineData.mimeType, 'audio/wav');
});
test('native temporal perception sends original video with soundtrack and actual audio query media', async () => {
  const requests = [];
  const audio = new Uint8Array(await readFile(new URL('fixtures/tone.wav', import.meta.url)));
  const models = new CloudflareMemoryModels(settings, engine, async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, headers: init.headers, body });
    if (url.includes(':embedContent')) return Response.json({ embedding: { values: Array(1536).fill(0.1) } });
    if (url.endsWith('/ai/run')) return body.input.generationConfig.responseSchema
      ? temporal(JSON.stringify({ correctionRelevant: false, intervals: [{ startMs: 0, endMs: 500, text: 'blue image and tone', modalities: ['audio', 'video'] }] }))
      : temporal('Synthetic native observation.');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Synthetic image observation.' } }] });
  });
  await models.perceive('image/png', Uint8Array.of(1, 2));
  const perception = await models.perceive('video/mp4', Uint8Array.of(3, 4), timeline);
  const hits = await models.locate({ mimeType: 'video/mp4', bytes: Uint8Array.of(3, 4), timeline,
    query: 'the beep', media: { mimeType: 'audio/wav', bytes: audio } });
  await models.embed({ mimeType: 'video/mp4', bytes: Uint8Array.of(3, 4) });
  assert.equal(perception.kind, 'video'); assert.equal(perception.model, 'google-ai-studio/gemini-2.5-flash');
  assert.match(requests[0].body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(requests[1].body.input.contents[0].parts[0], { inlineData: { mimeType: 'video/mp4', data: 'AwQ=' } });
  assert.deepEqual(requests[2].body.input.contents[0].parts.slice(0, 2), [requests[1].body.input.contents[0].parts[0],
    { inlineData: { mimeType: 'audio/wav', data: Buffer.from(audio).toString('base64') } }]);
  assert.equal(requests[1].url, 'https://api.cloudflare.com/client/v4/accounts/account/ai/run');
  assert.equal(requests[1].body.model, 'google/gemini-2.5-flash');
  assert.equal(requests[1].headers.Authorization, 'Bearer fixture-token');
  assert.equal(requests[1].headers['cf-aig-authorization'], undefined);
  assert.equal(requests[1].headers['cf-aig-gateway-id'], 'gateway');
  assert.equal(requests[1].headers['cf-aig-max-attempts'], '1');
  assert.equal(requests[1].headers['cf-aig-skip-cache'], 'true');
  assert.equal(requests[3].headers['cf-aig-authorization'], 'Bearer fixture-token');
  assert.equal(hits.intervals[0].basis, 'model-estimate'); assert.deepEqual(hits.intervals[0].modalities, ['audio', 'video']);
  assert.deepEqual(requests[3].body.content.parts, [{ inline_data: { mime_type: 'video/mp4', data: 'AwQ=' } }]);
});

test('standalone audio perception uses parsed WAV windows and the windows response contract', async () => {
  const audio = new Uint8Array(await readFile(new URL('fixtures/tone.wav', import.meta.url)));
  const audioTimeline = await inspectMedia('audio/wav', audio);
  let attempts = 0, sent;
  const models = new CloudflareMemoryModels(settings, engine, async (_url, init) => {
    attempts++; sent = JSON.parse(init.body).input;
    assert.ok(sent.generationConfig.responseSchema.properties.windows);
    const parts = sent.contents[0].parts;
    const ids = parts.flatMap(part => /^SOURCE WINDOW (w\d+)\./.exec(part.text ?? '')?.slice(1) ?? []);
    for (const part of parts.filter(part => part.inlineData)) {
      assert.equal(part.inlineData.mimeType, 'audio/wav');
      const clip = Buffer.from(part.inlineData.data, 'base64');
      assert.equal(clip.toString('ascii', 0, 4), 'RIFF');
      assert.ok(clip.length > 44);
    }
    return temporal(JSON.stringify({ windows: ids.map(id => ({ id, text: 'A synthetic tone with surrounding silence.' })) }));
  });
  const result = await models.perceive('audio/wav', audio, audioTimeline);
  assert.equal(result.kind, 'audio'); assert.equal(result.configKey, 'sample-window-observation-v1');
  assert.match(result.text, /excerpt bounds, not exact event times/);
  assert.match(sent.contents[0].parts.at(-1).text, /AUDIO ONLY/);
  assert.equal(attempts, 1);
});
test('grounding rejects invalid times, unsupported modalities and malformed responses without retries', async () => {
  for (const intervals of [[{ startMs: 0, endMs: 1001, text: 'x', modalities: ['video'] }],
    [{ startMs: 0.5, endMs: 500, text: 'x', modalities: ['video'] }],
    [{ startMs: 500, endMs: 500, text: 'x', modalities: ['video'] }],
    [{ startMs: 0, endMs: 500, text: 'x', modalities: ['audio'] }], Array(4).fill({ startMs: 0, endMs: 500, text: 'x', modalities: ['video'] })]) {
    let attempts = 0;
    const models = new CloudflareMemoryModels(settings, engine, async () => { attempts++; return temporal(JSON.stringify({ correctionRelevant: false, intervals })); });
    await assert.rejects(models.locate({ query: 'x', mimeType: 'video/mp4', bytes: Uint8Array.of(1), timeline: { ...timeline, hasAudio: false } }), /grounding_response_invalid/);
    assert.equal(attempts, 1);
  }
});
test('generation response is bounded and non-STOP/error responses are terminal', async () => {
  for (const [response, error] of [[new Response('x'.repeat(128 * 1024 + 1)), /model_response_too_large/],
    [Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), /temporal_incomplete/],
    [new Response('{'), /model_response_invalid/], [new Response(null, { status: 429 }), /model_http_429/]]) {
    let attempts = 0;
    const models = new CloudflareMemoryModels(settings, engine, async () => { attempts++; return response; });
    await assert.rejects(models.perceive('video/mp4', Uint8Array.of(1), timeline), error); assert.equal(attempts, 1);
  }
  const models = new CloudflareMemoryModels(settings, { fetch: async () => new Response(null, { status: 422 }) });
  await assert.rejects(models.compute({}), /hy_engine_http_422/);
});

test('correction relevance is classified in the same native request and cannot be true without correction', async () => {
  let attempts = 0; let request;
  const models = new CloudflareMemoryModels(settings, engine, async (_url, init) => {
    attempts++; request = JSON.parse(init.body).input;
    return temporal(JSON.stringify({ intervals: [], correctionRelevant: true }));
  });
  const input = { query: 'original audio proves a red button and spoken warning together', mimeType: 'video/mp4', bytes: Uint8Array.of(1), timeline };
  await assert.rejects(models.locate(input), /grounding_response_invalid/);
  assert.equal(attempts, 1);
  assert.deepEqual(request.generationConfig.responseSchema.properties.correctionRelevant, { type: 'BOOLEAN' });
  assert.ok(request.generationConfig.responseSchema.required.includes('correctionRelevant'));
  assert.match(request.contents[0].parts.at(-1).text, /authority does not imply relevance/);
  assert.deepEqual(await models.locate({ ...input, correction: 'Owner clarifies which event this recording depicts.' }), { intervals: [], correctionRelevant: true });
  assert.equal(attempts, 2);
});

test('knowledge calls reserve output for explicit JSON and reject a length-limited answer without retry', async () => {
  const requests = [];
  const models = new CloudflareMemoryModels(settings, engine, async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
  });
  await assert.rejects(models.knowledge.extract({ source: { sourceId: 's', revision: 1, mediaRef: 'm' },
    perception: { kind: 'text', model: 'owner-statement', configKey: 'v1', text: 'a meeting' }, nodes: [], authority: 'owner' }), /knowledge_incomplete/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reasoning_effort, 'none');
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
});

test('structured video reasoning reserves JSON capacity separately from thinking and never retries truncation',async()=>{
  const ref={sourceId:'meeting',revision:1,mediaRef:'original'};
  const prior={events:[],conclusion:{text:'Unknown',status:'unknown',support:[],opposition:[]},incomplete:false,requireMore:false,model:'pending',configKey:'native-video-reason-v1'};
  const requests=[];
  const models=new CloudflareMemoryModels(settings,engine,async(_url,init)=>{
    const body=JSON.parse(init.body);requests.push(body);
    assert.equal(body.input.generationConfig.maxOutputTokens,8192);
    assert.deepEqual(body.input.generationConfig.thinkingConfig,{thinkingBudget:1024});
    return Response.json({candidates:[{finishReason:'MAX_TOKENS'}]});
  });
  await assert.rejects(models.reasonVideoClip({query:'What was decided?',mimeType:'video/mp4',bytes:Uint8Array.of(1),timeline,logical:{startMs:0,endMs:1000},offsetMs:0,prior,ref}),/temporal_incomplete/);
  await assert.rejects(models.compactVideoReason({query:'What was decided?',ref,state:prior}),/temporal_incomplete/);
  assert.equal(requests.length,2,'one request per explicitly invoked operation');
  assert.equal(requests[0].input.contents[0].parts[0].inlineData.mimeType,'video/mp4');
  assert.equal(requests[1].input.contents[0].parts.some(part=>part.inlineData),false);
});
