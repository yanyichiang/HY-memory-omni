// Copyright YY. Apache-2.0. Original native structure remains separately inspectable source evidence.
import {Ream,HY_OFFICE_BOUNDED} from '../.generated/reamkit/index.js';
import {Unzlib,zipSync} from 'fflate';
import {officePackageParts,officeXml,splitDerivedOfficePdf,DOCUMENT_MIME_TYPES} from './parse.mjs';
import {officeFonts,fontPolicy} from './office-fonts.mjs';
const MiB=1024*1024;
const fail=code=>{throw Error(code);};
const encoder=new TextEncoder();
const prefixes={
 'http://schemas.openxmlformats.org/wordprocessingml/2006/main':'w',
 'http://schemas.openxmlformats.org/drawingml/2006/main':'a',
 'http://schemas.openxmlformats.org/officeDocument/2006/relationships':'r',
 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing':'wp',
 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing':'xdr',
 'http://schemas.openxmlformats.org/spreadsheetml/2006/main':'',
 'http://schemas.openxmlformats.org/package/2006/relationships':'',
 'http://schemas.openxmlformats.org/package/2006/content-types':'',
 'http://www.w3.org/XML/1998/namespace':'xml',
};
const transitional=uri=>uri.replace('http://purl.oclc.org/ooxml/wordprocessingml/main','http://schemas.openxmlformats.org/wordprocessingml/2006/main').replace('http://purl.oclc.org/ooxml/spreadsheetml/main','http://schemas.openxmlformats.org/spreadsheetml/2006/main').replace('http://purl.oclc.org/ooxml/drawingml/main','http://schemas.openxmlformats.org/drawingml/2006/main').replace('http://purl.oclc.org/ooxml/officeDocument/relationships','http://schemas.openxmlformats.org/officeDocument/2006/relationships').replace('http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing','http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing').replace('http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing','http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing');
const escapeXml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function canonicalXml(root){
 const uris=new Map();let next=0;
 function collect(n){if(n.uri&&!uris.has(n.uri))uris.set(n.uri,prefixes[transitional(n.uri)]??'ns'+next++);for(const a of n.attributes)if(a.uri&&!uris.has(a.uri))uris.set(a.uri,prefixes[transitional(a.uri)]??'ns'+next++);n.children.forEach(collect);}collect(root);
 const name=n=>(uris.get(n.uri)?uris.get(n.uri)+':':'')+n.local;
 function emit(n,isRoot=false){if(n.local==='#text')return escapeXml(n.text);return '<'+name(n)+(isRoot?[...uris].filter(([,p])=>p!=='xml').map(([u,p])=>' xmlns'+(p?':'+p:'')+'="'+escapeXml(transitional(u))+'"').join(''):'')+n.attributes.map(a=>' '+name(a)+'="'+escapeXml(a.local==='Type'?transitional(a.value):a.value)+'"').join('')+'>'+n.children.map(c=>emit(c)).join('')+'</'+name(n)+'>';}
 return encoder.encode(emit(root,true));
}
const attribute=(n,key)=>n.attributes.find(a=>a.local===key)?.value;
function position(ref){
  const m=/^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(ref);if(!m)fail('office_render_range_unsupported');
  let col=0;for(const c of m[1])col=col*26+c.charCodeAt(0)-64;
  const row=Number(m[2]);if(row>1048576||col>16384)fail('office_render_range_unsupported');return {row,col};
}
function boundedRange(ref){
  const pieces=ref.split(':');if(pieces.length>2)fail('office_render_range_unsupported');
  const a=position(pieces[0]),b=position(pieces[1]??pieces[0]);
  if(b.row<a.row||b.col<a.col||b.row-a.row+1>2048||b.col-a.col+1>128||(b.row-a.row+1)*(b.col-a.col+1)>32768)fail('office_render_grid_budget_exceeded');
  return {a,b};
}
function imageCheck(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let width,height;
  if(bytes.length>=24&&view.getUint32(0)===0x89504e47&&view.getUint32(4)===0x0d0a1a0a){
    width=view.getUint32(16);height=view.getUint32(20);
    if(!width||!height||width*height>4e6)fail('office_render_image_pixel_budget_exceeded');
    // Validate compressed data before Ream's synchronous inflate can allocate it.
    const inflate=new Unzlib((chunk)=>{expanded+=chunk.length;if(expanded>8*MiB)fail('office_render_image_expansion_exceeded');});
    let expanded=0,seen=false;
    for(let p=8;p<bytes.length;){
      if(p+12>bytes.length)fail('office_render_image_invalid');const length=view.getUint32(p),end=p+12+length;
      if(end>bytes.length)fail('office_render_image_invalid');
      if(view.getUint32(p+4)===0x49444154){seen=true;for(let at=p+8;at<p+8+length;at+=4096)inflate.push(bytes.subarray(at,Math.min(at+4096,p+8+length)),false);}
      p=end;
    }
    if(!seen)fail('office_render_image_invalid');inflate.push(new Uint8Array(),true);
  }else if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216){
    for(let p=2;p+4<=bytes.length;){
      if(bytes[p++]!==255)fail('office_render_image_invalid');while(bytes[p]===255)p++;const marker=bytes[p++];
      if(marker===0xd9||marker===0xda)break;if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      if(p+2>bytes.length)fail('office_render_image_invalid');const size=view.getUint16(p);if(size<2||p+size>bytes.length)fail('office_render_image_invalid');
      if([0xc0,0xc1,0xc2].includes(marker)){if(size<8)fail('office_render_image_invalid');height=view.getUint16(p+3);width=view.getUint16(p+5);break;}p+=size;
    }
    if(!width||!height)fail('office_render_image_jpeg_unsupported');
  }else fail('office_render_image_format_unsupported');
  if(!width||!height||width*height>4e6)fail('office_render_image_pixel_budget_exceeded');return width*height;
}
/** All parts are checked, including styles, themes, header/footer and drawing XML. */
export function preflightOffice(bytes){
  const parts=officePackageParts(bytes),renderParts={};let xmlBytes=0,nodes=0,text='',images=0,pixels=0,cells=0,sheets=0;
  for(const [path,data]of parts){
    if(/\.(xml|rels)$/i.test(path)){
      xmlBytes+=data.length;if(xmlBytes>4*MiB)fail('office_render_xml_budget_exceeded');
      const root=officeXml(parts,path);let sheetMinRow=Infinity,sheetMaxRow=0,sheetMinCol=Infinity,sheetMaxCol=0;
      function walk(n){
        if(++nodes>32768)fail('office_render_node_budget_exceeded');
        if(n.local==='#text'){text+=n.text;if(text.length>250000)fail('office_render_text_budget_exceeded');return;}
        if(n.attributes.length>64)fail('office_render_attribute_budget_exceeded');
        if(n.local==='sheet'&&++sheets>16)fail('office_render_sheet_budget_exceeded');
        // No embedded source fonts, active/external content or unbounded layout extensions.
        if(['altChunk','object','oleObject','control','externalLink','embeddedFont','embedRegular','embedBold','embedItalic','embedBoldItalic'].includes(n.local))fail('office_render_active_or_embedded_content_unsupported');
        if(n.local==='Relationship'&&attribute(n,'TargetMode')==='External'&&!attribute(n,'Type')?.endsWith('/hyperlink'))fail('office_render_external_relationship_unsupported');
        if(n.local==='c'&&/worksheets\/.*\.xml$/i.test(path)){
          if(++cells>16384)fail('office_render_cell_budget_exceeded');const pos=position(attribute(n,'r')??'');
          sheetMinRow=Math.min(sheetMinRow,pos.row);sheetMaxRow=Math.max(sheetMaxRow,pos.row);sheetMinCol=Math.min(sheetMinCol,pos.col);sheetMaxCol=Math.max(sheetMaxCol,pos.col);
        }
        if(['dimension','mergeCell','autoFilter'].includes(n.local)&&attribute(n,'ref'))boundedRange(attribute(n,'ref'));
        if(n.local==='definedName'&&attribute(n,'name')==='_xlnm.Print_Area'){
          const value=n.children.map(c=>c.text??'').join('');
          // Multiple print areas are retained natively but not admitted by this bounded renderer.
          const m=/^(?:'(?:[^']|'')+'|[^!,]+)!([^!,]+)$/.exec(value);if(!m)fail('office_render_print_area_unsupported');boundedRange(m[1]);
        }
        if(n.local==='definedName'&&attribute(n,'name')==='_xlnm.Print_Titles'){
          const value=n.children.map(c=>c.text??'').join('');
          for(const area of value.split(',')){
            const ref=area.slice(area.lastIndexOf('!')+1).replace(/\$/g,'');
            const row=/^(\d+):(\d+)$/.exec(ref),col=/^([A-Z]+):([A-Z]+)$/.exec(ref);
            if(row){if(Number(row[1])<1||Number(row[2])<Number(row[1])||Number(row[2])-Number(row[1])+1>128||Number(row[2])>1048576)fail('office_render_print_titles_budget_exceeded');}
            else if(col){const a=position(col[1]+'1'),b=position(col[2]+'1');if(b.col<a.col||b.col-a.col+1>32)fail('office_render_print_titles_budget_exceeded');}
            else fail('office_render_print_titles_unsupported');
          }
        }
        for(const a of n.attributes){
          if(a.value.length>4096)fail('office_render_attribute_budget_exceeded');
          if((['gridSpan','colSpan','rowSpan'].includes(a.local)||n.local==='gridSpan'&&a.local==='val')&&(!/^\d+$/.test(a.value)||Number(a.value)>128))fail('office_render_table_span_budget_exceeded');
          if(n.local==='col'&&['min','max'].includes(a.local)&&(!/^\d+$/.test(a.value)||Number(a.value)>16384))fail('office_render_column_budget_exceeded');
          if(['w','h','cx','cy','sz','ht','width','height','val','defaultRowHeight','defaultColWidth'].includes(a.local)&&/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(a.value)){
            const v=Number(a.value);let limit=['cx','cy'].includes(a.local)?60000000:60000;
            if(['sz','szCs','fontSize'].includes(n.local))limit=288;
            if(n.local==='col'&&a.local==='width')limit=255;
            if(n.local==='row'&&a.local==='ht')limit=409;
            if(!Number.isFinite(v)||Math.abs(v)>limit)fail('office_render_geometry_budget_exceeded');
          }
        }
        if(n.local==='pgSz')for(const key of ['w','h']){const v=Number(attribute(n,key));if(!Number.isFinite(v)||v<1440||v>31680)fail('office_render_page_geometry_unsupported');}
        n.children.forEach(walk);
      }
      walk(root);renderParts[path]=canonicalXml(root);
      if(sheetMaxRow)boundedRange(`${columnName(sheetMinCol)}${sheetMinRow}:${columnName(sheetMaxCol)}${sheetMaxRow}`);
    }else{
      if(++images>32)fail('office_render_image_count_exceeded');renderParts[path]=data;pixels+=imageCheck(data);if(pixels>8e6)fail('office_render_image_pixel_budget_exceeded');
    }
  }
  return {admission:{parts:parts.size,cells,images},renderBytes:zipSync(renderParts,{level:0})};
}
function columnName(n){let out='';while(n){out=String.fromCharCode(65+(n-1)%26)+out;n=Math.floor((n-1)/26);}return out;}
/** Workers native derived pages. A failed render rejects ingestion; never silently drops it. */
export async function renderOffice(mimeType,bytes){
  const format=mimeType===DOCUMENT_MIME_TYPES[1]?'docx':mimeType===DOCUMENT_MIME_TYPES[2]?'xlsx':undefined;
  if(!format)return {units:[],coverage:{unsupported:[]}};
  if(HY_OFFICE_BOUNDED!==true)fail('office_render_bounded_build_required');
  const {admission,renderBytes}=preflightOffice(bytes);
  const document=Ream.parse(renderBytes);if(document.format!==format)fail('office_render_format_mismatch');
  let renderedRows;
  const result=await document.convertWithReport('pdf',{fonts:officeFonts(),fontFetch:()=>fail('office_render_network_font_forbidden'),hyCaptureLayout:pages=>{renderedRows=pages.map(page=>page.hyXlsxRows??[]);}});
  if(result.bytes.length>16*MiB)fail('office_render_output_budget_exceeded');
  const pages=await splitDerivedOfficePdf(result.bytes);
  if(!renderedRows||renderedRows.length!==pages.length)fail('office_render_topology_page_mismatch');
  const unsupported=[{kind:'office-rendered-pages-not-office-identical',detail:'Derived pagination uses Ream and bundled substitute fonts. Source native coordinates remain authoritative.'},
    {kind:'office-renderer-loss-report-incomplete',detail:'An empty renderer loss list does not establish fidelity. Layout, typography, fields, charts and unsupported OOXML may differ.'},
    {kind:'office-render-font-substitution',detail:fontPolicy},
    ...result.losses.map(loss=>({kind:'office-renderer-reported-loss',detail:loss}))];
  if(format==='xlsx')unsupported.push({kind:'office-formulas-not-recalculated',detail:'Cell formulas use cached source values; Ream can evaluate a limited formula subset for conditional formatting. No workbook recalculation is performed.'});
  const rendering={namespacePolicy:'Renderer copy canonicalizes prefixes and Strict OOXML namespace/relationship identifiers to their transitional equivalents; original bytes and native structure are retained.',engine:'reamkit',version:'1.33.1',patches:['hidden-row-page-boundary','bounded-grid-pages-output','missing-visible-glyph-rejection','same-pass-xlsx-table-topology'],fontPolicy,admission,sourceFormat:format,officeIdentical:false};
  const units=pages.map((unit,index)=>{
    const context={rendering,pageGeometry:unit.context,...format==='xlsx'?{renderedTableTopology:{
      basis:'same-pdf-layout-pass',
      coordinateBasis:'Source rows/columns are one-based worksheet coordinates retained by the actual print projection; layout columns belong to emitted row fragments. Source merge bounds describe the original grid; layout spans describe this emitted fragment.',
      coverage:'Partial XLSX body grid: only cells retaining source coordinates. Synthetic print headings and column-band continuation blanks may be omitted; omittedCellCount reports missing cells within a captured row. Header/footer text, shapes and page geometry are not covered. Missing records do not establish absence. Print-title roles can appear on the first page; isPrintTitleRow does not assert this occurrence is a repeat. Split/repeated fragments may repeat source coordinates. A null sheet name is unresolved.',
      rows:renderedRows[index],
    }}:{}};
    if(encoder.encode(JSON.stringify(context)).length>65536)fail('document_unit_context_exceeded');
    return {locator:{kind:'office-rendered-page',format,page:index+1},context,coverage:{unsupported},images:[],derived:unit.derived};
  });
  return {units,coverage:{unsupported}};
}
