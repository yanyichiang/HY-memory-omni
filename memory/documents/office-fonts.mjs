import { regular, bold } from '../.generated/fonts/fonts.mjs';
import coverage from '../fonts/coverage.mjs';

const supported = new Set(coverage);
let cached;
const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
/** Bundled real weight 400/700 faces. No host fonts or network font resolution. */
export function officeFonts() {
  return cached ??= { regular: decode(regular), bold: decode(bold) };
}
export const fontPolicy = Object.freeze({
  id: 'hy-office-sans-sc-gb2312-v1',
  family: 'HY Office Sans SC',
  upstreamFamily: 'Noto Sans SC',
  upstreamVersion: '2.004',
  source: 'https://github.com/google/fonts/tree/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/notosanssc',
  license: 'OFL-1.1',
  regularWeight: 400,
  boldWeight: 700,
  italicFace: false,
  boldItalicFace: false,
  sourceFamilies: 'All Office source font families are substituted with this bundled sans-serif family; source metrics and identical Office pagination are not preserved.',
  styles: 'Real regular and bold faces only. Italic/bold-italic use the renderer regular/bold fallback; no authentic italic face is bundled.',
  coverage: 'GB2312 characters plus supported Latin, punctuation, kana and symbols; not full Unicode/CJK. Unsupported visible code points are rejected before PDF publication.',
  coveredCodePoints: coverage.length,
  fontNetworkRequests: false,
});
/** Unique unsupported code points, in source order. Layout controls have no glyph. */
export function missingOfficeGlyphs(text) {
  const missing = new Map();
  for (const character of String(text)) {
    const codePoint = character.codePointAt(0);
    // XML whitespace and Unicode directional/format controls are layout metadata.
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) continue;
    if (!supported.has(codePoint) && !missing.has(codePoint)) {
      missing.set(codePoint, { codePoint, unicode: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`, character });
    }
  }
  return [...missing.values()];
}
