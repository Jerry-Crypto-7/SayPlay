/** Offline fixed-DUMMY protocol only. The trusted caller owns the sandbox launch;
 * these frames do not attest that an arbitrary executable actually is isolated.
 * No production Command integration, credentials, or model calls. */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

const integer = z.number().int().safe();
const pid = integer.min(2);
const state = z.object({ pid, state: z.string().regex(/^[A-Za-z]$/), ppid: integer.min(0),
  pgid: integer.min(1), startTicks: integer.nonnegative(),
  effectiveCapabilities: z.literal('0000000000000000'), noNewPrivs: z.literal('1') }).strict();
const states = z.array(state).max(1024);
const terminalSchema = z.object({ version: z.literal(1), type: z.literal('supervisor_terminal'),
  reason: z.enum(['completed', 'cancelled', 'input_eof', 'lease_expired', 'start_deadline',
    'job_deadline', 'supervisor_error', 'stdout_backpressure']), initialProcesses: states,
  cleanup: z.object({ verified: z.boolean(), owner: z.literal('supervisor_pid_namespace_init'),
    before: states, observedStates: z.array(state.extend({phase: z.enum(['job_ready', 'cleanup'])})).max(2048),
    after: states, observedPidsESRCH: z.record(z.string().regex(/^[1-9][0-9]*$/), z.boolean()),
    allObservedPidsESRCH: z.boolean(),
    reapedChildren: z.array(z.object({pid, waitStatus: integer}).strict()).max(1024),
    signals: z.array(z.union([z.object({pid, signal:z.enum(['SIGTERM','SIGKILL'])}).strict(),
      z.object({pgid:pid, signal:z.enum(['SIGTERM','SIGKILL'])}).strict()])).max(2048),
    directChildReturnCode: integer.nullable() }).strict(),
  inference: z.literal(false), credentialsAccessed: z.literal(false), externalHarnessCleanup: z.literal(false),
  delivery: z.object({backpressure:z.boolean(), stdoutClosed:z.boolean(), queuedBytes:integer.nonnegative().max(65536)}).strict().optional(),
  childInput: z.object({totalBytes:integer.nonnegative().max(32768), writtenBytes:integer.nonnegative().max(32768),
    pendingBytes:integer.nonnegative().max(32768), closed:z.boolean(), pipeCapacityBytes:integer.positive()}).strict().optional(),
}).strict().superRefine((frame, ctx) => {
  const c = frame.cleanup;
  const ids = new Set([...frame.initialProcesses, ...c.before, ...c.observedStates].map(p => String(p.pid)));
  if (c.verified && (c.after.length || !c.allObservedPidsESRCH ||
      Object.values(c.observedPidsESRCH).some(v => !v) || [...ids].some(id => c.observedPidsESRCH[id] !== true)))
    ctx.addIssue({code:'custom', message:'Inconsistent cleanup acknowledgement'});
  const input = frame.childInput;
  if (input && (input.writtenBytes + input.pendingBytes !== input.totalBytes || !input.closed))
    ctx.addIssue({code:'custom', message:'Inconsistent child input acknowledgement'});
});
const frameSchema = z.union([
  z.object({version:z.literal(1), type:z.literal('supervisor_ready'), supervisorPid:z.literal(1),
    leaseMs:integer.min(100).max(30000), sandbox:z.object({usrReadOnly:z.literal(true),
      hostHomeMounted:z.literal(false), hostMntMounted:z.literal(false),
      networkInterfaces:z.tuple([z.literal('lo')]), exclusivePidNamespace:z.literal(true)}).strict()}).strict(),
  z.object({version:z.literal(1), type:z.literal('job_ready'), processes:states}).strict(),
  z.object({version:z.literal(1), type:z.literal('child_output'), stream:z.enum(['stdout','stderr']), text:z.string()}).strict(),
  z.object({version:z.literal(1), type:z.literal('supervisor_error'), code:z.string().min(1).max(128)}).strict(),
  terminalSchema,
]);
export type SupervisedDummyTerminal = z.infer<typeof terminalSchema>;
export type FixedDummyMode = 'normal'|'sleep'|'ignore_term'|'setsid'|'zombie'|'backpressure'|'stdin_backpressure'|'stdin_setup_failure';
export interface DummyLaunchProfile { executable:string; args:readonly string[]; cwd?:string; env?:NodeJS.ProcessEnv }
export interface SupervisedDummyOptions {
  launch:DummyLaunchProfile;
  startupMs?:number; runtimeMs?:number; acknowledgementMs?:number; closeMs?:number;
  maxOutputBytes?:number; maxFrameBytes?:number;
  abortControl?:'cancel'|'eof';
}
export interface SupervisedDummyResult {
  outcome:'completed'|'cancelled'|'failed'|'not-started';
  childStdout:string; childStderr:string; wrapperStderr:string;
  terminal:SupervisedDummyTerminal|null;
  remoteCleanup:'verified'|'unverified'|'unknown'|'not-started';
  localClose:{code:number|null;signal:string|null}|null;
  error:string|null; fixedDummy:true; modelCalls:0;
}
const bounded = (n:number|undefined, fallback:number, max:number) => {
  const v = n ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new Error('Invalid bounded transport option');
  return v;
};

export async function runSupervisedDummy(input:{mode:FixedDummyMode;payload:string;signal?:AbortSignal},
  options:SupervisedDummyOptions):Promise<SupervisedDummyResult> {
  const result:SupervisedDummyResult = {outcome:'failed',childStdout:'',childStderr:'',wrapperStderr:'',
    terminal:null,remoteCleanup:'unknown',localClose:null,error:null,fixedDummy:true,modelCalls:0};
  if (input.signal?.aborted) return {...result,outcome:'not-started',remoteCleanup:'not-started'};
  const start = JSON.stringify({version:1,op:'start',mode:input.mode,payload:input.payload})+'\n';
  if (!['normal','sleep','ignore_term','setsid','zombie','backpressure','stdin_backpressure','stdin_setup_failure'].includes(input.mode) ||
      typeof input.payload !== 'string' || Buffer.byteLength(start)>32768) throw new Error('Invalid fixed-DUMMY input');
  const startup = bounded(options.startupMs,90000,120000), runtime = bounded(options.runtimeMs,15000,30000);
  const ack = bounded(options.acknowledgementMs,6000,10000), close = bounded(options.closeMs,2000,10000);
  const outputCap = bounded(options.maxOutputBytes,1048576,4194304), frameCap = bounded(options.maxFrameBytes,65536,131072);
  return new Promise(resolve => {
    const child = spawn(options.launch.executable,[...options.launch.args],{cwd:options.launch.cwd,
      env:options.launch.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let settled=false, ready=false, started=false, jobReady=false, stopping=false, invalid=false, bytes=0;
    let pending='', wireBytes=0;
    const decoder = new StringDecoder('utf8');
    let deadline:ReturnType<typeof setTimeout>;
    let heartbeat:ReturnType<typeof setInterval>|undefined;
    const arm = (ms:number, fn:()=>void) => {clearTimeout(deadline); deadline=setTimeout(fn,ms);};
    const finish = () => {
      if(settled) return; settled=true; clearTimeout(deadline); clearInterval(heartbeat);
      input.signal?.removeEventListener('abort',abort);
      if(result.terminal && !invalid) result.remoteCleanup=result.terminal.cleanup.verified?'verified':'unverified';
      if(result.remoteCleanup==='verified' && result.localClose?.code===0 && !result.error) {
        if(result.terminal?.reason==='completed' && result.terminal.cleanup.directChildReturnCode===0) result.outcome='completed';
        else if(input.signal?.aborted && ['cancelled','input_eof'].includes(result.terminal!.reason)) result.outcome='cancelled';
      }
      resolve(result);
    };
    const kill = () => {
      child.kill('SIGKILL');
      arm(close,()=>{ result.error ??='local_close_timeout'; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(); });
    };
    const send = (frame:string) => {if(!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(frame);};
    const stop = () => {
      if(stopping || result.terminal) return; stopping=true; clearInterval(heartbeat);
      if(options.abortControl==='eof') child.stdin.end();
      else send('{"version":1,"op":"cancel"}\n');
      arm(ack,()=>{result.error ??='missing_terminal'; kill();});
    };
    function abort() { if(ready) stop(); }
    const fail = (code:string) => {invalid=true; result.error ??=code; stop();};
    input.signal?.addEventListener('abort',abort,{once:true});
    child.stdin.on('error',()=>{ result.error ??='control_pipe_error'; });
    child.on('error',()=>{result.error ??='spawn_or_process_error';});
    child.stderr.on('data',(chunk:Buffer)=>{
      const remaining=Math.max(0,outputCap-bytes); result.wrapperStderr+=chunk.subarray(0,remaining).toString('utf8');
      bytes+=chunk.length; if(bytes>outputCap) fail('output_limit');
    });
    child.stdout.on('data',(chunk:Buffer)=>{
      // Always drain, including after rejection; never queue unbounded rejected bytes.
      if(invalid || settled) return;
      wireBytes+=chunk.length;
      if(wireBytes>outputCap*8+frameCap) {fail('wire_limit');return;}
      pending+=decoder.write(chunk);
      let newline:number;
      while((newline=pending.indexOf('\n'))>=0) {
        const line=pending.slice(0,newline); pending=pending.slice(newline+1);
        if(Buffer.byteLength(line)>frameCap){fail('frame_limit');return;}
        let parsed:ReturnType<typeof frameSchema.safeParse>;
        try{parsed=frameSchema.safeParse(JSON.parse(line));}catch{fail('invalid_frame');return;}
        if(!parsed.success || result.terminal){fail('invalid_or_duplicate_frame');return;}
        const frame=parsed.data;
        if(frame.type==='supervisor_ready') {
          if(ready){fail('duplicate_ready');return;} ready=true;
          if(input.signal?.aborted){stop();continue;}
          started=true; send(start);
          heartbeat=setInterval(()=>{if(!child.stdin.writableNeedDrain)send('{"version":1,"op":"keepalive"}\n');},Math.max(10,Math.floor(frame.leaseMs/3)));
          arm(runtime,()=>{result.error='runtime_timeout';stop();});
        } else if(!ready) {fail('frame_before_ready');return;}
        else if(frame.type==='job_ready') {
          if(!started || jobReady){fail('unexpected_job_ready');return;}jobReady=true;
        } else if(frame.type==='child_output') {
          if(!started){fail('output_before_start');return;}
          bytes+=Buffer.byteLength(frame.text);if(bytes>outputCap){fail('output_limit');return;}
          if(frame.stream==='stdout')result.childStdout+=frame.text;else result.childStderr+=frame.text;
        } else if(frame.type==='supervisor_error') {result.error ??='supervisor_error';}
        else {
          result.terminal=frame; clearInterval(heartbeat); child.stdin.end();
          arm(close,()=>{result.error ??='local_close_timeout';kill();});
        }
      }
      if(Buffer.byteLength(pending)>frameCap)fail('frame_limit');
    });
    child.on('close',(code,signal)=>{
      result.localClose={code,signal};
      if(pending.length || decoder.end()) {invalid=true;result.error ??='truncated_frame';}
      if(!result.terminal)result.error ??='missing_terminal';
      finish();
    });
    arm(startup,()=>{result.error='startup_timeout';kill();});
  });
}
