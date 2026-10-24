// One parsing operation owns the budget across every asynchronous load/copy/save.
export class PdfBudgetError extends Error {}
let active, tail=Promise.resolve();
export function activePdfBudget(){if(!active)throw new PdfBudgetError('document_pdf_budget_missing');return active;}
export async function withPdfBudget(run){
  let release;const previous=tail;tail=new Promise(resolve=>{release=resolve;});await previous;
  let allocated=0,derived=0;
  active={
    stream(size){if(!Number.isSafeInteger(size)||size<0||size>8*1024*1024)throw new PdfBudgetError('document_pdf_stream_limit');},
    allocate(size){this.stream(size);allocated+=size;if(allocated>24*1024*1024)throw new PdfBudgetError('document_pdf_decode_limit');},
    output(size){if(!Number.isSafeInteger(size)||size<0||size>8*1024*1024||(derived+=size)>16*1024*1024)throw new PdfBudgetError('document_derived_size_exceeded');},
  };
  try{return await run();}finally{active=undefined;release();}
}
