"""Finite reviewed-worker workload. No host entry, resource controls or network."""
import errno
import json
import os
import re
import select
import signal
import stat
import sys
import time

WORK_SECONDS=22
TOTAL_SECONDS=30
CHUNK_BYTES=16*1024*1024
STAGE_CHUNKS=48
MAX_CHUNKS=72
MAX_FORKS=64
OUTPUT_LIMIT=65536
INSTALLED='/usr/bin/candidate-resource-stress-worker.py'
WIRE={name:('{"version":1,"action":"'+name+'"}\n').encode() for name in ('start','ramp','release','cancel')}
BLOCKED=False


class Stop(Exception):pass
class ForkDenied(Exception):pass


def action(raw,expected):
    if raw==b'':raise Stop('CONTROL_EOF')
    if raw==WIRE['cancel']:raise Stop('CANCELLED')
    if raw!=WIRE[expected]:raise Stop('CONTROL_PROTOCOL')
    return expected


def allocate(blocks,count,deadline,clock=time.monotonic,allocator=bytearray):
    if type(count) is not int or count not in (STAGE_CHUNKS,MAX_CHUNKS):raise ValueError('FIXED_ALLOCATION_STAGE')
    while len(blocks)<count:
        if clock()>=deadline:raise Stop('WORK_DEADLINE')
        block=allocator(CHUNK_BYTES)
        # Explicitly fault every page with nonzero data; retain each allocation.
        for offset in range(0,CHUNK_BYTES,4096):
            if offset%1048576==0 and clock()>=deadline:raise Stop('WORK_DEADLINE')
            block[offset]=1+(len(blocks)%254)
        blocks.append(block)
        if clock()>=deadline:raise Stop('WORK_DEADLINE')


def child_loop(kind,command,output,deadline):
    # Only these two private pipes survive in allocator/fork children.
    for value in os.listdir('/proc/self/fd'):
        fd=int(value)
        if fd not in (command,output):
            try:os.close(fd)
            except OSError as e:
                if e.errno!=errno.EBADF:raise
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    def take(expected):
        while True:
            remain=deadline-time.monotonic()
            if remain<=0:raise Stop('WORK_DEADLINE')
            if select.select([command],[],[],remain)[0]:
                value=os.read(command,2)
                if value!=expected:raise Stop('CHILD_GATE_CLOSED_OR_INVALID')
                return
    take(b'S')  # No hold/allocation work until own parent has acquired its pidfd.
    blocks=[]
    if kind=='memory':
        allocate(blocks,STAGE_CHUNKS,deadline)
        if os.write(output,b'H')!=1:raise Stop('CHILD_REPORT_WRITE')
        take(b'R');allocate(blocks,MAX_CHUNKS,deadline)
        if os.write(output,b'F')!=1:raise Stop('CHILD_REPORT_WRITE')
    take(b'Q')


class Kernel:
    def __init__(self,began):
        self.began=began;self.work=began+WORK_SECONDS;self.total=began+TOTAL_SECONDS
        self.children=[];self.partial=bytearray();self.output_bytes=0;self.setup_close_unknown=False;self.identity_unknown=False
        os.set_blocking(0,False);os.set_blocking(1,False)
    def now(self):return time.monotonic()
    def remaining(self,deadline):
        value=deadline-self.now()
        if value<=0:raise Stop('WORK_DEADLINE')
        return value
    def check_work(self):self.remaining(self.work)
    def emit(self,record):
        raw=json.dumps(record,sort_keys=True,separators=(',',':'),allow_nan=False).encode()+b'\n'
        self.output_bytes+=len(raw)
        if self.output_bytes>OUTPUT_LIMIT:raise Stop('OUTPUT_LIMIT')
        while raw:
            if not select.select([],[1],[],self.remaining(self.total))[1]:raise Stop('OUTPUT_DEADLINE')
            self.remaining(self.total)
            try:n=os.write(1,raw)
            except BlockingIOError:continue
            if n<=0:raise Stop('OUTPUT_CLOSED')
            raw=raw[n:]
    def receive(self):
        while b'\n' not in self.partial:
            if not select.select([0],[],[],self.remaining(self.work))[0]:raise Stop('WORK_DEADLINE')
            try:raw=os.read(0,129)
            except BlockingIOError:continue
            if not raw:return b''
            self.partial.extend(raw)
            if len(self.partial)>128:raise Stop('CONTROL_LIMIT')
        line,_,rest=self.partial.partition(b'\n');self.partial=bytearray(rest)
        if rest:raise Stop('CONTROL_PIPELINING')
        return bytes(line)+b'\n'
    def identity(self,pid):
        fd=os.open('/proc/'+str(pid)+'/stat',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:raw=os.read(fd,4097)
        finally:
            try:os.close(fd)
            except OSError:self.setup_close_unknown=True;raise
        if len(raw)>4096:raise Stop('OWN_CHILD_STAT_BOUND')
        text=raw.decode('ascii')
        if not text.startswith(str(pid)+' (') or ') ' not in text:raise Stop('OWN_CHILD_STAT')
        fields=text.rsplit(') ',1)[1].split()
        if len(fields)<20 or fields[0] not in ('R','S','D','T','t','I','W') or not re.fullmatch('[1-9][0-9]{0,31}',fields[19]):raise Stop('OWN_CHILD_STAT')
        return {'pid':pid,'startTicks':fields[19]}
    def held_identities(self):
        # These are actual pre-release observations, not identities copied from a final report.
        try:
            self.check_work();pid=os.getpid();own=self.identity(pid)
            namespace=os.readlink('/proc/self/ns/pid');init_namespace=os.readlink('/proc/1/ns/pid')
            if not re.fullmatch(r'pid:\[[1-9][0-9]{0,19}\]',namespace) or namespace!=init_namespace:
                raise Stop('HELD_WORKER_NAMESPACE')
            children=[]
            for item in self.children:
                self.check_work()
                if not item['pinAcquired'] or item['pidfd'] is None or item['returncode'] is not None:
                    raise Stop('HELD_CHILD_NOT_PINNED_LIVE')
                signal.pidfd_send_signal(item['pidfd'],0)
                current=self.identity(item['pid'])
                signal.pidfd_send_signal(item['pidfd'],0)
                if current!=item['identity']:raise Stop('HELD_CHILD_GENERATION')
                children.append(current);self.check_work()
            if len({x['pid'] for x in children})!=len(children):raise Stop('HELD_DUPLICATE_CHILD')
            if (self.identity(pid)!=own or os.readlink('/proc/self/ns/pid')!=namespace
                    or os.readlink('/proc/1/ns/pid')!=init_namespace):raise Stop('HELD_WORKER_CHANGED')
            self.check_work()
            return {'workerIdentity':{**own,'pidNamespace':namespace,'procInitPidNamespace':init_namespace},'childIdentities':children}
        except (OSError,Stop,ValueError,IndexError,KeyError,TypeError):
            self.identity_unknown=True
            raise
    def spawn(self,kind):
        self.remaining(self.work)
        owned=[]
        try:
            cr,cw=os.pipe2(os.O_CLOEXEC);owned.extend((cr,cw))
            rr,rw=os.pipe2(os.O_CLOEXEC);owned.extend((rr,rw))
            try:pid=os.fork()
            except OSError as e:
                if e.errno==errno.EAGAIN:raise ForkDenied() from e
                raise
            if pid==0:
                code=1
                try:child_loop(kind,cr,rw,self.work);code=0
                except BaseException:pass
                os._exit(code)
            item={'pid':pid,'pidfd':None,'command':cw,'report':rr,'kind':kind,'returncode':None,'events':[],'pinAcquired':False,'released':False,'errors':[]}
            self.children.append(item);owned.remove(cw);owned.remove(rr)
            for fd in (cr,rw):
                owned.remove(fd)
                try:os.close(fd)
                except OSError:self.setup_close_unknown=True;raise
            item['pidfd']=os.pidfd_open(pid,0);os.set_inheritable(item['pidfd'],False)
            signal.pidfd_send_signal(item['pidfd'],0);item['identity']=self.identity(pid)
            signal.pidfd_send_signal(item['pidfd'],0);item['pinAcquired']=True
            self.send(item,b'S');return item
        finally:
            for fd in owned:
                try:os.close(fd)
                except OSError:self.setup_close_unknown=True
    def send(self,item,value):
        self.remaining(self.work)
        if not item['pinAcquired']:raise Stop('CHILD_NOT_PINNED')
        if os.write(item['command'],value)!=1:raise Stop('CHILD_COMMAND_WRITE')
        if value==b'Q':item['released']=True
    def reap(self,item):
        if item['returncode'] is not None:return
        pid,status=os.waitpid(item['pid'],os.WNOHANG)
        if pid==item['pid']:item['returncode']=os.waitstatus_to_exitcode(status)
    def await_stage(self,stage,allow_oom=False):
        while True:
            self.check_work()
            complete=True
            for item in self.children:
                self.reap(item)
                if item['returncode'] is not None:
                    if not allow_oom or item['returncode']!=-signal.SIGKILL:raise Stop('UNEXPECTED_CHILD_EXIT')
                elif stage not in item['events']:complete=False
            if complete:return
            if self.partial:action(self.receive(),'cancel')
            readers=[0]+[x['report'] for x in self.children if x['returncode'] is None]
            for fd in select.select(readers,[],[],min(.05,self.remaining(self.work)))[0]:
                if fd==0:action(self.receive(),'cancel')
                else:
                    item=next(x for x in self.children if x['report']==fd)
                    value=os.read(fd,2)
                    if value:
                        expected=b'H' if not item['events'] else b'F'
                        if value!=expected:raise Stop('CHILD_EVENT_PROTOCOL')
                        item['events'].append(value.decode())
    def cleanup(self,normal):
        failures=['SETUP_CLOSE_UNKNOWN'] if self.setup_close_unknown else []
        if getattr(self,'identity_unknown',False):failures.append('HELD_IDENTITY_UNKNOWN')
        def safe_reap(item):
            if item.get('waitError'):return
            try:self.reap(item)
            except OSError as error:
                item['waitError']=type(error).__name__;failures.append('OWN_WAIT_UNKNOWN')
        for item in self.children:
            try:
                safe_reap(item)
                if normal and item['returncode'] is None:self.send(item,b'Q')
            except (OSError,Stop) as e:failures.append(type(e).__name__)
            fd=item['command'];item['command']=None
            try:os.close(fd);item['commandClosed']=True
            except OSError:item['commandClosed']=False;failures.append('COMMAND_CLOSE')
        # EOF closes the private gate even when pin acquisition failed. Never numeric kill.
        natural=min(self.total,self.now()+2)
        while self.now()<natural:
            for item in self.children:safe_reap(item)
            if all(x['returncode'] is not None for x in self.children):break
            time.sleep(.01)
        for sig,seconds in ((signal.SIGTERM,2),(signal.SIGKILL,1)):
            if self.now()>=self.total:break
            for item in self.children:
                if item['returncode'] is None and item['pidfd'] is not None:
                    try:signal.pidfd_send_signal(item['pidfd'],sig);item.setdefault('cleanupSignals',[]).append(sig)
                    except ProcessLookupError:pass
                    except OSError:failures.append('PIDFD_SIGNAL')
            until=min(self.total,self.now()+seconds)
            while self.now()<until:
                for item in self.children:safe_reap(item)
                if all(x['returncode'] is not None for x in self.children):break
                time.sleep(.01)
        for item in self.children:
            for key in ('report','pidfd'):
                fd=item[key];item[key]=None
                if fd is not None:
                    try:os.close(fd);item[key+'Closed']=True
                    except OSError:item[key+'Closed']=False;failures.append('OWNED_FD_CLOSE')
        known=not failures and all(x['returncode'] is not None for x in self.children)
        return {'known':known,'errors':failures,'allOwnChildrenReaped':all(x['returncode'] is not None for x in self.children)}


def run(phase,kernel):
    global BLOCKED
    if BLOCKED:raise Stop('UNKNOWN_CLEANUP_FENCE')
    if phase not in ('tasks','memory'):raise ValueError('FIXED_PHASE')
    state='await-start';reason=None;fork_errno=None;normal=False;history=[]
    def take(name):
        kernel.check_work()
        raw=kernel.receive();history.append({'state':state,'rawHex':raw.hex()});action(raw,name)
        kernel.check_work()
    try:
        take('start');state='working'
        if phase=='tasks':
            for _ in range(MAX_FORKS):
                try:kernel.spawn('tasks')
                except ForkDenied:
                    fork_errno=errno.EAGAIN;break
            identities=kernel.held_identities()
            state='held';kernel.emit({'type':'held','phase':phase,'children':len(kernel.children),'forkErrno':fork_errno,**identities})
        else:
            kernel.spawn('memory');kernel.spawn('memory');kernel.await_stage('H')
            identities=kernel.held_identities()
            state='held';kernel.emit({'type':'held','phase':phase,'children':2,'bytesPerAllocator':STAGE_CHUNKS*CHUNK_BYTES,**identities})
            take('ramp');state='ramping'
            for item in kernel.children:kernel.send(item,b'R')
            kernel.await_stage('F',allow_oom=True)
            state='ramp-complete';kernel.emit({'type':'ramp-complete','phase':phase,'allocationCapPerChild':MAX_CHUNKS*CHUNK_BYTES})
        take('release');state='released';normal=True
    except (Stop,OSError,ValueError) as e:reason=str(e) if isinstance(e,Stop) else type(e).__name__
    finally:
        try:cleanup=kernel.cleanup(normal)
        except BaseException as e:cleanup={'known':False,'allOwnChildrenReaped':False,'errors':[type(e).__name__]}
        if cleanup.get('known') is not True:BLOCKED=True
    children=[{k:v for k,v in x.items() if k not in ('command','report','pidfd')} for x in kernel.children]
    clean_outcomes=all(x.get('pinAcquired') is True and not x.get('cleanupSignals') and
        (x.get('returncode')==0 or phase=='memory' and x.get('returncode')==-signal.SIGKILL) for x in children)
    expected=clean_outcomes and (fork_errno==errno.EAGAIN and bool(children) if phase=='tasks' else any(x.get('returncode')==-signal.SIGKILL for x in children))
    return {'version':1,'kind':'FIXED_CANDIDATE_RESOURCE_WORKLOAD','phase':phase,'state':state,'reason':reason,'releaseHistory':history,
        'normalRelease':normal,'expectedWorkloadOutcome':normal and expected and cleanup['known'],'forkErrno':fork_errno,'children':children,'cleanup':cleanup,
        'resourceEnforcementValidated':False,'productionReady':False,'modelCalls':0,'credentialFilesRead':0}


def admission():
    if sys.platform!='linux' or os.path.abspath(__file__)!=INSTALLED or os.getcwd()!='/work/exec-worker':raise Stop('REVIEWED_WORKER_PROFILE_REQUIRED')
    fd=os.open(INSTALLED,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or not os.fstatvfs(fd).f_flag&os.ST_RDONLY:raise Stop('READONLY_PROFILE_REQUIRED')
    finally:os.close(fd)
    fd=os.open('/proc/self/status',os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
    try:raw=os.read(fd,4097)
    finally:os.close(fd)
    if len(raw)>4096:raise Stop('STATUS_BOUND')
    fields=dict(line.split(':',1) for line in raw.decode('ascii').splitlines() if ':' in line)
    if fields.get('NoNewPrivs','').strip()!='1' or fields.get('Seccomp','').strip()!='2' or any(int(fields.get(k,'1').strip(),16)!=0 for k in ('CapEff','CapBnd')):raise Stop('LOCKDOWN_REQUIRED')
    if os.readlink('/proc/self/ns/pid')!=os.readlink('/proc/1/ns/pid'):raise Stop('FRESH_PROC_REQUIRED')


def main():
    began=time.monotonic()
    phases={'--inside-tasks':'tasks','--inside-memory':'memory'}
    if len(sys.argv)!=2 or sys.argv[1] not in phases:raise Stop('FIXED_REVIEWED_PROFILE_ONLY')
    admission();kernel=Kernel(began);result=run(phases[sys.argv[1]],kernel)
    result['elapsedMs']=(time.monotonic()-began)*1000
    if result['elapsedMs']>=TOTAL_SECONDS*1000:result['reason']=result['reason'] or 'TOTAL_DEADLINE';result['expectedWorkloadOutcome']=False
    kernel.emit(result)
    return 0 if result['expectedWorkloadOutcome'] and time.monotonic()-began<TOTAL_SECONDS else 1


if __name__=='__main__':raise SystemExit(main())
