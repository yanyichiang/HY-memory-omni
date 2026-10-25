// Explicit OOXML measurements only; never infer effective layout or style inheritance.
// Sources: Microsoft Open XML SDK references (ISO/IEC 29500 remarks):
// https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.tablewidthunitvalues
// https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.gridcolumn.width
// https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.pagesize
// https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.pagemargin
// https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.fontsize
const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);

/** Return host-computed annotations for a raw namespace-bound XML node. */
export function wordMeasurements(node) {
  if (!node || !WORD.has(node.uri)) return undefined;
  // Require Word-qualified attributes: a foreign or unqualified lookalike is not evidence.
  const attr = name => (node.attributes ?? []).find(a => WORD.has(a.uri) && a.local === name)?.value;
  let names, unit = 'twip', divisor = 20, type = 'explicit';
  switch (node.local) {
    case 'pgSz': names = ['w', 'h']; break;
    case 'pgMar': names = ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter']; break;
    case 'gridCol': names = ['w']; type = 'initial-grid-width'; break;
    case 'tblW': case 'tcW':
      if (attr('type') !== 'dxa') return undefined;
      names = ['w']; type = 'preferred-width-dxa'; break;
    case 'sz': case 'szCs': names = ['val']; unit = 'half-point'; divisor = 2; type = 'explicit-font-size'; break;
    default: return undefined;
  }
  const result = {};
  for (const name of names) {
    const raw = attr(name);
    // Numeric lexical forms only; unit suffixes, fractions, exponent notation and
    // unsafe integers remain in the original raw property without interpretation.
    if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) continue;
    const value = Number(raw);
    const signedMargin = node.local === 'pgMar' && (name === 'top' || name === 'bottom');
    if (!Number.isSafeInteger(value) || (value < 0 && !signedMargin)) continue;
    result[name] = { raw, type, unit, value, points: value / divisor, inches: value / (divisor * 72) };
  }
  return Object.keys(result).length ? result : undefined;
}
