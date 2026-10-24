// Static adaptation of pinned pdf-lib. Keep the original source and licence beside it.
import {createRequire} from 'node:module';
import {readFile,writeFile,cp,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function preparePdf(){
  const require=createRequire(import.meta.url),upstream=dirname(require.resolve('pdf-lib/package.json'));
  if(JSON.parse(await readFile(resolve(upstream,'package.json'),'utf8')).version!=='1.17.1')throw Error('pdf_upstream_version_mismatch');
  const output=fileURLToPath(new URL('../.generated/pdf-lib/',import.meta.url));
  await mkdir(output,{recursive:true});
  for(const entry of ['es','src','LICENSE.md','package.json'])await cp(resolve(upstream,entry),resolve(output,entry),{recursive:true});
  const replace=(source,before,after)=>{if(source.split(before).length!==2)throw Error('pdf_patch_source_mismatch');return source.replace(before,after);};
  const budgetImport="import {activePdfBudget, PdfBudgetError} from '../../../../../documents/pdf-budget.mjs';\n";
  let file=resolve(output,'es/core/streams/DecodeStream.js'),source=await readFile(file,'utf8');
  source=replace(source,'    function DecodeStream(maybeMinBufferLength) {\n        this.pos = 0;', '    function DecodeStream(maybeMinBufferLength) {\n        this.hyBudget = activePdfBudget();\n        if (maybeMinBufferLength) this.hyBudget.stream(maybeMinBufferLength);\n        this.pos = 0;');
  source=replace(source,'        var buffer = this.buffer;', '        this.hyBudget.stream(requested);\n        var buffer = this.buffer;');
  source=replace(source,'        var buffer2 = new Uint8Array(size);','        this.hyBudget.allocate(size);\n        var buffer2 = new Uint8Array(size);');
  await writeFile(file,budgetImport+source);
  file=resolve(output,'es/core/parser/PDFParser.js');source=await readFile(file,'utf8');
  source=replace(source,'                        e_1 = _a.sent();','                        e_1 = _a.sent();\n                        if (e_1 instanceof PdfBudgetError) throw e_1;');
  await writeFile(file,budgetImport+source);
  file=resolve(output,'es/core/writers/PDFWriter.js');source=await readFile(file,'utf8');
  source=replace(source,'                        buffer = new Uint8Array(size);','                        activePdfBudget().output(size);\n                        buffer = new Uint8Array(size);');
  await writeFile(file,budgetImport+source);
  file=resolve(output,'es/index.js');source=await readFile(file,'utf8');
  await writeFile(file,source+'\nexport const HY_PDF_BOUNDED = true;\n');
  await cp(fileURLToPath(new URL('../documents/pdf-budget.mjs',import.meta.url)),resolve(output,'HY-pdf-budget.mjs'));
  await cp(fileURLToPath(import.meta.url),resolve(output,'HY-prepare-pdf.mjs'));
  return resolve(output,'es/index.js');
}
