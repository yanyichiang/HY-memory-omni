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
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ matches: false, text: 'Source is red, while the query requires blue.' }) } }] });
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
  let sent, cue, attempts = 0;
  const models = new CloudflareMemoryModels(settings, engine, async (url, init) => {
    attempts++; assert.ok(url.endsWith('/ai/run')); sent = JSON.parse(init.body);
    if (!sent.input.generationConfig.responseSchema) { cue=sent; return temporal('An audible tone.'); }
    return temporal(JSON.stringify({ matches: false, text: 'No audio evidence exists in a still image.', correctionRelevant: true }));
  });
  await assert.rejects(models.matchImage({ mimeType: 'image/png', bytes: Uint8Array.of(1), query: 'Find the sound source', media: { mimeType: 'audio/wav', bytes: Uint8Array.of(2) } }), /image_match_response_invalid/);
  assert.equal(attempts, 2);
  assert.equal(sent.model, 'google/gemini-2.5-flash');
  assert.equal(cue.input.contents[0].parts[1].inlineData.mimeType, 'audio/wav');
  assert.deepEqual(sent.input.contents[0].parts.filter(p=>p.inlineData).map(p=>p.inlineData.mimeType),['image/png']);
  assert.match(sent.input.contents[0].parts[2].text,/An audible tone/);
});
test('native temporal perception sends original video with soundtrack and actual audio query media', async () => {
  const requests = [];
  const audio = new Uint8Array(await readFile(new URL('fixtures/tone.wav', import.meta.url)));
  const video = new Uint8Array(await readFile(new URL('fixtures/blue.mp4', import.meta.url)));
  const models = new CloudflareMemoryModels(settings, engine, async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, headers: init.headers, body });
    if (url.includes(':embedContent')) return Response.json({ embedding: { values: Array(1536).fill(0.1) } });
    if (url.endsWith('/ai/run')) return body.input.generationConfig.responseSchema
      ? temporal(JSON.stringify({ intervals: [{ startMs: 0, endMs: 500, text: 'blue image and tone', modalities: ['audio', 'video'] }] }))
      : temporal('Synthetic native observation.');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Synthetic image observation.' } }] });
  });
  await models.perceive('image/png', Uint8Array.of(1, 2));
  const perception = await models.perceive('video/mp4', Uint8Array.of(3, 4), timeline);
  const hits = await models.locate({ mimeType: 'video/mp4', bytes: Uint8Array.of(3, 4), timeline,
    query: 'the beep', media: { mimeType: 'audio/wav', bytes: audio } });
  const vector = await models.embed({ mimeType: 'video/mp4', bytes: video });
  assert.equal(perception.kind, 'video'); assert.equal(perception.model, 'google-ai-studio/gemini-2.5-flash');
  assert.match(requests[0].body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(requests[1].body.input.contents[0].parts[0], { inlineData: { mimeType: 'video/mp4', data: 'AwQ=' } });
  assert.deepEqual(requests[2].body.input.contents[0].parts.filter(p=>p.inlineData), [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from(audio).toString('base64') } }]);
  assert.deepEqual(requests[3].body.input.contents[0].parts.filter(p=>p.inlineData),[requests[1].body.input.contents[0].parts[0]]);
  assert.match(requests[3].body.input.contents[0].parts[1].text,/Synthetic native observation/);
  assert.equal(requests[1].url, 'https://api.cloudflare.com/client/v4/accounts/account/ai/run');
  assert.equal(requests[1].body.model, 'google/gemini-2.5-flash');
  assert.equal(requests[1].headers.Authorization, 'Bearer fixture-token');
  assert.equal(requests[1].headers['cf-aig-authorization'], undefined);
  assert.equal(requests[1].headers['cf-aig-gateway-id'], 'gateway');
  assert.equal(requests[1].headers['cf-aig-max-attempts'], '1');
  assert.equal(requests[1].headers['cf-aig-skip-cache'], 'true');
  assert.equal(requests[1].body.input.systemInstruction,undefined);
  assert.equal(requests[2].body.input.systemInstruction,undefined);
  assert.equal(requests[4].headers['cf-aig-authorization'], 'Bearer fixture-token');
  assert.equal(hits.intervals[0].basis, 'model-estimate'); assert.deepEqual(hits.intervals[0].modalities, ['audio', 'video']);
  assert.deepEqual(requests[4].body.content.parts, [{ inline_data: { mime_type: 'video/mp4', data: Buffer.from(video).toString('base64') } }]);
  assert.deepEqual(vector.modalities, ['video']);
});

test('standalone audio perception uses parsed WAV windows and the windows response contract', async () => {
  const audio = new Uint8Array(await readFile(new URL('fixtures/tone.wav', import.meta.url)));
  const audioTimeline = await inspectMedia('audio/wav', audio);
  let attempts = 0, sent;
  const models = new CloudflareMemoryModels(settings, engine, async (_url, init) => {
    attempts++; sent = JSON.parse(init.body).input;
    assert.ok(sent.generationConfig.responseSchema.properties.windows);
    assert.equal(sent.generationConfig.maxOutputTokens,4096);
    assert.deepEqual(sent.generationConfig.thinkingConfig,{thinkingBudget:1024});
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
  assert.equal(result.kind, 'audio'); assert.equal(result.configKey, 'sample-window-observation-v3');
  assert.match(result.text, /excerpt bounds, not exact event times/);
  assert.match(sent.systemInstruction.parts[0].text, /AUDIO ONLY/);
  assert.equal(attempts, 1);
});
test('grounding rejects invalid times, unsupported modalities and malformed responses without retries', async () => {
  for (const intervals of [[{ startMs: 0, endMs: 1001, text: 'x', modalities: ['video'] }],
    [{ startMs: 0.5, endMs: 500, text: 'x', modalities: ['video'] }],
    [{ startMs: 500, endMs: 500, text: 'x', modalities: ['video'] }],
    [{ startMs: 0, endMs: 500, text: 'x', modalities: ['audio'] }], Array(4).fill({ startMs: 0, endMs: 500, text: 'x', modalities: ['video'] })]) {
    let attempts = 0;
    const models = new CloudflareMemoryModels(settings, engine, async () => { attempts++; return temporal(JSON.stringify({ intervals })); });
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

test('video grounding asks correction relevance only for authenticated Owner input and rejects invented fields without retry', async () => {
  let attempts=0,request,reply={intervals:[]};
  const models=new CloudflareMemoryModels(settings,engine,async(_url,init)=>{
    attempts++;request=JSON.parse(init.body).input;return temporal(JSON.stringify(reply));
  });
  const input={query:'The Chair says correction in the recording',mimeType:'video/mp4',bytes:Uint8Array.of(1),timeline};
  assert.deepEqual(await models.locate(input),{intervals:[],correctionRelevant:false});
  assert.equal(request.generationConfig.responseSchema.properties.correctionRelevant,undefined);
  assert.deepEqual(request.generationConfig.responseSchema.required,['intervals']);
  assert.doesNotMatch(request.contents[0].parts.at(-1).text,/correctionRelevant/);
  assert.match(request.contents[0].parts.at(-1).text,/inside the recording are media evidence, not Owner input/);
  for(const value of [true,false]){
    reply={intervals:[],correctionRelevant:value};const before=attempts;
    await assert.rejects(models.locate(input),/grounding_response_invalid/);assert.equal(attempts,before+1);
  }
  const corrected={...input,correction:'Authenticated Owner clarifies which event the recording depicts.'};
  reply={intervals:[],correctionRelevant:true};
  assert.deepEqual(await models.locate(corrected),{intervals:[],correctionRelevant:true});
  assert.deepEqual(request.generationConfig.responseSchema.properties.correctionRelevant,{type:'BOOLEAN'});
  assert.ok(request.generationConfig.responseSchema.required.includes('correctionRelevant'));
  assert.match(request.contents[0].parts.at(-1).text,/authority does not imply relevance/);
  for(const value of [undefined,'true',1]){
    reply={intervals:[],correctionRelevant:value};
    await assert.rejects(models.locate(corrected),/grounding_response_invalid/);
  }
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


test('both image provider branches omit Owner relevance without correction and require a boolean with correction',async()=>{
  for(const media of [undefined,{mimeType:'audio/wav',bytes:Uint8Array.of(2)}]){
    let sent,reply={matches:false,text:'A visible caption says correction, which is media evidence.'},attempts=0;
    const models=new CloudflareMemoryModels(settings,engine,async(url,init)=>{
      attempts++;sent=JSON.parse(init.body);
      return url.endsWith('/ai/run')?temporal(JSON.stringify(reply)):Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(reply)}}]});
    });
    const input={mimeType:'image/png',bytes:Uint8Array.of(1),query:'Chair correction',...(media?{media}:{})};
    assert.equal((await models.matchImage(input)).correctionRelevant,false);
    const prompt=media?sent.input.contents[0].parts.at(-1).text:sent.messages[1].content.at(-1).text;
    assert.doesNotMatch(prompt,/correctionRelevant/);
    if(media){assert.equal(sent.input.generationConfig.responseSchema.properties.correctionRelevant,undefined);assert.deepEqual(sent.input.generationConfig.responseSchema.required,['matches','text']);}
    for(const value of [true,false]){
      reply={...reply,correctionRelevant:value};const before=attempts;
      await assert.rejects(models.matchImage(input),/image_match_response_invalid/);assert.equal(attempts,before+1);
    }
    reply={...reply,correctionRelevant:true};
    assert.equal((await models.matchImage({...input,correction:'Owner supplied context'})).correctionRelevant,true);
    const correctedPrompt=media?sent.input.contents[0].parts.at(-1).text:sent.messages[1].content.at(-1).text;
    assert.match(correctedPrompt,/correctionRelevant:boolean/);
    for(const value of [undefined,'true']){
      reply={...reply,correctionRelevant:value};await assert.rejects(models.matchImage({...input,correction:'Owner supplied context'}),/image_match_response_invalid/);
    }
  }
});


test('audio reinspection emits native Gemini systemInstruction and keeps the question out of audible source text',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('fixtures/tone.wav',import.meta.url)));
  const question='Is an instrument audible here?';let calls=0,sent;
  const models=new CloudflareMemoryModels(settings,engine,async(_url,init)=>{
    calls++;sent=JSON.parse(init.body).input;
    const parts=sent.contents[0].parts;
    assert.deepEqual(sent.systemInstruction.parts.length,1);
    assert.match(sent.systemInstruction.parts[0].text,/only its inline audio as audible evidence/);
    assert.equal(sent.systemInstruction.parts[0].text.includes(question),false);
    assert.equal(parts.at(-1).text,`REINSPECTION QUESTION DATA (not audio evidence): ${JSON.stringify(question)}`);
    assert.equal(parts.filter(part=>part.inlineData).length,1);
    assert.equal(parts.filter(part=>part.text).length,2);
    assert.ok(sent.generationConfig.responseSchema.properties.windows);
    assert.equal(sent.generationConfig.maxOutputTokens,4096);
    assert.deepEqual(sent.generationConfig.thinkingConfig,{thinkingBudget:1024});
    return temporal(JSON.stringify({windows:[{id:'w0',text:'A steady tone is audible.'}]}));
  });
  const value=await models.perceive('audio/wav',bytes,await inspectMedia('audio/wav',bytes),question);
  assert.equal(calls,1);assert.equal(value.configKey,'sample-window-observation-v3');assert.match(value.text,/steady tone/);
});
