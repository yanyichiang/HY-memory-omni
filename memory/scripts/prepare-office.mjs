// Reproducible adaptation of reamkit@1.33.1; never edits installed upstream.
import {createRequire} from 'node:module';
import {readFile,writeFile,cp,mkdir,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function prepareOffice(){
  const require=createRequire(import.meta.url),upstream=dirname(require.resolve('reamkit/package.json'));
  if(JSON.parse(await readFile(resolve(upstream,'package.json'),'utf8')).version!=='1.33.1')throw Error('office_upstream_version_mismatch');
  const output=fileURLToPath(new URL('../.generated/reamkit/',import.meta.url));
  await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
  for(const entry of ['dist','LICENSE','package.json'])await cp(resolve(upstream,entry),resolve(output,entry),{recursive:true});
  const replace=(source,before,after)=>{if(source.split(before).length!==2)throw Error('office_patch_source_mismatch:'+before.slice(0,80));return source.replace(before,after);};
  async function patch(path,edits){const file=resolve(output,'dist/esm',path);let source=await readFile(file,'utf8');for(const [a,b]of edits)source=replace(source,a,b);await writeFile(file,source);}
  await patch('excel/print-model.js',[
    ['const cellMatrix = Array.from({ length: rowCount }, () => new Array(colCount));','if (wantRows > 2048 || wantCols > 128 || wantRows * wantCols > 32768) throw Error("office_render_grid_budget_exceeded");\n\tconst cellMatrix = Array.from({ length: rowCount }, () => new Array(colCount));'],
    ['const manualRowBreaks = new Set(honouredBreaks(worksheet, "rows"));','const manualRowBreaks = new Set(honouredBreaks(worksheet, "rows"));\n\t// Preserve a boundary before hidden rows at the next visible row.\n\tconst visibleRowBreaks = new Set();\n\tlet nextVisibleRow;\n\tfor (let r = rowCount - 1; r >= 0; r--) {\n\t\tconst abs = r + rowStart;\n\t\tif (!hiddenRows.has(r)) nextVisibleRow = abs;\n\t\tif (manualRowBreaks.has(abs) && nextVisibleRow !== undefined) visibleRowBreaks.add(nextVisibleRow);\n\t}'],
    ['if (manualRowBreaks.has(abs)) fitRowBreaks.add(fitRowTwips.length);','if (visibleRowBreaks.has(abs)) fitRowBreaks.add(fitRowTwips.length);'],
    ['const breakRows = new Set(print.screen ? [] : honouredBreaks(worksheet, "rows"));','const breakRows = new Set(print.screen ? [] : visibleRowBreaks);'],
  ]);
  await patch('layout/styled-layout.js',[
    ['this.pages.push({','if (this.pages.length >= 128) throw Error("office_render_page_budget_exceeded");\n\t\tthis.pages.push({'],
  ]);
  await patch('core/font/ttf-parser.js',[
    ['const glyphForCodepoint = buildCmap(raw, require("cmap").offset);','const hyCmap = buildCmap(raw, require("cmap").offset);\n\tconst glyphForCodepoint = (cp) => { const glyph = hyCmap(cp); if (!glyph && !/[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]/u.test(String.fromCodePoint(cp))) throw Error("office_render_font_glyph_unsupported:U+" + cp.toString(16).toUpperCase()); return glyph; };'],
    ['\t\tglyphForCodepoint,','\t\tglyphForCodepoint,\n\t\thyRawGlyphForCodepoint: hyCmap,'],
  ]);
  // ToUnicode enumerates the entire BMP, including glyphs never requested for rendering.
  await patch('pdf/cid-font.js',[
    ['const gid = parsed.glyphForCodepoint(cp);','const gid = (parsed.hyRawGlyphForCodepoint ?? parsed.glyphForCodepoint)(cp);'],
  ]);
  await patch('pdf/writer.js',[
    ['const id = this.objects.length + 1;','if (this.objects.length >= 32768) throw Error("office_render_object_budget_exceeded");\n\t\tconst id = this.objects.length + 1;'],
    ['parts.push(bytes);','if (pos + bytes.length > 16 * 1024 * 1024) throw Error("office_render_output_budget_exceeded");\n\t\t\tparts.push(bytes);'],
  ]);
  await writeFile(resolve(output,'index.js'),'export {Ream} from "./dist/esm/index.js";\nexport const HY_OFFICE_BOUNDED = true;\n');
  await cp(fileURLToPath(import.meta.url),resolve(output,'HY-prepare-office.mjs'));
  return resolve(output,'index.js');
}
