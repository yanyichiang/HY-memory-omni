// Targeted first-answer regression. Production prompts/adapter only; no retry or embedding/engine.
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve,join} from 'node:path';
import {readConfig} from '../scripts/config.mjs';
import {liveDocumentFixtures} from './live-document-fixtures.mjs';
if(!process.env.HY_LIVE_OUTPUT)throw Error('HY_LIVE_OUTPUT must name a new private directory. Live models will be called.');
const out=resolve(process.env.HY_LIVE_OUTPUT);await mkdir(out,{mode:0o700});
const config=await readConfig(),report={finished:false,scope:'Explicit notice-selection text plus native PDF query, not pure-media-only full-page matching.',checks:[],errors:[]};
const hook=registerHooks({load(url,ctx,next){if(!url.endsWith('.wasm'))return next(url,ctx);const data=readFileSync(new URL(url)).toString('base64');return{format:'module',source:`export default new WebAssembly.Module(Buffer.from('${data}','base64'));`,shortCircuit:true};}});
let calls=0;
try{
 const {CloudflareMemoryModels}=await import('../memory/dist/models.js');
 const {prepareDocument}=await import('../memory/dist/document-media.js');
 const generated=await liveDocumentFixtures(),fixtures=generated.fixtures;
 if(process.env.HY_LIVE_DOCUMENT_ORIGINALS)for(const fixture of fixtures)fixture.bytes=new Uint8Array(await readFile(join(resolve(process.env.HY_LIVE_DOCUMENT_ORIGINALS),fixture.name)));
 const media=generated.query; // Same object/bytes identity lets production query-cue caching share one observation.
 await writeFile(join(out,'query.pdf'),media.bytes,{mode:0o600});
 const models=new CloudflareMemoryModels({accountId:config.CF_ACCOUNT_ID,gatewayId:config.MEMORY_GATEWAY_ID,token:config.MEMORY_MODEL_TOKEN,temporalModel:config.MEMORY_TEMPORAL_MODEL,formationModel:config.MEMORY_FORMATION_MODEL,textEmbeddingModel:config.MEMORY_TEXT_EMBEDDING_MODEL,mediaEmbeddingModel:config.MEMORY_MEDIA_EMBEDDING_MODEL},{fetch(){throw Error('Engine forbidden in targeted grounding.');}},async(url,init)=>{
   if(url.includes(':embedContent'))throw Error('Embedding forbidden in targeted grounding.');
   const id=++calls,response=await fetch(url,init),raw=await response.clone().text();
   let result;try{result=JSON.parse(raw)}catch{result={raw}}
   await appendFile(join(out,'first-responses.jsonl'),JSON.stringify({id,status:response.status,request:JSON.parse(init.body),response:result})+'\n',{mode:0o600});return response;
 });
 const query='Find document units containing the same PROJECT REVIEW MEETING notice shown in the query PDF. Match the meeting ID, scheduled date/time and room; the surrounding page label is not part of the requested notice. Do not match a different meeting, a budget table or an unrelated proposal.';
 const cases=[];
 for(const fixture of fixtures){
   const prepared=await prepareDocument(fixture.mimeType,fixture.bytes);
   await writeFile(join(out,fixture.name),fixture.bytes,{mode:0o600});
   for(const [index,unit]of prepared.units.entries())cases.push({name:fixture.name+':'+index,bytes:unit.bytes,locator:unit.locator,expected:index===0&&!fixture.name.endsWith('.xlsx'),query});
 }
 if(cases.length!==7)throw Error('Expected exactly seven original units; do not silently change the profile.');
 const docx=cases.find(c=>c.name.endsWith('.docx:0'));
 cases.push({...docx,name:'docx-notice-does-not-prove-authorized-M18-decision',expected:false,query:'Find a unit containing this PROJECT REVIEW MEETING notice combined with an authorized board decision changing M18. The embedded notice alone does not establish an authorized decision or a relationship to surrounding proposal text.'});
 for(const c of cases){
   try{const result=await models.matchDocument({bytes:c.bytes,query:c.query,media});report.checks.push({name:c.name,locator:c.locator,query:c.query,expected:c.expected,result,passed:result.matches===c.expected});}
   catch(error){report.checks.push({name:c.name,locator:c.locator,query:c.query,expected:c.expected,error:error.message,passed:false});}
   await writeFile(join(out,'report.json'),JSON.stringify({...report,calls},null,2),{mode:0o600});
 }
 report.finished=true;
}catch(error){report.errors.push(error.message);process.exitCode=1;}
finally{hook.deregister();await writeFile(join(out,'report.json'),JSON.stringify({...report,calls},null,2),{mode:0o600});}
console.log(JSON.stringify({...report,calls}));if(report.checks.some(c=>!c.passed))process.exitCode=1;
