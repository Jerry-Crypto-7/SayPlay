"""Owned metadata-only service and retained common-view observation. No workload."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time
import types
import uuid

FILES = ('subscription-cgroup-common-view-service.py','subscription-cgroup-common-view.py',
         'subscription-cgroup-common-view-child.py','subscription-systemd-fixture-transport.py',
         'subscription-systemd-cli-probe.py')
ROOT = Path('/mnt/d/claude/Hackaton/scripts')
MAX_REPORT = 2*1024*1024
MAX_CHILD = 512*1024
TOTAL_SECONDS = 30
_UNKNOWN = False
_ACTIVE_CANCEL = None


def encode(value):return json.dumps(value,separators=(',',':'),sort_keys=True,allow_nan=False).encode()
def same(a,b):return encode(a)==encode(b)
def require(value,reason):
    if not value:raise ValueError(reason)
def check(deadline):
    if _ACTIVE_CANCEL is not None and _ACTIVE_CANCEL.is_set():
        raise ValueError('COMMON_SERVICE_CANCELLED')
    require(time.monotonic()<deadline,'COMMON_SERVICE_DEADLINE')
def label(error):
    value=str(error)
    return type(error).__name__+(':'+value if type(error) is ValueError and re.fullmatch('[A-Z_]{1,128}',value) else '')


def strict(raw):
    def pairs(items):
        value={}
        for key,item in items:
            require(key not in value,'COMMON_SERVICE_DUPLICATE_KEY');value[key]=item
        return value
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('COMMON_SERVICE_NONFINITE')))


def source_hashes_valid(value):
    return type(value) is dict and set(value)==set(FILES) and all(type(v) is str and re.fullmatch('[a-f0-9]{64}',v) for v in value.values())


def sources(expected,deadline):
    global _UNKNOWN
    require(source_hashes_valid(expected),'COMMON_SERVICE_SOURCES')
    result={}
    for name in FILES:
        check(deadline);fd=os.open(str(ROOT/name),os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
        data=bytearray()
        try:
            before=os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and 0<before.st_size<=1048576,'COMMON_SERVICE_SOURCE_FILE')
            while True:
                check(deadline);chunk=os.read(fd,min(4096,1048577-len(data)))
                if not chunk:break
                data.extend(chunk);require(len(data)<=1048576,'COMMON_SERVICE_SOURCE_BOUND')
            after=os.fstat(fd)
            require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==
                    (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'COMMON_SERVICE_SOURCE_CHANGED')
        finally:
            try:os.close(fd)
            except BaseException:_UNKNOWN=True;raise
        check(deadline);require(hashlib.sha256(data).hexdigest()==expected[name],'COMMON_SERVICE_SOURCE_HASH')
        result[name]=bytes(data)
    return result


def dependencies(raw):
    modules=[]
    for name in FILES[1:]:
        module=types.ModuleType('private_'+name.replace('-','_'));module.__file__=str(ROOT/name)
        exec(compile(raw[name],module.__file__,'exec'),module.__dict__);modules.append(module)
    return tuple(modules)  # sampler, child, relay, probe; exact captured bytes.


def command(unit):
    require(type(unit) is str and re.fullmatch('codex-cli-resource-[a-f0-9]{32}\\.service',unit),'COMMON_SERVICE_UNIT')
    return ['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--collect','--unit='+unit,
        '--property=MemoryMax=2147483648','--property=MemorySwapMax=0','--property=TasksMax=64',
        '--property=RuntimeMaxSec=20','--property=TimeoutStopSec=5','--property=KillMode=control-group',
        '--property=WorkingDirectory=/', '/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C',
        '/usr/bin/python3','-I','-S','/mnt/d/claude/Hackaton/scripts/subscription-cgroup-common-view-child.py']


def live(fd):
    poll=select.poll();poll.register(fd,select.POLLIN)
    require(poll.poll(0)==[],'COMMON_SERVICE_PIN_EXITED')
    signal.pidfd_send_signal(fd,0)


def exited_pin(fd):
    poll=select.poll();poll.register(fd,select.POLLIN)
    events=poll.poll(0)
    require(len(events)==1 and events[0][0]==fd and events[0][1]&select.POLLIN
        and events[0][1]&~(select.POLLIN|select.POLLHUP)==0,'COMMON_SERVICE_EXIT_PIN_UNKNOWN')
    error=None
    try:signal.pidfd_send_signal(fd,0)
    except OSError as failure:error=failure.errno
    require(error==3,'COMMON_SERVICE_EXIT_ESRCH_REQUIRED')
    return {'exitReady':True,'pollFlags':events[0][1],'signalZeroErrno':error}


def process_generation(pid,fd,expected,deadline):
    check(deadline);live(fd)
    target='/proc/'+str(pid)+'/stat'
    handle=os.open(target,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:raw=os.read(handle,4097)
    finally:os.close(handle)
    require(len(raw)<=4096,'COMMON_SERVICE_STAT_BOUND')
    fields=raw.decode('ascii').rsplit(') ',1)[1].split()
    require(len(fields)>=20 and fields[0] not in ('Z','X','x') and fields[19]==expected,'COMMON_SERVICE_GENERATION')
    live(fd);check(deadline)
    return {'pid':pid,'startTicks':fields[19],'state':fields[0],'rawStatHex':raw.hex(),'rawStatSha256':hashlib.sha256(raw).hexdigest()}


def write_all(fd,raw,deadline):
    offset=0
    while offset<len(raw):
        check(deadline);_,ready,_=select.select([],[fd],[],max(0,deadline-time.monotonic()));check(deadline)
        if not ready:continue
        try:count=os.write(fd,raw[offset:offset+4096])
        except BlockingIOError:continue
        require(type(count) is int and count>0,'COMMON_SERVICE_WRITE');offset+=count
    check(deadline)


class Capture:
    def __init__(self):self.selector=None;self.stdout=bytearray();self.stderr=bytearray();self.eof={'stdout':False,'stderr':False}
    def open(self,process):
        self.selector=selectors.DefaultSelector()
        for name in ('stdout','stderr'):
            pipe=getattr(process,name);os.set_blocking(pipe.fileno(),False);self.selector.register(pipe,selectors.EVENT_READ,name)
    def read(self,deadline,until_line=False):
        while not all(self.eof.values()):
            check(deadline)
            events=self.selector.select(min(.05,max(0,deadline-time.monotonic())));check(deadline)
            for key,_ in events:
                try:chunk=os.read(key.fileobj.fileno(),4096)
                except BlockingIOError:continue
                if not chunk:self.eof[key.data]=True;self.selector.unregister(key.fileobj);continue
                target=getattr(self,key.data);target.extend(chunk)
                require(len(target)<=(MAX_CHILD if key.data=='stdout' else 65536),'COMMON_SERVICE_OUTPUT_BOUND')
            if until_line and b'\n' in self.stdout:return
        require(not until_line,'COMMON_SERVICE_REPORT_EOF')
    def close(self):
        if self.selector is not None:self.selector.close();self.selector=None


def wait_main(probe,unit,deadline):
    while True:
        check(deadline)
        result=subprocess.run(['/usr/bin/systemctl','--user','--no-ask-password','show',unit,'--property=MainPID'],
            env=probe.environment(),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
            timeout=min(1,max(.001,deadline-time.monotonic())),check=False)
        check(deadline);require(len(result.stdout)<=128,'COMMON_SERVICE_MAINPID_BOUND')
        if result.returncode==0 and re.fullmatch(rb'MainPID=[1-9][0-9]{0,9}\n',result.stdout):return
        time.sleep(min(.025,max(0,deadline-time.monotonic())))


def cleanup(process,created,unit,relay,probe,capture,view,pins,deadline,helper_pin=None):
    errors=[]
    def attempt(name,call):
        try:return call()
        except BaseException as error:errors.append(name+':'+type(error).__name__);return None
    if process is not None:attempt('STDIN_CLOSE',process.stdin.close)
    if view is not None and attempt('VIEW_CLOSE',view.close) is not True:errors.append('VIEW_CLOSE_UNKNOWN')
    if created:
        # A collected natural exit needs no stop. Otherwise a failed stop stays
        # a failure even if a later independent absence check succeeds.
        already_absent=attempt('BEFORE_STOP_ABSENCE',lambda:relay.unit_absent(probe,unit))
        if already_absent is not True:
            stopped=attempt('UNIT_STOP',lambda:subprocess.run(['/usr/bin/systemctl','--user','--no-ask-password','stop',unit],
                env=probe.environment(),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                timeout=min(3,max(.001,deadline-time.monotonic())),check=False))
            if stopped is None or type(stopped.returncode) is not int or stopped.returncode!=0:errors.append('UNIT_STOP_FAILED')
    if process is not None:
        attempt('FINAL_DRAIN',lambda:capture.read(min(deadline,time.monotonic()+2)))
        try:process.wait(timeout=min(2,max(.001,deadline-time.monotonic())))
        except BaseException:
            errors.append('LOCAL_WAIT_FAILED')
            attempt('LOCAL_KILL',process.kill)
            attempt('LOCAL_REAP',lambda:process.wait(timeout=min(1,max(.001,deadline-time.monotonic()))))
    attempt('SELECTOR_CLOSE',capture.close)
    outcome=attempt('HELPER_PIN_OUTCOME',lambda:exited_pin(helper_pin)) if helper_pin is not None else None
    for fd in pins:attempt('PIN_CLOSE',lambda fd=fd:os.close(fd))
    if process is not None:
        for name in ('stdout','stderr'):attempt('PIPE_CLOSE',getattr(process,name).close)
    absent=attempt('UNIT_ABSENCE',lambda:relay.unit_absent(probe,unit)) if relay is not None else None
    def leaf_absent():
        try:os.lstat(probe.leaf_path(unit));return False
        except FileNotFoundError:return True
    leaf=attempt('LEAF_ABSENCE',leaf_absent) if probe is not None else None
    attempt('CLEANUP_DEADLINE',lambda:check(deadline))
    return {'unitAbsent':absent,'leafAbsent':leaf,'systemdRunClosed':process is not None and process.returncode is not None,
            'localHandlesClosed':not errors,'errors':errors,'notSpawned':not created,'helperPinOutcome':outcome}


def run(expected_source_hashes, *, _deadline=None, _cancel_event=None):
    global _UNKNOWN, _ACTIVE_CANCEL
    require(_cancel_event is None or type(_cancel_event) is threading.Event,'COMMON_SERVICE_FIXED_CANCEL_EVENT')
    require(not _UNKNOWN,'COMMON_SERVICE_PRIOR_UNKNOWN');_UNKNOWN=True
    _ACTIVE_CANCEL=_cancel_event
    deadline=time.monotonic()+TOTAL_SECONDS if _deadline is None else _deadline
    work=min(deadline-10,time.monotonic()+20)
    unit='codex-cli-resource-'+uuid.uuid4().hex+'.service'
    report={'version':1,'type':'common_view_service','unit':unit,'command':command(unit),
        'sourceSha256':copy.deepcopy(expected_source_hashes),'commonViewValidated':False,
        'productionReady':False,'modelCalls':0,'errors':[]}
    process=None;created=False;view=None;pins=[];main_fd=None;relay=probe=sampler=None;capture=Capture();raw=None
    try:
        check(work)
        raw=sources(expected_source_hashes,work);sampler,child,relay,probe=dependencies(raw)
        require(relay.unit_absent(probe,unit),'COMMON_SERVICE_UNIT_EXISTS')
        try:os.lstat(probe.leaf_path(unit))
        except FileNotFoundError:pass
        else:raise ValueError('COMMON_SERVICE_LEAF_EXISTS')
        manager=relay.manager_connection(probe);report['manager']=manager
        manager_fd=os.pidfd_open(manager['managerPid']);pins.append(manager_fd);os.set_inheritable(manager_fd,False);live(manager_fd)
        require(relay.process_start_ticks(manager['managerPid'])==manager['managerStartTimeTicks'],'COMMON_SERVICE_MANAGER_GENERATION')
        check(work)
        process=subprocess.Popen(command(unit),env=probe.environment(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        created=True
        capture.open(process);os.set_blocking(process.stdin.fileno(),False)
        wait_main(probe,unit,min(work,time.monotonic()+2))
        before=relay.binding(probe,unit,manager,manager_fd);report['bindingBefore']=before
        main_fd=os.pidfd_open(before['unitMainPid']);pins.append(main_fd);os.set_inheritable(main_fd,False)
        report['mainBefore']=process_generation(before['unitMainPid'],main_fd,before['unitMainStartTimeTicks'],work)
        report['readbackBefore']=relay.exact_readback(probe,unit)
        window=min(work,time.monotonic()+5);view=sampler.open_self_view(window)
        report['observerBefore']=view.sample()
        admission={'type':'common_view_sample','sourceSha256':{name:expected_source_hashes[name] for name in child.FILES}}
        write_all(process.stdin.fileno(),encode(admission)+b'\n',window)
        capture.read(window,True)
        require(bytes(capture.stdout).count(b'\n')==1 and capture.stdout.endswith(b'\n'),'COMMON_SERVICE_SINGLE_REPORT')
        helper=strict(bytes(capture.stdout));report['helper']=helper
        require(type(helper) is dict and set(helper)=={'version','type','sourceSha256','observation','productionReady','modelCalls'}
            and same({k:helper[k] for k in ('version','type','sourceSha256','productionReady','modelCalls')},
                {'version':1,'type':'common_view_sample','sourceSha256':admission['sourceSha256'],'productionReady':False,'modelCalls':0}),
            'COMMON_SERVICE_HELPER_ENVELOPE')
        report['observerAfter']=view.sample()
        after=relay.binding(probe,unit,manager,manager_fd);report['bindingAfter']=after
        require(same(before,after),'COMMON_SERVICE_BINDING_DRIFT')
        report['mainAfter']=process_generation(before['unitMainPid'],main_fd,before['unitMainStartTimeTicks'],window)
        report['readbackAfter']=relay.exact_readback(probe,unit);check(window)
        binding={'unit':unit,'uid':os.getuid(),'mainPid':before['unitMainPid'],
                 'mainStartTicks':before['unitMainStartTimeTicks'],'controlGroup':before['unitMainCgroup']}
        report['expectedBinding']=binding
        require(sampler.validate_common_view(report['observerBefore'],helper['observation'],report['observerAfter'],binding),'COMMON_SERVICE_VIEW_MISMATCH')
        require(view.close() is True,'COMMON_SERVICE_VIEW_CLOSE');view=None
        check(window)
        write_all(process.stdin.fileno(),b'{"type":"common_view_release"}\n',work)
        capture.read(work)
        process.wait(timeout=max(.001,work-time.monotonic()));check(work)
        require(process.returncode==0,'COMMON_SERVICE_CHILD_EXIT')
        require(sources(expected_source_hashes,work)==raw,'COMMON_SERVICE_FINAL_SOURCE_DRIFT')
        report['sourceSha256After']=dict(expected_source_hashes)
    except BaseException as error:report['errors'].append(label(error))
    finally:
        # Cancellation must stop work but never skip owned process/FD cleanup.
        _ACTIVE_CANCEL=None
        report['cleanup']=cleanup(process,created,unit,relay,probe,capture,view,pins,deadline,main_fd)
        report.update(rawStdoutHex=bytes(capture.stdout).hex(),rawStderrHex=bytes(capture.stderr).hex(),
                      streamEOF=capture.eof,exitCode=process.returncode if process is not None else None)
    if _cancel_event is not None and _cancel_event.is_set():
        reason='ValueError:COMMON_SERVICE_CANCELLED'
        if reason not in report['errors']:report['errors'].append(reason)
    report['commonViewValidated']=validate_report(report,expected_source_hashes,(sampler,)) if sampler is not None else False
    try:
        require(len(encode(report))+1<=MAX_REPORT,'COMMON_SERVICE_REPORT_BOUND');check(deadline)
        # Last observation before success publication. The caller must also
        # reject a completed result if its own cancellation arrives afterward.
        require(_cancel_event is None or not _cancel_event.is_set(),'COMMON_SERVICE_CANCELLED')
    except BaseException as error:report['errors'].append(label(error));report['commonViewValidated']=False
    if report['commonViewValidated']:_UNKNOWN=False
    return report


def validate_report(report,expected_source_hashes,deps):
    try:
        sampler,=deps
        require(source_hashes_valid(expected_source_hashes),'SOURCES')
        require(same(report['sourceSha256'],expected_source_hashes) and same(report['sourceSha256After'],expected_source_hashes),'SOURCES')
        require(type(report['version']) is int and report['version']==1 and report['type']=='common_view_service','ENVELOPE')
        require(report['productionReady'] is False and type(report['modelCalls']) is int and report['modelCalls']==0,'CREDIT')
        require(report['errors']==[] and same(report['streamEOF'],{'stdout':True,'stderr':True}) and report['rawStderrHex']=='','ERROR')
        require(type(report['exitCode']) is int and report['exitCode']==0,'EXIT')
        cleanup_report=report['cleanup'];outcome=cleanup_report['helperPinOutcome']
        require(same({k:v for k,v in cleanup_report.items() if k!='helperPinOutcome'},
            {'unitAbsent':True,'leafAbsent':True,'systemdRunClosed':True,'localHandlesClosed':True,'errors':[],'notSpawned':False}),'CLEANUP')
        require(type(outcome) is dict and set(outcome)=={'exitReady','pollFlags','signalZeroErrno'} and outcome['exitReady'] is True
            and type(outcome['pollFlags']) is int and outcome['pollFlags'] in (1,17)
            and type(outcome['signalZeroErrno']) is int and outcome['signalZeroErrno']==3,'PIN_EXIT')
        require(same(report['command'],command(report['unit'])),'COMMAND')
        require(same(report['bindingBefore'],report['bindingAfter']),'BINDING')
        b=report['bindingBefore'];expected={'unit':report['unit'],'uid':b['managerUid'],'mainPid':b['unitMainPid'],
            'mainStartTicks':b['unitMainStartTimeTicks'],'controlGroup':b['unitMainCgroup']}
        require(same(expected,report['expectedBinding']),'BINDING')
        require(same({k:b[k] for k in report['manager']},report['manager']),'MANAGER')
        require(valid_binding(b,report['manager'],report['observerBefore'],expected),'MANAGER_BINDING')
        for name in ('mainBefore','mainAfter'):
            value=report[name];raw=bytes.fromhex(value['rawStatHex']);parts=raw.decode('ascii').rsplit(') ',1)[1].split()
            require(raw.hex()==value['rawStatHex'] and hashlib.sha256(raw).hexdigest()==value['rawStatSha256'],'STAT')
            require(raw.split(b' (',1)[0]==str(expected['mainPid']).encode() and type(value['pid']) is int
                    and value['pid']==expected['mainPid'] and value['startTicks']==expected['mainStartTicks'] and parts[19]==value['startTicks']
                    and parts[0]==value['state'] and value['state'] not in ('Z','X','x') and int(parts[1])==b['managerPid'],'STAT')
        resource={'memoryMax':'2147483648','memorySwapMax':'0','pidsMax':'64'}
        require(same(report['readbackBefore'],resource) and same(report['readbackAfter'],resource),'READBACK')
        raw=bytes.fromhex(report['rawStdoutHex']);helper=report['helper']
        require(raw.hex()==report['rawStdoutHex'] and len(raw)<=MAX_CHILD and raw.endswith(b'\n') and raw.count(b'\n')==1 and same(strict(raw),helper),'RAW')
        require(type(helper) is dict and set(helper)=={'version','type','sourceSha256','observation','productionReady','modelCalls'},'HELPER')
        require(same({k:helper[k] for k in ('version','type','sourceSha256','productionReady','modelCalls')},
            {'version':1,'type':'common_view_sample','sourceSha256':{name:expected_source_hashes[name] for name in FILES[1:3]},
             'productionReady':False,'modelCalls':0}),'HELPER')
        require(helper['observation']['localHandlesClosed'] is True,'HELPER_CLOSE')
        require(sampler.validate_common_view(report['observerBefore'],helper['observation'],report['observerAfter'],expected) is True,'VIEW')
        require(len(encode(report))+1<=MAX_REPORT,'BOUND')
        return True
    except (ValueError,TypeError,KeyError,IndexError,AttributeError,OverflowError):return False


def valid_binding(b,manager,observer,expected):
    def number(v,minimum=0):return type(v) is int and minimum<=v<=9007199254740991
    manager_keys={'managerIdentityProfile','managerPid','managerUid','managerGid','managerStartTimeTicks','managerSocket','managerCgroup'}
    require(type(manager) is dict and set(manager)==manager_keys and type(b) is dict and
            set(b)==manager_keys|{'driverPid','driverCgroup','unitMainPid','unitMainCgroup','unitMainStartTimeTicks'},'BINDING_SHAPE')
    require(manager['managerIdentityProfile']=='private-socket-peer-v1' and number(b['managerUid']) and number(b['managerGid']),'PEER')
    require(all(number(b[k],2) for k in ('managerPid','driverPid','unitMainPid')) and len({b[k] for k in ('managerPid','driverPid','unitMainPid')})==3,'PIDS')
    require(b['driverPid']==observer['selfIdentity']['pid'] and b['driverCgroup']==observer['membership'],'DRIVER')
    for key in ('managerStartTimeTicks','unitMainStartTimeTicks'):
        require(type(b[key]) is str and re.fullmatch('[0-9]{1,32}',b[key]),'TICKS')
    prefix='/user.slice/user-'+str(b['managerUid'])+'.slice/user@'+str(b['managerUid'])+'.service'
    require(b['managerCgroup']==prefix+'/init.scope' and b['unitMainCgroup']==prefix+'/app.slice/'+expected['unit'],'CGROUP')
    require(b['driverCgroup']!=b['unitMainCgroup'] and not b['driverCgroup'].startswith(b['unitMainCgroup']+'/'),'OUTSIDE')
    socket=manager['managerSocket']
    require(type(socket) is dict and set(socket)=={'path','components'} and socket['path']=='/run/user/'+str(b['managerUid'])+'/systemd/private'
            and type(socket['components']) is list and len(socket['components'])==5,'SOCKET')
    for index,item in enumerate(socket['components']):
        require(type(item) is dict and set(item)=={'dev','ino','mode','uid','gid'} and all(number(v) for v in item.values())
            and item['ino']>0 and item['mode']&0xf000==(0xc000 if index==4 else 0x4000),'SOCKET_COMPONENT')
    require(socket['components'][-1]['uid']==b['managerUid'],'SOCKET_UID')
    return True


def main():
    global _UNKNOWN
    require(sys.platform=='linux' and sys.argv[1:]==[],'COMMON_SERVICE_FIXED_ENTRY')
    began=time.monotonic();deadline=began+TOTAL_SECONDS;raw=bytearray()
    while True:
        check(min(deadline,began+5));ready,_,_=select.select([0],[],[],max(0,began+5-time.monotonic()));check(min(deadline,began+5))
        if not ready:continue
        byte=os.read(0,1);require(bool(byte),'COMMON_SERVICE_ADMISSION_EOF');raw.extend(byte)
        require(len(raw)<=2048,'COMMON_SERVICE_ADMISSION_BOUND')
        if byte==b'\n':break
    admission=strict(bytes(raw));require(type(admission) is dict and set(admission)=={'type','sourceSha256'} and admission['type']=='common_view_service','COMMON_SERVICE_ADMISSION')
    report=run(admission['sourceSha256'],_deadline=deadline)
    os.set_blocking(1,False)
    try:
        encoded=encode(report)+b'\n';require(len(encoded)<=MAX_REPORT,'COMMON_SERVICE_REPORT_BOUND')
        write_all(1,encoded,deadline)
    except BaseException:_UNKNOWN=True;raise
    return 0 if report['commonViewValidated'] else 1


if __name__=='__main__':raise SystemExit(main())
