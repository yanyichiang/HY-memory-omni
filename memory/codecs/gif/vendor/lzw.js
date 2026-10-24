/** Hardened gifuct-js 2.1.2 LZW decoder. MIT, Matt Way; original java algorithm
 * credited upstream to https://gist.github.com/devunwired/4479231 .
 * YY changes: typed bounded buffers, strict code/dictionary/input/output bounds,
 * exact pixel count, mandatory EOI, no fabricated zero pixels.
 */
export function lzw(minCodeSize, data, pixelCount) {
  const bad = () => { throw new Error('gif_lzw_invalid'); };
  if (!Number.isInteger(minCodeSize) || minCodeSize < 2 || minCodeSize > 8
    || !Number.isSafeInteger(pixelCount) || pixelCount <= 0) bad();
  const output = new Uint8Array(pixelCount), prefix = new Uint16Array(4096),
    suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  const clear = 1 << minCodeSize, eoi = clear + 1;
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let size = minCodeSize + 1, available = clear + 2, old = -1, first = 0,
    byte = 0, bits = 0, datum = 0, count = 0;
  for (;;) {
    while (bits < size) {
      if (byte >= data.length) bad();
      datum |= data[byte++] << bits; bits += 8;
    }
    let code = datum & ((1 << size) - 1);
    datum >>>= size; bits -= size;
    if (code === clear) { size = minCodeSize + 1; available = clear + 2; old = -1; continue; }
    if (code === eoi) {
      // GIF89a Appendix F: EOI terminates LZW processing. Byte-oriented data
      // subblocks can retain packing padding after that final code (FFmpeg can
      // emit an extra zero byte). The envelope validates their framing separately.
      // Do not mistake unconsumed packing bytes for missing/extra decoded pixels.
      if (count !== pixelCount) bad();
      return output;
    }
    if (code > available || code >= 4096 || old === -1 && code >= clear) bad();
    const incoming = code; let top = 0;
    if (code === available) { if (old < 0) bad(); stack[top++] = first; code = old; }
    while (code >= clear) {
      if (code < clear + 2 || code >= available || top >= 4096 || prefix[code] >= code) bad();
      stack[top++] = suffix[code]; code = prefix[code];
    }
    first = suffix[code]; stack[top++] = first;
    if (count + top > pixelCount) bad();
    while (top) output[count++] = stack[--top];
    if (old !== -1 && available < 4096) {
      prefix[available] = old; suffix[available] = first; available++;
      if (available === 1 << size && size < 12) size++;
    }
    old = incoming;
  }
}
