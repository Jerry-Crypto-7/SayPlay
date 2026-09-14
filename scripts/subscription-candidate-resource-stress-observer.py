"""Retained own-unit observations; never creates units, releases work or signals it."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import time
import types

FILES=('subscription-candidate-resource-events.py','subscription-systemd-fixture-transport.py','subscription-systemd-cli-probe.py')
ROOT=Path(__file__).resolve().parent
_TOKEN=object()
_UNKNOWN=False
MAX_PROC_BYTES=16384


def positive(value):return type(value) is int and 1<value<=2147483647

def identity_record(value):
    if type(value) is not dict or set(value)!={'pid','startTicks','pidNamespace','nspid'} or type(value['pid']) is not int or not 1<=value['pid']<=2147483647:raise ValueError('WORKER_IDENTITY_SHAPE')
    if type(value['startTicks']) is not str or re.fullmatch(r'[1-9][0-9]{0,19}',value['startTicks']) is None:raise ValueError('WORKER_START_TICKS')
    if type(value['pidNamespace']) is not str or re.fullmatch(r'pid:\[[1-9][0-9]{0,19}\]',value['pidNamespace']) is None:raise ValueError('WORKER_PID_NAMESPACE')
    values=value['nspid']
    if type(values) is not list or not 1<=len(values)<=8 or any(type(v) is not int or not 1<=v<=2147483647 for v in values) or values[-1]!=value['pid']:raise ValueError('WORKER_NSPID')
    return copy.deepcopy(value)


def held_records(value):
    if type(value) is not dict or set(value)!={'phase','workerIdentity','childIdentities'} or value['phase'] not in ('tasks','memory') or type(value['childIdentities']) is not list or not 1<=len(value['childIdentities'])<=64:raise ValueError('HELD_IDENTITY_SHAPE')
    worker=value['workerIdentity']
    if type(worker) is not dict or set(worker)!={'pid','startTicks','pidNamespace','procInitPidNamespace'} or worker['pidNamespace']!=worker['procInitPidNamespace']:raise ValueError('WORKER_FRESH_PROC_REQUIRED')
    records=[identity_record({'pid':worker['pid'],'startTicks':worker['startTicks'],'pidNamespace':worker['pidNamespace'],'nspid':[worker['pid']]})]
    for child in value['childIdentities']:
        if type(child) is not dict or set(child)!={'pid','startTicks'}:raise ValueError('CHILD_IDENTITY_SHAPE')
        records.append(identity_record({'pid':child['pid'],'startTicks':child['startTicks'],'pidNamespace':worker['pidNamespace'],'nspid':[child['pid']]}))
    if len({v['pid'] for v in records})!=len(records):raise ValueError('HELD_IDENTITY_DUPLICATE_OR_NAMESPACE')
    if value['phase']=='memory' and len(value['childIdentities'])!=2:raise ValueError('MEMORY_ALLOCATOR_COUNT')
    return records


def load_sources(expected):
    global _UNKNOWN
    if type(expected) is not dict or set(expected)!=set(FILES) or any(type(v) is not str or re.fullmatch('[a-f0-9]{64}',v) is None for v in expected.values()):raise ValueError('EXACT_SOURCE_HASHES')
    captured={}
    for name in FILES:
        fd=os.open(ROOT/name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=131072:raise ValueError('SOURCE_FILE_BOUND')
            raw=os.read(fd,131073);after=os.fstat(fd)
            if len(raw)!=before.st_size or (before.st_dev,before.st_ino,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_mtime_ns) or hashlib.sha256(raw).hexdigest()!=expected[name]:raise ValueError('SOURCE_HASH_MISMATCH')
            captured[name]=raw
        finally:
            try:os.close(fd)
            except BaseException:_UNKNOWN=True;raise
    modules=[]
    for name in FILES:
        module=types.ModuleType('private_'+name.replace('-','_'));module.__file__=str(ROOT/name)
        exec(compile(captured[name],str(ROOT/name),'exec'),module.__dict__)
        module.__source_sha256__=expected[name]  # Exact bytes above; same EventReader class instance.
        modules.append(module)
    return tuple(modules)


def create_observer(absolute_deadline,expected_source_hashes):
    if _UNKNOWN:raise ValueError('PRIOR_OBSERVER_UNKNOWN')
    if type(absolute_deadline) not in (int,float) or not math.isfinite(absolute_deadline) or not 0<absolute_deadline-time.monotonic()<=180:raise ValueError('ABSOLUTE_DEADLINE')
    dependencies=load_sources(expected_source_hashes)
    return Observer(absolute_deadline,dependencies,expected_source_hashes,_TOKEN)


class Observer:
    def __init__(self,deadline,dependencies,hashes,token):
        if token is not _TOKEN:raise ValueError('FACTORY_ONLY')
        self.deadline=deadline;self.events,self.relay,self.probe=dependencies
        self.reader=self.events.create_event_reader(deadline);self._hashes=copy.deepcopy(hashes)
        self.manager=None;self.control=None;self.pins={};self.workers={};self.samples=[]
        self.closed=False;self.failed=False;self.opened=False;self.admitted=False
        # Private compiled relay only: clamp its supported fixed metadata query.
        self.relay.subprocess=types.SimpleNamespace(run=self._query,PIPE=subprocess.PIPE,DEVNULL=subprocess.DEVNULL)

    @property
    def unit(self):return self.reader.unit

    def _fail(self):
        global _UNKNOWN
        self.failed=True;_UNKNOWN=True

    def _check(self):
        if self.closed or self.failed or time.monotonic()>=self.deadline:raise ValueError('OBSERVER_DEADLINE_OR_CLOSED')

    def _seal(self,value):
        self._check()
        value['sealedMonotonic']=time.monotonic()
        self._check()
        return value

    def _query(self,argv,**kwargs):
        self._check()
        prefix=['/usr/bin/systemctl','--user','--no-ask-password','show',self.unit]
        if argv not in (prefix+['--property=MainPID','--property=ControlGroup'],prefix+['--property=OOMPolicy']):raise ValueError('FIXED_METADATA_QUERY_ONLY')
        kwargs['timeout']=min(2,max(0,self.deadline-time.monotonic()))
        result=subprocess.run(argv,**kwargs);self._check()
        if len(result.stdout)>4096:raise ValueError('UNIT_METADATA_LIMIT')
        return result

    def _pin(self,key,pid):
        self._check()
        fd=os.pidfd_open(pid);self.pins[key]=fd
        os.set_inheritable(fd,False);signal.pidfd_send_signal(fd,0);self._check()
        return fd

    def _live_worker(self,fd):
        self._check()
        poller=select.poll();poller.register(fd,select.POLLIN)
        if poller.poll(0):raise ValueError('WORKER_PIDFD_NOT_LIVE')
        self._check()

    def _read(self,pid,name):
        if not positive(pid) or name not in ('stat','status','cgroup'):raise ValueError('FIXED_PROCESS_METADATA')
        self._check();fd=os.open('/proc/'+str(pid)+'/'+name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            raw=os.read(fd,MAX_PROC_BYTES+1)
            if not 0<len(raw)<=MAX_PROC_BYTES:raise ValueError('PROCESS_METADATA_LIMIT')
        finally:
            try:os.close(fd)
            except BaseException:self._fail();raise
        self._check();return raw.decode('ascii')

    def _process(self,pid):
        fields=self._read(pid,'stat').rsplit(') ',1)[1].split()
        if len(fields)<20 or re.fullmatch('[1-9][0-9]{0,19}',fields[19]) is None:raise ValueError('PROCESS_GENERATION')
        if fields[0] in ('Z','X','x'):raise ValueError('WORKER_ZOMBIE_OR_DEAD')
        matches=re.findall(r'^NSpid:\s*([0-9\t ]+)$',self._read(pid,'status'),re.M)
        if len(matches)!=1:raise ValueError('PROCESS_NSPID')
        nspid=[int(v) for v in matches[0].split()]
        ns=os.readlink('/proc/'+str(pid)+'/ns/pid');self._check()
        record={'pid':nspid[-1] if nspid else 0,'startTicks':fields[19],'pidNamespace':ns,'nspid':nspid}
        identity_record(record)
        if nspid[0]!=pid:raise ValueError('HOST_NSPID_VIEW_REQUIRED')
        group=self._read(pid,'cgroup')
        if group!='0::'+self.probe.leaf_path(self.unit).removeprefix('/sys/fs/cgroup')+'\n':raise ValueError('WORKER_OUTSIDE_OWN_LEAF')
        return record

    def _control(self):
        self._check()
        current=self.relay.binding(self.probe,self.unit,self.manager,self.pins['manager'])
        if self.control is not None and current!=self.control:raise ValueError('CONTROL_GENERATION_DRIFT')
        self.relay.exact_readback(self.probe,self.unit)
        result=self._query(['/usr/bin/systemctl','--user','--no-ask-password','show',self.unit,'--property=OOMPolicy'],env=self.probe.environment(),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True)
        if result.stdout!=b'OOMPolicy=continue\n':raise ValueError('OOM_POLICY_CONTINUE_REQUIRED')
        self._check();return current

    def open(self):
        if self.opened:raise ValueError('SINGLE_OBSERVER_OPEN')
        try:
            self._check();self.manager=self.relay.manager_connection(self.probe)
            self._pin('manager',self.manager['managerPid'])
            if self.relay.process_start_ticks(self.manager['managerPid'])!=self.manager['managerStartTimeTicks'] or self.relay.cgroup(self.manager['managerPid'])!=self.manager['managerCgroup']:raise ValueError('MANAGER_GENERATION_DRIFT')
            self.control=self._control();self._pin('main',self.control['unitMainPid'])
            if self.relay.process_start_ticks(self.control['unitMainPid'])!=self.control['unitMainStartTimeTicks']:raise ValueError('MAIN_GENERATION_DRIFT')
            baseline=self.reader.open();self._control();signal.pidfd_send_signal(self.pins['main'],0)
            self._check();self.opened=True;self.samples.append(copy.deepcopy(baseline))
            return self._seal({'unit':self.unit,'control':copy.deepcopy(self.control),'baseline':baseline,'sourceSha256':copy.deepcopy(self._hashes),'releaseAdmitted':False})
        except BaseException:
            self._fail();self.close();raise

    def sample(self):
        try:
            self._check()
            if not self.opened:raise ValueError('OBSERVER_NOT_OPEN')
            self._control();signal.pidfd_send_signal(self.pins['main'],0)
            value=self.reader.sample();self._check();self.samples.append(copy.deepcopy(value));self._check()
            return self._seal(value)
        except BaseException:self._fail();raise

    def admit_workers(self,held_identity):
        try:
            self._check()
            if self.admitted:raise ValueError('SINGLE_WORKER_ADMISSION')
            expected=held_records(held_identity);sample=self.sample();found={}
            # Host PID candidates come exclusively from this own retained leaf.
            for host_pid in sample['values']['cgroup.procs']:
                actual=self._process(host_pid)
                for record in expected:
                    if actual['pid']==record['pid'] and actual['startTicks']==record['startTicks'] and actual['pidNamespace']==record['pidNamespace'] and actual['nspid'][-len(record['nspid']):]==record['nspid']:
                        key=record['pid']
                        if key in found:raise ValueError('AMBIGUOUS_WORKER_IDENTITY')
                        self._pin('worker-'+str(key),host_pid)
                        self._live_worker(self.pins['worker-'+str(key)])
                        if self._process(host_pid)!=actual:raise ValueError('WORKER_GENERATION_DRIFT')
                        found[key]={'hostPid':host_pid,'identity':actual,'reportedIdentity':copy.deepcopy(record)}
            if len(found)!=len(expected):raise ValueError('WORKER_IDENTITY_NOT_FOUND')
            final=self.sample()
            if not set(v['hostPid'] for v in found.values())<=set(final['values']['cgroup.procs']):raise ValueError('WORKER_LEFT_LEAF')
            for key,value in found.items():
                self._live_worker(self.pins['worker-'+str(key)])
                signal.pidfd_send_signal(self.pins['worker-'+str(key)],0)
                if self._process(value['hostPid'])!=value['identity']:raise ValueError('WORKER_GENERATION_DRIFT')
                self._live_worker(self.pins['worker-'+str(key)])
            self._check();self.workers=found;self.admitted=True
            return self._seal({'unit':self.unit,'phase':held_identity['phase'],'workers':copy.deepcopy(found),'sample':final,'releaseAdmitted':True,'releaseWritten':False,'exhaustionValidated':False})
        except BaseException:self._fail();raise

    def observe_outcomes(self):
        try:
            self._check()
            if not self.admitted:raise ValueError('WORKERS_NOT_ADMITTED')
            outcomes=[]
            for key,value in self.workers.items():
                poller=select.poll();poller.register(self.pins['worker-'+str(key)],select.POLLIN)
                ready=poller.poll(0)
                # Reaping by the worker can add HUP to an exited pidfd. This
                # still proves only readiness of our retained identity, never
                # its exit code or that the observer performed wait/reap.
                if (type(ready) is not list or len(ready)>1
                        or any(type(fd) is not int or fd!=self.pins['worker-'+str(key)]
                               or type(flags) is not int or flags not in (select.POLLIN,select.POLLIN|select.POLLHUP)
                               for fd,flags in ready)):raise ValueError('PIDFD_EVENT_UNKNOWN')
                exited=bool(ready)
                if not exited and self._process(value['hostPid'])!=value['identity']:raise ValueError('WORKER_GENERATION_DRIFT')
                outcomes.append({'hostPid':value['hostPid'],'identity':copy.deepcopy(value['identity']),'pidfdExitObserved':exited,'returnCode':None,'reapedByObserver':False})
            return self._seal({'unit':self.unit,'outcomes':outcomes,'exhaustionValidated':False,'unitCleanupAttested':False})
        except BaseException:self._fail();raise

    def close(self):
        if self.closed:return not self.failed
        self.closed=True
        try:
            if self.reader.close() is not True:self._fail()
        except BaseException:self._fail()
        pins=list(self.pins.values());self.pins={}
        for fd in pins:
            try:os.close(fd)
            except BaseException:self._fail()
        if time.monotonic()>=self.deadline:self._fail()
        return not self.failed


if __name__=='__main__':raise SystemExit('OWN_RESOURCE_COORDINATOR_INTEGRATION_REQUIRED')
