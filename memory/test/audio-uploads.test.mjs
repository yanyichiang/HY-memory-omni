import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoUploads } from '../dist/uploads.js';

test('audio multipart uploads use the existing immutable owner-scoped upload machinery and reject cross-family reuse',async()=>{
  const rows=new Map(),created=[];
  const db={async get(k){return rows.get(k);},async set(k,v){rows.set(k,v);},check(){}};
  const bucket={async createMultipartUpload(key,options){created.push({key,options});return {uploadId:'provider-upload'};}};
  const owner={ownerRef:'owner',scopeRef:'scope'};
  const audio=new VideoUploads(db,bucket,owner,'audio'),video=new VideoUploads(db,bucket,owner);
  for(const mimeType of ['audio/wav','audio/mpeg']){
    const upload=await audio.start({mimeType});
    assert.equal(upload.partBytes,8*1024*1024);
    const stored=rows.get(`upload:${upload.uploadId}`);
    assert.equal(stored.mimeType,mimeType);assert.match(stored.key,/^owner\/scope\/uploads\//);
    await assert.rejects(video.abort(upload.uploadId),/video_required/);
  }
  await assert.rejects(audio.start({mimeType:'video/mp4'}),/audio_required/);
  await assert.rejects(video.start({mimeType:'audio/mpeg'}),/video_required/);
  assert.equal(created.length,2);
});
