// Model HTTP only. Memory authority, media decoding, Hy Writer/Reader and storage are real.
export async function modelFixture(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/chat/completions')) {
    const body = await request.json();
    let content = 'A blue fixture image.';
    if (body.messages[0].content.startsWith('Verify image retrieval')) {
      content = JSON.stringify({ matches: true, text: 'Visible fixture.', correctionRelevant: false });
    } else if (body.messages[0].content.startsWith('Project the supplied current Hy L2 memories')) {
      const input = JSON.parse(body.messages[1].content);
      content = JSON.stringify({ claims: [{ key: 'observed', nodeId: input.nodes[0].nodeId, text: input.perception.text,
        subject: 'Source observation', event: 'This recording', predicate: 'description', value: input.perception.text,
        validTime: '', conditions: '', quote: input.perception.text }] });
    } else if (body.messages[0].content.startsWith('Assess EACH supplied ordered pair')) {
      const input = JSON.parse(body.messages[1].content);
      content = JSON.stringify({ relations: input.pairs.map(({ left, right }) => ({ left: left.id, right: right.id, kind: 'different', reason: 'Independent fixtures.' })) });
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
  }
  if (url.pathname.endsWith(':embedContent')) return Response.json({ embedding: { values: [1, ...Array(1535).fill(0)] } });
  if (url.pathname.endsWith('/ai/run')) {
    const { input: body } = await request.json();
    const schema = body.generationConfig.responseSchema;
    let text = 'A blue frame and a synthetic tone.';
    if (schema?.properties.windows || schema?.properties.matches) {
      const ids = body.contents[0].parts.flatMap(part => /^SOURCE WINDOW (w\d+)\./.exec(part.text ?? '')?.slice(1) ?? []);
      const items = ids.map(id => ({ id, text: 'An audible synthetic tone.' }));
      text = JSON.stringify(schema.properties.windows ? { windows: items } : { matches: items, correctionRelevant: false });
    } else if (schema) {
      const native = body.contents[0].parts[0].inlineData;
      text = JSON.stringify({ correctionRelevant: false, intervals: [{ startMs: 100, endMs: 800, text, modalities: native.mimeType.startsWith('audio/') ? ['audio'] : ['video', 'audio'] }] });
    }
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
  }
  throw new Error(`Unexpected model route ${url.pathname}`);
}
