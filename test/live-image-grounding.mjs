// Targeted real-provider regression for the observed animation boundary error.
// Uses the production model adapter and native image conversion; no alternate prompt or retry.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, join } from 'node:path';
import { readConfig } from '../scripts/config.mjs';
if(!process.env.HY_LIVE_OUTPUT) throw Error('HY_LIVE_OUTPUT must be a new private directory. Live models will be called.');
const out=resolve(process.env.HY_LIVE_OUTPUT); await mkdir(out,{mode:0o700});
const config=await readConfig();
const hook=registerHooks({load(url,ctx,next){if(!url.endsWith('.wasm'))return next(url,ctx);const data=readFileSync(new URL(url)).toString('base64');return {format:'module',source:`export default new WebAssembly.Module(Buffer.from('${data}','base64'));`,shortCircuit:true};}});
let calls=0;
const report={finished:false,checks:[],error:undefined};
const redact=(v,k='')=>typeof v==='string'&&['data','url'].includes(k)&&v.length>512?`<${v.length} chars>`:Array.isArray(v)?v.map(x=>redact(x)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,redact(x,k)])):v;
try{
 const {CloudflareMemoryModels}=await import('../memory/dist/models.js');
 const {nativeImage}=await import('../memory/dist/native-image.js');
 const source=new Uint8Array(await readFile(new URL('./live-fixtures/revision.gif',import.meta.url)));
 const native=await nativeImage('image/gif',source);
 const models=new CloudflareMemoryModels({accountId:config.CF_ACCOUNT_ID,gatewayId:config.MEMORY_GATEWAY_ID,token:config.MEMORY_MODEL_TOKEN,temporalModel:config.MEMORY_TEMPORAL_MODEL,formationModel:config.MEMORY_FORMATION_MODEL,textEmbeddingModel:config.MEMORY_TEXT_EMBEDDING_MODEL,mediaEmbeddingModel:config.MEMORY_MEDIA_EMBEDDING_MODEL},{fetch(){throw Error('Engine not used by targeted native grounding.');}},async(url,init)=>{
   const id=++calls,response=await fetch(url,init),body=await response.clone().json();
   await appendFile(join(out,'first-responses.jsonl'),JSON.stringify({id,status:response.status,request:redact(JSON.parse(init.body)),response:body})+'\n',{mode:0o600});return response;
 });
 const result=await models.locate({mimeType:'image/gif',bytes:source,timeline:native.timeline,media:{mimeType:'image/gif',bytes:source.slice()},query:'Locate the M-17 RESCHEDULE NOTICE stating the previous and new dates and the effective time. Return only the displayed reschedule notice, not the plain meeting announcement.'});
 report.result=result;
 report.checks.push({name:'reschedule notice grounds exact second source frame',passed:result.intervals.length===1&&result.intervals[0].startMs===3000&&result.intervals[0].endMs===6000&&result.intervals[0].basis==='source-frame'&&result.intervals[0].frames.startIndex===1&&result.intervals[0].frames.endIndex===1});
 report.finished=true;
}catch(e){report.error=e.message;process.exitCode=1;}finally{hook.deregister();await writeFile(join(out,'report.json'),JSON.stringify({...report,calls},null,2),{mode:0o600});}
console.log(JSON.stringify({...report,calls}));if(report.checks.some(c=>!c.passed))process.exitCode=1;
