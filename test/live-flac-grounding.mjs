// One current-production regression for the retained FLAC false negative.
// Same source, media query and text query; no ingestion, embedding or retries.
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve,join} from 'node:path';
import {readConfig} from '../scripts/config.mjs';
if(!process.env.HY_LIVE_OUTPUT)throw Error('HY_LIVE_OUTPUT must name a new private directory. Live models will be called.');
const out=resolve(process.env.HY_LIVE_OUTPUT);await mkdir(out,{mode:0o700});
const config=await readConfig(),report={finished:false,scope:'Current production audio grounding for the original retained FLAC query; not a repeat of full ingestion/search.',checks:[]};
const hook=registerHooks({load(url,ctx,next){if(!url.endsWith('.wasm'))return next(url,ctx);const data=readFileSync(new URL(url)).toString('base64');return {format:'module',source:`export default new WebAssembly.Module(Buffer.from('${data}','base64'));`,shortCircuit:true};}});
let calls=0;
try{
  const {CloudflareMemoryModels}=await import('../memory/dist/models.js');
  const {inspectMedia}=await import('../memory/dist/media.js');
  const source=new Uint8Array(await readFile(new URL('./live-fixtures/proposal.m4a',import.meta.url)));
  const query=new Uint8Array(await readFile(new URL('./live-fixtures/proposal.flac',import.meta.url)));
  const timeline=await inspectMedia('audio/mp4',source);
  const models=new CloudflareMemoryModels({accountId:config.CF_ACCOUNT_ID,gatewayId:config.MEMORY_GATEWAY_ID,token:config.MEMORY_MODEL_TOKEN,
    temporalModel:config.MEMORY_TEMPORAL_MODEL,formationModel:config.MEMORY_FORMATION_MODEL,textEmbeddingModel:config.MEMORY_TEXT_EMBEDDING_MODEL,mediaEmbeddingModel:config.MEMORY_MEDIA_EMBEDDING_MODEL},
    {fetch(){throw Error('Engine forbidden in focused FLAC grounding.');}},async(url,init)=>{
      const id=++calls,response=await fetch(url,init),body=await response.clone().text();
      await appendFile(join(out,'first-responses.jsonl'),JSON.stringify({id,status:response.status,request:JSON.parse(init.body),response:JSON.parse(body)})+'\n',{mode:0o600});return response;
    });
  report.result=await models.locate({mimeType:'audio/mp4',bytes:source,timeline,media:{mimeType:'audio/flac',bytes:query},query:'The proposal to hold meeting M42 on Friday'});
  report.checks.push({name:'original FLAC query grounds original M4A proposal',passed:report.result.intervals.length>0&&report.result.intervals.every(i=>i.startMs>=0&&i.endMs<=timeline.durationMs&&i.modalities.includes('audio'))});
  report.finished=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{hook.deregister();await writeFile(join(out,'report.json'),JSON.stringify({...report,calls},null,2),{mode:0o600});}
console.log(JSON.stringify({...report,calls}));if(report.checks.some(c=>!c.passed))process.exitCode=1;
