import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { zipSync, strToU8 } from 'fflate';
import { fileURLToPath } from 'node:url';
import { preparePdf } from '../scripts/prepare-pdf.mjs';

test('actual Worker retains raw DOCX run/style/section/table layout without resolving authority', { timeout: 120000 }, async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../documents/parse.mjs', import.meta.url))], alias: { 'pdf-lib': await preparePdf() }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' });
  const modules = {
    'parse.js': { type: 'esm', contents: bundle.outputFiles[0].text },
    'test.js': { type: 'esm', contents: `import {parseDocument} from './parse.js';globalThis.fetch=()=>{throw Error('external_fetch_forbidden')};export default{async fetch(r){try{return Response.json(await parseDocument('application/vnd.openxmlformats-officedocument.wordprocessingml.document',new Uint8Array(await r.arrayBuffer())))}catch(e){return Response.json({error:e.message},{status:400})}}};` },
  };
  const mf = new Miniflare({ workers: [{ config: { name: 'document-layout', compatibilityDate: '2026-10-19', manifest: { mainModule: 'test.js', modules } } }] });
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const styles = `<d:styles xmlns:d="${w}">
    <d:docDefaults><d:rPrDefault><d:rPr><d:rFonts d:ascii="DefaultFont"/><d:sz d:val="22"/></d:rPr></d:rPrDefault><d:pPrDefault><d:pPr><d:spacing d:after="120"/></d:pPr></d:pPrDefault></d:docDefaults>
    <d:style d:type="paragraph" d:default="1" d:styleId="Normal"><d:pPr><d:jc d:val="left"/></d:pPr></d:style>
    <d:style d:type="paragraph" d:styleId="Heading"><d:basedOn d:val="Normal"/><d:pPr><d:keepNext/></d:pPr><d:rPr><d:b/></d:rPr></d:style>
    <d:style d:type="character" d:styleId="BaseChar"><d:rPr><d:b/></d:rPr></d:style>
    <d:style d:type="character" d:styleId="ToggleChar"><d:basedOn d:val="BaseChar"/><d:rPr><d:b/><d:i/></d:rPr></d:style>
    <d:style d:type="table" d:styleId="Grid"><d:tblPr><d:tblBorders><d:top d:val="single"/></d:tblBorders></d:tblPr></d:style>
    <d:style d:type="paragraph" d:styleId="Unused"><d:rPr><d:color d:val="FF0000"/></d:rPr></d:style>
    <d:style d:type="paragraph" d:styleId="CycleA"><d:basedOn d:val="CycleB"/></d:style><d:style d:type="paragraph" d:styleId="CycleB"><d:basedOn d:val="CycleA"/></d:style>
    </d:styles>`;
  const document = `<d:document xmlns:d="${w}"><d:body>
    <d:p><d:pPr><d:pStyle d:val="Heading"/><d:jc d:val="center"/><d:ind d:left="720" d:firstLine="240"/><d:spacing d:before="80" d:after="160" d:line="360" d:lineRule="auto"/><d:tabs><d:tab d:val="right" d:pos="900"/></d:tabs><d:pageBreakBefore/><d:sectPr><d:pgSz d:w="12240" d:h="15840"/><d:pgMar d:top="1440" d:right="1200" d:bottom="1440" d:left="1200"/><d:cols d:num="2" d:space="720"/><d:type d:val="nextPage"/></d:sectPr></d:pPr>
      <d:r><d:rPr><d:rStyle d:val="ToggleChar"/><d:b d:val="0"/><d:i/><foreign:b xmlns:foreign="urn:foreign-format"/><d:strike/><d:dstrike d:val="false"/><d:vanish/><d:highlight d:val="yellow"/><d:color d:val="112233" d:themeColor="accent1"/><d:rFonts d:ascii="EvidenceFont" d:eastAsia="SimSun"/><d:sz d:val="28"/><d:szCs d:val="30"/></d:rPr><d:t>Hidden struck proposal</d:t><d:br d:type="page"/></d:r><d:r><d:t>Still evidence</d:t></d:r></d:p>
    <d:p><d:r><d:t>Final section</d:t></d:r></d:p>
    <d:tbl><d:tblPr><d:tblStyle d:val="Grid"/><d:tblW d:w="5000" d:type="pct"/><d:jc d:val="right"/><d:tblLayout d:type="fixed"/></d:tblPr><d:tblGrid><d:gridCol d:w="2400"/></d:tblGrid><d:tr><d:trPr><d:trHeight d:val="400" d:hRule="atLeast"/><d:cantSplit/></d:trPr><d:tc><d:tcPr><d:tcW d:w="2400" d:type="dxa"/><d:shd d:fill="EEEEEE"/><d:vAlign d:val="center"/></d:tcPr><d:p><d:r><d:t>Cell</d:t></d:r></d:p></d:tc></d:tr></d:tbl>
    <d:sectPr><d:pgSz d:w="15840" d:h="12240" d:orient="landscape"/><d:pgMar d:left="720"/><d:cols d:num="1"/></d:sectPr>
    </d:body></d:document>`;
  const pack = xml => zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Target="word/document.xml" Type="${rel}/officeDocument"/></Relationships>`,
    'word/document.xml': xml, 'word/styles.xml': styles,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Target="styles.xml" Type="${rel}/styles"/></Relationships>`,
  }).map(([key, value]) => [key, strToU8(value)])));
  const call = async data => { const r = await mf.dispatchFetch('http://test/', { method: 'POST', body: data }); const value = await r.json(); assert.equal(r.status, 200, JSON.stringify(value)); return value; };
  const prop = (node, name) => node.children.find(c => c.kind === name);
  try {
    const original = pack(document), result = await call(original);
    assert.deepEqual(Uint8Array.from(Object.values(result.original.bytes)), original);
    assert.deepEqual(result.units.map(u => [u.locator.blockIndex, u.locator.sectionIndex]), [[0, 0], [1, 1], [2, 1]]);
    const first = result.units[0].context;
    assert.equal(first.text, 'Hidden struck proposal\nStill evidence', 'formatting tabs must not become content and hidden text must not silently disappear');
    assert.equal(first.runs.length, 2); assert.equal(first.segments[0].runIndex, 0); assert.equal(first.segments[2].runIndex, 1);
    const rp = first.runs[0].properties;
    for (const k of ['b', 'i', 'strike', 'dstrike', 'vanish', 'highlight', 'color', 'rFonts', 'sz', 'szCs']) assert.ok(prop(rp, k), k);
    assert.equal(prop(rp, 'b').attributes.val, '0'); assert.equal(prop(rp, 'dstrike').attributes.val, 'false');
    assert.ok(rp.children.some(p => p.kind === 'b' && p.namespace === 'urn:foreign-format'), 'foreign property keeps its namespace and cannot masquerade as Word bold');
    assert.equal(prop(rp, 'rFonts').attributes.eastAsia, 'SimSun'); assert.equal(prop(rp, 'sz').attributes.val, '28');
    assert.equal(prop(first.paragraphProperties, 'jc').attributes.val, 'center');
    assert.equal(prop(first.paragraphProperties, 'ind').attributes.left, '720');
    assert.equal(prop(first.paragraphProperties, 'spacing').attributes.line, '360');
    assert.ok(prop(first.paragraphProperties, 'pageBreakBefore')); assert.equal(first.segments[1].type, 'page');
    assert.equal(first.formatting.resolved, false);
    assert.deepEqual(first.formatting.styles.map(s => s.styleId), ['Heading', 'Normal', 'ToggleChar', 'BaseChar']);
    assert.equal(first.formatting.styles.find(s => s.styleId === 'ToggleChar').basedOn, 'BaseChar');
    assert.ok(prop(prop(first.formatting.docDefaults, 'rPrDefault'), 'rPr'));
    assert.equal(first.formatting.styles.some(s => ['Unused', 'Grid', 'CycleA'].includes(s.styleId)), false);
    assert.equal(prop(first.sectionProperties, 'pgSz').attributes.w, '12240'); assert.equal(prop(first.sectionProperties, 'cols').attributes.num, '2');
    assert.equal(prop(result.units[1].context.sectionProperties, 'pgSz').attributes.orient, 'landscape');
    const table = result.units[2].context;
    assert.equal(prop(table.tableProperties, 'tblW').attributes.type, 'pct');
    assert.equal(prop(table.rows[0].properties, 'trHeight').attributes.val, '400');
    assert.equal(prop(table.rows[0].cells[0].properties, 'vAlign').attributes.val, 'center');
    assert.ok(table.formatting.styles.some(s => s.styleId === 'Grid'));
    assert.ok(result.units.every(u => u.coverage.unsupported.some(c => c.kind === 'styles-numbering-theme-not-resolved')));
    const cyclic = await call(pack(document.replace('d:val="Heading"', 'd:val="CycleA"')));
    assert.ok(cyclic.units[0].coverage.unsupported.some(c => c.kind === 'docx-style-cycle-not-resolved'));
    const missing = await call(pack(document.replace('d:val="Heading"', 'd:val="Missing"')));
    assert.ok(missing.units[0].coverage.unsupported.some(c => c.kind === 'docx-style-reference-missing'));
  } finally { await mf.dispose(); }
});
