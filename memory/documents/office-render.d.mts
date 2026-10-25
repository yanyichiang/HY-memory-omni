import type {DocumentUnit,Coverage} from './parse.mjs';
/** Explicitly bounded Workers derived layout; source native evidence is retained separately. */
export function renderOffice(mimeType:string,bytes:Uint8Array):Promise<{units:(Omit<DocumentUnit,'locator'> & {locator:{kind:'office-rendered-page';format:'docx'|'xlsx';page:number}})[];coverage:Coverage}>;
export function preflightOffice(bytes:Uint8Array):{admission:{parts:number;cells:number;images:number};renderBytes:Uint8Array};
