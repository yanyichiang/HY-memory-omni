import {preparePdf} from '../scripts/prepare-pdf.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { PDFDocument, degrees } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

test('actual Worker preserves native document evidence, namespace aliases and bounded spreadsheet ranges', { timeout: 120000 }, async () => {
  const source = fileURLToPath(new URL('../documents/parse.mjs', import.meta.url));
  const bundle = await build({ entryPoints: [source], alias:{'pdf-lib':await preparePdf()}, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' });
  const modules = {
    'parse.js': { type: 'esm', contents: bundle.outputFiles[0].text },
    'test.js': { type: 'esm', contents: `import {parseDocument} from './parse.js';
      globalThis.fetch=()=>{throw Error('external_fetch_forbidden')};
      export default{async fetch(r){try{return Response.json(await parseDocument(r.headers.get('content-type'),new Uint8Array(await r.arrayBuffer())))}catch(e){return Response.json({error:e.message},{status:400})}}};` },
  };
  const mf = new Miniflare({ workers: [{ config: { name: 'documents-test', compatibilityDate: '2026-10-19', manifest: { mainModule: 'test.js', modules } } }] });
  const call = async (mime, bytes) => {
    const response = await mf.dispatchFetch('http://test', { method: 'POST', headers: { 'content-type': mime }, body: bytes });
    return { status: response.status, result: await response.json() };
  };
  const types = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  const ns = 'http://schemas.openxmlformats.org/';
  const relations = ns + 'officeDocument/2006/relationships';
  const w = ns + 'wordprocessingml/2006/main', s = ns + 'spreadsheetml/2006/main', p = ns + 'presentationml/2006/main', a = ns + 'drawingml/2006/main';
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
  const rel = (id, target, type, external = false) => `<Relationship Id="${id}" Target="${target}" Type="${relations}/${type}"${external ? ' TargetMode="External"' : ''}/>`;
  const rels = entries => `<Relationships xmlns="${ns}package/2006/relationships">${entries}</Relationships>`;
  const zip = (main, entries) => zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<Types xmlns="${ns}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/></Types>`,
    '_rels/.rels': rels(rel('main', main, 'officeDocument')), ...entries,
  }).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value])));
  const bytes = value => Uint8Array.from(Object.values(value));
  try {
    const pdf = await PDFDocument.create(); pdf.addPage([320, 240]).drawText('First native page'); const secondPage = pdf.addPage([120, 90]); secondPage.setRotation(degrees(90)); secondPage.drawText('Second native page', { size: 8 });
    const original = await pdf.save(), result = await call('application/pdf', original);
    assert.equal(result.status, 200, JSON.stringify(result.result)); assert.deepEqual(bytes(result.result.original.bytes), original);
    assert.equal(result.result.units.length, 2); const page = result.result.units[1];
    assert.deepEqual(page.locator, { kind: 'pdf-page', pageIndex: 1 }); assert.equal(page.context.rotation, 90);
    const derivedPdf = await PDFDocument.load(bytes(page.derived.bytes));
    assert.equal(derivedPdf.getPageCount(), 1);
    const contentBytes = (doc, index) => { const contents = doc.getPage(index).node.Contents(); return doc.context.lookup(contents.get(0)).getContents(); };
    assert.deepEqual(contentBytes(derivedPdf, 0), contentBytes(await PDFDocument.load(original), 1), 'native page content stream survives copying');

    // A tiny compressed source must not allocate its >8 MiB decoded ObjStm/XRef,
    // and PDFParser's invalid-object recovery must not turn the budget error into success.
    const expandedPdf = type => {
      const compressed = deflateSync(new Uint8Array(9 * 1024 * 1024).fill(32));
      const extra = type === 'ObjStm' ? '/N 0 /First 0' : '/Size 1 /W [1 4 2]';
      return Buffer.concat([
        Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 32 32] >> endobj\n4 0 obj << /Type /' + type + ' ' + extra + ' /Filter /FlateDecode /Length ' + compressed.length + ' >> stream\n'),
        compressed, Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF'),
      ]);
    };
    for (const type of ['ObjStm', 'XRef']) {
      const rejected = await call('application/pdf', expandedPdf(type));
      assert.equal(rejected.status, 400, type);
      assert.equal(rejected.result.error, 'document_pdf_stream_limit', type + ' must preserve the budget error');
    }
    // Failure releases the serial PDF budget and does not poison a subsequent load/save.
    assert.equal((await call('application/pdf', original)).status, 200);

    // Non-conventional prefixes bind to URI, including relationship attributes.
    const docxEntries = {
      'word/document.xml': `<d:document xmlns:d="${w}" xmlns:g="${a}" xmlns:q="${relations}" xmlns:pos="${ns}drawingml/2006/wordprocessingDrawing"><d:body><d:p><d:r><d:t>001 &amp; first</d:t><d:tab/><d:t>second</d:t><d:br/><d:t>third</d:t><d:drawing><pos:anchor><pos:extent cx="12" cy="34"/><g:blip q:embed="img"/></pos:anchor></d:drawing></d:r></d:p><d:tbl><d:tr><d:tc><d:tcPr><d:gridSpan d:val="2"/></d:tcPr><d:p><d:r><d:t>cell</d:t></d:r></d:p></d:tc><d:tc><d:p><d:r><d:t>after merge</d:t></d:r></d:p></d:tc></d:tr></d:tbl></d:body></d:document>`,
      'word/_rels/document.xml.rels': rels(rel('img', 'media/a.png', 'image') + rel('external', 'https://must-not-fetch.invalid/private', 'hyperlink', true)),
      'word/media/a.png': png,
    };
    const d = await call(types.docx, zip('word/document.xml', docxEntries)); assert.equal(d.status, 200, JSON.stringify(d.result));
    assert.equal(d.result.units[0].context.text, '001 & first\tsecond\nthird');
    assert.deepEqual(bytes(d.result.units[0].images[0].bytes), png); assert.equal(d.result.units[0].images[0].anchor.extent.cx, '12');
    assert.equal(d.result.units[1].context.rows[0].cells[1].columnIndex, 2);
    assert.equal(d.result.units[1].context.rows[0].cells[0].paragraphs[0].text, 'cell');
    assert.ok(d.result.units.every(u => u.coverage.unsupported.some(c => c.kind === 'external-relationship-not-read')));

    const xlsx = zip('xl/workbook.xml', {
      'xl/workbook.xml': `<book:workbook xmlns:book="${s}" xmlns:link="${relations}"><book:workbookPr date1904="true"/><book:sheets><book:sheet name="Evidence" link:id="s1"/></book:sheets></book:workbook>`,
      'xl/_rels/workbook.xml.rels': rels(rel('s1', '/xl/worksheets/sheet1.xml', 'worksheet') + rel('style', 'styles.xml', 'styles')),
      'xl/styles.xml': `<styleSheet xmlns="${s}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${s}" xmlns:x="${relations}"><cols><col min="1" max="2" width="18"/></cols><sheetData><row r="1"><c r="A1" s="0" t="inlineStr"><is><t>Item</t></is></c><c r="B1"><f>2+3</f><v>5</v></c><c r="C1" s="1"><v>1</v></c></row><row r="40"><c r="A40" t="str"><v>00123</v></c></row></sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells><drawing x:id="d1"/></worksheet>`,
      'xl/worksheets/_rels/sheet1.xml.rels': rels(rel('d1', '../drawings/drawing1.xml', 'drawing')),
      'xl/drawings/drawing1.xml': `<anchor:wsDr xmlns:anchor="${ns}drawingml/2006/spreadsheetDrawing" xmlns:g="${a}" xmlns:link="${relations}"><anchor:twoCellAnchor><anchor:from><anchor:col>0</anchor:col><anchor:row>0</anchor:row></anchor:from><anchor:to><anchor:col>2</anchor:col><anchor:row>45</anchor:row></anchor:to><anchor:pic><g:blip link:embed="i1"/></anchor:pic></anchor:twoCellAnchor></anchor:wsDr>`,
      'xl/drawings/_rels/drawing1.xml.rels': rels(rel('i1', '../media/a.png', 'image')), 'xl/media/a.png': png,
    });
    const x = await call(types.xlsx, xlsx); assert.equal(x.status, 200, JSON.stringify(x.result)); assert.equal(x.result.units.length, 2);
    assert.equal(x.result.units[0].locator.range, 'A1:P32'); assert.equal(x.result.units[1].locator.range, 'A33:P64');
    assert.equal(x.result.units[0].context.cells[1].formula.text, '2+3'); assert.equal(x.result.units[0].context.cells[1].cachedValue, '5');
    assert.equal(x.result.units[1].context.cells[0].value, '00123');
    assert.equal(x.result.units[0].context.dateSystem, '1904');
    assert.equal(x.result.units[0].context.workbookProperties.date1904, 'true');
    assert.equal(x.result.units[0].context.cells[2].value, '1');
    assert.ok(x.result.units.every(u => u.images.length === 1)); assert.deepEqual(bytes(x.result.units[1].images[0].bytes), png);
    assert.equal(x.result.units[0].context.merges[0].ref, 'A1:A2'); assert.equal(x.result.units[0].context.columns[0].width, '18');

    const pptx = zip('ppt/presentation.xml', {
      'ppt/presentation.xml': `<deck:presentation xmlns:deck="${p}" xmlns:link="${relations}"><deck:sldIdLst><deck:sldId id="256" link:id="s1"/></deck:sldIdLst><deck:sldSz cx="9144000" cy="6858000"/></deck:presentation>`,
      'ppt/_rels/presentation.xml.rels': rels(rel('s1', 'slides/slide1.xml', 'slide')),
      'ppt/slides/slide1.xml': `<deck:sld xmlns:deck="${p}" xmlns:g="${a}" xmlns:link="${relations}"><deck:cSld><deck:spTree><deck:sp><deck:spPr><g:xfrm><g:off x="100" y="200"/><g:ext cx="300" cy="400"/></g:xfrm></deck:spPr><deck:txBody><g:p><g:r><g:t>Claim</g:t></g:r></g:p></deck:txBody></deck:sp><deck:pic><deck:blipFill><g:blip link:embed="i1"/><g:srcRect l="25000" r="10000"/><g:stretch><g:fillRect/></g:stretch></deck:blipFill></deck:pic><deck:graphicFrame/></deck:spTree></deck:cSld></deck:sld>`,
      'ppt/slides/_rels/slide1.xml.rels': rels(rel('i1', '../media/a.png', 'image')), 'ppt/media/a.png': png,
    });
    const t = await call(types.pptx, pptx); assert.equal(t.status, 200, JSON.stringify(t.result));
    assert.equal(t.result.units[0].context.shapes[0].paragraphs[0], 'Claim'); assert.equal(t.result.units[0].images[0].anchor.zOrder, 1);
    assert.ok(t.result.units[0].coverage.unsupported.some(c => c.kind === 'presentation-shape-not-interpreted'));
    assert.deepEqual(t.result.units[0].images[0].anchor.display.crop, { l: '25000', r: '10000' });
    assert.equal(t.result.units[0].images[0].anchor.display.viewportApplied, false);
    assert.equal(t.result.units[0].images[0].anchor.display.evidence, 'full-embedded-asset');
    assert.deepEqual(bytes(t.result.units[0].images[0].bytes), png);
    assert.ok(t.result.units[0].coverage.unsupported.some(c => c.kind === 'image-crop-not-rendered'));

    for (const bad of [
      '<d:document xmlns:d="' + w + '"><d:body></d:document>',
      '<unbound:document/>',
      '<d:document xmlns:d="' + w + '"><d:body><d:p><d:r><d:t>&undefined;</d:t></d:r></d:p></d:body></d:document>',
      '<d:document xmlns:d="' + w + '" xmlns:alias="' + w + '" d:flag="1" alias:flag="2"><d:body/></d:document>',
      '<d:document xmlns:d="' + w + '" xmlns:xml="https://wrong.invalid"><d:body/></d:document>',
      '<!DOCTYPE x><document/>',
    ]) assert.equal((await call(types.docx, zip('word/document.xml', { ...docxEntries, 'word/document.xml': bad }))).status, 400, bad);
    assert.equal((await call(types.docx, zip('word/document.xml', { ...docxEntries, '../outside': 'bad' }))).status, 400);
    const expanded = await call(types.docx, zip('word/document.xml', { ...docxEntries, 'huge.bin': new Uint8Array(9 * 1024 * 1024) }));
    assert.equal(expanded.result.error, 'document_zip_expansion_exceeded');
  } finally { await mf.dispose(); }
});
