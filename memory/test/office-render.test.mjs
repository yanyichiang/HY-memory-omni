import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {zipSync,unzipSync,strFromU8,strToU8} from 'fflate';
import {prepareOffice} from '../scripts/prepare-office.mjs';
import {prepareOfficeFonts} from '../scripts/prepare-office-fonts.mjs';
import {preparePdf} from '../scripts/prepare-pdf.mjs';
import {officeRenderFixtures} from './office-render-fixtures.mjs';
import {documentFixtures} from './document-fixtures.mjs';
function edit(bytes,path,fn){const parts=unzipSync(bytes);parts[path]=strToU8(fn(strFromU8(parts[path])));return zipSync(parts);}
test('bounded Office renderer runs in workerd; hidden row page boundaries and malformed budgets', {timeout:180000},async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));await prepareOffice();await prepareOfficeFonts();
 const bundle=await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`import {renderOffice} from './documents/office-render.mjs'; globalThis.fetch=()=>{throw Error('network_forbidden')};export default{async fetch(r){try{const mime=new URL(r.url).searchParams.get('mime');const result=await renderOffice(mime,new Uint8Array(await r.arrayBuffer()));return Response.json({units:result.units.map(u=>({locator:u.locator,context:u.context,coverage:u.coverage,bytes:u.derived.bytes.length,...new URL(r.url).searchParams.has('preview')?{pdf:Array.from(u.derived.bytes)}:{},mimeType:u.derived.mimeType})),coverage:result.coverage});}catch(e){return Response.json({error:e.message},{status:422});}}};`},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',alias:{'pdf-lib':await preparePdf()}});
 const mf=new Miniflare({workers:[{config:{name:'office-render-test',compatibilityDate:'2026-10-19',manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:bundle.outputFiles[0].text}}}}}]});
 const run=async(f,bytes=f.bytes)=>{const r=await mf.dispatchFetch('http://office/?mime='+encodeURIComponent(f.mimeType)+(process.env.OFFICE_PREVIEW_DIR?'&preview=1':''),{method:'POST',body:bytes});return {status:r.status,...await r.json()};};
 try{
  const [docx,xlsx]=officeRenderFixtures();
  for(const fixture of [docx,xlsx]){const r=await run(fixture);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.units.length,2,fixture.name);
   if(fixture===xlsx){
    const first=r.units[0].context.renderedTableTopology,second=r.units[1].context.renderedTableTopology;
    assert.equal(first.basis,'same-pdf-layout-pass');
    assert.deepEqual(first.rows.map(row=>row.sourceRow),[1,2,3]);
    const merged=first.rows[2];assert.equal(merged.rowFragment,true);assert.equal(merged.omittedCellCount,0);assert.equal(merged.cells.length,1);
    assert.equal(merged.cells[0].spanKind,'source-merge');assert.equal(merged.cells[0].layoutColumnSpan,2);
    assert.deepEqual(merged.cells[0].sourceMerge,{startRow:3,endRow:3,startColumn:1,endColumn:2});
    assert.deepEqual(second.rows.map(row=>row.sourceRow),[1,5,6]);assert.equal(second.rows[0].isPrintTitleRow,true);
    assert.ok([...first.rows,...second.rows].every(row=>row.sourceRow!==4));
   }
   for(const [i,u]of r.units.entries()){if(process.env.OFFICE_PREVIEW_DIR){await mkdir(process.env.OFFICE_PREVIEW_DIR,{recursive:true});await writeFile(join(process.env.OFFICE_PREVIEW_DIR,fixture.name+'.page'+(i+1)+'.pdf'),Uint8Array.from(u.pdf));}assert.equal(u.locator.kind,'office-rendered-page');assert.equal(u.locator.page,i+1);assert.equal(u.mimeType,'application/pdf');assert.ok(u.bytes>100);assert.equal(u.context.rendering.officeIdentical,false);assert.ok(u.coverage.unsupported.some(x=>x.kind==='office-renderer-loss-report-incomplete'));}}
  const sheet='xl/worksheets/sheet1.xml';
  const overflow=edit(xlsx.bytes,sheet,s=>s.replace('<col min="3" max="3" width="20" hidden="1"/>','<col min="3" max="3" width="20"/>').replace('Done','Long text extending into the empty neighbour column without any source merge'));
  const overflowResult=await run(xlsx,overflow);assert.equal(overflowResult.status,200,JSON.stringify(overflowResult));
  const overflowCells=overflowResult.units.flatMap(unit=>unit.context.renderedTableTopology.rows).flatMap(row=>row.cells);
  const spilled=overflowCells.find(cell=>cell.sourceRow===6&&cell.sourceColumn===2);
  assert.equal(spilled.spanKind,'text-overflow');assert.equal(spilled.sourceMerge,undefined);assert.ok(spilled.layoutColumnSpan>1);
  // 512 short source-bearing cells on one compact print page exceed the existing
  // 64 KiB unit-context limit solely through emitted topology, below old XML/grid limits.
  const denseParts=unzipSync(xlsx.bytes),column=n=>n<=26?String.fromCharCode(64+n):'A'+String.fromCharCode(64+n-26);
  const denseRows=Array.from({length:16},(_,r)=>`<row r="${r+1}" ht="8" customHeight="1">${Array.from({length:32},(_,c)=>`<c r="${column(c+1)}${r+1}" t="inlineStr"><is><t>1</t></is></c>`).join('')}</row>`).join('');
  let denseSheet=strFromU8(denseParts[sheet]).replace(/<sheetData>[\s\S]*?<\/sheetData>/,'<sheetData>'+denseRows+'</sheetData>')
   .replace(/<cols>[\s\S]*?<\/cols>/,'<cols><col min="1" max="32" width="2" customWidth="1"/></cols>')
   .replace(/<mergeCells[\s\S]*?<\/mergeCells>/,'').replace(/<rowBreaks[\s\S]*?<\/rowBreaks>/,'');
  denseParts[sheet]=strToU8(denseSheet);denseParts['xl/workbook.xml']=strToU8(strFromU8(denseParts['xl/workbook.xml']).replace('$A$1:$C$6','$A$1:$AF$16'));
  const denseResult=await run(xlsx,zipSync(denseParts));assert.equal(denseResult.status,422);assert.equal(denseResult.error,'document_unit_context_exceeded');
  const hidden=edit(xlsx.bytes,sheet,s=>s.replace('<row r="5" ht="30" customHeight="1">','<row r="5" hidden="1" ht="30" customHeight="1">'));
  assert.equal((await run(xlsx,hidden)).units.length,2,'consecutive hidden rows preserve break');
  const offset=edit(xlsx.bytes,'xl/workbook.xml',s=>s.replace('$A$1:$C$6','$A$2:$C$6'));
  assert.equal((await run(xlsx,offset)).units.length,2,'nonzero print-area origin preserves break');
  const huge=edit(xlsx.bytes,sheet,s=>s.replace('<sheetData>','<dimension ref="A1:XFD1048576"/><sheetData>'));
  assert.match((await run(xlsx,huge)).error,/grid_budget_exceeded/);
  const hugeSpan=edit(docx.bytes,'word/document.xml',s=>s.replace('<w:tcPr>','<w:tcPr><w:gridSpan w:val="129"/>'));
  assert.match((await run(docx,hugeSpan)).error,/table_span_budget_exceeded/);
  const hugePages=edit(docx.bytes,'word/document.xml',s=>s.replace('</w:body>','<w:p><w:r><w:t>Page</w:t><w:br w:type="page"/></w:r></w:p>'.repeat(130)+'</w:body>'));
  assert.match((await run(docx,hugePages)).error,/page_budget_exceeded/);
  const visibleEmoji=edit(docx.bytes,'word/document.xml',s=>s.replace('中文排版验证','中文😀'));
  assert.match((await run(docx,visibleEmoji)).error,/font_glyph_unsupported/);
  const metadataParts=unzipSync(docx.bytes);metadataParts['docProps/core.xml']=strToU8('<metadata>Author 😀</metadata>');
  assert.equal((await run(docx,zipSync(metadataParts))).status,200,'metadata glyphs never used for layout');
  const hiddenEmoji=edit(xlsx.bytes,sheet,s=>s.replace('HIDDEN ROW','HIDDEN 😀'));
  assert.equal((await run(xlsx,hiddenEmoji)).status,200,'hidden row glyphs never painted');
  const strict=edit(docx.bytes,'word/document.xml',s=>s.replaceAll('http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main'));
  assert.equal((await run(docx,strict)).units.length,2,'strict word namespace canonicalized');
  const ordinary=await documentFixtures();for(const f of ordinary.filter(f=>/docx|xlsx/.test(f.name))){const r=await run(f);assert.equal(r.status,200,JSON.stringify(r));assert.ok(r.units.length,'arbitrary input prefixes render');}
 }finally{await mf.dispose();}
});
