import type { SourceRef } from './service.js';
export interface DocumentCoverage { unsupported: Record<string, unknown>[] }
export interface DocumentUnit {
  original?:SourceRef; empty?:boolean;
  locator: Record<string, unknown>; context: Record<string, unknown>; coverage: DocumentCoverage;
  images: {part:string; mimeType:string; dataBase64:string; anchor:unknown}[];
  derived?: {mimeType:'application/pdf';dataBase64:string};
}
export interface DocumentRoot { units:number;cursor:number;complete:boolean;coverage:DocumentCoverage }
export interface DocumentPart { original:SourceRef;index:number;locator:Record<string,unknown>;coverage:DocumentCoverage;empty?:boolean;origin?:'owner-correction' }
