// Synthetic original media notices embedded in native document formats.
import {readFile} from 'node:fs/promises';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {unzipSync,zipSync} from 'fflate';
import {documentFixtures} from '../memory/test/document-fixtures.mjs';
export async function liveDocumentFixtures(){
  const C=await readFile(new URL('./live-fixtures/C.png',import.meta.url)),B=await readFile(new URL('./live-fixtures/B.png',import.meta.url)),D=await readFile(new URL('./live-fixtures/D.png',import.meta.url));
  async function pdf(images){const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);for(const bytes of images){const image=await doc.embedPng(bytes),page=doc.addPage([600,430]);page.drawText('Synthetic source notice',{x:20,y:400,size:12,font});page.drawImage(image,{x:20,y:50,width:560,height:317});}return doc.save();}
  const fixtures=await documentFixtures();fixtures[0].bytes=await pdf([C,B]);
  for(const fixture of fixtures.slice(1)){
    const parts=unzipSync(fixture.bytes),image=fixture.name.endsWith('.xlsx')?D:C;
    for(const key of Object.keys(parts))if(key.endsWith('/mark.png'))parts[key]=image;
    fixture.bytes=zipSync(parts);
  }
  return {fixtures,query:{mimeType:'application/pdf',bytes:await pdf([C])}};
}
