/** Explicit opt-in only. Ten live edits on manual fixtures, NOT live-generated worlds. */
import {mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve,relative,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {upstreamBranch,upstreamConfigFromEnv} from '@/server/upstream';
import {a4Specs,a4Fixture,runA4Intervention} from './a4-fixtures';
import {frozenFiles,qualityRoot} from './corpus';

it('records exactly the frozen ten A4 cases through single-call planning and production commit/replay',async()=>{
  if(!process.env.P20_A4_LIVE_RUN_DIR)throw new Error('P20_A4_LIVE_RUN_DIR must explicitly name a NEW run directory');
  const root=resolve(process.env.P20_A4_LIVE_RUN_DIR),specs=a4Specs();expect(specs).toHaveLength(10);
  const limits={cases:10,calls:10,callsPerCase:1,timeoutMs:240_000,maxOutputTokens:8_000,runnerTimeoutMs:2_700_000};
  const config=upstreamConfigFromEnv({...process.env,WORLDSMITH_MODEL_ENDPOINT:'codex-cli',WORLDSMITH_MODEL:'gpt-6-astra',WORLDSMITH_MODEL_EFFORT:'medium',WORLDSMITH_MODEL_PROFILE:'subscription',
    WORLDSMITH_MODEL_KEY:'unused-cli-transport',WORLDSMITH_CALL_CAP:'10',WORLDSMITH_UPSTREAM_TIMEOUT_MS:'240000',WORLDSMITH_MAX_OUTPUT_TOKENS:'8000',WORLDSMITH_USD_PER_MTOK_IN:'1',WORLDSMITH_USD_PER_MTOK_OUT:'1'});
  if(!config)throw new Error('Existing authorized CLI transport unavailable');
  mkdirSync(root);for(const name of ['raw','fixtures','outcomes'])mkdirSync(join(root,name));
  const write=(file:string,value:unknown)=>{const path=join(root,file);writeFileSync(`${path}.tmp`,JSON.stringify(value,null,2));renameSync(`${path}.tmp`,path);};
  const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const code:Record<string,{sha256:string;archivePath:string}>={};
  const snapshot=(path:string)=>{for(const entry of readdirSync(path,{withFileTypes:true})){
    const file=join(path,entry.name);if(entry.isDirectory())snapshot(file);
    else if(entry.isFile()&&/\.(ts|tsx|json|mjs)$/.test(entry.name)){
      const bytes=readFileSync(file),name=relative(process.cwd(),file).replaceAll('\\','/'),archivePath=`source/${name}.txt`;
      code[name]={sha256:hash(bytes),archivePath};mkdirSync(dirname(join(root,archivePath)),{recursive:true});writeFileSync(join(root,archivePath),bytes,{flag:'wx'});
    }
  }};
  for(const directory of ['src/model','src/ir','src/sim','src/verify','src/worldstream','src/patch','src/server','src/assets','src/scene','src/geom','src/shape','src/app/api/edit','evals/worldstream/world-quality'])snapshot(directory);
  const museum='evals/reality-compiler/museum.sim.json';
  const dataset:Record<string,string>={};mkdirSync(join(root,'corpus'));
  for(const file of [...frozenFiles,'MANIFEST.lock']){const bytes=readFileSync(join(qualityRoot,file));dataset[file]=hash(bytes);writeFileSync(join(root,'corpus',file),bytes,{flag:'wx'});}
  const environment={version:'p20-a4-live-v2',fixtureVersion:'a4-fixtures-v2-lever-target',behaviorContract:'one-existing-rule-condition-or-action',startedAt:new Date().toISOString(),model:'gpt-6-astra',effort:'medium',speed:'standard',transport:'existing codex-cli',limits,
    provenance:'Live model interventions over explicit certified manual museum-derived fixtures; not ten live-generated worlds, not browser/HTTP/host validation.',
    fixtureCertification:'Explicit visible fixtureFinish control at tick500; never part of comparison inputs or oracle. Certification does not establish that the requested intervention was correct.',
    accounting:'Nominal subscription accounting units, not USD price.',cacheState:'unknown',commit:execFileSync('git',['--no-replace-objects','rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    dirtyDiffHash:hash(execFileSync('git',['--no-replace-objects','diff','HEAD'],{maxBuffer:64*1024**2})),code,dataset,
    forkEvidence:'Compared state-slot hash, values, entities, tick and run state through production rebranch; queue/RNG internals are not exposed by RuntimeSnapshot and are not independently asserted by this harness.',
    museumSha256:hash(readFileSync(museum)),packageLockSha256:hash(readFileSync('package-lock.json'))};
  write('environment.json',environment);write('expected-cases.json',specs);
  writeFileSync(join(root,'museum.sim.json'),readFileSync(museum),{flag:'wx'});
  for(const [file,evidence]of Object.entries(code))if(hash(readFileSync(file))!==evidence.sha256)throw new Error(`Source changed during snapshot: ${file}`);
  type Row={id:string;status:string;calls:number;modelMs:number|null;totalMs:number|null;result:unknown};
  const rows:Row[]=specs.map(spec=>({id:spec.id,status:'pending',calls:0,modelMs:null,totalMs:null,result:null}));
  let calls=0;
  const checkpoint=()=>{write('results.json',rows);write('summary.json',{version:environment.version,denominator:10,calls,
    passed:rows.filter(r=>r.status==='passed').length,rejected:rows.filter(r=>r.status==='rejected').length,failed:rows.filter(r=>r.status==='failed').length,
    pending:rows.filter(r=>r.status==='pending').length,running:rows.filter(r=>r.status==='running').length,notRun:rows.filter(r=>r.status==='not-run').length,updatedAt:new Date().toISOString(),provenance:environment.provenance});};
  checkpoint();const branch=upstreamBranch(config);
  for(const [index,spec]of specs.entries()){
    const row=rows[index],started=performance.now();row.status='running';checkpoint();let transportFailure:string|null=null;
    try{
      const fixture=a4Fixture(spec);
      const {oracle:_testOnlyOracle,...archivedFixture}=fixture;write(`fixtures/${spec.id}.json`,archivedFixture);
      row.result=await runA4Intervention(fixture,async request=>{
        if(row.calls!==0||calls>=10)throw new Error('A4 call budget exhausted; retries are forbidden');
        row.calls++;calls++;const modelStarted=performance.now();
        const pending={caseId:spec.id,selectedStableId:fixture.targetId,frozenChangePrompt:spec.changePrompt,startedAt:new Date().toISOString(),status:'pending',request};
        write(`raw/${spec.id}.json`,pending);checkpoint();
        let saved=false;
        try{
          const response=await branch.generate({prompt:request.user,request});row.modelMs=performance.now()-modelStarted;
          write(`raw/${spec.id}.json`,{...pending,status:response.ok?'answered':'failed',ms:row.modelMs,response});saved=true;
          if(!response.ok){if(response.reason!=='MALFORMED_RESPONSE')transportFailure=`${response.reason}: ${response.detail}`;throw new Error(`${response.reason}: ${response.detail}`);}
          return response.body;
        }catch(error){row.modelMs=performance.now()-modelStarted;if(!saved){transportFailure=String(error);write(`raw/${spec.id}.json`,{...pending,status:'threw',ms:row.modelMs,error:String(error)});}throw error;}
      });
      row.status=(row.result as {status:string}).status;write(`outcomes/${spec.id}.json`,row.result);
    }catch(error){row.status='failed';row.result={stage:'harness',error:String(error)};write(`outcomes/${spec.id}.json`,row.result);}
    row.totalMs=performance.now()-started;checkpoint();
    if(transportFailure){for(const remaining of rows.slice(index+1)){remaining.status='not-run';remaining.result={stage:'transport-stop',reason:transportFailure};}checkpoint();break;}
  }
  write('completion.json',{completedAt:new Date().toISOString(),denominator:10,calls,allCasesAttempted:rows.every(r=>r.calls===1),passCount:rows.filter(r=>r.status==='passed').length});
  // Measurement completion does not assert a pass-rate threshold or erase failures.
  expect(calls).toBeLessThanOrEqual(10);
},2_700_000);
