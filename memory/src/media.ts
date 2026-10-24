import { BufferSource, EncodedPacketSink, Input, MP3, MP4, QTFF, WAVE } from 'mediabunny';
import { MemoryError, type Timeline } from './service.js';
import { inspectInlineAudio, isExtendedAudio } from './native-audio.js';

/** Inspect container/packets and, for extended audio, decoded sample clocks. No network or key lookup. */
export async function inspectMedia(mimeType: string, bytes: Uint8Array): Promise<Timeline | undefined> {
  if (mimeType.startsWith('image/')) return undefined;
  if (isExtendedAudio(mimeType)) return inspectInlineAudio(mimeType, bytes);
  const format = mimeType === 'video/mp4' ? MP4 : mimeType === 'video/quicktime' ? QTFF
    : mimeType === 'audio/mpeg' ? MP3 : mimeType === 'audio/wav' ? WAVE : undefined;
  if (!format) throw new MemoryError('media_type_unsupported', 415);
  const video = mimeType.startsWith('video/');
  const input = new Input({ formats: [format], source: new BufferSource(bytes),
    formatOptions: { isobmff: { resolveKeyId: () => { throw new MemoryError('media_encrypted', 415); } } } });
  try {
    if (await input.getFormat() !== format) throw new MemoryError('media_type_mismatch', 415);
    const tracks = await input.getTracks();
    const videos = tracks.filter(track => track.isVideoTrack());
    const audios = tracks.filter(track => track.isAudioTrack());
    if ((video ? videos.length !== 1 || audios.length > 1 : videos.length !== 0 || audios.length !== 1)
      || tracks.length !== videos.length + audios.length) throw new MemoryError('media_tracks_invalid', 415);
    let duration = 0;
    for (const track of tracks) {
      const codec = await track.getCodec();
      const supported = track.isVideoTrack() ? ['avc', 'hevc', 'av1', 'vp9'].includes(codec ?? '')
        : video ? ['aac', 'mp3'].includes(codec ?? '')
          : mimeType === 'audio/mpeg' ? codec === 'mp3' : ['pcm-u8', 'pcm-s16', 'pcm-s24', 'pcm-s32', 'pcm-f32'].includes(codec ?? '');
      if (!supported) throw new MemoryError('media_codec_unsupported', 415);
      if (await track.isLive() || await track.isRelativeToUnixEpoch() || await track.getFirstTimestamp() !== 0) {
        throw new MemoryError('media_timeline_origin', 415);
      }
      let count = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        if (++count > 250_000 || !Number.isFinite(packet.timestamp) || packet.timestamp < 0
          || !Number.isFinite(packet.duration) || packet.duration <= 0 || packet.data.byteLength === 0) {
          throw new MemoryError('media_packets_invalid', 415);
        }
      }
      const end = await track.computeDuration();
      if (!count || !Number.isFinite(end) || end <= 0) throw new MemoryError('media_duration_invalid', 415);
      duration = Math.max(duration, end);
    }
    if (duration > (video ? 120 : 180)) throw new MemoryError('media_duration_exceeded', 413);
    return { durationMs: Math.ceil(duration * 1000), hasAudio: audios.length === 1, hasVideo: videos.length === 1 };
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('media_container_invalid', 415);
  } finally { input.dispose(); }
}
