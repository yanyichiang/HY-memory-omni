import { parseDocument, documentMime, DOCUMENT_MIME_TYPES } from '../documents/parse.mjs';
import { MemoryError, decode, encode, record } from './service.js';
import { nativeMedia } from './native-media.js';
import type { DocumentUnit, DocumentCoverage } from './document-types.js';
export type { DocumentCoverage } from './document-types.js';
export const DOCUMENT_UNIT_MIME = 'application/vnd.hy-memory.document-unit+json';
export const isDocument = (mime:string) => (DOCUMENT_MIME_TYPES as readonly string[]).includes(mime);
export interface DocumentProviderPart { text?:string;inlineData?:{mimeType:string;data:string} }
const cap=8*1024*1024;
export function readDocumentUnit(bytes:Uint8Array):DocumentUnit {
  if (!bytes.length || bytes.length>cap) throw new MemoryError('document_unit_size_limit',413);
  let unit:Record<string,unknown>;
  try {unit=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
  catch {throw new MemoryError('document_unit_invalid',400);}
  record(unit.locator); record(unit.context);
  const coverage=record(unit.coverage);
  if(!Array.isArray(coverage.unsupported)||!Array.isArray(unit.images)||unit.images.length>6) throw new MemoryError('document_unit_invalid',400);
  return unit as unknown as DocumentUnit;
}
export async function prepareDocument(mimeType:string,bytes:Uint8Array):Promise<{units:{bytes:Uint8Array;locator:Record<string,unknown>;coverage:DocumentCoverage}[];coverage:DocumentCoverage}> {
  if(!isDocument(mimeType)) throw new MemoryError('document_mime_unsupported',415);
  let parsed:Awaited<ReturnType<typeof parseDocument>>;
  try {parsed=await parseDocument(mimeType,bytes);} catch(error) {throw new MemoryError(error instanceof Error?error.message:'document_parse_failed',415);}
  if(!parsed.units.length||parsed.units.length>128) throw new MemoryError('document_unit_count_limit',413);
  let total=0;
  const units=[];
  for(const value of parsed.units){
    if(value.images.length>6) throw new MemoryError('document_unit_image_limit',413);
    // No text-only substitute for an unsupported embedded image.
    for(const image of value.images) {
      if(!['image/png','image/jpeg','image/webp','image/heic','image/heif','image/avif','image/gif'].includes(image.mimeType)) throw new MemoryError('document_image_unsupported',415);
      await nativeMedia({mimeType:image.mimeType,bytes:image.bytes});
    }
    const unit:DocumentUnit={locator:value.locator,context:value.context,coverage:value.coverage??parsed.coverage,...(value.empty?{empty:true}:{}),
      images:value.images.map(image=>({part:image.part,mimeType:image.mimeType,dataBase64:encode(image.bytes),anchor:image.anchor})),
      ...(value.derived?{derived:{mimeType:'application/pdf',dataBase64:encode(value.derived.bytes)}}:{})};
    const packed=new TextEncoder().encode(JSON.stringify(unit));
    total+=packed.length;
    if(packed.length>cap || total>24*1024*1024) throw new MemoryError('document_representation_limit',413);
    units.push({bytes:packed,locator:unit.locator,coverage:unit.coverage});
  }
  return {units,coverage:parsed.coverage};
}
export async function documentParts(bytes:Uint8Array):Promise<{unit:DocumentUnit;parts:DocumentProviderPart[]}> {
  const unit=readDocumentUnit(bytes),parts:DocumentProviderPart[]=[];
  parts.push({text:JSON.stringify({documentOriginal:unit.original,sourceLocator:unit.locator,structure:unit.context,coverage:unit.coverage})});
  if(unit.derived) parts.push({inlineData:{mimeType:'application/pdf',data:unit.derived.dataBase64}});
  for(const image of unit.images){
    const native=await nativeMedia({mimeType:image.mimeType,bytes:decode(image.dataBase64)});
    parts.push({text:JSON.stringify({embeddedImage:image.part,anchor:image.anchor,representation:'representation' in native?native.representation:undefined})});
    parts.push({inlineData:{mimeType:native.mimeType,data:encode(native.bytes)}});
  }
  return {unit,parts};
}
/** A query is observed separately; no query document is admitted as source evidence. */
export async function documentQueryParts(mimeType:string,bytes:Uint8Array):Promise<DocumentProviderPart[]> {
  const prepared=await prepareDocument(mimeType,bytes);
  if(mimeType==='application/pdf') {
    if(prepared.units.length>6) throw new MemoryError('document_query_page_limit',413);
    return [{inlineData:{mimeType,data:encode(bytes)}}];
  }
  const parts:DocumentProviderPart[]=[];
  for(const unit of prepared.units) parts.push(...(await documentParts(unit.bytes)).parts);
  if(parts.filter(p=>p.inlineData).length>6 || parts.reduce((n,p)=>n+new TextEncoder().encode(p.text??'').length,0)>65536) throw new MemoryError('document_query_representation_limit',413);
  return parts;
}

export async function inspectDocument(bytes:Uint8Array){const mimeType=documentMime(bytes);if(!mimeType)throw new MemoryError('document_mime_unsupported',415);const parsed=await prepareDocument(mimeType,bytes);return {mimeType,units:parsed.units.map((unit,index)=>({index,locator:unit.locator,coverage:unit.coverage})),coverage:parsed.coverage};}
