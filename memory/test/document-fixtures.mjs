// Small synthetic evidence packages, not a renderer or Office compatibility corpus.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';

export async function documentFixtures() {
  const ns = 'http://schemas.openxmlformats.org/', r = ns + 'officeDocument/2006/relationships';
  const w = ns + 'wordprocessingml/2006/main', s = ns + 'spreadsheetml/2006/main', p = ns + 'presentationml/2006/main', a = ns + 'drawingml/2006/main';
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII='), c => c.charCodeAt(0));
  const rel = (id, target, kind) => `<Relationship Id="${id}" Target="${target}" Type="${r}/${kind}"/>`;
  const rels = value => `<Relationships xmlns="${ns}package/2006/relationships">${value}</Relationships>`;
  function pack(main, contentType, parts) {
    return zipSync(Object.fromEntries(Object.entries({
      '[Content_Types].xml': `<Types xmlns="${ns}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/${main}" ContentType="${contentType}"/></Types>`,
      '_rels/.rels': rels(rel('root', main, 'officeDocument')), ...parts,
    }).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])));
  }
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const label of ['Synthetic board decision: approve Friday proposal.', 'Synthetic budget: five units, pending review.']) {
    pdf.addPage([320, 240]).drawText(label, { x: 15, y: 180, size: 10, font });
  }
  return [
    { name: 'synthetic-evidence.pdf', mimeType: 'application/pdf', units: 2, bytes: await pdf.save() },
    { name: 'synthetic-evidence.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', units: 2,
      bytes: pack('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', {
        'word/document.xml': `<d:document xmlns:d="${w}" xmlns:g="${a}" xmlns:link="${r}" xmlns:pos="${ns}drawingml/2006/wordprocessingDrawing"><d:body><d:p><d:r><d:t>Synthetic board decision: approve Friday proposal.</d:t><d:drawing><pos:inline><pos:extent cx="914400" cy="914400"/><g:blip link:embed="img"/></pos:inline></d:drawing></d:r></d:p><d:tbl><d:tr><d:tc><d:p><d:r><d:t>Budget</d:t></d:r></d:p></d:tc><d:tc><d:p><d:r><d:t>5</d:t></d:r></d:p></d:tc></d:tr></d:tbl></d:body></d:document>`,
        'word/_rels/document.xml.rels': rels(rel('img', 'media/mark.png', 'image')), 'word/media/mark.png': png,
      }) },
    { name: 'synthetic-evidence.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', units: 2,
      bytes: pack('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', {
        'xl/workbook.xml': `<workbook xmlns="${s}" xmlns:link="${r}"><sheets><sheet name="Decisions" sheetId="1" link:id="sheet"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': rels(rel('sheet', 'worksheets/sheet1.xml', 'worksheet')),
        'xl/worksheets/sheet1.xml': `<worksheet xmlns="${s}" xmlns:link="${r}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Friday proposal</t></is></c><c r="B1"><f>2+3</f><v>5</v></c></row><row r="40"><c r="A40" t="inlineStr"><is><t>Pending review</t></is></c></row></sheetData><drawing link:id="drawing"/></worksheet>`,
        'xl/worksheets/_rels/sheet1.xml.rels': rels(rel('drawing', '../drawings/drawing1.xml', 'drawing')),
        'xl/drawings/drawing1.xml': `<x:wsDr xmlns:x="${ns}drawingml/2006/spreadsheetDrawing" xmlns:g="${a}" xmlns:link="${r}"><x:twoCellAnchor><x:from><x:col>0</x:col><x:row>0</x:row></x:from><x:to><x:col>2</x:col><x:row>45</x:row></x:to><x:pic><g:blip link:embed="image"/></x:pic></x:twoCellAnchor></x:wsDr>`,
        'xl/drawings/_rels/drawing1.xml.rels': rels(rel('image', '../media/mark.png', 'image')), 'xl/media/mark.png': png,
      }) },
    { name: 'synthetic-evidence.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', units: 1,
      bytes: pack('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', {
        'ppt/presentation.xml': `<deck:presentation xmlns:deck="${p}" xmlns:link="${r}"><deck:sldIdLst><deck:sldId id="256" link:id="slide"/></deck:sldIdLst><deck:sldSz cx="9144000" cy="6858000"/></deck:presentation>`,
        'ppt/_rels/presentation.xml.rels': rels(rel('slide', 'slides/slide1.xml', 'slide')),
        'ppt/slides/slide1.xml': `<deck:sld xmlns:deck="${p}" xmlns:g="${a}" xmlns:link="${r}"><deck:cSld><deck:spTree><deck:sp><deck:spPr><g:xfrm><g:off x="100" y="200"/><g:ext cx="3000" cy="1000"/></g:xfrm></deck:spPr><deck:txBody><g:p><g:r><g:t>Synthetic board decision: Friday proposal.</g:t></g:r></g:p></deck:txBody></deck:sp><deck:pic><g:blip link:embed="image"/></deck:pic></deck:spTree></deck:cSld></deck:sld>`,
        'ppt/slides/_rels/slide1.xml.rels': rels(rel('image', '../media/mark.png', 'image')), 'ppt/media/mark.png': png,
      }) },
  ];
}

/** Deterministically empty structural units, distinct from failed model observations. */
export async function emptyDocumentFixtures() {
  const pdf = await PDFDocument.create(); pdf.addPage([320, 240]);
  const ns = 'http://schemas.openxmlformats.org/';
  const entries = {
    '[Content_Types].xml': `<Types xmlns="${ns}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="main" Target="word/document.xml" Type="${ns}officeDocument/2006/relationships/officeDocument"/></Relationships>`,
    'word/document.xml': `<document xmlns="${ns}wordprocessingml/2006/main"><body><p><r><t>   </t></r></p></body></document>`,
  };
  return [
    { name: 'synthetic-empty-page.pdf', mimeType: 'application/pdf', units: 1, bytes: await pdf.save() },
    { name: 'synthetic-empty-paragraph.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', units: 1,
      bytes: zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)]))) },
  ];
}
