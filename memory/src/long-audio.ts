import { CustomSource, Input, MP3 } from 'mediabunny';
import { MemoryError, type Timeline, type TimeRange } from './service.js';
import { acquireAudio } from './audio.js';
import type { RangeMedia } from './video.js';

const fail = (code: string, status = 415): never => { throw new MemoryError(code, status); };
async function read(source: RangeMedia, offset: number, length: number) {
  if (!Number.isSafeInteger(source.size) || source.size <= 0 || offset < 0 || offset + length > source.size) return fail('audio_range_invalid');
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) return fail('audio_range_short');
  return bytes;
}
async function wave(source: RangeMedia) {
  const header = await read(source, 0, 12), hv = new DataView(header.buffer, header.byteOffset, header.length);
  if (hv.getUint32(0, false) !== 0x52494646 || hv.getUint32(8, false) !== 0x57415645 || hv.getUint32(4, true) + 8 !== source.size) return fail('audio_wave_container_invalid');
  let fmt: Uint8Array | undefined, dataOffset = 0, dataLength = 0;
  for (let offset = 12; offset < source.size;) {
    const bytes = await read(source, offset, 8), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const id = view.getUint32(0, false), length = view.getUint32(4, true);
    if (offset + 8 + length + (length & 1) > source.size) return fail('audio_wave_chunk_invalid');
    if (id === 0x666d7420) {
      if (fmt || length < 16 || length > 4096) return fail('audio_wave_chunk_invalid');
      fmt = await read(source, offset + 8, length);
    }
    if (id === 0x64617461) {
      if (dataOffset || !length) return fail('audio_wave_chunk_invalid');
      dataOffset = offset + 8; dataLength = length;
    }
    offset += 8 + length + (length & 1);
  }
  if (!fmt || !dataOffset) return fail('audio_wave_chunk_invalid');
  const view = new DataView(fmt.buffer, fmt.byteOffset, fmt.length);
  let tag = view.getUint16(0, true);
  const channels = view.getUint16(2, true), rate = view.getUint32(4, true), align = view.getUint16(12, true), bits = view.getUint16(14, true);
  if (tag === 65534) {
    if (fmt.length < 40 || view.getUint16(16, true) !== 22 || view.getUint16(18, true) > bits
      || !fmt.subarray(26, 40).every((b, i) => b === [0,0,0,0,16,0,128,0,0,170,0,56,155,113][i])) return fail('audio_codec_unsupported');
    tag = view.getUint16(24, true);
  }
  if (!(tag === 1 && [8,16,24,32].includes(bits) || tag === 3 && bits === 32) || !channels || !rate
    || align !== channels * bits / 8 || view.getUint32(8, true) !== rate * align || dataLength % align
    || Math.floor((4 * 1024 * 1024 - fmt.length - 64) / align) / rate * 1000 < 1) return fail('audio_codec_unsupported');
  return { fmt, tag, rate, align, samples: dataLength / align, dataOffset };
}
function wrap(pcm: Uint8Array, fmt: Uint8Array, floating: boolean, samples: number) {
  const factLength = floating ? 12 : 0, at = 20 + fmt.length + (fmt.length & 1) + factLength;
  const result = new Uint8Array(at + 8 + pcm.length + (pcm.length & 1)), view = new DataView(result.buffer);
  const ascii = (offset: number, value: string) => result.set(new TextEncoder().encode(value), offset);
  ascii(0, 'RIFF'); view.setUint32(4, result.length - 8, true); ascii(8, 'WAVEfmt '); view.setUint32(16, fmt.length, true); result.set(fmt, 20);
  if (floating) { ascii(at - 12, 'fact'); view.setUint32(at - 8, 4, true); view.setUint32(at - 4, samples, true); }
  ascii(at, 'data'); view.setUint32(at + 4, pcm.length, true); result.set(pcm, at + 8);
  return result;
}
async function mp3(source: RangeMedia, selection?: TimeRange) {
  const release = await acquireAudio();
  let input: Input | undefined;
  try {
    if (!Number.isSafeInteger(source.size) || source.size <= 0) return fail('audio_range_invalid');
    input = new Input({formats:[MP3],source:new CustomSource({getSize:()=>source.size,maxCacheSize:1024,prefetchProfile:'none',read:async(start,end)=>{
      const bytes=new Uint8Array(end-start);
      for(let offset=start;offset<end;offset+=4096) bytes.set(await read(source,offset,Math.min(4096,end-offset)),offset-start);
      return bytes;
    }})});
    const tracks=await input.getTracks(), track=await input.getPrimaryAudioTrack();
    if (await input.getFormat()!==MP3 || tracks.length!==1 || !track || await track.getCodec()!=='mp3'
      || await track.getFirstTimestamp()!==0 || await track.isLive() || await track.isRelativeToUnixEpoch()
      || await track.getSampleRate()>48000 || await track.getNumberOfChannels()>2) return fail('audio_codec_unsupported');
    input.dispose();input=undefined;
    const { decodeMp3Range } = await import('./mp3-decoder.js'); return await decodeMp3Range(source, selection); }
  catch (error) { if (error instanceof MemoryError) throw error; return fail(error instanceof Error && /^(audio_|media_)/.test(error.message) ? error.message : 'audio_decode_invalid', error instanceof Error && error.message === 'media_slice_too_large' ? 413 : 415); }
  finally { try { input?.dispose(); } finally { release(); } }
}
export async function inspectLongAudio(mimeType: string, source: RangeMedia): Promise<Timeline> {
  if (!['audio/wav', 'audio/mpeg'].includes(mimeType)) return fail('audio_type_unsupported');
  const info = mimeType === 'audio/wav' ? await wave(source) : await mp3(source);
  const rate = 'rate' in info ? info.rate : info.sampleRate;
  return { durationMs: Math.ceil(info.samples / rate * 1000), hasAudio: true, hasVideo: false };
}
export async function sliceLongAudio(mimeType: string, source: RangeMedia, logical: TimeRange, timeline: Timeline) {
  if (!timeline.hasAudio || timeline.hasVideo || !Number.isSafeInteger(timeline.durationMs) || timeline.durationMs <= 0
    || !Number.isFinite(logical.startMs) || !Number.isFinite(logical.endMs) || logical.startMs < 0 || logical.endMs <= logical.startMs || logical.endMs > timeline.durationMs) return fail('audio_window_invalid', 400);
  let bytes: Uint8Array, rate: number, start: number, end: number;
  if (mimeType === 'audio/wav') {
    const info = await wave(source); rate = info.rate;
    start = Math.floor(logical.startMs * rate / 1000); end = Math.min(info.samples, Math.ceil(logical.endMs * rate / 1000));
    if ((end - start) * info.align + info.fmt.length + 64 > 4 * 1024 * 1024) return fail('media_slice_too_large', 413);
    bytes = wrap(await read(source, info.dataOffset + start * info.align, (end - start) * info.align), info.fmt, info.tag === 3, end - start);
  } else if (mimeType === 'audio/mpeg') {
    const info = await mp3(source, logical); rate = info.sampleRate; start = info.startSample; end = info.endSample;
    const fmt = new Uint8Array(16), view = new DataView(fmt.buffer);
    view.setUint16(0, 1, true); view.setUint16(2, 2, true); view.setUint32(4, rate, true); view.setUint32(8, rate * 4, true); view.setUint16(12, 4, true); view.setUint16(14, 16, true);
    bytes = wrap(info.pcm!, fmt, false, end - start);
  } else return fail('audio_type_unsupported');
  const actual = { startMs: start / rate * 1000, endMs: end / rate * 1000 };
  return { bytes, mimeType: 'audio/wav', logical, actual, offsetMs: actual.startMs,
    timeline: { durationMs: Math.ceil((end - start) / rate * 1000), hasAudio: true, hasVideo: false }, sourceTimeline: timeline };
}
