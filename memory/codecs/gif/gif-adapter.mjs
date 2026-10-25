import { decompressFrame } from './vendor/index.js';
const bad = (code = 'gif_container_invalid') => { throw new Error(code); };
const DEFAULTS = { maxInputBytes: 8 * 1024 * 1024, maxDimension: 4096,
  maxCanvasPixels: 1024 * 1024, maxFrames: 128, maxDecodedBytes: 32 * 1024 * 1024 };
/** One finite source cycle, including zero-duration frames. No browser timing clamp.
 * `loopCount`: undefined = no loop extension, 0 = infinite; positive = Netscape raw count.
 * The original binary is caller-owned evidence, never replaced by these derivatives.
 */
export function decodeGif(bytes, limits = {}) {
  const cap = { ...DEFAULTS, ...limits };
  for (const [key, value] of Object.entries(cap)) if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULTS[key]) bad('gif_limits_invalid');
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > cap.maxInputBytes) bad('gif_input_limit');
  let pos = 0;
  const take = n => { if (!Number.isSafeInteger(n) || n < 0 || pos + n > bytes.length) bad('gif_truncated'); const out = bytes.subarray(pos, pos + n); pos += n; return out; };
  const u8 = () => take(1)[0];
  const u16 = () => { const b = take(2); return b[0] | b[1] << 8; };
  const ascii = n => String.fromCharCode(...take(n));
  const palette = n => { const b = take(n * 3); return Array.from({length:n}, (_, i) => Array.from(b.subarray(i * 3, i * 3 + 3))); };
  const blocks = () => {
    const parts = []; let total = 0;
    for (;;) { const n = u8(); if (!n) break; const part = take(n); parts.push(part); total += n; }
    const out = new Uint8Array(total); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out;
  };
  if (!['GIF87a', 'GIF89a'].includes(ascii(6))) bad('gif_signature_invalid');
  const width = u16(), height = u16(), packed = u8(), backgroundIndex = u8(), aspect = u8();
  if (!width || !height || width > cap.maxDimension || height > cap.maxDimension || width * height > cap.maxCanvasPixels) bad('gif_dimensions_limit');
  const gct = packed & 128 ? palette(1 << ((packed & 7) + 1)) : undefined;
  if (gct && backgroundIndex >= gct.length) bad('gif_background_invalid');
  const bg = gct ? [...gct[backgroundIndex], 255] : [0, 0, 0, 0];
  // GIF without a GCT has no specified logical-screen background; preserve alpha
  // and name this interpretation rather than invent a white/black opaque backdrop.
  const canvas = new Uint8Array(width * height * 4);
  const paintBackground = (left, top, w, h) => {
    for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) canvas.set(bg, (y * width + x) * 4);
  };
  paintBackground(0, 0, width, height);
  let gce, loopCount, elapsed = 0, decodedBytes = 0, ended = false;
  const frames = [], applications = [];
  for (;;) {
    const marker = u8();
    if (marker === 0x3b) { ended = true; break; }
    if (marker === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        if (gce || u8() !== 4) bad('gif_control_invalid');
        const p = u8(), delay = u16(), transparentColorIndex = u8();
        if (u8() !== 0 || p & 0xe0 || (p >> 2 & 7) > 3) bad('gif_control_invalid');
        if (p & 2) bad('gif_user_input_unsupported');
        gce = { delay, transparentColorIndex, extras: { disposal: p >> 2 & 7, transparentColorGiven: Boolean(p & 1) } };
      } else if (label === 0xff) {
        if (u8() !== 11) bad('gif_application_invalid');
        const id = ascii(11), data = blocks(); applications.push(id);
        if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') {
          if (loopCount !== undefined || data.length !== 3 || data[0] !== 1) bad('gif_loop_invalid');
          loopCount = data[1] | data[2] << 8;
        } else bad('gif_application_unsupported');
      } else if (label === 0xfe) blocks();
      else if (label === 0x01) bad('gif_plain_text_unsupported');
      else bad('gif_extension_unsupported');
      continue;
    }
    if (marker !== 0x2c) bad();
    const left = u16(), top = u16(), w = u16(), h = u16(), p = u8();
    if (p & 0x18 || !w || !h || left + w > width || top + h > height) bad('gif_frame_bounds_invalid');
    if (frames.length >= cap.maxFrames || decodedBytes + canvas.length > cap.maxDecodedBytes) bad('gif_decoded_limit');
    const lct = p & 128 ? palette(1 << ((p & 7) + 1)) : undefined;
    const colors = lct ?? gct; if (!colors) bad('gif_palette_missing');
    if (gce?.extras.transparentColorGiven && gce.transparentColorIndex >= colors.length) bad('gif_palette_index_invalid');
    const minCodeSize = u8(), data = blocks();
    const raw = { image: { descriptor: {left, top, width:w, height:h, lct: {exists:Boolean(lct), interlaced:Boolean(p & 64)}}, lct, data: { minCodeSize, blocks:data } }, gce };
    // Upstream patch generation silently maps undefined colors to black, so inspect
    // strict decoded indices before requesting its RGBA patch.
    const frame = decompressFrame(raw, gct, false);
    for (const index of frame.pixels) if (index >= colors.length) bad('gif_palette_index_invalid');
    const disposal = gce?.extras.disposal ?? 0;
    const restore = disposal === 3 ? canvas.slice() : undefined;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const index = frame.pixels[y * w + x];
      if (index === frame.transparentIndex) continue;
      canvas.set([...colors[index], 255], ((top + y) * width + left + x) * 4);
    }
    const durationMs = (gce?.delay ?? 0) * 10;
    frames.push({index:frames.length, startMs:elapsed, endMs:elapsed + durationMs, durationMs,
      rawDelayCentiseconds:gce?.delay ?? null, disposal, rect:{left,top,width:w,height:h}, rgba:canvas.slice()});
    elapsed += durationMs; decodedBytes += canvas.length;
    if (disposal === 2) paintBackground(left, top, w, h);
    else if (restore) canvas.set(restore);
    gce = undefined;
  }
  if (!ended || pos !== bytes.length || gce || !frames.length) bad('gif_container_invalid');
  return { width, height, durationMs:elapsed, frames, loopCount,
    background:{ rgba:bg, interpretation:gct ? 'GIF logical-screen global-palette background' : 'unspecified GIF background represented as transparent RGBA' },
    pixelAspectRatioRaw:aspect, applications, originalMimeType:'image/gif', representation:'composited-source-cycle-rgba-v1' };
}
