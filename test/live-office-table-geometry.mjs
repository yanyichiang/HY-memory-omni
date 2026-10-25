// Focused first-answer repair reuses the retained PDF and provider unit context. The native
// range is prepared again from the retained workbook; no service ingestion replay.
import {readFileSync} from 'node:fs';
import {writeFile,mkdir,appendFile,readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {resolve,join} from 'node:path';
import {readConfig} from '../scripts/config.mjs';
if(!process.env.HY_LIVE_OUTPUT||!process.env.HY_LIVE_REUSE_FROM)throw Error('Set a new private HY_LIVE_OUTPUT and the retained office-rendering HY_LIVE_REUSE_FROM. Real models will be called.');
const out=resolve(process.env.HY_LIVE_OUTPUT);await mkdir(out,{mode:0o700});
const config=await readConfig(),report={finished:false,scope:'Production perception, grounding and claim projection using the exact retained Excel PDF and its retained provider unit context, plus native-unit exclusion locally prepared again from the retained workbook. One observation-backed L2 fixture; no Hy Writer, embedding or service ingestion replay.',checks:[],semanticReview:'required'};
const hook=registerHooks({load(url,ctx,next){if(!url.endsWith('.wasm'))return next(url,ctx);const data=readFileSync(new URL(url)).toString('base64');return{format:'module',source:`export default new WebAssembly.Module(Buffer.from('${data}','base64'));`,shortCircuit:true};}});
let calls=0;
try{
 const rows=(await readFile(join(resolve(process.env.HY_LIVE_REUSE_FROM),'model-first-responses.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 let metadata;
 for(const row of rows){
  const parts=row.request?.input?.contents?.[0]?.parts;
  if(!parts?.[0]?.text?.startsWith('{'))continue;
  const candidate=JSON.parse(parts[0].text);
  if(candidate.sourceLocator?.kind==='office-rendered-page'&&candidate.sourceLocator.format==='xlsx'&&candidate.sourceLocator.page===1){
   if(parts.filter(p=>p.inlineData).length!==1||!parts.some(p=>p.inlineData?.mimeType==='application/pdf'))throw Error('Retained rendered unit attachment contract changed.');
   metadata=candidate;break;
  }
 }
 if(!metadata)throw Error('Retained rendered spreadsheet page 1 context is absent.');
 const pdf=await readFile(join(resolve(process.env.HY_LIVE_REUSE_FROM),'layout.xlsx-page-1.pdf'));
 if(pdf.subarray(0,5).toString()!=='%PDF-')throw Error('Retained page is not PDF.');
 const unit={original:metadata.documentOriginal,locator:metadata.sourceLocator,context:metadata.structure,coverage:metadata.coverage,images:[],derived:{mimeType:'application/pdf',dataBase64:pdf.toString('base64')}};
 const bytes=Buffer.from(JSON.stringify(unit));
 await writeFile(join(out,'unit.json'),bytes,{mode:0o600});
 const {CloudflareMemoryModels}=await import('../memory/dist/models.js');
 const {DOCUMENT_UNIT_MIME,prepareDocument}=await import('../memory/dist/document-media.js');
 const original=await readFile(join(resolve(process.env.HY_LIVE_REUSE_FROM),'layout.xlsx'));
 const prepared=await prepareDocument('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',original);
 const native=prepared.units.find(u=>u.locator.kind==='xlsx-range');
 if(!native)throw Error('Retained workbook native range is absent.');
 const nativeBytes=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(native.bytes).toString()),original:unit.original}));
 const models=new CloudflareMemoryModels({accountId:config.CF_ACCOUNT_ID,gatewayId:config.MEMORY_GATEWAY_ID,token:config.MEMORY_MODEL_TOKEN,temporalModel:config.MEMORY_TEMPORAL_MODEL,formationModel:config.MEMORY_FORMATION_MODEL,textEmbeddingModel:config.MEMORY_TEXT_EMBEDDING_MODEL,mediaEmbeddingModel:config.MEMORY_MEDIA_EMBEDDING_MODEL},{fetch(){throw Error('Hy engine forbidden in focused geometry acceptance.');}},async(url,init)=>{
  if(url.includes(':embedContent'))throw Error('Embedding forbidden in focused geometry acceptance.');
  const id=++calls,response=await fetch(url,init),result=await response.clone().json();
  await appendFile(join(out,'first-responses.jsonl'),JSON.stringify({id,status:response.status,request:JSON.parse(init.body),response:result})+'\n',{mode:0o600});return response;
 });
 report.observation=await models.perceive(DOCUMENT_UNIT_MIME,bytes);
 report.claims=await models.knowledge.extract({source:unit.original,authority:'observation',perception:report.observation,nodes:[{payload:{node_id:'observation-backed-fixture',layer:'l2_fact',status:'active',is_latest:true,content:report.observation.text}}]});
 for(const c of [
  {name:'three rows including header and full-width bottom cell',query:'Does this rendered table have three rows in total including its header, with 合并单元格 in a single full-width bottom cell and no vertical divider splitting that bottom row?',expected:true},
  {name:'separate empty bottom-right cell rejected',query:'Does the rendered bottom row have two separate cells divided by a visible vertical border, with 合并单元格 on the left and an empty cell on the right?',expected:false},
 ]){const result=await models.matchDocument({bytes,query:c.query});report.checks.push({...c,result,passed:result.matches===c.expected});}
 for(const c of [
  {name:'native formula and cached value remain queryable',query:'Does the native worksheet store formula 1+1 with cached value 99 in cell B2 next to 缓存公式?',expected:true},
  {name:'native cache is not rendered-page evidence',query:'Find the rendered spreadsheet page showing 缓存公式 with displayed cached value 99. Do not recalculate the formula to 2.',expected:false},
  {name:'native range cannot prove rendered same-page placement',query:'Find the rendered spreadsheet page with the repeated header 标题 / Value above both Second page / 42 and Last row / Done.',expected:false},
 ]){const result=await models.matchDocument({bytes:nativeBytes,query:c.query});report.checks.push({...c,result,passed:result.matches===c.expected});}
 report.finished=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{hook.deregister();await writeFile(join(out,'report.json'),JSON.stringify({...report,calls},null,2),{mode:0o600});}
console.log(JSON.stringify({...report,calls}));if(report.checks.some(c=>!c.passed))process.exitCode=1;
