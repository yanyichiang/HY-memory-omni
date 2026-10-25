// One fixed first-answer format-sensitive case; current production prompts only.
import {readFileSync} from 'node:fs';
import {writeFile,mkdir,appendFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {resolve,join} from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {readConfig} from '../scripts/config.mjs';
if(!process.env.HY_LIVE_OUTPUT)throw Error('HY_LIVE_OUTPUT must name a new private directory. Live models will be called.');
const out=resolve(process.env.HY_LIVE_OUTPUT);await mkdir(out,{mode:0o700});
const config=await readConfig(),report={finished:false,scope:'Production DOCX perception/grounding of direct formatting. No renderer, model formation, embedding, service ingestion or style-cascade quality claim.',checks:[]};
const hook=registerHooks({load(url,ctx,next){if(!url.endsWith('.wasm'))return next(url,ctx);const data=readFileSync(new URL(url)).toString('base64');return{format:'module',source:`export default new WebAssembly.Module(Buffer.from('${data}','base64'));`,shortCircuit:true};}});
let calls=0;
try {
  const {CloudflareMemoryModels}=await import('../memory/dist/models.js');
  const {prepareDocument,DOCUMENT_UNIT_MIME}=await import('../memory/dist/document-media.js');
  const ns='http://schemas.openxmlformats.org/',w=ns+'wordprocessingml/2006/main',r=ns+'officeDocument/2006/relationships';
  const source=zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml':`<Types xmlns="${ns}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels':`<Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="root" Target="word/document.xml" Type="${r}/officeDocument"/></Relationships>`,
    'word/document.xml':`<w:document xmlns:w="${w}"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:strike/></w:rPr><w:t>M42 proposal: Friday.</w:t><w:br/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>M42 displayed schedule: Saturday.</w:t><w:br/></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>Private draft location: Room Z.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`,
  }).map(([name,value])=>[name,strToU8(value)])));
  await writeFile(join(out,'format-sensitive.docx'),source,{mode:0o600});
  const prepared=await prepareDocument('application/vnd.openxmlformats-officedocument.wordprocessingml.document',source);
  if(prepared.units.length!==1)throw Error('Expected one native unit.');
  const bytes=prepared.units[0].bytes;
  await writeFile(join(out,'unit.json'),bytes,{mode:0o600});
  const models=new CloudflareMemoryModels({accountId:config.CF_ACCOUNT_ID,gatewayId:config.MEMORY_GATEWAY_ID,token:config.MEMORY_MODEL_TOKEN,temporalModel:config.MEMORY_TEMPORAL_MODEL,formationModel:config.MEMORY_FORMATION_MODEL,textEmbeddingModel:config.MEMORY_TEXT_EMBEDDING_MODEL,mediaEmbeddingModel:config.MEMORY_MEDIA_EMBEDDING_MODEL},{fetch(){throw Error('Engine forbidden in focused layout grounding.');}},async(url,init)=>{
    if(url.includes(':embedContent'))throw Error('Embedding forbidden.');
    const id=++calls,response=await fetch(url,init),raw=await response.clone().text();
    let result;try{result=JSON.parse(raw)}catch{result={raw}}
    await appendFile(join(out,'first-responses.jsonl'),JSON.stringify({id,status:response.status,request:JSON.parse(init.body),response:result})+'\n',{mode:0o600});return response;
  });
  report.observation=await models.perceive(DOCUMENT_UNIT_MIME,bytes);
  const cases=[
    {name:'visible-Saturday-schedule',query:'Does the ordinary visible, unstruck text state that the displayed M42 schedule is Saturday?',expected:true},
    {name:'Friday-not-visible-current-schedule',query:'Does the ordinary visible, unstruck text state that the current M42 schedule is Friday?',expected:false},
    {name:'hidden-draft-not-visible-room',query:'Does the ordinary visible text state that the location is Room Z?',expected:false},
    {name:'struck-proposal-remains-inspectable',query:'Is there strikethrough text recording a proposal for M42 on Friday, without asserting it is the current schedule or an authorized cancellation?',expected:true},
  ];
  for(const c of cases) {
    try {const result=await models.matchDocument({bytes,query:c.query});report.checks.push({...c,result,passed:result.matches===c.expected});}
    catch(error){report.checks.push({...c,error:error.message,passed:false});}
    await writeFile(join(out,'report.json'),JSON.stringify({...report,calls},null,2),{mode:0o600});
  }
  report.finished=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{hook.deregister();await writeFile(join(out,'report.json'),JSON.stringify({...report,calls},null,2),{mode:0o600});}
console.log(JSON.stringify({...report,calls}));if(report.checks.some(c=>!c.passed))process.exitCode=1;
