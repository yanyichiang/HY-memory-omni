import { BufferSource, EncodedPacketSink, Input, MP4, MP3, QTFF, type EncodedPacket } from 'mediabunny';
import { acquireAudio } from './audio.js';
import { createAacFrameDecoder } from './aac-pcm.js';
import { encodeFloatWav } from './extended-audio.js';
import { MemoryError } from './service.js';
const LIMIT = 8 * 1024 * 1024;
const fail = (code: string, status = 415): never => { throw new MemoryError(code, status); };
interface Edit { start: number; end: number; rounding: number }
/** Envelope only: the upstream demuxer still owns sample tables and media-time offsets.
 * Its public packets do not expose elst segment_duration, so retain that boundary here. */
function audioEdit(bytes: Uint8Array, id: number): Edit | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const boxes = (begin: number, end: number) => {
    const result: { type: string; at: number; end: number }[] = [];
    for (let at = begin; at < end;) {
      if (at + 8 > end || result.length >= 65536) return fail('soundtrack_container_invalid');
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      let length = view.getUint32(at), header = 8;
      if (length === 1) {
        if (at + 16 > end) return fail('soundtrack_container_invalid');
        const large = view.getBigUint64(at + 8); if (large > BigInt(Number.MAX_SAFE_INTEGER)) return fail('soundtrack_container_invalid');
        length = Number(large); header = 16;
      }
      if (!length) length = end - at;
      if (length < header || at + length > end) return fail('soundtrack_container_invalid');
      if (['moof', 'mvex', 'sinf', 'senc', 'pssh'].includes(type)) return fail('soundtrack_container_unsupported');
      result.push({ type, at: at + header, end: at + length }); at += length;
    }
    return result;
  };
  const roots = boxes(0, bytes.length), moovs = roots.filter(b => b.type === 'moov');
  if (moovs.length !== 1) return fail('soundtrack_container_invalid');
  const movie = boxes(moovs[0]!.at, moovs[0]!.end), mvhd = movie.filter(b => b.type === 'mvhd');
  if (mvhd.length !== 1) return fail('soundtrack_container_invalid');
  const h = mvhd[0]!, version = bytes[h.at];
  if (![0, 1].includes(version!) || h.at + (version === 1 ? 24 : 16) > h.end) return fail('soundtrack_clock_invalid');
  const scale = view.getUint32(h.at + (version === 1 ? 20 : 12)); if (!scale) return fail('soundtrack_clock_invalid');
  const matches = movie.filter(b => b.type === 'trak').map(b => ({ b, children: boxes(b.at, b.end) })).filter(({ children }) => {
    const headers = children.filter(b => b.type === 'tkhd'); if (headers.length !== 1) return fail('soundtrack_track_invalid');
    const t = headers[0]!, v = bytes[t.at];
    if (![0, 1].includes(v!) || t.at + (v === 1 ? 24 : 16) > t.end) return fail('soundtrack_track_invalid');
    return view.getUint32(t.at + (v === 1 ? 20 : 12)) === id;
  });
  if (matches.length !== 1) return fail('soundtrack_track_invalid');
  const edts = matches[0]!.children.filter(b => b.type === 'edts');
  if (!edts.length) return undefined;
  if (edts.length !== 1) return fail('soundtrack_edit_unsupported');
  const edits = boxes(edts[0]!.at, edts[0]!.end).filter(b => b.type === 'elst');
  if (edits.length !== 1) return fail('soundtrack_edit_unsupported');
  const edit = edits[0]!, v = bytes[edit.at], stride = v === 1 ? 20 : 12;
  if (![0, 1].includes(v!) || edit.at + 8 > edit.end) return fail('soundtrack_edit_unsupported');
  const count = view.getUint32(edit.at + 4);
  if (!count || count > 64 || edit.at + 8 + count * stride !== edit.end) return fail('soundtrack_edit_unsupported');
  let leading = 0, main: Edit | undefined;
  for (let i = 0; i < count; i++) {
    const at = edit.at + 8 + i * stride;
    const duration = v === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at);
    const mediaTime = v === 1 ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
    if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(mediaTime) || view.getInt32(at + stride - 4) !== 65536 || main) return fail('soundtrack_edit_unsupported');
    if (mediaTime === -1) leading += duration;
    else {
      if (mediaTime < 0 || !duration) return fail('soundtrack_edit_unsupported');
      main = { start: leading / scale, end: (leading + duration) / scale, rounding: Math.min(1 / scale, 0.001) };
    }
    if (!Number.isSafeInteger(leading)) return fail('soundtrack_edit_unsupported');
  }
  if (!main) return fail('soundtrack_edit_unsupported');
  return main;
}

/** Extract the actual presented soundtrack; the returned clock never invents leading silence. */
export async function videoSoundtrack(mimeType: string, bytes: Uint8Array): Promise<{ mimeType: 'audio/wav'; bytes: Uint8Array; startMs: number; endMs: number } | undefined> {
  if (!['video/mp4', 'video/quicktime'].includes(mimeType) || !bytes.length) return fail('soundtrack_input_invalid');
  const release = await acquireAudio();
  let input: Input | undefined;
  let aac: Awaited<ReturnType<typeof createAacFrameDecoder>> | undefined;
  try {
    input = new Input({ formats: [mimeType === 'video/mp4' ? MP4 : QTFF], source: new BufferSource(bytes), formatOptions: { isobmff: { resolveKeyId: () => fail('soundtrack_encrypted') } } });
    const tracks = await input.getAudioTracks();
    if (!tracks.length) return undefined;
    if (tracks.length !== 1) return fail('soundtrack_tracks_unsupported');
    const track = tracks[0]!, codec = await track.getCodec();
    if (!['aac', 'mp3', 'pcm-f32'].includes(codec ?? '') || await track.isLive() || await track.isRelativeToUnixEpoch()) return fail('soundtrack_codec_unsupported');
    const edit = audioEdit(bytes, track.id), resolution = await track.getTimeResolution();
    const config = await track.getDecoderConfig();
    if (!config || !Number.isSafeInteger(config.sampleRate) || config.sampleRate <= 0 || ![1, 2].includes(config.numberOfChannels)) return fail('soundtrack_format_unsupported');
    const packets: EncodedPacket[] = []; let encodedSize = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      if (!packet.data.length || !Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration <= 0 || packets.length >= 65536) return fail('soundtrack_packet_invalid');
      encodedSize += packet.data.length;
      if (encodedSize > LIMIT) return fail('soundtrack_size_limit', 413);
      packets.push(packet);
    }
    if (!packets.length) return fail('soundtrack_packet_invalid');
    let firstAac: ReturnType<NonNullable<typeof aac>['decode']> | undefined;
    let rate = config.sampleRate, channels = config.numberOfChannels;
    if (codec === 'aac') {
      const raw = config.description; if (!raw) return fail('soundtrack_decoder_config_invalid');
      aac = await createAacFrameDecoder(ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw));
      firstAac = aac.decode(packets[0]!.data); rate = firstAac.rate; channels = firstAac.channels;
    }
    const sample = (time: number) => {
      const n = Math.round(time * rate);
      if (!Number.isSafeInteger(n) || Math.abs(time - n / rate) > 1 / resolution + 1e-9) return fail('soundtrack_time_mapping_invalid');
      return n;
    };
    const first = packets[0]!, last = packets.at(-1)!;
    const begin = Math.max(0, sample(first.timestamp), edit ? Math.ceil(edit.start * rate - 1e-6) : 0);
    const finish = Math.min(sample(last.timestamp + last.duration), edit ? Math.ceil(edit.end * rate - 1e-6) : Infinity);
    const length = (finish - begin) * channels * 4;
    if (!Number.isSafeInteger(length) || length <= 0 || length + 56 > LIMIT) return fail('soundtrack_size_limit', 413);
    // Validate coverage before output allocation; no silent padding for gaps.
    let previous: number | undefined;
    for (const packet of packets) {
      const at = sample(packet.timestamp), count = sample(packet.duration);
      if (count <= 0 || previous !== undefined && at !== previous) return fail('soundtrack_time_mapping_invalid');
      previous = at + count;
    }
    if (edit && (last.timestamp + last.duration < edit.end - edit.rounding - 1 / rate || first.timestamp > edit.start + 1 / rate)) return fail('soundtrack_presentation_incomplete');
    const pcm = new Uint8Array(length), output = new DataView(pcm.buffer);
    let copied = 0;
    const put = (packet: EncodedPacket, data: Float32Array, decodedSamples: number) => {
      const at = sample(packet.timestamp), count = sample(packet.duration);
      if (count > decodedSamples || data.length !== decodedSamples * channels) return fail('soundtrack_decoded_timeline_invalid');
      for (const value of data) if (!Number.isFinite(value)) return fail('soundtrack_samples_invalid');
      const from = Math.max(0, begin - at), to = Math.min(count, finish - at);
      for (let frame = from; frame < to; frame++) for (let channel = 0; channel < channels; channel++) output.setFloat32(((at + frame - begin) * channels + channel) * 4, data[frame * channels + channel]!, true);
      copied += Math.max(0, to - from);
    };
    if (codec === 'aac') {
      for (let i = 0; i < packets.length; i++) {
        const decoded = i === 0 ? firstAac! : aac!.decode(packets[i]!.data);
        if (decoded.rate !== rate || decoded.channels !== channels) return fail('soundtrack_format_changed');
        put(packets[i]!, decoded.data, decoded.samples); // Consume heap view before the next decode.
      }
    } else if (codec === 'pcm-f32') {
      for (const packet of packets) {
        if (packet.data.length % (channels * 4)) return fail('soundtrack_pcm_invalid');
        const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
        const data = new Float32Array(packet.data.length / 4);
        for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(i * 4, true);
        put(packet, data, data.length / channels);
      }
    } else {
      // Independent upstream MP3 demux verifies complete frames and decoded counts;
      // original MP4 packet durations may present only a prefix of a decoded frame.
      const encoded = new Uint8Array(encodedSize); let offset = 0;
      for (const p of packets) { encoded.set(p.data, offset); offset += p.data.length; }
      const mp3 = new Input({ formats: [MP3], source: new BufferSource(encoded) });
      const frameCounts: number[] = []; let total = 0;
      try {
        const mp3Track = await mp3.getPrimaryAudioTrack();
        if (!mp3Track || await mp3Track.getSampleRate() !== rate || await mp3Track.getNumberOfChannels() !== channels) return fail('soundtrack_mp3_format_invalid');
        let packetIndex = 0, inPacket = 0, count = 0;
        for await (const frame of new EncodedPacketSink(mp3Track).packets()) {
          inPacket += frame.data.length; count += sample(frame.duration);
          if (!packets[packetIndex] || inPacket > packets[packetIndex]!.data.length) return fail('soundtrack_mp3_frame_mapping_invalid');
          if (inPacket === packets[packetIndex]!.data.length) { frameCounts.push(count); total += count; packetIndex++; inPacket = 0; count = 0; }
        }
        if (packetIndex !== packets.length || inPacket || total * 4 > LIMIT) return fail('soundtrack_size_limit', 413);
      } finally { mp3.dispose(); }
      const { decodeMp3 } = await import('./mp3-decoder.js');
      const decoded = new DataView((await decodeMp3(encoded, total, rate)).buffer);
      offset = 0;
      for (let i = 0; i < packets.length; i++) {
        const count = frameCounts[i]!, data = new Float32Array(count * channels);
        for (let frame = 0; frame < count; frame++) {
          const left = decoded.getInt16((offset + frame) * 4, true), right = decoded.getInt16((offset + frame) * 4 + 2, true);
          if (channels === 1 && left !== right) return fail('soundtrack_mp3_channels_invalid');
          data[frame * channels] = left / 32768;
          if (channels === 2) data[frame * channels + 1] = right / 32768;
        }
        put(packets[i]!, data, count); offset += count;
      }
    }
    if (copied !== finish - begin) return fail('soundtrack_presentation_incomplete');
    return { mimeType: 'audio/wav', bytes: encodeFloatWav(pcm, rate, channels), startMs: begin / rate * 1000, endMs: finish / rate * 1000 };
  } catch (error) { if (error instanceof MemoryError) throw error; return fail('soundtrack_decode_invalid'); }
  finally { try { aac?.free(); input?.dispose(); } finally { release(); } }
}
