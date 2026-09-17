/** Offline replay of a completed, immutable T18 series. No upstream transport. */
import {readFileSync,readdirSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,join,relative,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {readPlannerEmission} from '@/model/worldstream-intent';
import {compileBlueprint} from '@/model/worldstream-compiler';
import {WORLDSTREAM_ASSETS} from '@/assets/catalog';
import type {UpstreamRequest} from '@/model/prompt';

it('replays every archived T18 candidate with the current compiler without new model calls',()=>{
  if(!process.env.P20_T18_RUN_DIR||!process.env.P20_REPLAY_DIR)throw new Error('Explicit P20_T18_RUN_DIR and NEW P20_REPLAY_DIR required');
  const origin=resolve(process.env.P20_T18_RUN_DIR),output=resolve(process.env.P20_REPLAY_DIR);
  if(output===origin||output.startsWith(origin+sep)||origin.startsWith(output+sep))throw new Error('Replay and historical run directories must be separate');
  const read=(name:string)=>JSON.parse(readFileSync(join(origin,name),'utf8'));
  const completion=read('completion.json');
  if(completion.complete!==true)throw new Error('Historical run must be complete before replay');
  const cases=read('expected-cases.json') as {id:string;prompt:string}[];
  const historical=read('results.json') as {id:string;status:string;failure:unknown;rounds:{attempt:number;fault:unknown}[]}[];
  expect(cases).toHaveLength(30);expect(historical).toHaveLength(30);
  if(historical.some(r=>r.status==='pending'||r.status==='running'))throw new Error('Historical rows are not complete');
  const sourceEnvironment=read('environment.json');
  if(!Number.isSafeInteger(sourceEnvironment.seed))throw new Error('Missing original session seed');
  mkdirSync(output);mkdirSync(join(output,'inputs'));mkdirSync(join(output,'cases'));
  const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const write=(name:string,value:unknown)=>{const path=join(output,name);writeFileSync(path+'.tmp',JSON.stringify(value,null,2));renameSync(path+'.tmp',path);};
  const inputHashes:Record<string,string>={};
  const archiveInput=(name:string)=>{const bytes=readFileSync(join(origin,name));inputHashes[name]=hash(bytes);const destination=join(output,'inputs',name);mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,bytes,{flag:'wx'});return JSON.parse(bytes.toString('utf8'));};
  for(const name of ['completion.json','expected-cases.json','results.json','environment.json'])archiveInput(name);
  const source:Record<string,{sha256:string;archivePath:string}>={};
  const snapshot=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);if(entry.isDirectory())snapshot(path);
    else if(entry.isFile()&&/\.(ts|tsx|json|mjs|glsl)$/.test(entry.name)){
      const bytes=readFileSync(path),name=relative(process.cwd(),path).replaceAll('\\','/'),archivePath=`source/${name}.txt`;
      source[name]={sha256:hash(bytes),archivePath};mkdirSync(dirname(join(output,archivePath)),{recursive:true});writeFileSync(join(output,archivePath),bytes,{flag:'wx'});
    }
  }};
  for(const directory of ['model','ir','sim','verify','scene','geom','shape','worldstream','assets','server'])snapshot(join('src',directory));
  snapshot('evals/worldstream/world-quality');
  for(const [path,evidence]of Object.entries(source))if(hash(readFileSync(path))!==evidence.sha256)throw new Error(`Source changed during archive: ${path}`);
  const environment={version:'p20-t18-current-replay-v1',createdAt:new Date().toISOString(),origin,seed:sourceEnvironment.seed,modelCalls:0,
    provenance:'Offline replay of unchanged archived model emissions; not new generation, not holdout tuning, not a visual or human evaluation.',
    interpretation:'Current compiler aggregate may include multiple post-freeze changes. Improvements cannot all be attributed to solver changes without inspecting each before/after failure.',
    commit:execFileSync('git',['--no-replace-objects','rev-parse','HEAD'],{encoding:'utf8'}).trim(),source,inputHashes};
  write('environment.json',environment);
  const rows:unknown[]=[];
  const rawNames=readdirSync(join(origin,'raw'));
  for(const entry of cases){
    const before=historical.find(row=>row.id===entry.id);if(!before)throw new Error(`Missing historical row ${entry.id}`);
    const at=performance.now();
    const callNames=rawNames.filter(name=>new RegExp(`^${entry.id}-[1-3]\\.json$`).test(name)).sort();
    type Call={caseCall:number;stage:string;request:UpstreamRequest;result?:{ok:boolean;body?:unknown};status:string};
    const calls=callNames.map(name=>({name,call:archiveInput(`raw/${name}`) as Call}));
    const planner=calls.find(({call})=>call.caseCall===1);
    const plannerBefore=rawNames.includes(`${entry.id}-planner.json`)?archiveInput(`raw/${entry.id}-planner.json`):null;
    const plannerAfter=planner?.call.result?.ok?readPlannerEmission(planner.call.result.body,{prompt:entry.prompt,requireSceneSpec:true}):null;
    const candidates=[];
    for(const {name,call}of calls.filter(({call})=>call.caseCall>1)){
      const candidateAt=performance.now();
      const previous=before.rounds.find(round=>round.attempt===call.caseCall-1);
      let current:unknown=null,status='not-replayed';
      if(!call.result?.ok){status='transport-failure';current=call;}
      else if(!plannerAfter?.ok){status='planner-rejected';current=plannerAfter;}
      else{
        try{const result=compileBlueprint(structuredClone(call.result.body),plannerAfter.value,{sessionSeed:sourceEnvironment.seed,upstream:call.request,assets:WORLDSTREAM_ASSETS});current=result;status=result.ok?'compiled':'rejected';}
        catch(error){status='exception';current={error:String(error)};}
      }
      candidates.push({archive:name,inputSha256:inputHashes[`raw/${name}`],attempt:call.caseCall-1,
        before:previous?{status:previous.fault===null?'compiled':'rejected',fault:previous.fault}:{status:'transport-or-no-verdict'},
        after:{status,result:current},ms:performance.now()-candidateAt});
    }
    const after=candidates.some(c=>c.after.status==='compiled')?'compiled':plannerAfter&&!plannerAfter.ok?'planner-rejected':candidates.length?'no-accepted-candidate':'no-compiler-answer';
    const row={id:entry.id,before,after,planner:{before:plannerBefore,after:plannerAfter},candidates,totalMs:performance.now()-at};
    rows.push(row);write(`cases/${entry.id}.json`,row);write('results.json',rows);write('environment.json',environment);
    process.stdout.write(`${entry.id}: ${before.status} -> ${after}; candidates=${candidates.length}\n`);
  }
  for(const [name,digest]of Object.entries(inputHashes))if(hash(readFileSync(join(origin,name)))!==digest)throw new Error(`Historical input changed during replay: ${name}`);
  const records=rows as {before:{status:string};after:string}[];
  write('summary.json',{denominator:30,modelCalls:0,beforeCompiled:records.filter(r=>r.before.status==='compiled').length,
    afterCompiled:records.filter(r=>r.after==='compiled').length,gained:records.filter(r=>r.before.status!=='compiled'&&r.after==='compiled').length,
    lost:records.filter(r=>r.before.status==='compiled'&&r.after!=='compiled').length,provenance:environment.provenance});
  write('completion.json',{complete:true,finishedAt:new Date().toISOString(),rows:rows.length,historicalInputsUnchanged:true});expect(rows).toHaveLength(30);
},30*60_000);
