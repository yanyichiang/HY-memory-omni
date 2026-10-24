import factory from './animation.mjs';
import wasm from './animation.wasm';
import { BufferSource, BufferTarget, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output } from 'mediabunny';
const MAX_BYTES = 8 * 1024 * 1024;
const fail = code => { throw new Error(code); };
const near = (a,b) => Math.abs(a-b) <= 1e-7;
/** White matte + edge padding, BT.601 limited-range YCbCr 4:2:0.
 * This deliberately lossy provider derivative never replaces the source RGBA/binary.
 */
function yuv420(rgba, w, h, cw, ch, heap) {
  const pixel = (x,y) => {
    const i = (Math.min(y,h-1)*w+Math.min(x,w-1))*4, a = rgba[i+3]/255;
    return [rgba[i]*a+255*(1-a),rgba[i+1]*a+255*(1-a),rgba[i+2]*a+255*(1-a)];
  };
  const clip = x => Math.max(0,Math.min(255,Math.round(x)));
  const size=cw*ch;
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){
    const [r,g,b]=pixel(x,y);heap[y*cw+x]=clip(16+0.256788*r+0.504129*g+0.097906*b);
  }
  for(let y=0;y<ch;y+=2)for(let x=0;x<cw;x+=2){
    let r=0,g=0,b=0;for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const p=pixel(x+dx,y+dy);r+=p[0]/4;g+=p[1]/4;b+=p[2]/4;}
    const at=(y/2)*(cw/2)+x/2;heap[size+at]=clip(128-0.148223*r-0.290993*g+0.439216*b);heap[size+size/4+at]=clip(128+0.439216*r-0.367788*g-0.071427*b);
  }
}
function avcPacket(annex) {
  const nals=[];let begin=-1;
  for(let at=0;at<annex.length;){
    let prefix=0;
    if(annex[at]===0&&annex[at+1]===0){if(annex[at+2]===1)prefix=3;else if(annex[at+2]===0&&annex[at+3]===1)prefix=4;}
    if(prefix){if(begin>=0){let end=at;while(end>begin&&annex[end-1]===0)end--;if(end>begin)nals.push(annex.subarray(begin,end));}begin=at+prefix;at+=prefix;}else at++;
  }
  if(begin>=0&&begin<annex.length)nals.push(annex.subarray(begin));
  const sps=nals.find(n=>(n[0]&31)===7),pps=nals.find(n=>(n[0]&31)===8);
  if(!sps||!pps||sps.length<4||sps.length>65535||pps.length>65535||!nals.some(n=>(n[0]&31)===5)||nals.some(n=>(n[0]&31)===1))fail('animation_intra_invalid');
  const description=new Uint8Array(11+sps.length+pps.length),v=new DataView(description.buffer);
  description.set([1,sps[1],sps[2],sps[3],255,225]);v.setUint16(6,sps.length);description.set(sps,8);let at=8+sps.length;description[at++]=1;v.setUint16(at,pps.length);description.set(pps,at+2);
  const bytes=new Uint8Array(nals.reduce((n,p)=>n+4+p.length,0)),view=new DataView(bytes.buffer);at=0;
  for(const nal of nals){view.setUint32(at,nal.length);bytes.set(nal,at+4);at+=nal.length+4;}
  return {bytes,description,codec:`avc1.${[sps[1],sps[2],sps[3]].map(v=>v.toString(16).padStart(2,'0')).join('')}`};
}
/** `frames` is Iterable/AsyncIterable of full, already composited RGBA frame records.
 * Each record's startMs/endMs/durationMs is its exact source coordinate.
 * Caller must hold the shared image/audio resource permit for the whole operation.
 */
export async function encodeAnimationSource({width,height,frames,sourceMetadata=()=>({}),maxBytes=MAX_BYTES}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0||maxBytes>MAX_BYTES)fail('animation_limit_invalid');
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width>2048||height>2048)fail('animation_dimensions_limit');
  const codedWidth=width+(width&1),codedHeight=height+(height&1);
  if(codedWidth*codedHeight>1048576)fail('animation_dimensions_limit');
  const module=await factory({instantiateWasm(imports,receive){const instance=new WebAssembly.Instance(wasm,imports);receive(instance,wasm);return instance.exports;}});
  const encoder=module._animation_create(codedWidth,codedHeight),pointer=module._malloc(4);
  if(!encoder||!pointer){if(encoder)module._animation_free(encoder);if(pointer)module._free(pointer);fail('animation_allocation_failed');}
  let sourceFrameCount=0,encodedFrameCount=0,encodedBytes=0,cursor=0,config;
  const times=[],zeroDurationFrameIndices=[];
  const target=new BufferTarget();target.onwrite=(_data,position)=>{if(position>maxBytes)fail('animation_encoded_limit');};
  const output=new Output({format:new Mp4OutputFormat({fastStart:false}),target});
  const track=new EncodedVideoPacketSource('avc');
  try {
    for await(const frame of frames){
      if(++sourceFrameCount>128)fail('animation_frame_limit');
      if(!(frame.rgba instanceof Uint8Array || frame.rgba instanceof Uint8ClampedArray)||frame.rgba.length!==width*height*4||!Number.isFinite(frame.startMs)||!Number.isFinite(frame.endMs)||!Number.isFinite(frame.durationMs)||frame.durationMs<0||!near(frame.startMs,cursor)||!near(frame.endMs-frame.startMs,frame.durationMs))fail('animation_frame_timeline_invalid');
      cursor=frame.endMs;
      if(!Number.isFinite(cursor)||cursor<0||cursor>Number.MAX_SAFE_INTEGER/1000)fail('animation_frame_timeline_invalid');
      if(frame.durationMs===0){zeroDurationFrameIndices.push(sourceFrameCount-1);continue;}
      const input=module._animation_input(encoder),size=codedWidth*codedHeight*3/2;
      if(!Number.isSafeInteger(input)||input<=0||input+size>module.HEAPU8.length)fail('animation_allocation_failed');
      yuv420(frame.rgba,width,height,codedWidth,codedHeight,module.HEAPU8.subarray(input,input+size));
      const length=module._animation_encode(encoder,pointer),data=module.HEAPU32[pointer/4];
      if(!Number.isSafeInteger(length)||length<=0||!Number.isSafeInteger(data)||data<=0||data+length>module.HEAPU8.length)fail('animation_encode_invalid');
      if(encodedBytes+length>maxBytes)fail('animation_encoded_limit');
      const packet=avcPacket(module.HEAPU8.subarray(data,data+length));encodedBytes+=packet.bytes.length;if(encodedBytes>maxBytes)fail('animation_encoded_limit');
      if(!config){config={codec:packet.codec,codedWidth,codedHeight,description:packet.description,colorSpace:{primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:false}};output.addVideoTrack(track,{decoderConfig:config,hasOnlyKeyPackets:true});await output.start();}
      else if(packet.description.length!==config.description.length||packet.description.some((v,i)=>v!==config.description[i]))fail('animation_config_changed');
      await track.add(new EncodedPacket(packet.bytes,'key',frame.startMs/1000,frame.durationMs/1000),{decoderConfig:config});
      times.push({sourceIndex:sourceFrameCount-1,startMs:frame.startMs,endMs:frame.endMs,durationMs:frame.durationMs});encodedFrameCount++;
    }
    if(!encodedFrameCount)fail(sourceFrameCount>1?'animation_all_zero_duration':'animation_zero_duration');
    track.close();await output.finalize();
    if(!target.buffer||target.buffer.byteLength>maxBytes)fail('animation_encoded_limit');
    const mediaBytes=new Uint8Array(target.buffer);
    const checked=new Input({formats:[MP4],source:new BufferSource(mediaBytes)});let muxTimeResolution=0;
    try{const t=await checked.getPrimaryVideoTrack();if(!t)fail('animation_mux_invalid');muxTimeResolution=await t.getTimeResolution();let i=0;
      for await(const p of new EncodedPacketSink(t).packets()){const source=times[i++];if(!source||p.type!=='key'||p.duration<=0||Math.abs(p.timestamp-source.startMs/1000)>1/muxTimeResolution+1e-9||Math.abs(p.duration-source.durationMs/1000)>1/muxTimeResolution+1e-9)fail('animation_mux_timeline_invalid');source.outputStartMs=p.timestamp*1000;source.outputDurationMs=p.duration*1000;}
      if(i!==encodedFrameCount)fail('animation_mux_timeline_invalid');
    }finally{checked.dispose();}
    return {mimeType:'video/mp4',bytes:mediaBytes,timeline:{durationMs:cursor,hasVideo:true,hasAudio:false},
      mapping:{muxTimeResolution,muxToleranceMs:1000/muxTimeResolution,sourceFrameCount,encodedFrameCount,zeroDurationFrameIndices,frames:times,sourceCycleOnly:true,originalDimensions:{width,height},codedDimensions:{width:codedWidth,height:codedHeight},edgePadding:{right:codedWidth-width,bottom:codedHeight-height},matte:{rgba:[255,255,255,255],scope:'provider derivative'},colorConversion:'RGBA white matte to BT.601 limited YUV420; lossy H264 all-intra',sourceMetadata:sourceMetadata()}};
  } finally {module._free(pointer);module._animation_free(encoder);}
}

/** Public integration API. Original loop metadata remains with the native-image wrapper. */
export async function encodeAnimation(frames, {maxBytes=MAX_BYTES}={}) {
  const iterator=frames?.[Symbol.asyncIterator]?.() ?? frames?.[Symbol.iterator]?.();
  if(!iterator)fail('animation_frames_invalid');
  try {
    const first=await iterator.next();if(first.done)fail('animation_frames_empty');
    const {width,height}=first.value??{};let previousIndex=-1;const indices=[];
    const normalized={async *[Symbol.asyncIterator](){let next=first;while(!next.done){const f=next.value;
      if(!f||f.width!==width||f.height!==height||!Number.isSafeInteger(f.index)||f.index<0||f.index<=previousIndex)fail('animation_frame_identity_invalid');
      previousIndex=f.index;indices.push(f.index);
      yield {rgba:f.rgba,startMs:f.startMs,endMs:f.endMs,durationMs:f.endMs-f.startMs};next=await iterator.next();
    }}};
    const result=await encodeAnimationSource({width,height,frames:normalized,maxBytes});
    result.mapping.frames=result.mapping.frames.map(f=>({...f,sourceIndex:indices[f.sourceIndex]}));
    result.mapping.zeroDurationFrameIndices=result.mapping.zeroDurationFrameIndices.map(i=>indices[i]);
    return {...result,durationMs:result.timeline.durationMs,
      frames:result.mapping.frames.map(f=>({index:f.sourceIndex,startMs:f.startMs,endMs:f.endMs})),
      width:result.mapping.codedDimensions.width,height:result.mapping.codedDimensions.height,
      originalWidth:width,originalHeight:height,matte:'white',
      colorLimitation:'Lossy H264, white matte for alpha, BT.601 limited YUV420; original RGBA/color profile remain authoritative.'};
  } finally {await iterator.return?.();}
}
