import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { zipSync, strToU8 } from 'fflate';
import { fileURLToPath } from 'node:url';
import { preparePdf } from '../scripts/prepare-pdf.mjs';

test('actual Worker keeps spreadsheet and slide formatting as evidence without rendering it', { timeout: 120000 }, async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../documents/parse.mjs', import.meta.url))], alias: { 'pdf-lib': await preparePdf() }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' });
  const modules = {
    'parse.js': { type: 'esm', contents: bundle.outputFiles[0].text },
    'test.js': { type: 'esm', contents: `import {parseDocument} from './parse.js';globalThis.fetch=()=>{throw Error('external_fetch_forbidden')};export default{async fetch(r){try{return Response.json(await parseDocument(r.headers.get('content-type'),new Uint8Array(await r.arrayBuffer())))}catch(e){return Response.json({error:e.message},{status:400})}}};` },
  };
  const mf = new Miniflare({ workers: [{ config: { name: 'sheet-slide-layout', compatibilityDate: '2026-10-19', manifest: { mainModule: 'test.js', modules } } }] });
  const ns = 'http://schemas.openxmlformats.org/', rel = ns + 'officeDocument/2006/relationships';
  const s = ns + 'spreadsheetml/2006/main', p = ns + 'presentationml/2006/main', a = ns + 'drawingml/2006/main';
  const relationship = (id, target, kind) => `<Relationship Id="${id}" Target="${target}" Type="${rel}/${kind}"/>`;
  const relationships = values => `<Relationships xmlns="${ns}package/2006/relationships">${values}</Relationships>`;
  const pack = (main, parts) => zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<Types xmlns="${ns}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
    '_rels/.rels': relationships(relationship('main', main, 'officeDocument')), ...parts,
  }).map(([key, value]) => [key, strToU8(value)])));
  const call = async (mime, bytes) => { const r = await mf.dispatchFetch('http://test/', { method: 'POST', headers: { 'content-type': mime }, body: bytes }); const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); assert.deepEqual(Uint8Array.from(Object.values(result.original.bytes)), bytes); return result; };
  const attribute = (node, name) => node?.attributes?.find(v => v.local === name)?.value;
  const descendant = (node, kind) => node?.kind === kind ? node : node?.children?.map(c => descendant(c, kind)).find(Boolean);
  try {
    const workbook = pack('xl/workbook.xml', {
      'xl/workbook.xml': `<x:workbook xmlns:x="${s}" xmlns:r="${rel}"><x:sheets><x:sheet name="Evidence" sheetId="1" state="hidden" r:id="sheet"/></x:sheets></x:workbook>`,
      'xl/_rels/workbook.xml.rels': relationships(relationship('sheet', 'worksheets/sheet1.xml', 'worksheet') + relationship('styles', 'styles.xml', 'styles') + relationship('strings', 'sharedStrings.xml', 'sharedStrings')),
      'xl/sharedStrings.xml': `<x:sst xmlns:x="${s}"><x:si><x:r><x:rPr><x:strike/><x:b/><x:color rgb="FF112233"/></x:rPr><x:t>Old </x:t></x:r><x:r><x:t>plan</x:t></x:r><x:rPh sb="0" eb="3"><x:t>phonetic-only</x:t></x:rPh><x:phoneticPr fontId="0"/></x:si></x:sst>`,
      'xl/styles.xml': `<x:styleSheet xmlns:x="${s}"><x:fonts><x:font><x:name val="BaseFont"/><x:sz val="11"/></x:font><x:font><x:name val="RowFont"/><x:strike/></x:font></x:fonts><x:fills><x:fill><x:patternFill patternType="none"/></x:fill><x:fill><x:patternFill patternType="solid"><x:fgColor rgb="FFFFFF00"/></x:patternFill></x:fill></x:fills><x:borders><x:border/><x:border><x:bottom style="thin"><x:color rgb="FF000000"/></x:bottom></x:border></x:borders><x:cellStyleXfs><x:xf numFmtId="0" fontId="0" fillId="0" borderId="0"><x:alignment horizontal="left"/></x:xf></x:cellStyleXfs><x:cellXfs><x:xf xfId="0" fontId="1" fillId="0" borderId="0" applyFont="0" applyAlignment="1"><x:alignment horizontal="center" wrapText="1"/></x:xf><x:xf xfId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/><x:xf xfId="0" fontId="0" fillId="1" borderId="1" applyFill="1"/><x:xf fontId="0" fillId="0" borderId="0" numFmtId="49"/></x:cellXfs></x:styleSheet>`,
      'xl/worksheets/sheet1.xml': `<x:worksheet xmlns:x="${s}"><x:sheetFormatPr defaultRowHeight="15"/><x:cols><x:col min="1" max="2" width="20" hidden="1" style="2"/></x:cols><x:sheetData><x:row r="1" s="1" customFormat="1"><x:c r="A1" t="s" s="0"><x:v>0</x:v></x:c><x:c r="B1" t="inlineStr"><x:is><x:r><x:rPr><x:i/><x:strike val="0"/></x:rPr><x:t>New </x:t></x:r><x:r><x:t>plan</x:t></x:r><x:rPh sb="0" eb="3"><x:t>inline-guide</x:t></x:rPh></x:is></x:c><x:c r="C1" s="99"><x:v>7</x:v></x:c></x:row><x:row r="40" hidden="1"><x:c r="A40" t="inlineStr"><x:is><x:t>Retained evidence</x:t></x:is></x:c></x:row></x:sheetData><x:conditionalFormatting sqref="A1"><x:cfRule type="expression" priority="1"><x:formula>1=1</x:formula></x:cfRule></x:conditionalFormatting></x:worksheet>`,
    });
    const x = await call('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook);
    assert.deepEqual(x.units.map(u => u.locator), [
      { kind: 'xlsx-range', part: 'xl/worksheets/sheet1.xml', sheetIndex: 0, sheetName: 'Evidence', range: 'A1:P32' },
      { kind: 'xlsx-range', part: 'xl/worksheets/sheet1.xml', sheetIndex: 0, sheetName: 'Evidence', range: 'A33:P64' },
    ]);
    const first = x.units[0].context, last = x.units[1].context;
    assert.deepEqual(first.cells.map(c => c.value), ['Old plan', 'New plan', '7'], 'phonetic annotations must not become cell text');
    assert.ok(descendant(first.cells[0].richText, 'strike')); assert.equal(attribute(descendant(first.cells[1].richText, 'strike'), 'val'), '0');
    assert.equal(descendant(first.cells[0].richText, 'rPh').children.some(n => n.kind === 't'), true, 'phonetic evidence remains separately available');
    assert.equal(last.cells[0].value, 'Retained evidence', 'hidden content is evidence, not deleted data');
    assert.equal(first.sheetProperties.state, 'hidden'); assert.equal(first.columns[0].hidden, '1'); assert.equal(last.rows[0].hidden, '1');
    assert.equal(first.rows[0].s, '1'); assert.equal(first.columns[0].style, '2');
    const cellStyle = first.styles.find(st => st.id === '0');
    assert.equal(cellStyle.definition.applyFont, '0'); assert.equal(cellStyle.definition.applyAlignment, '1');
    assert.equal(attribute(descendant(cellStyle.properties, 'alignment'), 'wrapText'), '1');
    assert.equal(attribute(descendant(cellStyle.baseStyle.properties, 'alignment'), 'horizontal'), 'left');
    assert.deepEqual(cellStyle.resources.filter(r => r.kind === 'fontId').map(r => r.id), ['1', '0'], 'retain direct and base resources without pretending applyFont=0 resolves them');
    assert.equal(attribute(descendant(cellStyle.resources.find(r => r.kind === 'fontId' && r.id === '1').properties, 'name'), 'val'), 'RowFont');
    const columnStyle = first.styles.find(st => st.id === '2');
    assert.ok(descendant(columnStyle.resources.find(r => r.kind === 'fillId' && r.id === '1').properties, 'fgColor'));
    assert.equal(attribute(descendant(columnStyle.resources.find(r => r.kind === 'borderId' && r.id === '1').properties, 'bottom'), 'style'), 'thin');
    assert.equal(first.styles.some(st => st.id === '3'), false, 'unreferenced XFs are not duplicated into the unit');
    assert.ok(x.units[0].coverage.unsupported.some(c => c.kind === 'spreadsheet-style-reference-missing' && c.detail.id === '99'));
    assert.ok(x.units.every(u => u.coverage.unsupported.some(c => c.kind === 'spreadsheet-conditionalFormatting-not-evaluated')));
    assert.equal(first.formatting.resolved, false);

    const textbox = (id, label) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${label}" hidden="1"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="23" y="47"/><a:ext cx="900" cy="600"/></a:xfrm><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr wrap="none" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr" marL="100"/><a:r><a:rPr b="1" strike="sngStrike" sz="2400"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:rPr><a:t>Draft</a:t></a:r><a:br/><a:r><a:rPr i="1"/><a:t>Final</a:t></a:r></a:p></p:txBody></p:sp>`;
    const table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="1000"/></a:tblGrid><a:tr h="400"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Revenue 42</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    const deck = pack('ppt/presentation.xml', {
      'ppt/presentation.xml': `<p:presentation xmlns:p="${p}" xmlns:r="${rel}"><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': relationships(relationship('slide', 'slides/slide1.xml', 'slide')),
      'ppt/slides/slide1.xml': `<p:sld xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Placed group"/></p:nvGrpSpPr><p:grpSpPr><a:xfrm rot="5400000"><a:off x="1000" y="2000"/><a:ext cx="4000" cy="5000"/><a:chOff x="10" y="20"/><a:chExt cx="40" cy="50"/></a:xfrm></p:grpSpPr>${textbox('3', 'Hidden body')}</p:grpSp><p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="No local transform"/></p:nvGrpSpPr>${textbox('5', 'Local child')}</p:grpSp>${table}</p:spTree></p:cSld></p:sld>`,
    });
    const t = await call('application/vnd.openxmlformats-officedocument.presentationml.presentation', deck);
    assert.deepEqual(t.units[0].locator, { kind: 'pptx-slide', part: 'ppt/slides/slide1.xml', slideIndex: 0 });
    const slide = t.units[0].context, group = slide.shapes[0], child = group.children[0], noTransform = slide.shapes[1];
    assert.deepEqual(child.shapePath, [0, 0]); assert.deepEqual(child.paragraphs, ['Draft\nFinal']);
    assert.equal(attribute(descendant(child.nonVisual, 'cNvPr'), 'hidden'), '1'); assert.equal(attribute(descendant(child.nonVisual, 'ph'), 'type'), 'body');
    assert.equal(attribute(child.textLayout.bodyProperties, 'wrap'), 'none');
    const para = child.textLayout.paragraphs[0];
    assert.equal(para.text, 'Draft\nFinal'); assert.equal(attribute(descendant(para.properties, 'pPr'), 'algn'), 'ctr');
    assert.equal(attribute(descendant(para.properties, 'rPr'), 'strike'), 'sngStrike'); assert.equal(attribute(descendant(para.properties, 'rPr'), 'sz'), '2400');
    assert.equal(attribute(descendant(child.shapeProperties, 'srgbClr'), 'val'), 'FFFF00');
    assert.equal(attribute(descendant(child.shapeProperties, 'ln'), 'w'), '12700');
    assert.equal(group.transform.rot, '5400000'); assert.equal(group.transform.children.find(n => n.kind === 'off').x, '1000');
    assert.equal(child.transform.children.find(n => n.kind === 'off').x, '23', 'local child coordinates must not be converted to page coordinates');
    assert.equal(noTransform.transform, undefined, 'a group without grpSpPr must not borrow its descendant shape transform');
    assert.equal(noTransform.children[0].transform.children.find(n => n.kind === 'off').x, '23');
    assert.deepEqual(slide.shapes[2].paragraphs, ['Revenue 42'], 'graphicFrame table text must not disappear when preserving text-box formatting');
    assert.equal(attribute(descendant(slide.shapes[2].tables[0], 'tr'), 'h'), '400');
    assert.equal(slide.formatting.resolved, false); assert.ok(t.units[0].coverage.unsupported.some(c => c.kind === 'theme-master-layout-not-resolved-rendering-not-run'));
  } finally { await mf.dispose(); }
});
