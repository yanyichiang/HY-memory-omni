/** Original changes by YY, Apache-2.0. See README.md for dependency notices. */
export const DOCUMENT_MIME_TYPES: readonly [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
];
export type DocumentMimeType = typeof DOCUMENT_MIME_TYPES[number];
export type CoverageIssue = { kind: string; part?: string; detail?: Record<string, unknown> };
export type Coverage = { unsupported: CoverageIssue[] };
export type DocumentLocator =
  | { kind: 'pdf-page'; pageIndex: number }
  | { kind: 'docx-block'; part: string; blockIndex: number; sectionIndex: number }
  | { kind: 'xlsx-range'; part: string; sheetIndex: number; sheetName: string; range: string }
  | { kind: 'pptx-slide'; part: string; slideIndex: number };
export type DocumentImage = {
  part: string;
  /** Package-declared MIME; consumers must validate bytes with nativeMedia. */
  mimeType: string;
  bytes: Uint8Array;
  anchor: Record<string, unknown>;
};
export type DocumentUnit = {
  empty?:boolean;
  locator: DocumentLocator;
  context: Record<string, unknown>;
  images: DocumentImage[];
  coverage: Coverage;
  derived?: { mimeType: 'application/pdf'; bytes: Uint8Array };
};
export type ParsedDocument = {
  original: { mimeType: DocumentMimeType; bytes: Uint8Array };
  units: DocumentUnit[];
  coverage: Coverage;
};
/** Throws on malformed, encrypted, unsupported or over-budget input; never fetches external relations. */
export function parseDocument(mimeType: string, bytes: Uint8Array): Promise<ParsedDocument>;

export function documentMime(bytes:Uint8Array):DocumentMimeType|undefined;
