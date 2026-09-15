"""One real environment bootstrap followed by one fixed worker; no injected RPC."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time
import types

PROFILE='environment-trusted-cli-worker'
BASE='/usr/bin/exec-server-worker-gate.py'
BASE_SHA='2311f43aba1e79460391e720f113578db059fba45819266e104b559e12278d35'
POLICY='/usr/bin/appserver-noenv.py'
POLICY_SHA='08c2e49b18f67502d5c752b266b8d0294b27126e95ba014e138ea747c76c9429'
ENVIRONMENT={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':'/work/executor-home',
    'CODEX_HOME':'/work/executor-home','TMPDIR':'/work/executor-home/tmp'}
MAX_LINE=131072
MAX_QUEUE=262144
MAX_EVIDENCE=2*1024*1024
_UNKNOWN=False
TRACE='/work/executor-home/real-client-fixed-worker-gate-terminal.json'
MAX_TERMINAL=MAX_EVIDENCE+65536


def need(value,reason):
    if not value:raise ValueError(reason)


def encode(value):return json.dumps(value,separators=(',',':'),sort_keys=True,allow_nan=False).encode()


def load_base(raw):
    need(type(raw) is bytes and hashlib.sha256(raw).hexdigest()==BASE_SHA,'FIXED_BASE_SOURCE')
    module=types.ModuleType('private_real_client_base');module.__file__=BASE
    exec(compile(raw,BASE,'exec'),module.__dict__)
    original=module.profile_start_request
    def request(profile):
        frame=original(profile)
        if profile=='trusted-cli-worker-boundary':frame['id']=5
        return frame
    module.profile_start_request=request
    return module


def fixed_source(path,expected):
    global _UNKNOWN
    need((path,expected) in ((BASE,BASE_SHA),(POLICY,POLICY_SHA)),'FIXED_SOURCE_PAIR')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        need(stat.S_ISREG(os.fstat(fd).st_mode),'SOURCE_REGULAR')
        raw=os.read(fd,131073)
        need(len(raw)<=131072 and hashlib.sha256(raw).hexdigest()==expected,'SOURCE_HASH')
        return raw
    finally:
        try:os.close(fd)
        except BaseException:_UNKNOWN=True;raise


def fixed_policy():
    raw=fixed_source(POLICY,POLICY_SHA)
    module=types.ModuleType('private_real_client_policy');module.__file__=POLICY
    exec(compile(raw,POLICY,'exec'),module.__dict__)
    return module


class Protocol:
    def __init__(self,raw,pid_namespace,mount_namespace):
        self.base=load_base(raw)
        self.metadata=self.base.Gate(pid_namespace,mount_namespace,'environment-bootstrap-metadata')
        self.worker=self.base.Gate(pid_namespace,mount_namespace,'trusted-cli-worker-boundary')
        self.current=self.metadata;self.failed=False;self.events=[];self.evidence_bytes=0
        self.received={'client':0,'server':0};self.worker_selected=False

    @property
    def pending(self):return self.current.pending

    @property
    def complete(self):
        return (not self.failed and self.worker_selected and self.worker.closed and self.worker.exited
            and not self.pending and self.worker.awaiting is None)

    def record(self,kind,raw):
        item={'kind':kind,'rawHex':raw.hex()}
        size=len(encode(item))
        need(self.evidence_bytes+size<=MAX_EVIDENCE,'REAL_CLIENT_EVIDENCE_BOUND')
        self.events.append(item);self.evidence_bytes+=size

    def receive(self,side,raw):
        try:
            need(not self.failed and side in ('client','server') and type(raw) is bytes
                and raw.endswith(b'\n') and b'\n' not in raw[:-1] and len(raw)<=MAX_LINE,'REAL_CLIENT_FRAME')
            self.received[side]+=len(raw)
            need(self.received[side]<=(65536 if side=='client' else 8388608),'REAL_CLIENT_BYTE_BOUND')
            self.record(side,raw)
            frame=self.base.strict_json(raw)
            if side=='client':
                if not self.worker_selected:
                    if self.metadata.complete:
                        need(not self.metadata.awaiting and not self.metadata.pending and frame.get('method')=='process/start','FIXED_PROCESS_AFTER_BOOTSTRAP')
                        self.worker.initialized=True;self.worker.init_ok=True;self.worker.identifier=4
                        self.current=self.worker;self.worker_selected=True
                    else:
                        # Exactly info id2 and two unique stat ids3/4, not a repeated info.
                        method=frame.get('method') if type(frame) is dict else None
                        if method=='environment/info':need(frame.get('id')==2 and not self.metadata.metadata_ok,'ONE_ENVIRONMENT_INFO')
                        if method=='fs/getMetadata':need(frame.get('id') in (3,4),'FIXED_STAT_IDS')
                self.current.admit(frame)
            else:
                self.current.receive(frame)
                if self.worker_selected and frame.get('method')=='process/exited':
                    value=frame['params']
                    need(type(value.get('exitCode')) is int and value['exitCode']==0
                        and value.get('sandboxDenied') is False,'FIXED_WORKER_COMPLETION')
                if self.worker_selected and type(frame) is dict and type(frame.get('result')) is dict:
                    value=frame['result']
                    if 'chunks' in value and value.get('closed') is True:
                        need(value.get('exited') is True and type(value.get('exitCode')) is int and value['exitCode']==0
                            and value.get('failure') is None and value.get('sandboxDenied') is False,'FIXED_WORKER_COMPLETION')
                        self.worker.exited=True;self.worker.closed=True
        except BaseException:
            self.failed=True;raise

    def written(self,count):
        try:
            need(not self.failed and type(count) is int and 0<count<=len(self.pending),'REAL_CLIENT_WRITE_COUNT')
            raw=bytes(self.pending[:count]);self.record('forwarded',raw)
            self.current.written(count)
        except BaseException:self.failed=True;raise

    def report(self):
        return {'version':1,'profile':PROFILE,'baseSha256':BASE_SHA,'events':self.events,
            'receivedBytes':dict(self.received),'complete':self.complete,'failed':self.failed,
            'clientDelivery':'not-attested','remoteCleanup':'not-attested','productionReady':False}


def validate_report(report,raw,pid_namespace,mount_namespace):
    try:
        need(type(report) is dict and type(report.get('events')) is list,'REPORT')
        protocol=Protocol(raw,pid_namespace,mount_namespace)
        for item in report['events']:
            need(type(item) is dict and set(item)=={'kind','rawHex'} and type(item['rawHex']) is str,'EVENT')
            block=bytes.fromhex(item['rawHex']);need(block.hex()==item['rawHex'],'HEX')
            if item['kind']=='forwarded':
                need(bytes(protocol.pending[:len(block)])==block,'FORWARDED_BYTES')
                protocol.written(len(block))
            else:protocol.receive(item['kind'],block)
        return protocol.complete and encode(protocol.report())==encode(report)
    except (ValueError,TypeError,KeyError,AttributeError,RecursionError):return False


def validate_terminal(report,raw,pid_namespace,mount_namespace):
    """Offline consistency check, not independent OS or remote cleanup evidence."""
    try:
        need(type(report) is dict and set(report)=={'version','profile','protocol','error',
            'ownedHandlesKnown','processReaped','executorExitCode','outerPidNamespace',
            'outerMountNamespace','transport','remoteCleanup','productionReady'},'TERMINAL_SHAPE')
        need(type(report['version']) is int and report['version']==1 and report['profile']==PROFILE
            and report['error'] is None and report['ownedHandlesKnown'] is True
            and report['processReaped'] is True and type(report['executorExitCode']) is int
            and report['executorExitCode']==0 and report['outerPidNamespace']==pid_namespace
            and report['outerMountNamespace']==mount_namespace
            and report['remoteCleanup']=='not-attested' and report['productionReady'] is False,'TERMINAL_STATUS')
        need(validate_report(report['protocol'],raw,pid_namespace,mount_namespace),'TERMINAL_PROTOCOL')
        transport=report['transport']
        need(type(transport) is dict and set(transport)=={'observedBytes','partialHex',
            'stderrSha256','eofObserved','undeliveredServerBytes','undeliveredStderrBytes'},'TRANSPORT_SHAPE')
        need(encode(transport['partialHex'])==encode({'client':'','server':''})
            and transport['eofObserved']==['client','server','stderr'],'TRANSPORT_EOF')
        for key in ('undeliveredServerBytes','undeliveredStderrBytes'):
            need(type(transport[key]) is int and transport[key]==0,'TRANSPORT_UNDELIVERED')
        observed=transport['observedBytes'];received=report['protocol']['receivedBytes']
        need(type(observed) is dict and set(observed)=={'client','server','stderr'}
            and all(type(v) is int and v>=0 for v in observed.values()),'TRANSPORT_COUNTS')
        need(observed['client']==received['client'] and observed['server']==received['server']
            and observed['client']<=65536 and observed['server']+observed['stderr']<=8388608,'TRANSPORT_BOUND')
        digest=transport['stderrSha256']
        need(type(digest) is str and len(digest)==64 and bytes.fromhex(digest).hex()==digest,'STDERR_DIGEST')
        if observed['stderr']==0:need(digest==hashlib.sha256(b'').hexdigest(),'EMPTY_STDERR_DIGEST')
        return True
    except (ValueError,TypeError,KeyError,AttributeError,RecursionError):return False


def read_terminal(raw,pid_namespace,mount_namespace):
    """Read the owned terminal after gate exit; no caller path or OS attestation."""
    global _UNKNOWN
    need(not _UNKNOWN,'PRIOR_REAL_CLIENT_CLEANUP_UNKNOWN')
    base=load_base(raw)  # Refuse a changed validator before touching the trace.
    fd=os.open(TRACE,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and 0<before.st_size<=MAX_TERMINAL,'TERMINAL_FILE_BOUND')
        data=bytearray()
        while len(data)<=before.st_size:
            block=os.read(fd,min(65536,before.st_size+1-len(data)))
            if not block:break
            data.extend(block)
        after=os.fstat(fd)
        fields=('st_dev','st_ino','st_mode','st_size','st_mtime_ns','st_ctime_ns')
        need(len(data)==before.st_size and all(getattr(before,k)==getattr(after,k) for k in fields),
            'TERMINAL_CHANGED_OR_PARTIAL')
    finally:
        try:os.close(fd)
        except BaseException:_UNKNOWN=True;raise
    data=bytes(data)
    need(data.endswith(b'\n') and b'\n' not in data[:-1],'TERMINAL_FRAMING')
    report=base.strict_json(data)
    need(validate_terminal(report,raw,pid_namespace,mount_namespace),'TERMINAL_REPLAY_FAILED')
    return {'rawHex':data.hex(),'rawBytes':len(data),'rawSha256':hashlib.sha256(data).hexdigest(),
        'report':report,'protocolValidated':True,'remoteCleanup':'not-attested','productionReady':False}


def publish(report,deadline):
    global _UNKNOWN
    raw=encode(report)+b'\n';need(len(raw)<=MAX_TERMINAL,'TERMINAL_EVIDENCE_BOUND')
    need(time.monotonic()<deadline,'TRACE_DEADLINE')
    fd=os.open(TRACE,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,0o600)
    try:
        need(stat.S_ISREG(os.fstat(fd).st_mode),'TRACE_REGULAR')
        offset=0
        while offset<len(raw):
            need(time.monotonic()<deadline,'TRACE_DEADLINE')
            count=os.write(fd,raw[offset:]);need(type(count) is int and 0<count<=len(raw)-offset,'TRACE_WRITE')
            offset+=count
    finally:
        try:os.close(fd)
        except BaseException:_UNKNOWN=True;raise
    need(time.monotonic()<deadline,'TRACE_FINAL_DEADLINE')


def run(raw,environment,pid_namespace,mount_namespace):
    """Own stdio loop. Setup exceptions retain Popen for bounded cleanup."""
    global _UNKNOWN
    need(not _UNKNOWN,'PRIOR_REAL_CLIENT_CLEANUP_UNKNOWN')
    need(encode(environment)==encode(ENVIRONMENT),'FIXED_EXECUTOR_ENVIRONMENT')
    protocol=Protocol(raw,pid_namespace,mount_namespace);base=protocol.base
    deadline=time.monotonic()+180;process=None;selector=None;pin=None;known=True
    partial={'client':bytearray(),'server':bytearray()};output=bytearray();stderr=bytearray()
    eof=set();cleanup=False;error=None;stderr_bytes=0
    observed={'client':0,'server':0,'stderr':0};stderr_digest=hashlib.sha256()
    def check():need(time.monotonic()<deadline,'REAL_CLIENT_DEADLINE')
    def consume(side):
        while b'\n' in partial[side] and not (side=='client' and protocol.pending):
            line,_,rest=partial[side].partition(b'\n');partial[side]=bytearray(rest)
            frame=bytes(line)+b'\n';protocol.receive(side,frame)
            if side=='server':output.extend(frame)
        need(len(partial[side])<=MAX_LINE,'PARTIAL_LINE_BOUND')
    try:
        base.verify_bootstrap_absence();base.verify_control_marker();check()
        policy=fixed_policy()
        argv=tuple(policy.ARGV[:-2])+('exec-server','--listen','stdio')
        process=subprocess.Popen(argv,cwd='/work',env=environment,stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
        selector=selectors.DefaultSelector();pin=os.pidfd_open(process.pid)
        for fd in (0,1,2,process.stdin.fileno(),process.stdout.fileno(),process.stderr.fileno()):os.set_blocking(fd,False)
        for fd,side in ((0,'client'),(process.stdout.fileno(),'server'),(process.stderr.fileno(),'stderr')):
            selector.register(fd,selectors.EVENT_READ,side)
        while True:
            check()
            need(time.monotonic()<deadline-12,'REAL_CLIENT_CLEANUP_RESERVE')
            for fd,buffer in ((1,output),(2,stderr)):
                if buffer:
                    try:
                        count=os.write(fd,buffer);need(type(count) is int and 0<count<=len(buffer),'OUTPUT_WRITE');del buffer[:count]
                    except BlockingIOError:pass
            if protocol.pending and not cleanup:
                try:
                    count=os.write(process.stdin.fileno(),protocol.pending);protocol.written(count)
                except BlockingIOError:pass
            if not cleanup:consume('client')
            # Exit can precede reading the final frames already buffered in pipes.
            if process.poll() is not None and {'server','stderr'}<=eof:
                need(protocol.complete and process.returncode==0,'EXECUTOR_EARLY_EXIT')
                if 'client' in eof and not output and not stderr:return 0
            events=selector.select(.01);check()
            for key,_ in events:
                side=key.data
                if side=='client' and protocol.pending:continue
                target=stderr if side=='stderr' else output
                if side!='client' and len(target)>MAX_QUEUE-4096-MAX_LINE:continue
                try:block=os.read(key.fd,4096)
                except BlockingIOError:continue
                check()
                if not block:
                    selector.unregister(key.fd);eof.add(side)
                    need(side=='stderr' or not partial[side],'PARTIAL_EOF')
                    if side=='client':
                        need(protocol.complete,'CLIENT_EOF_INCOMPLETE');process.stdin.close();cleanup=True
                    continue
                observed[side]+=len(block)
                need(observed['client']<=65536 and observed['server']+observed['stderr']<=8388608,'RAW_TRANSPORT_BOUND')
                if side=='stderr':
                    stderr_bytes+=len(block);stderr_digest.update(block);stderr.extend(block);continue
                partial[side].extend(block)
                # At most one queued client frame until its bytes actually drain.
                consume(side)
    except BaseException as failure:
        error=type(failure).__name__;return 1
    finally:
        # Sole waiter for exactly this Popen. Never signal a caller PID or manager.
        if process is not None:
            try:
                if process.poll() is None:
                    try:process.terminate()
                    except OSError:pass
                    try:process.wait(timeout=max(.001,min(5,deadline-time.monotonic())))
                    except subprocess.TimeoutExpired:
                        try:process.kill()
                        except OSError:pass
                        process.wait(timeout=max(.001,min(1,deadline-time.monotonic())))
                need(process.poll() is not None,'OWN_PROCESS_UNKNOWN')
            except BaseException:known=False
        calls=[]
        if selector is not None:calls.append(selector.close)
        if pin is not None:calls.append(lambda:os.close(pin))
        if process is not None:calls.extend(p.close for p in (process.stdin,process.stdout,process.stderr) if not p.closed)
        for close in calls:
            try:close()
            except BaseException:known=False
        if not known or time.monotonic()>=deadline:_UNKNOWN=True
        terminal={'version':1,'profile':PROFILE,'protocol':protocol.report(),'error':error,
            'ownedHandlesKnown':known,'processReaped':process is not None and process.returncode is not None,
            'executorExitCode':process.returncode if process is not None else None,
            'outerPidNamespace':pid_namespace,'outerMountNamespace':mount_namespace,
            'transport':{'observedBytes':observed,'partialHex':{k:bytes(v).hex() for k,v in partial.items()},
                'stderrSha256':stderr_digest.hexdigest(),'eofObserved':sorted(eof),
                'undeliveredServerBytes':len(output),'undeliveredStderrBytes':len(stderr)},
            'remoteCleanup':'not-attested','productionReady':False}
        try:publish(terminal,deadline)
        except BaseException:_UNKNOWN=True;raise
        if _UNKNOWN:raise ValueError('REAL_CLIENT_CLEANUP_UNKNOWN')


def main():
    global _UNKNOWN
    need(sys.platform=='linux' and sys.argv[1:]==['--inside'],'FIXED_REAL_CLIENT_ENTRY')
    need(not _UNKNOWN,'PRIOR_REAL_CLIENT_CLEANUP_UNKNOWN')
    need(os.statvfs('/usr/bin').f_flag&os.ST_RDONLY,'READONLY_IMAGE')
    raw=fixed_source(BASE,BASE_SHA)
    base=load_base(raw)
    return run(raw,base.prepare_home(),os.readlink('/proc/self/ns/pid'),os.readlink('/proc/self/ns/mnt'))


if __name__=='__main__':raise SystemExit(main())
