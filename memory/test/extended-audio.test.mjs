import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";

test("static Opus/FLAC decode preserves sample clocks, EOF integrity, bounded WAV and low-level nonzero samples", async () => {
  const directory = new URL("../dist/", import.meta.url),
    modules = {};
  for (const name of await readdir(directory)) {
    if (name.endsWith(".js"))
      modules[name] = {
        type: "esm",
        contents: await readFile(new URL(name, directory), "utf8"),
      };
    if (name.endsWith(".wasm"))
      modules[name] = {
        type: "wasm",
        contents: await readFile(new URL(name, directory)),
      };
  }
  modules["extended-test.js"] = {
    type: "esm",
    contents: `
    import {inspectExtendedAudio,sliceExtendedAudio,normalizeExtendedAudio} from './extended-audio.js';
    WebAssembly.compile=()=>{throw Error('runtime_compile_forbidden');};
    WebAssembly.compileStreaming=()=>{throw Error('runtime_compile_forbidden');};
    export default {async fetch(request){try{
      const url=new URL(request.url),mime=url.searchParams.get('mime'),bytes=new Uint8Array(await request.arrayBuffer()),original=bytes.slice();let maximum=0,reads=0;
      const source={size:bytes.length,async read(offset,length){maximum=Math.max(maximum,length);reads+=length;return bytes.slice(offset,offset+length);}};
      const timeline=await inspectExtendedAudio(mime,source,url.searchParams.has('limit')?Number(url.searchParams.get('limit')):undefined);
      const pcm=await normalizeExtendedAudio(mime,bytes,timeline);
      const logical={startMs:101,endMs:303};reads=0;
      const clip=timeline.durationMs>=303?await sliceExtendedAudio(mime,source,logical,timeline):undefined;
      const fullReads=reads;reads=0;
      const prefix=timeline.durationMs>=303?await sliceExtendedAudio(mime,source,logical,timeline,{validatedSource:true}):undefined;
      const prefixReads=reads;
      const encoded=data=>{let value='';for(let i=0;i<data.length;i+=8192)value+=String.fromCharCode(...data.subarray(i,i+8192));return btoa(value);};
      return Response.json({timeline,pcm:encoded(pcm),maximum,fullReads,prefixReads,...(prefix?{prefix:encoded(prefix.bytes)}:{}),unchanged:bytes.every((v,i)=>v===original[i]),...(clip?{clip:{...clip,bytes:encoded(clip.bytes)}}:{})});
    }catch(error){return Response.json({error:error.message},{status:error.status||500});}}};`,
  };
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "extended-audio-test",
          compatibilityDate: "2026-10-19",
          manifest: { mainModule: "extended-test.js", modules },
        },
      },
    ],
  });
  const call = async (mime, bytes, limit) => {
    const response = await mf.dispatchFetch(
      `http://test/?mime=${encodeURIComponent(mime)}${limit === undefined ? "" : `&limit=${limit}`}`,
      { method: "POST", body: bytes },
    );
    return { status: response.status, result: await response.json() };
  };
  try {
    for (const [mime, extension] of [
      ["audio/ogg", "opus"],
      ["audio/flac", "flac"],
    ]) {
      const bytes = new Uint8Array(
        await readFile(
          new URL(
            `fixtures/synthetic-extended-48123.${extension}`,
            import.meta.url,
          ),
        ),
      );
      const value = await call(mime, bytes);
      assert.equal(value.status, 200, JSON.stringify(value.result));
      const result = value.result,
        pcm = Buffer.from(result.pcm, "base64"),
        clip = Buffer.from(result.clip.bytes, "base64");
      assert.deepEqual(result.timeline, {
        durationMs: 1003,
        hasAudio: true,
        hasVideo: false,
      });
      assert.equal(pcm.readUInt16LE(20), 3);
      assert.equal(pcm.readUInt16LE(34), 32);
      assert.equal(pcm.readUInt32LE(44), 48123);
      assert.equal(pcm.length, 56 + 48123 * 4);
      assert.equal(result.unchanged, true);
      assert.ok(result.maximum <= 65536);
      assert.deepEqual(Buffer.from(result.prefix, "base64"), clip);
      assert.ok(
        result.prefixReads < result.fullReads,
        `${extension} prefix ${result.prefixReads} must read less than full ${result.fullReads}`,
      );
      assert.deepEqual(result.clip.actual, { startMs: 101, endMs: 303 });
      assert.equal(result.clip.offsetMs, 101);
      assert.deepEqual(
        clip.subarray(56),
        pcm.subarray(56 + 4848 * 4, 56 + 14544 * 4),
      );
      const limited = await call(mime, bytes, 1000);
      assert.equal(limited.status, 413);
      assert.equal(limited.result.error, "media_inline_expansion_exceeded");
      for (const removed of [1, 100]) {
        const truncated = await call(
          mime,
          bytes.subarray(0, bytes.length - removed),
        );
        assert.equal(truncated.status, 415, JSON.stringify(truncated.result));
      }
      if (extension === "opus") {
        const corrupted = bytes.slice();
        corrupted[corrupted.length - 20] ^= 1;
        const bad = await call(mime, corrupted);
        assert.equal(bad.status, 415);
        assert.equal(bad.result.error, "audio_ogg_crc_invalid");
      }
    }
    const quiet = await call(
      "audio/flac",
      new Uint8Array(
        await readFile(
          new URL("fixtures/synthetic-extended-low24.flac", import.meta.url),
        ),
      ),
    );
    assert.equal(quiet.status, 200, JSON.stringify(quiet.result));
    const low = Buffer.from(quiet.result.pcm, "base64");
    assert.equal(
      low.readUInt32LE(44),
      800,
      "the legal 13-byte FLAC final frame is retained",
    );
    assert.equal(low.readFloatLE(56), Math.fround(1 / 8388607));
    assert.equal(low.readFloatLE(60), -Math.fround(1 / 8388607));
  } finally {
    await mf.dispose();
  }
});
