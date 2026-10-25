import {zipSync,strToU8} from 'fflate';
export function officeRenderFixtures(){
const ns='http://schemas.openxmlformats.org/',r=ns+'officeDocument/2006/relationships',w=ns+'wordprocessingml/2006/main',s=ns+'spreadsheetml/2006/main';
const rel=(id,target,type)=>`<Relationship Id="${id}" Target="${target}" Type="${r}/${type}"/>`;
const rels=inner=>`<Relationships xmlns="${ns}package/2006/relationships">${inner}</Relationships>`;
const pack=(main,type,entries)=>zipSync(Object.fromEntries(Object.entries({
 '[Content_Types].xml':`<Types xmlns="${ns}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/${main}" ContentType="${type}"/></Types>`,
 '_rels/.rels':rels(rel('root',main,'officeDocument')),...entries
}).map(([k,v])=>[k,strToU8(v)])));
const docx=pack('word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',{
 'word/document.xml':`<w:document xmlns:w="${w}" xmlns:r="${r}"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="36"/></w:rPr><w:t>中文排版验证</w:t></w:r></w:p><w:p><w:r><w:t>Page one: source text above a two-cell table.</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="8"/><w:left w:val="single" w:sz="8"/><w:bottom w:val="single" w:sz="8"/><w:right w:val="single" w:sz="8"/><w:insideV w:val="single" w:sz="8"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:fill="D9EAF7"/></w:tcPr><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>数值 42</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Page two: explicit original page break.</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="header"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`,
 'word/styles.xml':`<w:styles xmlns:w="${w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans SC" w:eastAsia="Noto Sans SC"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
 'word/header1.xml':`<w:hdr xmlns:w="${w}"><w:p><w:r><w:t>Repeated source header</w:t></w:r></w:p></w:hdr>`,
 'word/_rels/document.xml.rels':rels(rel('styles','styles.xml','styles')+rel('header','header1.xml','header')),
});
const cell=(ref,text)=>`<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const rows=[`<row r="1" ht="30" customHeight="1">${cell('A1','标题')}${cell('B1','Value')}${cell('C1','HIDDEN COLUMN')}</row>`,`<row r="2" ht="30" customHeight="1">${cell('A2','缓存公式')}<c r="B2"><f>1+1</f><v>99</v></c></row>`,`<row r="3" ht="30" customHeight="1">${cell('A3','合并单元格')}</row>`,`<row r="4" hidden="1">${cell('A4','HIDDEN ROW')}</row>`,`<row r="5" ht="30" customHeight="1">${cell('A5','Second page')}${cell('B5','42')}</row>`,`<row r="6" ht="30" customHeight="1">${cell('A6','Last row')}${cell('B6','Done')}</row>`].join('');
const xlsx=pack('xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',{
 'xl/workbook.xml':`<workbook xmlns="${s}" xmlns:r="${r}"><sheets><sheet name="Evidence" sheetId="1" r:id="sheet"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Evidence!$A$1:$C$6</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">Evidence!$1:$1</definedName></definedNames></workbook>`,
 'xl/_rels/workbook.xml.rels':rels(rel('sheet','worksheets/sheet1.xml','worksheet')+rel('styles','styles.xml','styles')),
 'xl/styles.xml':`<styleSheet xmlns="${s}"><fonts count="1"><font><sz val="12"/><name val="Noto Sans SC"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
 'xl/worksheets/sheet1.xml':`<worksheet xmlns="${s}"><sheetPr><pageSetUpPr fitToPage="0"/></sheetPr><sheetFormatPr defaultRowHeight="30"/><cols><col min="1" max="2" width="24" customWidth="1"/><col min="3" max="3" width="20" hidden="1"/></cols><sheetData>${rows}</sheetData><mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells><printOptions gridLines="1"/><pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" scale="100"/><rowBreaks count="1" manualBreakCount="1"><brk id="3" min="0" max="16383" man="1"/></rowBreaks></worksheet>`,
});

return [{name:'layout.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:docx},{name:'layout.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:xlsx}];
}
