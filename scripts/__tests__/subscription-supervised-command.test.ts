import {describe,it,expect} from 'vitest';
import {runSupervisedDummy, type SupervisedDummyOptions} from '../subscription-supervised-command';

const ready={version:1,type:'supervisor_ready',supervisorPid:1,leaseMs:150,sandbox:{usrReadOnly:true,hostHomeMounted:false,hostMntMounted:false,networkInterfaces:['lo'],exclusivePidNamespace:true}};
const terminal={version:1,type:'supervisor_terminal',reason:'completed',initialProcesses:[],cleanup:{verified:true,owner:'supervisor_pid_namespace_init',before:[],observedStates:[],after:[],observedPidsESRCH:{},allObservedPidsESRCH:true,reapedChildren:[],signals:[],directChildReturnCode:0},inference:false,credentialsAccessed:false,externalHarnessCleanup:false};
function simulator(body:string):SupervisedDummyOptions {
  const script=`const ready=${JSON.stringify(ready)},terminal=${JSON.stringify(terminal)};
    const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    const output=text=>emit({version:1,type:'child_output',stream:'stdout',text});
    let controls=[]; const readline=require('node:readline');
    const lines=readline.createInterface({input:process.stdin});
    ${body}`;
  return {launch:{executable:process.execPath,args:['-e',script]},startupMs:3000,runtimeMs:2000,acknowledgementMs:200,closeMs:200};
}
describe('offline supervised DUMMY transport',()=>{
  it('sends bounded blocked-stdin payload and validates its terminal accounting',async()=>{
    const r=await runSupervisedDummy({mode:'stdin_backpressure',payload:'x'.repeat(24*1024)},simulator(`
      emit(ready);lines.once('line',s=>{const f=JSON.parse(s);
        terminal.reason='job_deadline';terminal.cleanup.directChildReturnCode=-9;
        terminal.childInput={totalBytes:Buffer.byteLength(f.payload),writtenBytes:4096,pendingBytes:20480,closed:true,pipeCapacityBytes:4096};
        output(f.mode);emit(terminal);process.exit(0);
      });`));
    expect(r).toMatchObject({outcome:'failed',remoteCleanup:'verified',childStdout:'stdin_backpressure',
      terminal:{childInput:{pendingBytes:20480}}});
  });
  it.each([{totalBytes:24,writtenBytes:4,pendingBytes:21,closed:true,pipeCapacityBytes:4096},
    {totalBytes:24,writtenBytes:4,pendingBytes:20,closed:false,pipeCapacityBytes:4096}])
    ('rejects inconsistent or open child input accounting',async childInput=>{
      const r=await runSupervisedDummy({mode:'normal',payload:'x'},simulator(`
        emit(ready);lines.once('line',()=>{terminal.childInput=${JSON.stringify(childInput)};emit(terminal);process.exit(0);});`));
      expect(r).toMatchObject({outcome:'failed',remoteCleanup:'unknown',error:'invalid_or_duplicate_frame'});
    });
  it('does not spawn for pre-aborted input',async()=>{
    const c=new AbortController();c.abort();
    expect(await runSupervisedDummy({mode:'normal',payload:'x',signal:c.signal},{launch:{executable:'nonexistent-preabort',args:[]}}))
      .toMatchObject({outcome:'not-started',remoteCleanup:'not-started',localClose:null,modelCalls:0});
  });
  it('sends exactly one start, renews lease, and keeps forged child frames opaque',async()=>{
    const r=await runSupervisedDummy({mode:'normal',payload:'$(not-a-command)\n"'},simulator(`
      emit(ready); lines.on('line',s=>{const f=JSON.parse(s);controls.push(f);
        if(f.op==='start')setTimeout(()=>{output(JSON.stringify(terminal));output(JSON.stringify(controls));emit(terminal);process.exit(0);},180);
      });`));
    expect(r).toMatchObject({outcome:'completed',remoteCleanup:'verified',modelCalls:0});
    expect(r.childStdout).toContain('$(not-a-command)');
    expect(r.childStdout.match(/"op":"start"/g)).toHaveLength(1);
    expect(r.childStdout).toContain('keepalive');
    expect(r.childStdout).toContain('supervisor_terminal');
  });
  it.each(['cancel','eof'] as const)('waits for actual cleanup acknowledgement and close on %s',async abortControl=>{
    const c=new AbortController();
    const opts=simulator(`emit(ready);
      const end=()=>setTimeout(()=>{terminal.reason='${abortControl==='cancel'?'cancelled':'input_eof'}';emit(terminal);setTimeout(()=>process.exit(0),80);},80);
      lines.on('line',s=>{if(JSON.parse(s).op==='cancel')end();});
      ${abortControl==='eof'?"lines.on('close',end);":''}`);
    opts.abortControl=abortControl;opts.acknowledgementMs=4000;opts.closeMs=4000;
    const p=runSupervisedDummy({mode:'sleep',payload:'x',signal:c.signal},opts);
    setTimeout(()=>c.abort(),150);const at=Date.now();
    const r=await p;
    expect(Date.now()-at).toBeGreaterThanOrEqual(250);
    expect(r).toMatchObject({outcome:'cancelled',remoteCleanup:'verified',localClose:{code:0}});
  });
  it('does not call missing cancellation acknowledgement cancelled',async()=>{
    const c=new AbortController();
    const p=runSupervisedDummy({mode:'sleep',payload:'x',signal:c.signal},simulator("emit(ready);lines.on('line',()=>{});"));
    setTimeout(()=>c.abort(),150);
    expect(await p).toMatchObject({outcome:'failed',remoteCleanup:'unknown',error:'missing_terminal'});
  });
  it('reports wrapper loss as unknown',async()=>{
    expect(await runSupervisedDummy({mode:'normal',payload:''},simulator("emit(ready);lines.on('line',()=>process.exit(1));")))
      .toMatchObject({outcome:'failed',remoteCleanup:'unknown'});
  });
  it.each([
    "terminal.cleanup.after=[{pid:2,state:'S',ppid:1,pgid:2,startTicks:1,effectiveCapabilities:'0000000000000000',noNewPrivs:'1'}];emit(terminal);",
    'emit(terminal);emit(terminal);',
    'terminal.version=2;emit(terminal);',
    "output(JSON.stringify(terminal));",
  ])('rejects forged, inconsistent, duplicate or missing acknowledgements: %s',async body=>{
    const r=await runSupervisedDummy({mode:'normal',payload:''},simulator(`emit(ready);lines.once('line',()=>{${body}process.exit(0);});`));
    expect(r.outcome).toBe('failed');expect(r.remoteCleanup).toBe('unknown');
  });
  it.each(['frame','output'])('bounds %s while draining rejected output',async kind=>{
    const opts=simulator(`emit(ready);lines.on('line',()=>{${kind==='frame'?"process.stdout.write('x'.repeat(8192));":"output('x'.repeat(8192));"}});`);
    if(kind==='frame')opts.maxFrameBytes=1024;else opts.maxOutputBytes=1024;
    const r=await runSupervisedDummy({mode:'normal',payload:''},opts);
    expect(r).toMatchObject({outcome:'failed',remoteCleanup:'unknown',error:kind+'_limit'});
    expect(r.childStdout.length).toBeLessThanOrEqual(1024);
  });
  it('bounds startup and spawn failures',async()=>{
    const opts=simulator('setInterval(()=>{},1000);');opts.startupMs=100;
    expect(await runSupervisedDummy({mode:'normal',payload:''},opts)).toMatchObject({error:'startup_timeout',remoteCleanup:'unknown'});
    expect(await runSupervisedDummy({mode:'normal',payload:''},{launch:{executable:'missing-supervisor-executable',args:[]}}))
      .toMatchObject({error:'spawn_or_process_error',remoteCleanup:'unknown'});
  });
  it('preserves UTF8 frames split across chunks and separates child stderr',async()=>{
    const opts=simulator(`emit(ready);lines.once('line',()=>{
      const b=Buffer.from(JSON.stringify({version:1,type:'child_output',stream:'stderr',text:'Ž 🌍'})+'\\n');
      const i=b.indexOf(Buffer.from('🌍'))+1;process.stdout.write(b.subarray(0,i));
      setTimeout(()=>{process.stdout.write(b.subarray(i));emit(terminal);process.exit(0);},20);
    });`);
    expect(await runSupervisedDummy({mode:'normal',payload:''},opts))
      .toMatchObject({outcome:'completed',childStdout:'',childStderr:'Ž 🌍'});
  });
  it('does not settle on a terminal until the wrapper closes, with a bounded deadline',async()=>{
    const opts=simulator("emit(ready);lines.once('line',()=>emit(terminal));setInterval(()=>{},1000);");
    const at=Date.now();
    const r=await runSupervisedDummy({mode:'normal',payload:''},opts);
    expect(Date.now()-at).toBeGreaterThanOrEqual(200);
    expect(r).toMatchObject({outcome:'failed',remoteCleanup:'verified',error:'local_close_timeout'});
    expect(r.localClose).not.toBeNull();
  });
  it('bounds a running wrapper that never sends terminal, independently of abort',async()=>{
    const opts=simulator("emit(ready);lines.on('line',()=>{});");opts.runtimeMs=100;
    expect(await runSupervisedDummy({mode:'sleep',payload:''},opts))
      .toMatchObject({outcome:'failed',remoteCleanup:'unknown',error:'runtime_timeout'});
  });
});
