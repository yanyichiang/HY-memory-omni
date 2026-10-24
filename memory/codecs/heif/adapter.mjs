// Caller serializes decoder use (holds the shared image-memory permit) and releases each frame.
import factory from './image-decoder.mjs';
import wasm from './image-decoder.wasm';
let ready;
function module() {
  return ready ??= factory({ instantiateWasm(imports, receive) {
    const instance = new WebAssembly.Instance(wasm, imports);
    receive(instance, wasm);
    return instance.exports;
  } });
}
function error(m) {
  const start = m._img_error();
  let end = start;
  while (m.HEAPU8[end] && end < start + 512) end++;
  return new Error(new TextDecoder().decode(m.HEAPU8.subarray(start, end)) || 'image_decoder_error');
}
async function opened(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 8 * 1024 * 1024) throw Error('input_limit');
  const m = await module(), pointer = m._malloc(bytes.length);
  if (!pointer) throw Error('allocation_failed');
  let handle = 0;
  try {
    m.HEAPU8.set(bytes, pointer);
    handle = m._img_open(pointer, bytes.length);
    if (!handle) throw error(m);
    return {m, handle, close(){m._img_close(handle);m._free(pointer);}};
  } catch (e) { if (handle) m._img_close(handle);m._free(pointer);throw e; }
}
const fourcc = n => String.fromCharCode((n >>> 24) & 255,(n >>> 16) & 255,(n >>> 8) & 255,n & 255);
export async function inspectImage(bytes) {
  const state = await opened(bytes), {m, handle:h} = state;
  try {
    return {
      kind: ['invalid','still','collection','sequence'][m._img_kind(h)],
      primaryItemId:m._img_primary(h),
      items:Array.from({length:m._img_count(h)},(_,i)=>{
        const width=m._img_item_width(h,i),height=m._img_item_height(h,i);
        let factor=1,outputWidth=width,outputHeight=height;
        if(width*height>8000000)while(outputWidth*outputHeight>4000000){
          factor++;outputWidth=Math.ceil(width/factor);outputHeight=Math.ceil(height/factor);
        }
        return {id:m._img_item_id(h,i),width,height,outputWidth,outputHeight,
          downsample:factor>1?{factor,strategy:'nearest-neighbor-integer-factor-independent-grid',providerDerived:true}:null};
      }),
      tracks:Array.from({length:m._img_track_count(h)},(_,i)=>({id:m._img_track_id(h,i),type:fourcc(m._img_track_type(h,i))})),
      limits:{inputBytes:8388608,pixels:8000000,largeGrid:{inputPixels:16000000,tilePixels:262144,tiles:256,outputPixels:4000000,opaqueSdrOnly:true},side:8192,items:256,tiles:256,frames:256,wasmBytes:67108864},
      heapBytes:m.HEAPU8.length,
    };
  } finally { state.close(); }
}
/** Explicitly choose item or sequence; this never silently picks a primary/first frame. */
export async function* imageFrames(bytes, {kind,index}) {
  const state = await opened(bytes), {m, handle:h} = state;
  try {
    if (!['item','sequence'].includes(kind) || !Number.isInteger(index) || index < 0) throw Error('selection_invalid');
    if (m._img_select(h,kind==='item'?1:2,index)!==1) throw error(m);
    const timescale=m._img_timescale(h),repetitions=m._img_repetitions(h);
    const originalWidth=kind==='item'?m._img_item_width(h,index):null,originalHeight=kind==='item'?m._img_item_height(h,index):null;
    let startTicks=0n,frameIndex=0;
    for (;;) {
      const status=m._img_next(h);
      if(status===0)return;
      if(status!==1)throw error(m);
      const width=m._img_width(h),height=m._img_height(h),stride=m._img_stride(h),pointer=m._img_plane(h);
      if(width*height>8000000 || !pointer || stride<width*4)throw Error('frame_invalid');
      const rgba=new Uint8ClampedArray(width*height*4);
      for(let row=0;row<height;row++)rgba.set(m.HEAPU8.subarray(pointer+row*stride,pointer+row*stride+width*4),row*width*4);
      const durationTicks=m._img_duration(h);
      yield {rgba,width,height,originalWidth:originalWidth??width,originalHeight:originalHeight??height,
        downsample:originalWidth>width?{factor:Math.max(Math.ceil(originalWidth/width),Math.ceil(originalHeight/height)),scaleX:width/originalWidth,scaleY:height/originalHeight,strategy:'nearest-neighbor-integer-factor-independent-grid',providerDerived:true}:null,index:frameIndex++,timescale,startTicks,durationTicks,repetitions,
        sourceDepth:kind==='item'?m._img_depth(h):null,sourceIccBytes:kind==='item'?m._img_icc_size(h):null,
        outputNclx:{primaries:m._img_nclx_primaries(h),transfer:m._img_nclx_transfer(h)},
        colorLimitation:'RGBA8 SDR/sRGB target via libheif; not lossless HDR/wide-gamut/ICC preservation',heapBytes:m.HEAPU8.length};
      startTicks+=durationTicks;
    }
  } finally { state.close(); }
}
