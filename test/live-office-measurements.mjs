// Focused repair acceptance. Real production perception, grounding and claim projection;
// one explicit L2 fixture supports the original observation. No Hy Writer or ingestion rerun.
import {readFileSync} from 'node:fs';
import {writeFile,mkdir,appendFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {resolve,join} from 'node:path';
import {readConfig} from '../scripts/config.mjs';
import {officeRenderFixtures} from '../memory/test/office-render-fixtures.mjs';
if(!process.env.HY_LIVE_OUTPUT)throw Error('HY_LIVE_OUTPUT must name a new private directory. Live models will be called.');
const out=resolve(process.env.HY_LIVE_OUTPUT);await mkdir(out,{mode:0o700});
const config=await readConfig(),report={finished:false,scope:'Current production DOCX perception/grounding and claim projection with a single observation-backed L2 fixture; not Hy Writer, service ingestion or a full suite rerun.',checks:[],semanticReview:'required'};
let calls=0;
const hook=registerHooks({load(url,ctx,next){if(!url.endsWith('.wasm'))return next(url,ctx);const data=readFileSync(new URL(url)).toString('base64');return{format:'module',source:`export default new WebAssembly.Module(Buffer.from('${data}','base64'));`,shortCircuit:true};}});
try{
 const {CloudflareMemoryModels}=await import('../memory/dist/models.js');
 const {prepareDocument,DOCUMENT_UNIT_MIME}=await import('../memory/dist/document-media.js');
 const fixture=officeRenderFixtures()[0],prepared=await prepareDocument(fixture.mimeType,fixture.bytes);
 const packed=prepared.units.find(u=>u.locator.kind==='docx-block'&&u.locator.blockIndex===3);
 if(!packed)throw Error('Original page-break unit absent.');
 const unit=JSON.parse(new TextDecoder().decode(packed.bytes));
 const margin=unit.context.sectionProperties.children.find(p=>p.kind==='pgMar').measurements;
 if(margin.top.inches!==1||margin.header.inches!==0.5)throw Error('Host measurement annotation incorrect.');
 report.measurements=margin;
 const source={sourceId:'synthetic-office-measurements',revision:1,mediaRef:'synthetic-office-measurements'};
 const bytes=new TextEncoder().encode(JSON.stringify({...unit,original:source}));
 const models=new CloudflareMemoryModels({accountId:config.CF_ACCOUNT_ID,gatewayId:config.MEMORY_GATEWAY_ID,token:config.MEMORY_MODEL_TOKEN,temporalModel:config.MEMORY_TEMPORAL_MODEL,formationModel:config.MEMORY_FORMATION_MODEL,textEmbeddingModel:config.MEMORY_TEXT_EMBEDDING_MODEL,mediaEmbeddingModel:config.MEMORY_MEDIA_EMBEDDING_MODEL},{fetch(){throw Error('Hy engine forbidden in this focused measurement acceptance.');}},async(url,init)=>{
  if(url.includes(':embedContent'))throw Error('Embedding forbidden in this focused acceptance.');
  const id=++calls,response=await fetch(url,init),result=await response.clone().json();
  await appendFile(join(out,'first-responses.jsonl'),JSON.stringify({id,status:response.status,request:JSON.parse(init.body),response:result})+'\n',{mode:0o600});return response;
 });
 report.observation=await models.perceive(DOCUMENT_UNIT_MIME,bytes,undefined,'Inspect the explicit section top margin and header/footer distances. Preserve their raw values and quote only the supplied host measurement conversions; do not infer effective rendered layout.');
 report.claims=await models.knowledge.extract({source,authority:'observation',perception:report.observation,nodes:[{payload:{node_id:'observation-backed-fixture',layer:'l2_fact',status:'active',is_latest:true,content:report.observation.text}}]});
 for(const c of [
  {name:'explicit raw margins converted correctly',query:'Do the original explicit section properties specify 1440 twips (1 inch) for the top margin and 720 twips (0.5 inch) for header distance, without claiming final effective rendered layout?',expected:true},
  {name:'incorrect half-inch top margin rejected',query:'Do the original explicit section properties specify a top margin of 0.5 inch, rather than 1 inch? Do not confuse header distance with the top margin.',expected:false},
 ]){const result=await models.matchDocument({bytes,query:c.query});report.checks.push({...c,result,passed:result.matches===c.expected});}
 report.finished=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{hook.deregister();await writeFile(join(out,'report.json'),JSON.stringify({...report,calls},null,2),{mode:0o600});}
console.log(JSON.stringify({...report,calls}));if(report.checks.some(c=>!c.passed))process.exitCode=1;
