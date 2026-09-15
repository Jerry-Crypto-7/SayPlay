"""Fixed trusted-caller protocol component; no OS execution or resource attestation."""
import base64
import hashlib
import json
import math
import re

WIRE={a:('{"version":1,"action":"'+a+'"}\n').encode() for a in ('start','ramp','release','cancel')}
LIMIT=65536


def encode(value):return json.dumps(value,separators=(',',':'),sort_keys=True,allow_nan=False).encode()
def same(a,b):return encode(a)==encode(b)
def integer(v,low=0,high=9007199254740991):return type(v) is int and low<=v<=high
def exact(v,keys):return type(v) is dict and set(v)==set(keys)
def strict(raw):
    def pairs(items):
        d={}
        for k,v in items:
            if k in d:raise ValueError('DUPLICATE_JSON_KEY')
            d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('NONFINITE')))


def identities(frame):
    w=frame.get('workerIdentity');children=frame.get('childIdentities')
    if not exact(w,('pid','startTicks','pidNamespace','procInitPidNamespace')) or type(children) is not list:raise ValueError('HELD_IDENTITIES')
    def valid(x):return exact(x,('pid','startTicks')) and integer(x['pid'],1) and type(x['startTicks']) is str and re.fullmatch('[1-9][0-9]{0,31}',x['startTicks'])
    if not valid({k:w[k] for k in ('pid','startTicks')}) or type(w['pidNamespace']) is not str or not re.fullmatch(r'pid:\[[1-9][0-9]{0,19}\]',w['pidNamespace']) or w['procInitPidNamespace']!=w['pidNamespace']:raise ValueError('WORKER_IDENTITY')
    if not 1<=len(children)<=64 or not all(valid(x) for x in children) or len({x['pid'] for x in children})!=len(children) or w['pid'] in {x['pid'] for x in children}:raise ValueError('CHILD_IDENTITIES')


class Protocol:
    """Caller passes a private source-bound gate. Observer permission is a trusted call, not wire input."""
    def __init__(self,gate,phase):
        if phase not in ('tasks','memory'):raise ValueError('FIXED_PHASE')
        self.gate=gate;self.phase=phase;self.pending=bytearray();self.pending_frames=[];self.awaiting=None;self.next_id=3
        self.history=[];self.history_bytes=0;self.queued_bytes=0;self.failed=False;self.done=False;self.cancelled=False
        self.started=False;self.start_replied=False;self.sent=set();self.accepted=set();self.permissions={}
        self.chunks={};self.committed=set();self.output_bytes=0;self.partial=bytearray();self.raw_stdout=bytearray();self.records=[]
        self.after_seq=None;self.last_next=1;self.notification_seq=0;self.exit_seen=None;self.closed_seen=False
        self.held=None;self.ramp_complete=None;self.terminal=None
        start=gate.stress_start_request(phase)
        expected=gate.control_start_request();expected['params']['argv']=['/usr/bin/python3','-I','-S','/usr/bin/candidate-resource-stress-worker.py','--inside-'+phase];expected['params']['pipeStdin']=True
        if not same(start,expected):raise ValueError('FIXED_STRESS_START')
        self.start_frame=start;self.queue(gate.initialize_request())
    def record(self,event,**values):
        item={'event':event,**values};self.history_bytes+=len(encode(item))
        if self.history_bytes>2*1024*1024:raise ValueError('HISTORY_LIMIT')
        self.history.append(item)
    def queue(self,frame):
        raw=encode(frame)+b'\n';self.queued_bytes+=len(raw)
        if self.queued_bytes>32768 or self.awaiting or (self.pending and frame['method']!='process/start'):raise ValueError('OUTGOING_ORDER_LIMIT')
        self.pending.extend(raw);self.pending_frames.append([len(raw),frame]);self.record('queued',frame=frame)
    def written(self,count):
        try:
            if self.failed or not integer(count,1,len(self.pending)):raise ValueError('WRITE_COUNT')
            del self.pending[:count]
            while count:
                used=min(count,self.pending_frames[0][0]);self.pending_frames[0][0]-=used;count-=used
                if self.pending_frames[0][0]==0:
                    _,frame=self.pending_frames.pop(0);self.record('written',frame=frame)
                    if frame.get('id') is not None:
                        self.awaiting=(frame['id'],frame['method'],frame)
                        if frame['method']=='process/start':self.started=True
                        if frame['method']=='process/write':self.sent.add(frame['params']['writeId'].rsplit('-',1)[1])
        except (ValueError,TypeError,KeyError):self.failed=True;raise
    def authorize_observer(self,action):
        try:
            if self.failed or self.done or self.cancelled or action not in ('start','ramp','release') or action in self.permissions:raise ValueError('OBSERVER_PERMISSION_ORDER')
            eligible=(action=='start' and self.start_replied or action=='ramp' and self.phase=='memory' and self.held is not None and 'start' in self.accepted or action=='release' and (self.phase=='tasks' and self.held is not None and 'start' in self.accepted or self.phase=='memory' and self.ramp_complete is not None and 'ramp' in self.accepted))
            if not eligible:raise ValueError('PROGRESS_AND_ACK_REQUIRED')
            self.permissions[action]=True;self.record('trusted-caller-observer-authorization',action=action,observerAdmissionAttestedHere=False)
            self.schedule()
        except (ValueError,TypeError):self.failed=True;raise
    def cancel(self):
        if self.failed or self.done or not self.start_replied or self.cancelled:raise ValueError('CANCEL_ORDER')
        self.cancelled=True;self.record('trusted-caller-cancel');self.schedule()
    def schedule(self):
        if self.failed or self.done or self.awaiting or self.pending:return
        if not self.start_replied:return
        actions=['cancel'] if self.cancelled else [x for x in ('start','ramp','release') if x in self.permissions]
        action=next((x for x in actions if x not in self.sent),None)
        if self.next_id>128:raise ValueError('RPC_LIMIT')
        if action:
            expected={'id':self.next_id,'method':'process/write','params':{'processId':'fixed-worker','chunk':base64.b64encode(WIRE[action]).decode(),'writeId':'stress-'+self.phase+'-'+action}}
            frame=self.gate.stress_write_request(self.next_id,self.phase,action)
            if not same(frame,expected):raise ValueError('FIXED_RELEASE_WRITE')
        else:frame=self.gate.read_request(self.next_id,self.after_seq)
        self.next_id+=1;self.queue(frame)
    def add_chunk(self,c):
        if not exact(c,('seq','stream','chunk')) or not integer(c['seq'],1) or c['stream'] not in ('stdout','stderr') or type(c['chunk']) is not str or len(c['chunk'])>87384:raise ValueError('OUTPUT_CHUNK')
        raw=base64.b64decode(c['chunk'],validate=True)
        if len(raw)>LIMIT or base64.b64encode(raw).decode()!=c['chunk']:raise ValueError('OUTPUT_BASE64')
        old=self.chunks.get(c['seq'])
        if old is not None:
            if old!=(c['stream'],raw):raise ValueError('OUTPUT_CONFLICT')
        else:
            self.output_bytes+=len(raw)
            if self.output_bytes>LIMIT:raise ValueError('OUTPUT_LIMIT')
            self.chunks[c['seq']]=(c['stream'],raw)
        if c['stream']=='stderr' and raw:raise ValueError('WORKER_STDERR')
        return raw
    def worker_record(self,v):
        if type(v) is not dict:raise ValueError('WORKER_RECORD_OBJECT')
        if v.get('type')=='held':
            fields={'type','phase','children','workerIdentity','childIdentities',('forkErrno' if self.phase=='tasks' else 'bytesPerAllocator')}
            if set(v)!=fields or self.held is not None or 'start' not in self.sent or v['phase']!=self.phase:raise ValueError('HELD_ORDER')
            identities(v)
            if not integer(v['children'],1,64) or len(v['childIdentities'])!=v['children']:raise ValueError('HELD_COUNT')
            if self.phase=='tasks':
                if type(v['forkErrno']) is not int or v['forkErrno']!=11:raise ValueError('TASK_LIMIT_NOT_OBSERVED')
            elif v['children']!=2 or type(v['bytesPerAllocator']) is not int or v['bytesPerAllocator']!=805306368:raise ValueError('MEMORY_STAGE')
            self.held=v
        elif v.get('type')=='ramp-complete':
            if not exact(v,('type','phase','allocationCapPerChild')) or self.phase!='memory' or v['phase']!='memory' or self.held is None or 'ramp' not in self.sent or self.ramp_complete is not None or type(v['allocationCapPerChild']) is not int or v['allocationCapPerChild']!=1207959552:raise ValueError('RAMP_ORDER')
            self.ramp_complete=v
        elif v.get('kind')=='FIXED_CANDIDATE_RESOURCE_WORKLOAD':
            self.validate_terminal(v);self.terminal=v
        else:raise ValueError('WORKER_RECORD_KIND')
        self.records.append(v)
        if len(self.records)>3:raise ValueError('WORKER_RECORD_COUNT')
    def validate_terminal(self,v):
        keys=('version','kind','phase','state','reason','releaseHistory','normalRelease','expectedWorkloadOutcome','forkErrno','children','cleanup','resourceEnforcementValidated','productionReady','modelCalls','credentialFilesRead','elapsedMs')
        if not exact(v,keys) or self.terminal is not None or type(v['version']) is not int or v['version']!=1 or v['phase']!=self.phase:raise ValueError('WORKER_TERMINAL_SCHEMA')
        if self.cancelled:raise ValueError('WORKLOAD_CANCELLED')
        if self.held is None or 'release' not in self.sent or self.phase=='memory' and self.ramp_complete is None:raise ValueError('TERMINAL_BEFORE_RELEASE')
        if v['state']!='released' or v['reason'] is not None or v['normalRelease'] is not True or v['expectedWorkloadOutcome'] is not True or v['resourceEnforcementValidated'] is not False or v['productionReady'] is not False or not integer(v['modelCalls'],0,0) or not integer(v['credentialFilesRead'],0,0):raise ValueError('WORKLOAD_NOT_SUCCESSFUL')
        if type(v['elapsedMs']) not in (int,float) or not math.isfinite(v['elapsedMs']) or not 0<=v['elapsedMs']<30000:raise ValueError('WORKLOAD_DEADLINE')
        if not same(v['cleanup'],{'known':True,'errors':[],'allOwnChildrenReaped':True}):raise ValueError('WORKLOAD_CLEANUP')
        actions=['start','release'] if self.phase=='tasks' else ['start','ramp','release'];states=['await-start','held'] if self.phase=='tasks' else ['await-start','held','ramp-complete']
        if not same(v['releaseHistory'],[{'state':s,'rawHex':WIRE[a].hex()} for s,a in zip(states,actions)]):raise ValueError('WORKLOAD_RELEASE_HISTORY')
        if not same(v['forkErrno'],11 if self.phase=='tasks' else None) or type(v['children']) is not list or len(v['children'])!=self.held['children']:raise ValueError('WORKLOAD_CHILDREN')
        expected={x['pid']:x for x in self.held['childIdentities']};seen=set();victims=0
        for c in v['children']:
            required={'pid','kind','returncode','events','pinAcquired','released','errors','identity','commandClosed','reportClosed','pidfdClosed'}
            if type(c) is not dict or set(c)!=required or type(c['released']) is not bool:raise ValueError('CHILD_TERMINAL_SCHEMA')
            if not integer(c['pid'],1) or c['pid'] in seen or c['pid'] not in expected or not same(c['identity'],expected[c['pid']]):raise ValueError('CHILD_IDENTITY_BINDING')
            seen.add(c['pid'])
            if c['kind']!=self.phase or c['pinAcquired'] is not True or c['errors']!=[] or c.get('cleanupSignals') or c.get('waitError') or any(c[x] is not True for x in ('commandClosed','reportClosed','pidfdClosed')):raise ValueError('CHILD_CLEANUP')
            if type(c['returncode']) is not int or c['returncode'] not in ((0,) if self.phase=='tasks' else (0,-9)):raise ValueError('CHILD_STATUS')
            if c['returncode']==-9:victims+=1
            if c['returncode']==0 and c['released'] is not True:raise ValueError('CHILD_NOT_RELEASED')
            if self.phase=='tasks' and c['events']!=[] or self.phase=='memory' and c['events'] not in (['H'],['H','F']):raise ValueError('CHILD_STAGE_EVENTS')
            if self.phase=='memory' and c['returncode']==0 and c['events']!=['H','F']:raise ValueError('SURVIVOR_RAMP_INCOMPLETE')
        if self.phase=='memory' and not victims:raise ValueError('NO_ALLOCATOR_VICTIM')
    def receive(self,frame):
        try:self._receive(strict(encode(frame)))
        except (ValueError,TypeError,KeyError,AttributeError):self.failed=True;raise
    def _receive(self,frame):
        self.record('received',frame=frame)
        if self.failed or self.done or type(frame) is not dict:raise ValueError('RESPONSE_STATE')
        if 'method' in frame:
            v=frame.get('params')
            if not exact(frame,('method','params')) or not self.started or type(v) is not dict or v.get('processId')!='fixed-worker' or not integer(v.get('seq'),self.notification_seq+1):raise ValueError('NOTIFICATION_IDENTITY')
            if frame['method']=='process/output':self.add_chunk({k:x for k,x in v.items() if k!='processId'})
            elif frame['method']=='process/exited':
                if set(v) not in ({'processId','seq','exitCode'},{'processId','seq','exitCode','sandboxDenied'}) or type(v['exitCode']) is not int or v.get('sandboxDenied') is not None and v.get('sandboxDenied') is not False or self.exit_seen is not None:raise ValueError('EXIT_NOTIFICATION')
                self.exit_seen=v['exitCode']
            elif frame['method']=='process/closed':
                if set(v)!={'processId','seq'} or self.exit_seen is None or self.closed_seen:raise ValueError('CLOSE_NOTIFICATION')
                self.closed_seen=True
            else:raise ValueError('UNKNOWN_NOTIFICATION')
            self.notification_seq=v['seq'];return
        if not exact(frame,('id','result')) or not self.awaiting or type(frame['id']) is not int or frame['id']!=self.awaiting[0]:raise ValueError('REPLY_ORDER_OR_ERROR')
        _,method,request=self.awaiting;v=frame['result'];self.awaiting=None
        if method=='initialize':
            if not exact(v,('sessionId',)) or type(v['sessionId']) is not str or not re.fullmatch('[A-Za-z0-9_-]{1,128}',v['sessionId']):raise ValueError('SESSION')
            self.queue({'method':'initialized','params':{}});self.queue(self.start_frame);return
        if method=='process/start':
            if not same(v,{'processId':'fixed-worker'}):raise ValueError('START_RESPONSE')
            self.start_replied=True
        elif method=='process/write':
            if not same(v,{'status':'accepted'}):raise ValueError('WRITE_NOT_ACCEPTED')
            self.accepted.add(request['params']['writeId'].rsplit('-',1)[1])
        elif method=='process/read':
            if not exact(v,('chunks','nextSeq','exited','exitCode','closed','failure','sandboxDenied')) or type(v['chunks']) is not list or len(v['chunks'])>64 or not integer(v['nextSeq'],self.last_next) or any(type(v[k]) is not bool for k in ('exited','closed','sandboxDenied')) or v['failure'] is not None or v['sandboxDenied']:raise ValueError('READ_RESPONSE')
            if (v['exitCode'] is not None and not integer(v['exitCode'],-2147483648,2147483647)) or (not v['exited'] and v['exitCode'] is not None):raise ValueError('READ_EXIT_STATUS')
            previous=self.after_seq or 0
            for c in v['chunks']:
                if type(c) is not dict or not integer(c.get('seq'),previous+1) or c['seq']>=v['nextSeq']:raise ValueError('READ_CURSOR')
                raw=self.add_chunk(c);previous=c['seq'];self.committed.add(c['seq']);self.partial.extend(raw);self.raw_stdout.extend(raw)
                while b'\n' in self.partial:
                    line,_,rest=self.partial.partition(b'\n');self.partial=bytearray(rest)
                    if self.terminal is not None:raise ValueError('AFTER_TERMINAL')
                    self.worker_record(strict(bytes(line)))
            if v['chunks'] and v['nextSeq']!=previous+1:raise ValueError('READ_CURSOR_SKIP')
            self.last_next=v['nextSeq'];self.after_seq=v['nextSeq']-1
            if v['closed']:
                if not v['exited'] or type(v['exitCode']) is not int or v['exitCode']!=0 or self.exit_seen not in (None,0) or self.terminal is None or self.partial or 'release' not in self.accepted or self.committed!=set(self.chunks):raise ValueError('CLOSED_INCOMPLETE')
                self.done=True;return
            if v['exited'] and (type(v['exitCode']) is not int or v['exitCode']!=0):raise ValueError('PROCESS_FAILED')
        else:raise ValueError('UNKNOWN_REPLY_METHOD')
        self.schedule()
    def eof(self):
        if not self.done:self.failed=True;raise ValueError('PROTOCOL_EOF_INCOMPLETE')
    def result(self):
        return strict(encode({'phase':self.phase,'complete':self.done and not self.failed,'failed':self.failed,'cancelled':self.cancelled,'records':self.records,
            'rawStdoutHex':bytes(self.raw_stdout).hex(),'rawStdoutSha256':hashlib.sha256(self.raw_stdout).hexdigest(),'history':self.history,
            'observerAuthority':'TRUSTED_CALLER_NOT_CRYPTOGRAPHIC_ATTESTATION','resourceEnforcementValidated':False}))
