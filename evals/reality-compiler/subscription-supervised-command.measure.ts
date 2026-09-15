/** Explicit offline smoke, never included in the ordinary unit suite. */
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {runSupervisedDummy} from '../../scripts/subscription-supervised-command';

it('standalone typed adapter receives genuine DUMMY supervisor acknowledgement',async()=>{
  const directory=resolve('scratch/subscription-wsl-supervisor',randomUUID(),'typed-adapter');
  mkdirSync(directory,{recursive:true});
  const linuxDirectory=directory.replace(/^D:/i,'/mnt/d').replaceAll('\\','/');
  const sourceSha256=Object.fromEntries(['scripts/subscription-supervised-command.ts',
    'scripts/subscription-wsl-supervisor.py','scripts/subscription-wsl-supervisor.sh',
    'evals/reality-compiler/subscription-supervised-command.measure.ts'].map(path=>[path,
      createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const result=await runSupervisedDummy({mode:'normal',payload:'Synthetic only: $(not executed) Ž 🌍'},
    {launch:{executable:'wsl.exe',args:['-d','Ubuntu-24.04','--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin',
      '/usr/bin/unshare','--user','--map-root-user','--mount','--net','--pid','--fork','/bin/sh',
      '/mnt/d/claude/Hackaton/scripts/subscription-wsl-supervisor.sh',linuxDirectory,
      '/mnt/d/claude/Hackaton/scripts/subscription-wsl-supervisor.py']}});
  writeFileSync(resolve(directory,'report.json'),JSON.stringify({sourceSha256,result,
    productionEnvelopeVerified:false},null,2));
  console.log('Typed DUMMY adapter report:',resolve(directory,'report.json'));
  expect(result).toMatchObject({outcome:'completed',remoteCleanup:'verified',modelCalls:0,localClose:{code:0}});
  expect(result.childStdout).toContain('forged');
  expect(result.childStdout).toContain('$(not executed)');
  expect(result.terminal?.cleanup.after).toEqual([]);
},110000);

it.each(['setsid','stdin_backpressure'] as const)('standalone typed adapter cancels a running TERM-ignoring DUMMY: %s',async mode=>{
  const directory=resolve('scratch/subscription-wsl-supervisor',randomUUID(),`typed-adapter-cancel-${mode}`);
  mkdirSync(directory,{recursive:true});
  const linuxDirectory=directory.replace(/^D:/i,'/mnt/d').replaceAll('\\','/');
  const sourceSha256=Object.fromEntries(['scripts/subscription-supervised-command.ts',
    'scripts/subscription-wsl-supervisor.py','scripts/subscription-wsl-supervisor.sh',
    'evals/reality-compiler/subscription-supervised-command.measure.ts'].map(path=>[path,
      createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const controller=new AbortController();
  const startedAt=performance.now();
  let jobReadyAt:number|null=null,abortAt:number|null=null,auditError:string|null=null;
  let jobProcesses:Array<{pid:number;pgid:number}>=[];
  // FD3 is supervisor-owned; child stdout is deliberately never parsed here.
  // Polling controls when to abort, never supplies the adapter's cleanup result.
  const poll=setInterval(()=>{
    try {
      const audit=readFileSync(resolve(directory,'supervisor-audit.jsonl'),'utf8');
      for(const line of audit.split('\n').slice(0,-1)) {
        const frame=JSON.parse(line);
        if(frame.version===1 && frame.type==='job_ready' && jobReadyAt===null) {
          jobReadyAt=performance.now()-startedAt;
          jobProcesses=frame.processes;
          abortAt=performance.now()-startedAt;
          controller.abort();
          clearInterval(poll);
          break;
        }
      }
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT') {
        auditError='audit_read_or_parse_failed';clearInterval(poll);
        // Adapter's own bounded deadlines remain responsible for cleanup.
      }
    }
  },25);
  let result;
  try {
    result=await runSupervisedDummy({mode,payload:mode==='stdin_backpressure'?'x'.repeat(24*1024):'Synthetic cancellation only: $(not executed)',signal:controller.signal},
      {launch:{executable:'wsl.exe',args:['-d','Ubuntu-24.04','--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin',
        '/usr/bin/unshare','--user','--map-root-user','--mount','--net','--pid','--fork','/bin/sh',
        '/mnt/d/claude/Hackaton/scripts/subscription-wsl-supervisor.sh',linuxDirectory,
        '/mnt/d/claude/Hackaton/scripts/subscription-wsl-supervisor.py']}});
  } finally {clearInterval(poll);}
  writeFileSync(resolve(directory,'report.json'),JSON.stringify({sourceSha256,result,mode,jobReadyAt,abortAt,
    jobProcesses,auditError,abortTrigger:'supervisor_audit_fd3_job_ready',productionEnvelopeVerified:false},null,2));
  console.log('Typed DUMMY adapter cancellation report:',resolve(directory,'report.json'));
  expect(auditError).toBeNull();expect(jobReadyAt).not.toBeNull();expect(abortAt).toBeGreaterThanOrEqual(jobReadyAt!);
  expect(jobProcesses.length).toBeGreaterThanOrEqual(2);
  if(mode==='setsid') expect(new Set(jobProcesses.map(p=>p.pgid)).size).toBeGreaterThanOrEqual(2);
  expect(result).toMatchObject({outcome:'cancelled',remoteCleanup:'verified',modelCalls:0,localClose:{code:0},
    terminal:{reason:'cancelled',externalHarnessCleanup:false,inference:false,credentialsAccessed:false,
      cleanup:{verified:true,owner:'supervisor_pid_namespace_init',after:[],allObservedPidsESRCH:true}}});
  for(const process of jobProcesses) expect(result.terminal?.cleanup.observedPidsESRCH[String(process.pid)]).toBe(true);
  expect(result.terminal?.cleanup.signals.some(s=>s.signal==='SIGKILL')).toBe(true);
  if(mode==='setsid') expect(result.childStdout).toContain('"forged": true');
  if(mode==='stdin_backpressure') {
    expect(result.terminal?.childInput).toMatchObject({totalBytes:24*1024,closed:true,pipeCapacityBytes:4096});
    expect(result.terminal?.childInput?.pendingBytes).toBeGreaterThan(0);
    expect(result.terminal?.childInput?.writtenBytes).toBeGreaterThan(0);
  }
},115000);
