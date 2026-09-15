"""Fixed persistent-control composition. No resource enforcement credit here."""
import base64
import hashlib
import json
import math
import os
import re
import selectors
import stat
import sys
import time
import types

NAMES=('exec-server-worker-gate.py','exec-server-worker-trampoline.py','exec-worker-probe.py',
       'trusted-control-boundary-probe.py','worker-lockdown.py','appserver-noenv.py','text-model-catalog.json',
       'trusted-control-boundary-parent.py','candidate-resource-stress-worker.py',
       'candidate-resource-stress-protocol.py','candidate-resource-stress-child.py')
HELPERS={'subscription-'+n:'/usr/bin/'+n for n in NAMES}
CATALOG_SHA256='59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791'
DEPS=('trusted-control-boundary-parent.py','appserver-noenv.py','exec-server-worker-gate.py',
      'trusted-control-boundary-probe.py','candidate-resource-stress-protocol.py')
BLOCKED=False

def encode(v):return json.dumps(v,separators=(',',':'),sort_keys=True,allow_nan=False).encode()
def same(a,b):return encode(a)==encode(b)
def close_selector(selector):
    global BLOCKED
    try:selector.close()
    except Exception:BLOCKED=True;raise
def elapsed(budget):return (time.monotonic()-budget.began)*1000
def work_remaining(budget):
    remaining=min(budget.require_remaining(),22-elapsed(budget)/1000)
    if remaining<=0:raise ValueError('STRESS_CHILD_WORK_DEADLINE')
    return remaining
def argv(phase):
    if phase not in ('tasks','memory'):raise ValueError('FIXED_PHASE')
    return ('/usr/bin/python3','-I','-S','/usr/bin/exec-server-worker-gate.py','--candidate-resource-stress-'+phase)

def fixed_bytes(name):
    global BLOCKED
    fd=os.open(HELPERS[name],os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        first=os.fstat(fd)
        if not stat.S_ISREG(first.st_mode) or not 0<first.st_size<=1048576 or not os.fstatvfs(fd).f_flag&os.ST_RDONLY:raise ValueError('READONLY_HELPER')
        raw=os.read(fd,1048577);last=os.fstat(fd)
        if len(raw)!=first.st_size or (first.st_dev,first.st_ino,first.st_size,first.st_mtime_ns)!=(last.st_dev,last.st_ino,last.st_size,last.st_mtime_ns):raise ValueError('HELPER_CHANGED')
        return raw
    finally:
        try:os.close(fd)
        except OSError:BLOCKED=True;raise

def sources():
    raw={n:fixed_bytes(n) for n in HELPERS}
    hashes={n:hashlib.sha256(v).hexdigest() for n,v in raw.items()}
    if hashes['subscription-text-model-catalog.json']!=CATALOG_SHA256:raise ValueError('CATALOG_HASH')
    return raw,hashes

def dependencies(raw):
    result=[]
    for short in DEPS:
        name='subscription-'+short;module=types.ModuleType('private_stress_'+short.replace('-','_'));module.__file__=HELPERS[name]
        exec(compile(raw[name],module.__file__,'exec'),module.__dict__);result.append(module)
    return tuple(result)

class Control:
    """Borrowed stdin. Records receipt separately from trusted API admission."""
    def __init__(self,budget,component):
        self.budget=budget;self.component=component;self.buffer=bytearray();self.received=[];self.applied=[]
        self.protocol=None;self.eof=False;self.bytes=0;self.failure=None
        self.cleanup_errors=[]
    def feed(self,raw):
        if not raw:
            self.eof=True
            if self.protocol is None or not self.protocol.done:raise ValueError('CONTROL_EOF_NOT_RELEASE')
            return
        work_remaining(self.budget)
        self.bytes+=len(raw)
        if self.bytes>256:raise ValueError('CONTROL_LIMIT')
        self.buffer.extend(raw)
        while b'\n' in self.buffer:
            line,_,rest=self.buffer.partition(b'\n');self.buffer=bytearray(rest);line=bytes(line)+b'\n'
            action=next((a for a,b in self.component.WIRE.items() if b==line),None)
            if action is None or any(v['action']==action for v in self.received) or len(self.received)>=4:raise ValueError('CONTROL_CANONICAL_ORDER')
            if self.received and self.received[-1]['action']=='cancel':raise ValueError('CONTROL_AFTER_CANCEL')
            self.received.append({'action':action,'rawHex':line.hex(),'elapsedMs':elapsed(self.budget)})
            # Only start may wait for the fixed process/start reply. A later
            # release cannot be preauthorized before actual progress exists.
            if action!='start' and self.protocol is None:raise ValueError('CONTROL_BEFORE_WORKER')
            self.apply()
    def apply(self):
        if self.protocol is None:return
        while len(self.applied)<len(self.received):
            action=self.received[len(self.applied)]['action']
            if action=='start' and not self.protocol.start_replied:return
            work_remaining(self.budget)
            index=len(self.protocol.history)
            if action=='cancel':self.protocol.cancel()
            else:self.protocol.authorize_observer(action)
            self.applied.append({'action':action,'historyIndex':index,
                                 'elapsedMs':elapsed(self.budget),'observerAdmissionAttestedHere':False})
    def report(self):return {'received':self.received,'applied':self.applied,'bytes':self.bytes,'partialHex':bytes(self.buffer).hex(),'eofObserved':self.eof,'failure':self.failure,'cleanupErrors':self.cleanup_errors}

def read_startup(parent,base,budget,control):
    os.set_blocking(0,False);raw=bytearray();selector=selectors.DefaultSelector()
    try:
        selector.register(0,selectors.EVENT_READ)
        while b'\n' not in raw:
            remaining=min(budget.require_remaining(),2-elapsed(budget)/1000)
            if remaining<=0:raise ValueError('STARTUP_DEADLINE')
            if not selector.select(remaining):continue
            if elapsed(budget)>=2000:raise ValueError('STARTUP_DEADLINE')
            try:piece=os.read(0,4097-len(raw))
            except BlockingIOError:continue
            if not piece:raise ValueError('STARTUP_EOF')
            raw.extend(piece)
            if len(raw)>4096 and b'\n' not in raw[:4096]:raise ValueError('STARTUP_LIMIT')
        line,_,rest=raw.partition(b'\n');line=bytes(line)+b'\n'
        value=base.strict_json(line)
        if not parent.validate_outer_packet(value):raise ValueError('STARTUP_IDENTITY')
        if os.readlink('/proc/self/ns/pid')!=value['namespaces']['trustedPid'] or os.readlink('/proc/self/ns/mnt')!=value['namespaces']['trustedMount']:raise ValueError('STARTUP_NAMESPACE')
        if rest:control.feed(bytes(rest))
        return {'value':value,'bytes':len(line),'sha256':hashlib.sha256(line).hexdigest(),'rawHex':line.hex(),
                'eofObserved':False,'sourceOfOuter':'supervisor-fixed-startup-pipe'}
    finally:close_selector(selector)

class Output:
    def __init__(self,budget):self.budget=budget;self.bytes=0;self.records=[]
    def send(self,value,final=False):
        raw=encode(value)+b'\n'
        if len(raw)>2*1024*1024 or self.bytes+len(raw)>3*1024*1024:raise ValueError('CHILD_OUTPUT_LIMIT')
        os.set_blocking(1,False);selector=selectors.DefaultSelector();offset=0
        try:
            selector.register(1,selectors.EVENT_WRITE)
            while offset<len(raw):
                remaining=self.budget.require_remaining() if final else work_remaining(self.budget)
                if not selector.select(remaining):continue
                self.budget.require_remaining() if final else work_remaining(self.budget)
                try:count=os.write(1,raw[offset:])
                except BlockingIOError:continue
                if count<=0:raise ValueError('CHILD_OUTPUT_CLOSED')
                offset+=count;self.bytes+=count
            self.budget.require_remaining() if final else work_remaining(self.budget)
        finally:close_selector(selector)
        if not final:self.records.append(value)

def compose(parent,gate,component,phase,control,output):
    original_selector=parent.selectors.DefaultSelector
    original_session=parent.Session
    class Selector:
        def __init__(self):
            self.inner=original_selector()
            try:self.inner.register(0,selectors.EVENT_READ,'persistent-control')
            except Exception:
                self.close()
                raise
        def register(self,*a,**k):return self.inner.register(*a,**k)
        def unregister(self,*a,**k):return self.inner.unregister(*a,**k)
        def get_key(self,*a,**k):return self.inner.get_key(*a,**k)
        def select(self,timeout=None):
            events=self.inner.select(timeout);returned=[]
            for key,mask in events:
                if key.data!='persistent-control':returned.append((key,mask));continue
                try:raw=os.read(0,257)
                except BlockingIOError:continue
                try:control.feed(raw)
                except Exception as failure:control.failure=type(failure).__name__+':'+str(failure);raise
                if not raw:self.inner.unregister(0)
            try:control.apply()
            except Exception as failure:control.failure=type(failure).__name__+':'+str(failure);raise
            return returned
        def close(self):
            global BLOCKED
            try:self.inner.close()
            except Exception as failure:
                BLOCKED=True;control.cleanup_errors.append('selector:'+type(failure).__name__)
    class Session(original_session):
        def close(self):
            global BLOCKED
            # Every own handle is attempted even after one close is unknown.
            for name in ('stdin','stdout','stderr'):
                try:getattr(self.process,name).close()
                except Exception as failure:
                    BLOCKED=True;control.cleanup_errors.append(self.name+':'+name+':'+type(failure).__name__)
            if self.pin is not None:
                try:os.close(self.pin)
                except Exception as failure:
                    BLOCKED=True;control.cleanup_errors.append(self.name+':pidfd:'+type(failure).__name__)
    class Worker(component.Protocol):
        def __init__(self,_gate,_probe,_marker):
            super().__init__(gate,phase);self.control_written=0;self.progress_sent=0;control.protocol=self
        @property
        def control_queued(self):return self.queued_bytes
        def written(self,count):
            super().written(count);self.control_written+=count
        def receive(self,frame):
            super().receive(frame)
            lines=bytes(self.raw_stdout).splitlines(keepends=True)
            while self.progress_sent<len(self.records):
                index=self.progress_sent;record=self.records[index]
                if record.get('type') in ('held','ramp-complete'):
                    raw=lines[index]
                    if not raw.endswith(b'\n') or not same(component.strict(raw),record):raise ValueError('PROGRESS_RAW_MISMATCH')
                    output.send({'version':1,'type':'candidate_stress_progress','phase':phase,'record':record,'rawHex':raw.hex()})
                self.progress_sent+=1
    def require(view):
        component.Protocol(view,phase)
        return argv(phase)
    parent.selectors=types.SimpleNamespace(**vars(parent.selectors));parent.selectors.DefaultSelector=Selector
    parent.Session=Session
    parent.WorkerProtocol=Worker;parent.GATE_ARGV=argv(phase);parent.require_fixed_worker_entry=require
    original_feed=parent.feed_output
    def feed(session,sessions,stream,raw,policy,parse):
        if sum(s.capture.observed_bytes for s in sessions)+len(raw)+output.bytes>policy.MAX_OUTPUT:raise ValueError('SHARED_PROGRESS_OUTPUT_LIMIT')
        original_feed(session,sessions,stream,raw,policy,parse)
        if sum(s.capture.observed_bytes for s in sessions)+output.bytes>policy.MAX_OUTPUT:raise ValueError('SHARED_PROGRESS_OUTPUT_LIMIT')
    parent.feed_output=feed

def replay_worker(session,component,gate,phase,control):
    keys={'argv','environment','pid','pinned','reaped','exitCode','error','history','controlBytesQueued','controlBytesWritten','cleanupHistory','signalDeliveries','stdoutBase64','stderrBase64','observedBytes','streamEOF','partialBytes'}
    if type(session) is not dict or set(session)!=keys or type(session['history']) is not list or len(session['history'])>4096:return None
    p=component.Protocol(gate,phase);applied=[]
    for i,event in enumerate(session['history']):
        if i>=len(p.history):
            kind=event.get('event')
            if kind=='written' and p.pending_frames:p.written(p.pending_frames[0][0])
            elif kind=='received':p.receive(event['frame'])
            elif kind=='trusted-caller-observer-authorization':p.authorize_observer(event['action']);applied.append(event['action'])
            else:return None
        if not same(p.history[i],event):return None
    if not same(p.history,session['history']) or p.pending or not p.done or p.failed:return None
    if applied!=[x['action'] for x in control['applied']]:return None
    if any(type(session[k]) is not int for k in ('controlBytesQueued','controlBytesWritten','observedBytes')) or session['controlBytesQueued']!=p.queued_bytes or session['controlBytesWritten']!=p.queued_bytes:return None
    stdout=base64.b64decode(session['stdoutBase64'],validate=True);stderr=base64.b64decode(session['stderrBase64'],validate=True)
    if base64.b64encode(stdout).decode()!=session['stdoutBase64'] or base64.b64encode(stderr).decode()!=session['stderrBase64'] or not stdout.endswith(b'\n') or len(stdout)+len(stderr)!=session['observedBytes'] or len(stdout)+len(stderr)>131072:return None
    if not same([component.strict(x) for x in stdout.splitlines()],[e['frame'] for e in p.history if e['event']=='received']):return None
    return p

def validate_report(report,deps,expected_worker_boundary):
    """External caller binds expected actual ready; observer receipts stay external."""
    try:
        parent,policy,gate,base,component=deps
        if type(report) is not dict or set(report)!={'version','profile','phase','success','error','parentReport','control','progress','protocol','helperSha256Before','helperSha256After','elapsedMs','resourceEnforcementValidated'}:return False
        phase=report['phase'];argv(phase)
        if type(report['version']) is not int or report['version']!=1 or report['profile']!='fixed-candidate-resource-stress-child' or report['success'] is not True or report['error'] is not None or report['resourceEnforcementValidated'] is not False:return False
        hashes=report['helperSha256Before']
        if type(hashes) is not dict or set(hashes)!=set(HELPERS) or not same(hashes,report['helperSha256After']) or any(type(x) is not str or not re.fullmatch('[a-f0-9]{64}',x) for x in hashes.values()) or hashes['subscription-text-model-catalog.json']!=CATALOG_SHA256:return False
        pr=report['parentReport'];packet=pr['startupPacket'];raw=bytes.fromhex(packet['rawHex'])
        if set(pr)!={'version','profile','success','error','startupPacket','marker','beforeWorker','afterWorker','sessions','completedMs','elapsedMs','actualModelCalls','credentialFilesRead','productionReady','appServerToolInvocation','descendantCleanupVerifiedHere'} or type(pr['version']) is not int or pr['version']!=1:return False
        if set(packet)!={'value','bytes','sha256','rawHex','eofObserved','sourceOfOuter'} or packet['eofObserved'] is not False or packet['sourceOfOuter']!='supervisor-fixed-startup-pipe' or not raw.endswith(b'\n') or raw.count(b'\n')!=1 or not 0<len(raw)<=4096 or type(packet['bytes']) is not int or packet['bytes']!=len(raw) or packet['sha256']!=hashlib.sha256(raw).hexdigest() or not same(base.strict_json(raw),packet['value']) or not parent.packet_matches_ready(packet['value'],expected_worker_boundary):return False
        if pr['profile']!='fixed-candidate-resource-stress-parent' or pr['success'] is not True or pr['error'] is not None or type(pr['actualModelCalls']) is not int or pr['actualModelCalls']!=0 or any(pr[x] is not False for x in ('credentialFilesRead','productionReady','appServerToolInvocation','descendantCleanupVerifiedHere')):return False
        for value,ceiling in ((pr['completedMs'],22000),(pr['elapsedMs'],30000),(report['elapsedMs'],30000)):
            if type(value) not in (int,float) or not math.isfinite(value) or not 0<=value<ceiling:return False
        if not pr['completedMs']<=pr['elapsedMs']<=report['elapsedMs']:return False
        control=report['control'];actions=['start','release'] if phase=='tasks' else ['start','ramp','release']
        if set(control)!={'received','applied','bytes','partialHex','eofObserved','failure','cleanupErrors'} or control['cleanupErrors']!=[] or control['failure'] is not None or control['partialHex']!='' or type(control['eofObserved']) is not bool:return False
        if [x['action'] for x in control['received']]!=actions or [x['action'] for x in control['applied']]!=actions or type(control['bytes']) is not int or control['bytes']!=sum(len(component.WIRE[a]) for a in actions):return False
        previous=-1
        for received,applied in zip(control['received'],control['applied']):
            if set(received)!={'action','rawHex','elapsedMs'} or received['rawHex']!=component.WIRE[received['action']].hex() or set(applied)!={'action','historyIndex','elapsedMs','observerAdmissionAttestedHere'} or applied['observerAdmissionAttestedHere'] is not False or type(applied['historyIndex']) is not int:return False
            for t in (received['elapsedMs'],applied['elapsedMs']):
                if type(t) not in (int,float) or not math.isfinite(t) or not previous<=t<=pr['completedMs']:return False
                previous=t
        sessions=pr['sessions']
        if set(sessions)!={'appserver','executor'} or sessions['appserver']['pid']==sessions['executor']['pid']:return False
        environment={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':parent.HOME,'CODEX_HOME':parent.HOME,'TMPDIR':parent.HOME+'/tmp'}
        app=parent.make_initialize_protocol(policy)
        if not parent.replay_session(sessions['appserver'],app,policy,parent.appserver_argv(policy),environment) or not app.initialized_complete:return False
        executor=sessions['executor']
        if executor['argv']!=list(argv(phase)) or executor['environment']!=environment or not parent.valid_direct_cleanup(executor) or not same(executor['streamEOF'],{'stdout':True,'stderr':True}) or type(executor['partialBytes']) is not int or executor['partialBytes']!=0:return False
        p=replay_worker(executor,component,gate,phase,control)
        if p is None or not same(p.result(),report['protocol']):return False
        auth=[(i,e) for i,e in enumerate(p.history) if e['event']=='trusted-caller-observer-authorization']
        if [i for i,e in auth]!=[v['historyIndex'] for v in control['applied']]:return False
        lines=bytes(p.raw_stdout).splitlines(keepends=True)
        progress=[{'version':1,'type':'candidate_stress_progress','phase':phase,'record':r,'rawHex':lines[i].hex()} for i,r in enumerate(p.records) if r.get('type') in ('held','ramp-complete')]
        if not same(progress,report['progress']) or sum(s['observedBytes'] for s in sessions.values())+sum(len(encode(v))+1 for v in progress)>policy.MAX_OUTPUT:return False
        marker=pr['marker'];mr=bytes.fromhex(marker['rawHex'])
        if set(marker)!={'path','bytes','sha256','rawHex','file','value','readonlyMountClaimedHere'} or marker['path']!=parent.MARKER_PATH or marker['readonlyMountClaimedHere'] is not False or type(marker['bytes']) is not int or not 0<len(mr)==marker['bytes']<=4096 or hashlib.sha256(mr).hexdigest()!=marker['sha256'] or not same(base.strict_json(mr),marker['value']) or not base.validate_marker(marker['value']):return False
        if not same(marker['value']['namespaces'],packet['value']['namespaces']) or any(not same(marker['value']['protectedDescriptors'][k],v) for k,v in packet['value']['protectedDescriptors'].items()):return False
        previous=-1
        for name in ('beforeWorker','afterWorker'):
            o=pr[name]
            if set(o)!={'pid','alive','pipes','objects','marker','elapsedMs'} or type(o['pid']) is not int or o['pid']!=sessions['appserver']['pid'] or o['alive'] is not True or not same(o['objects'],marker['value']['authoredProtectedObjects']) or not same(o['pipes'],{k:marker['value']['protectedDescriptors'][k] for k in ('appServerControl','appServerOutput')}) or not same(o['marker'],{'file':marker['file'],'sha256':marker['sha256']}) or type(o['elapsedMs']) not in (int,float) or not previous<=o['elapsedMs']<=pr['completedMs']:return False
            previous=o['elapsedMs']
        return previous==pr['completedMs'] and all(pr['completedMs']<=s['cleanupHistory'][0]['elapsedMs']<=s['cleanupHistory'][-1]['elapsedMs']<=pr['elapsedMs'] for s in sessions.values())
    except (ValueError,TypeError,KeyError,IndexError,AttributeError,OverflowError):return False

def run(phase):
    global BLOCKED
    if BLOCKED:raise ValueError('PREVIOUS_CLEANUP_UNKNOWN')
    began=time.monotonic();raw,before=sources();deps=dependencies(raw);parent,policy,gate,base,component=deps
    budget=parent.Budget();budget.began=began;control=Control(budget,component);output=Output(budget)
    packet=read_startup(parent,base,budget,control)
    compose(parent,gate,component,phase,control,output)
    try:pr=parent.run_parent(policy,gate,base,budget,packet)
    except Exception as failure:
        BLOCKED=True
        output.send({'version':1,'profile':'fixed-candidate-resource-stress-child','phase':phase,'success':False,
            'error':'PARENT_OWNERSHIP_UNKNOWN:'+type(failure).__name__,'control':control.report(),'progress':output.records,
            'cleanupKnown':False,'resourceEnforcementValidated':False},final=True)
        return 1
    pr['profile']='fixed-candidate-resource-stress-parent';pr['success']=pr['error'] is None
    report={'version':1,'profile':'fixed-candidate-resource-stress-child','phase':phase,'success':pr['success'],'error':pr['error'],
            'parentReport':pr,'control':control.report(),'progress':output.records,
            'protocol':control.protocol.result() if control.protocol is not None else None,
            'helperSha256Before':before,'helperSha256After':sources()[1],'elapsedMs':elapsed(budget),'resourceEnforcementValidated':False}
    expected={'namespace':packet['value']['namespaces']['trustedPid'],'mountNamespace':packet['value']['namespaces']['trustedMount'],
              'control':packet['value']['protectedDescriptors']['outerSupervisorControl'],'output':packet['value']['protectedDescriptors']['outerSupervisorOutput']}
    if not validate_report(report,dependencies(raw),expected):report['success']=False;report['error']=report['error'] or 'STRESS_CHILD_REPORT_INVALID'
    report['elapsedMs']=elapsed(budget)
    if report['elapsedMs']>=30000:report['success']=False;report['error']=report['error'] or 'STRESS_CHILD_TOTAL_DEADLINE'
    if any(not parent.valid_direct_cleanup(s) for s in pr['sessions'].values()):BLOCKED=True
    output.send(report,final=True)
    return 0 if report['success'] else 1

def main():
    if sys.platform!='linux' or sys.argv[1:] not in (['--inside-tasks'],['--inside-memory']):raise ValueError('FIXED_CAPSULE_ENTRY_REQUIRED')
    return run(sys.argv[1].removeprefix('--inside-'))

if __name__=='__main__':raise SystemExit(main())
