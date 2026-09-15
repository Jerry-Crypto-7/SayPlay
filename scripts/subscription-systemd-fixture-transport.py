"""Fixed interactive fixture/metadata relay, outside its owned systemd leaf."""
import hashlib
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid
import types
import threading
from collections import deque

ROOT = Path('/mnt/d/claude/Hackaton/scripts')
QUEUE_LIMIT = 65536
FAILURE_FRAME_LIMIT = 60000
NESTED_TERMINAL_LIMIT = 8192
CONTROL_LIMIT = 4 * 1024 * 1024
WIRE_LIMIT = 16 * 1024 * 1024
LIMITS = {'memoryMaxBytes': 2147483648, 'swapMaxBytes': 0, 'tasksMax': 64,
          'guardianMs': 220000, 'termGraceMs': 5000, 'innerCommandMs': 200000}
TRACE = None
STRESS_PROFILES = ('candidate-resource-stress-tasks', 'candidate-resource-stress-memory')
COMMON_STRESS_PROFILES = ('candidate-common-view-stress-tasks','candidate-common-view-stress-memory')
ALL_STRESS_PROFILES = STRESS_PROFILES + COMMON_STRESS_PROFILES
STRESS_CHILD_OUTPUT_LIMIT = 3 * 1024 * 1024  # Existing child serialization envelope, not model output.


def select_profile(arguments):
    if len(arguments) == 1 and arguments[0] in tuple('--' + p for p in ALL_STRESS_PROFILES): return arguments[0][2:]
    if arguments == []:
        return 'fixture'
    if arguments == ['--metadata-pipe']:
        return 'metadata'
    if arguments == ['--environment-metadata']:
        return 'environment-metadata'
    if arguments == ['--environment-bootstrap-metadata']:
        return 'environment-bootstrap-metadata'
    if arguments == ['--environment-bootstrap-controlled']:
        return 'environment-bootstrap-controlled'
    if arguments == ['--trusted-control-boundary']:
        return 'trusted-control-boundary'
    if arguments == ['--trusted-cgroup-worker-boundary']:
        return 'trusted-cgroup-worker-boundary'
    if arguments == ['--trusted-ingress-boundary']:
        return 'trusted-ingress-boundary'
    if arguments == ['--trusted-http-ingress-boundary']:
        return 'trusted-http-ingress-boundary'
    if arguments == ['--cli-proxy-refusal']:
        return 'cli-proxy-refusal'
    raise ValueError('FIXED_RELAY_PROFILE_REQUIRED')


def profile_contract(profile):
    if profile in COMMON_STRESS_PROFILES:return profile_contract('candidate-resource-stress-'+profile.rsplit('-',1)[1])
    if profile in STRESS_PROFILES:
        return (profile, 'candidateResourceStressBoundary', (*profile_contract('trusted-control-boundary')[2],
            'subscription-candidate-resource-stress-worker.py', 'subscription-candidate-resource-stress-protocol.py',
            'subscription-candidate-resource-stress-child.py'))
    if profile == 'trusted-cgroup-worker-boundary':
        return (profile, 'trustedCgroupWorkerBoundary',
                (*profile_contract('trusted-control-boundary')[2],
                 'subscription-trusted-cgroup-worker-probe.py', 'subscription-trusted-cgroup-worker-child.py'))
    if profile == 'cli-proxy-refusal':
        return (profile, 'cliProxyRefusalBoundary',
                (*profile_contract('environment-bootstrap-controlled')[2],
                 'subscription-cli-proxy-refusal.py', 'subscription-cli-proxy-provenance.py',
                 'subscription-cli-proxy-refusal-child.py'))
    if profile == 'trusted-http-ingress-boundary':
        return (profile, 'trustedHttpIngressBoundary',
                (*profile_contract('trusted-ingress-boundary')[2],
                 'subscription-trusted-http-ingress.py', 'subscription-trusted-http-capsule-factory.py',
                 'subscription-trusted-http-worker-probe.py', 'subscription-trusted-http-ingress-child.py'))
    if profile == 'trusted-ingress-boundary':
        return ('trusted-ingress-boundary', 'trustedIngressBoundary',
                (*profile_contract('trusted-control-boundary')[2],
                 'subscription-trusted-ingress-child.py', 'subscription-trusted-ingress-worker-probe.py'))
    if profile == 'trusted-control-boundary':
        return ('trusted-control-boundary', 'trustedControlBoundary',
                ('subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
                 'subscription-exec-worker-probe.py', 'subscription-trusted-control-boundary-probe.py',
                 'subscription-worker-lockdown.py', 'subscription-appserver-noenv.py',
                 'subscription-text-model-catalog.json', 'subscription-trusted-control-boundary-parent.py'))
    if profile == 'fixture':
        return ('appserver-fixture', 'appServerFixtureBoundary',
                ('subscription-appserver-fixture-child.py', 'subscription-worker-lockdown.py'))
    if profile == 'metadata':
        return ('appserver-metadata-pipe', 'appServerMetadataPipeBoundary',
                ('subscription-appserver-metadata-pipe-child.py', 'subscription-appserver-noenv.py',
                 'subscription-worker-lockdown.py', 'subscription-text-model-catalog.json'))
    if profile in ('environment-metadata', 'environment-bootstrap-metadata', 'environment-bootstrap-controlled'):
        return ('exec-' + profile, 'execEnvironmentMetadataBoundary',
                ('subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
                 'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py',
                 'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json',
                 'subscription-exec-environment-metadata-parent.py'))
    raise ValueError('FIXED_RELAY_PROFILE_REQUIRED')


def validate_profile_start(profile, frame, ready):
    mode, field, names = profile_contract(profile)
    ingress_profile = profile in ('trusted-ingress-boundary', 'trusted-http-ingress-boundary')
    keys = {'type', 'mode', 'helperSha256'} | ({'scenario'} if profile == 'fixture' else set()) | ({'nonce'} if ingress_profile else set())
    if (type(frame) is not dict or set(frame) != keys or frame['type'] != 'start' or frame['mode'] != mode
            or (profile == 'fixture' and frame['scenario'] not in ('normal', 'cancel', 'output-limit'))):
        raise ValueError('RELAY_FIXED_START_REQUIRED')
    if ingress_profile:
        ingress = ready.get('systemdIngressBoundary') if type(ready) is dict else None
        if (type(frame['nonce']) is not str or re.fullmatch('[a-f0-9]{32}', frame['nonce']) is None
                or type(ingress) is not dict or frame['nonce'] != ingress.get('nonce')):
            raise ValueError('RELAY_INGRESS_NONCE_MISMATCH')
    boundary = ready.get(field) if type(ready) is dict else None
    actual = boundary.get('helperSha256') if type(boundary) is dict else None
    expected = frame['helperSha256']
    if (type(boundary) is not dict or set(boundary) != ({'phase', 'helperSha256'} if profile in ALL_STRESS_PROFILES else {'helperSha256'})
            or (profile in ALL_STRESS_PROFILES and boundary.get('phase') != profile.rsplit('-', 1)[1]) or type(actual) is not dict
            or type(expected) is not dict or set(actual) != set(names) or set(expected) != set(names)
            or any(type(value) is not str or re.fullmatch('[a-f0-9]{64}', value) is None for value in actual.values())
            or expected != actual):
        raise ValueError('RELAY_HELPER_IDENTITY')


def admit_profile_start(profile, probe, unit, receipt, ready, frame, fd, manager_identity, manager_fd):
    validate_profile_start(profile, frame, ready)
    if profile in ALL_STRESS_PROFILES:
        extra = stress_readback(probe, unit)
        if extra != receipt['readback']: raise ValueError('STRESS_PRESTART_READBACK_CHANGED')
        base = admit_start(probe, unit, receipt, frame, fd, manager_identity, manager_fd)
        return {**base, 'memoryOomGroup': extra['memoryOomGroup'], 'oomPolicy': extra['oomPolicy']}
    return admit_start(probe, unit, receipt, frame, fd, manager_identity, manager_fd)


def require_interactive_profile(profile):
    if profile not in ('fixture', 'metadata'):
        raise ValueError('RELAY_NONINTERACTIVE_PROFILE')


class StressActions:
    """Only supervisor pipe delivery; never a worker or observer ACK."""
    def __init__(self, profile):
        if profile not in ALL_STRESS_PROFILES: raise ValueError('FIXED_STRESS_PROFILE')
        self.actions = ['start','release'] if profile.endswith('-tasks') else ['start','ramp','release']
        self.position=0;self.pending=None;self.terminal=False

    def accept(self, frame):
        if type(frame) is not dict or set(frame)!={'type','action'} or frame['type']!='stress_action' or type(frame['action']) is not str or self.pending is not None or self.terminal: raise ValueError('RELAY_STRESS_ACTION_ORDER')
        action=frame['action']
        if action=='cancel': self.terminal=True
        elif self.position>=len(self.actions) or action!=self.actions[self.position]: raise ValueError('RELAY_STRESS_ACTION_ORDER')
        else: self.position+=1;self.terminal=action=='release'
        self.pending=action

    def delivered(self, frame):
        if (type(frame) is not dict or set(frame)!={'version','type','action','workerAcknowledged','observerAdmissionAttestedHere'}
            or type(frame['version']) is not int or frame['version']!=1 or frame['type']!='stress_action_delivered'
            or self.pending is None or frame['action']!=self.pending or frame['workerAcknowledged'] is not False
            or frame['observerAdmissionAttestedHere'] is not False): raise ValueError('RELAY_STRESS_DELIVERY_ORDER')
        self.pending=None


def admit_stress_action(owner, actions, frame, inbound, fd):
    if inbound.data: raise ValueError('STRESS_ACTION_QUEUE_NOT_EMPTY')
    actions.accept(frame)
    evidence=owner.before_action(frame['action'])
    write_stress_action(owner,frame,inbound,fd)
    return evidence


def write_stress_action(owner,frame,inbound,fd):
    if inbound.data: raise ValueError('STRESS_ACTION_QUEUE_NOT_EMPTY')
    raw=(json.dumps(frame,separators=(',',':'))+'\n').encode()
    owner._check()
    count=os.write(fd,raw)
    if type(count) is not int or count!=len(raw): raise ValueError('STRESS_ACTION_WRITE_UNKNOWN')
    owner._check()


def stress_readback(probe, unit):
    result=exact_readback(probe,unit)
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW
    fd=os.open('/',flags)
    try:
        for part in probe.leaf_path(unit).lstrip('/').split('/'):
            child=os.open(part,flags,dir_fd=fd);old=fd;fd=child;os.close(old)
        child=os.open('memory.oom.group',os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try: raw=os.read(child,3)
        finally: os.close(child)
    finally: os.close(fd)
    if raw not in (b'0',b'0\n'): raise ValueError('STRESS_MEMORY_OOM_GROUP')
    policy=subprocess.run(['/usr/bin/systemctl','--user','--no-ask-password','show',unit,'--property=OOMPolicy'],
        env=probe.environment(),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2,check=True)
    if policy.stdout!=b'OOMPolicy=continue\n': raise ValueError('STRESS_OOM_POLICY')
    return {**result,'memoryOomGroup':'0','oomPolicy':'continue'}


def _unit_argv(probe, profile, unit, capsule_argv):
    profile_contract(profile)
    # Unit is generated by the internal owner, never parsed from caller input.
    probe.leaf_path(unit)
    return ['/usr/bin/systemd-run','--user','--no-ask-password','--quiet','--wait','--pipe','--collect',
        '--unit='+unit,'--property=MemoryMax=2G','--property=MemorySwapMax=0','--property=TasksMax=64',
        '--property=RuntimeMaxSec=220','--property=TimeoutStopSec=5','--property=KillMode=control-group',
        *(['--property=OOMPolicy=continue'] if profile in ALL_STRESS_PROFILES else []),
        '--property=WorkingDirectory=/',*capsule_argv]


_STRESS_TOKEN=object()
_STRESS_UNKNOWN=False
STRESS_OBSERVER_FILES=('subscription-candidate-resource-stress-observer.py',
    'subscription-candidate-resource-events.py','subscription-systemd-fixture-transport.py','subscription-systemd-cli-probe.py',
    'subscription-candidate-resource-capacity.py')
COMMON_FILES=STRESS_OBSERVER_FILES+('subscription-cgroup-common-view-service.py','subscription-cgroup-common-view.py',
    'subscription-cgroup-common-view-child.py','subscription-cgroup-common-view-preflight.py','subscription-cgroup-target-ancestry.py',
    'subscription-cgroup-evidence-stream.py','subscription-cgroup-evidence-validation.py')


class StressComposition:
    def __init__(self, phase, observer, hashes, token, capacity=None):
        if token is not _STRESS_TOKEN: raise ValueError('STRESS_COMPOSITION_FACTORY_ONLY')
        self.phase=phase;self.profile='candidate-resource-stress-'+phase
        self._observer=observer;self._hashes=dict(hashes);self._capacity=capacity;self._closed=False;self._known=None
        self._used=False;self._opened=False;self._held=False;self._ramped=False;self._grant=False
        self._partial=bytearray();self._raw_bytes=0;self._baseline=None;self._next_sample=0
        self._records=[];self._manager=None;self._manager_fd=None;self._worker_pid=None;self._child_pids=set();self._runner=None
        self._common=None

    @property
    def unit(self): return self._observer.unit

    def _check(self):
        if self._closed or time.monotonic()>=self._observer.deadline: raise ValueError('STRESS_OWNER_DEADLINE')

    def _record(self, stage, evidence):
        self._check()
        record={'version':1,'type':'candidate_stress_observation','phase':self.phase,'unit':self.unit,
            'stage':stage,'evidence':evidence,'exhaustionValidated':False}
        raw=json.dumps(record,separators=(',',':'),allow_nan=False).encode()
        if len(raw)>45000 or len(self._records)>=40: raise ValueError('STRESS_OBSERVATION_BOUND')
        self._records.append(hashlib.sha256(raw).hexdigest());self._check()
        return record

    def _external_view(self):
        self._check();signal.pidfd_send_signal(self._manager_fd,0)
        manager=self._manager['managerPid'];views={}
        for kind in ('pid','cgroup'):
            paths=('/proc/self/ns/'+kind,'/proc/'+str(manager)+'/ns/'+kind,'/proc/1/ns/'+kind)
            values=[os.readlink(path) for path in paths]
            if any(not re.fullmatch(kind+r':\[[1-9][0-9]{0,19}\]',value) for value in values) or len(set(values))!=1: raise ValueError('STRESS_EXTERNAL_NAMESPACE_VIEW')
            views[kind]=values[0]
        if process_start_ticks(manager)!=self._manager['managerStartTimeTicks'] or cgroup(manager)!=self._manager['managerCgroup']: raise ValueError('STRESS_MANAGER_GENERATION')
        signal.pidfd_send_signal(self._manager_fd,0);self._check();return views

    def _fresh_capacity(self):
        if self._common is not None:return self._common.capacity_pair('work')
        before=self._external_view()
        result=self._capacity.check_capacity(min(self._observer.deadline,time.monotonic()+5))
        if self._external_view()!=before or result.get('admitted') is not True: raise ValueError('STRESS_CAPACITY_NOT_ADMITTED')
        self._check();return {'view':before,'capacity':result}

    def before_spawn(self, manager, manager_fd):
        self._manager=copy.deepcopy(manager);self._manager_fd=os.dup(manager_fd)
        os.set_inheritable(self._manager_fd,False)
        if self._common is not None:return None
        return self._record('before-unit-capacity',self._fresh_capacity())

    def ready(self):
        self._check();result=self._observer.open();self._opened=True
        self._baseline=copy.deepcopy(result['baseline'])
        if self._common is not None:self._common.bind_target()
        return self._record('baseline',result)

    def before_action(self, action):
        self._check()
        if not self._opened: raise ValueError('STRESS_OWNER_NOT_READY')
        if action=='cancel': return None
        if action=='start': return self._record('before-work-capacity',self._fresh_capacity())
        if action=='ramp' and self.phase=='memory' and self._held: return None
        if action=='release' and self._grant:
            self._grant=False;self._next_sample=0
            evidence=self.tick()
            if self._grant: return evidence
        raise ValueError('STRESS_OBSERVER_PERMISSION_REQUIRED')

    def output(self, frame):
        self._check()
        if frame.get('stream')!='stdout': return []
        if set(frame)!={'version','type','stream','encoding','data'} or type(frame['version']) is not int or frame['version']!=1 or frame['encoding']!='base64' or type(frame['data']) is not str: raise ValueError('STRESS_OUTPUT_ENVELOPE')
        raw=base64.b64decode(frame['data'],validate=True)
        if base64.b64encode(raw).decode()!=frame['data']: raise ValueError('STRESS_OUTPUT_ENCODING')
        self._raw_bytes+=len(raw)
        if self._raw_bytes>STRESS_CHILD_OUTPUT_LIMIT: raise ValueError('STRESS_CHILD_OUTPUT_LIMIT')
        self._partial.extend(raw);result=[]
        while b'\n' in self._partial:
            line,_,rest=self._partial.partition(b'\n');self._partial=bytearray(rest)
            value=strict_stress_json(bytes(line))
            if type(value) is not dict: raise ValueError('STRESS_CHILD_RECORD')
            if value.get('type')!='candidate_stress_progress':
                # Final child body is preserved and evaluated by the driver.
                continue
            if set(value)!={'version','type','phase','record','rawHex'} or type(value['version']) is not int or value['version']!=1 or value['phase']!=self.phase or type(value['rawHex']) is not str or len(value['rawHex'])>131072: raise ValueError('STRESS_PROGRESS_ENVELOPE')
            actual=bytes.fromhex(value['rawHex'])
            if actual.hex()!=value['rawHex'] or not actual.endswith(b'\n') or actual.count(b'\n')!=1 or json.dumps(strict_stress_json(actual),sort_keys=True,allow_nan=False)!=json.dumps(value['record'],sort_keys=True,allow_nan=False): raise ValueError('STRESS_PROGRESS_RAW_MISMATCH')
            record=value['record']
            if type(record) is not dict or record.get('phase')!=self.phase: raise ValueError('STRESS_PROGRESS_PHASE')
            if record.get('type')=='held' and not self._held:
                evidence=self._observer.admit_workers({key:record[key] for key in ('phase','workerIdentity','childIdentities')})
                self._worker_pid=record['workerIdentity']['pid'];self._child_pids={item['pid'] for item in record['childIdentities']}
                self._held=True;result.append(self._record('workers-held',evidence))
            elif record.get('type')=='ramp-complete' and self.phase=='memory' and self._held and not self._ramped and record=={'type':'ramp-complete','phase':'memory','allocationCapPerChild':1207959552}:
                self._ramped=True
            else: raise ValueError('STRESS_PROGRESS_ORDER')
        return result

    def tick(self):
        self._check()
        if self._grant or not self._held or (self.phase=='memory' and not self._ramped) or time.monotonic()<self._next_sample: return None
        self._next_sample=time.monotonic()+.1
        sample=self._observer.sample();outcomes=self._observer.observe_outcomes()
        workers=[item for item in outcomes['outcomes'] if item['identity']['pid']==self._worker_pid]
        if len(workers)!=1 or workers[0]['pidfdExitObserved'] is not False: raise ValueError('STRESS_WORKER_NOT_ALIVE')
        if self.phase=='tasks':
            proven=sample['values']['pids.current']==64 and sample['values']['pids.events']['max']>self._baseline['values']['pids.events']['max']
        else:
            proven=(sample['values']['memory.events']['oom_kill']>self._baseline['values']['memory.events']['oom_kill']
                and any(item['identity']['pid'] in self._child_pids and item['pidfdExitObserved'] is True for item in outcomes['outcomes']))
        result=self._record('release-observation',{'sample':sample,'outcomes':outcomes,'releaseAdmitted':proven})
        self._grant=proven;return result

    def run(self):
        if self._closed or self._used: raise ValueError('STRESS_OWNER_SINGLE_RUN')
        self._used=True
        try:result=_run_profile(self.profile,self)
        finally:known=self.close()
        return result if known else 1

    def close(self):
        global _STRESS_UNKNOWN
        if self._closed: return self._known
        self._closed=True
        try: finished=self._runner is None or self._runner.finish()
        except BaseException: finished=False
        if not finished:
            self._known=False;_STRESS_UNKNOWN=True
            return False  # Never close a descriptor while its observer uses it.
        try:common_known=self._common is None or self._common.close() is True
        except BaseException:common_known=False
        if not common_known:
            self._known=False;_STRESS_UNKNOWN=True
            return False
        try:self._known=self._observer.close() is True
        except BaseException:self._known=False
        if self._manager_fd is not None:
            fd=self._manager_fd;self._manager_fd=None
            try:os.close(fd)
            except BaseException:self._known=False
        if not self._known:_STRESS_UNKNOWN=True
        return self._known


def stress_observer_failure(kind,error):
    # Preserve fixed diagnostic symbols, never arbitrary exception text/data.
    stage=kind if kind in ('baseline','output','action','preopen','tick') else 'unknown'
    reason=str(error)
    symbol=(':'+reason if type(error) is ValueError and re.fullmatch(r'[A-Z][A-Z0-9_]{0,127}',reason) else '')
    return 'STRESS_OBSERVER_JOB_FAILED:'+stage+':'+type(error).__name__+symbol


class StressObserverRunner:
    """One owned metadata worker; main loop alone pumps control and output."""
    def __init__(self, owner):
        self.owner=owner;owner._runner=self
        self.queue=deque();self.queued_bytes=0;self.thread=None;self.result=None;self.error=None;self.current=None
        self.owner=owner;owner._runner=self
        self.queue=deque();self.queued_bytes=0;self.thread=None;self.result=None;self.error=None;self.current=None
        self.stopping=False;self.cancelled=False;self.completed_at=None;self.pending_completion=None

    def enqueue(self, kind, payload=None):
        if self.cancelled and kind=='output': return
        if kind not in ('baseline','output','action','preopen') or self.stopping: raise ValueError('STRESS_OBSERVER_JOB_KIND')
        if kind=='preopen' and self.owner._common is None:raise ValueError('COMMON_PREOPEN_PROFILE_REQUIRED')
        size=len(json.dumps(payload,separators=(',',':')).encode())
        if len(self.queue)>=64 or self.queued_bytes+size>262144: raise ValueError('STRESS_OBSERVER_QUEUE_LIMIT')
        self.queue.append((kind,copy.deepcopy(payload),size));self.queued_bytes+=size

    def idle(self): return self.thread is None and not self.queue and self.pending_completion is None

    def advance(self, allow_tick=True):
        if self.thread is not None:
            if self.thread.is_alive(): return None
            self.thread.join(0);self.thread=None
            kind,payload=self.current;result,error=self.result,self.error
            self.current=None;self.result=None;self.error=None
            if error is not None: raise ValueError(stress_observer_failure(kind,error))
            return kind,payload,result,self.completed_at
        if self.stopping: return None
        if self.queue:
            kind,payload,size=self.queue.popleft();self.queued_bytes-=size
        elif (allow_tick and self.owner._opened and self.owner._held and not self.owner._grant
              and (self.owner.phase=='tasks' or self.owner._ramped)
              and time.monotonic()>=self.owner._next_sample):kind,payload='tick',None
        else:return None
        self.current=(kind,payload)
        def work():
            try:
                if kind=='baseline':self.result=self.owner.ready()
                elif kind=='output':self.result=self.owner.output(payload)
                elif kind=='action':self.result=self.owner.before_action(payload['action'])
                elif kind=='preopen':self.result=self.owner._record('before-unit-capacity',self.owner._common.capacity_pair('open'))
                else:self.result=self.owner.tick()
            except BaseException as error:self.error=error
            finally:self.completed_at=time.monotonic()
        self.thread=threading.Thread(target=work,daemon=True)
        try:self.thread.start()
        except BaseException:self.thread=None;raise
        return None

    def cancel(self):
        self.cancelled=True;self.stopping=True
        self.queue.clear();self.queued_bytes=0
        self.pending_completion=None
        if self.owner._common is not None:self.owner._common.cancel()

    def finish(self):
        self.stopping=True;self.queue.clear();self.queued_bytes=0
        if self.thread is not None:
            self.thread.join(min(1,max(0,self.owner._observer.deadline-time.monotonic())))
            if self.thread.is_alive():return False
            self.thread=None
        return True


def pump_common_documents(common,outbound,deadline,steps):
    """At most four codec steps and two shared milliseconds per outer pump.

    Each queued frame gets one actual nonblocking drain attempt. Partial writes
    and EAGAIN return to control polling; completion still follows end-byte drain.
    """
    if outbound.data:return True
    while steps[0]>0:
        if time.monotonic()>=deadline:return True
        steps[0]-=1
        pending=common.pump_documents(outbound)
        if outbound.data:
            if time.monotonic()>=deadline:return True
            outbound.drain(1)
            if outbound.data:return True
        if not pending:return False
    return True


def pump_relay_buffers(outbound, inbound, proc, runner, stop_at, terminal):
    document_deadline=time.monotonic()+.002
    document_steps=[4]
    outbound.drain(1)
    if proc is not None and not proc.stdin.closed:inbound.drain(proc.stdin.fileno())
    if runner is None:return
    common=getattr(runner.owner,'_common',None)
    if common is not None and pump_common_documents(common,outbound,document_deadline,document_steps):return
    completed=runner.pending_completion or runner.advance(allow_tick=proc is not None and stop_at is None and terminal is None)
    if completed is None:return
    if common is not None and pump_common_documents(common,outbound,document_deadline,document_steps):
        runner.pending_completion=completed;return
    runner.pending_completion=None
    kind,payload,result,completed_at=completed
    if kind=='action':
        if runner.cancelled:return
        if stop_at is not None or terminal is not None:raise ValueError('STRESS_ACTION_AFTER_STOP')
        if completed_at is None or time.monotonic()-completed_at>=.1:raise ValueError('STRESS_ACTION_ADMISSION_STALE')
        write_stress_action(runner.owner,payload,inbound,proc.stdin.fileno())
        if result is not None:outbound.frame(result)
    elif kind=='output':
        for observation in result:outbound.frame(observation)
    elif result is not None:outbound.frame(result)


class CommonEvidence:
    """Source-bound fixed documents; only the relay thread serializes stdout."""
    def __init__(self,owner,modules):
        self.owner=owner;self.modules=modules
        self.sampler=modules['subscription-cgroup-common-view.py'];self.service=modules['subscription-cgroup-common-view-service.py']
        self.codec=modules['subscription-cgroup-evidence-stream.py'];self.target=modules['subscription-cgroup-target-ancestry.py']
        self.link=modules['subscription-cgroup-evidence-validation.py'];self.controller_module=modules['subscription-cgroup-common-view-preflight.py']
        self.documents={};self.completed={};self.pending=deque();self.iterator=None;self.label=None
        self.total=0;self.controller=None;self.cancelled=False;self.service_report=None;self.after_open=None

    def add_document(self,label,value):
        raw=self.sampler.encode(value)
        if label!=self.codec.LABELS[len(self.documents)] or label in self.documents or len(raw)>self.codec.LIMITS[label]:raise ValueError('COMMON_DOCUMENT_ORDER_OR_BOUND')
        if self.total+len(raw)>6*1024*1024:raise ValueError('COMMON_DOCUMENT_AGGREGATE')
        self.documents[label]=raw;self.total+=len(raw);self.pending.append(label)

    def pump_documents(self,outbound):
        if self.cancelled:return False
        if outbound.data:return bool(self.pending or self.iterator)
        if self.iterator is None:
            if not self.pending:return False
            self.label=self.pending.popleft();self.iterator=iter(self.codec.encode_document(self.owner.unit,self.label,self.documents[self.label]))
        try:frame=next(self.iterator)
        except StopIteration:
            raw=self.documents[self.label]
            self.completed[self.label]={'label':self.label,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            self.iterator=None;self.label=None
            return bool(self.pending)
        if type(frame) is not bytes or len(frame)>45000:raise ValueError('COMMON_DOCUMENT_FRAME_BOUND')
        outbound.append(frame);return True

    def accept_service(self,report):
        manager=report['manager'];expected=self.owner._manager
        if any(manager.get(key)!=value for key,value in expected.items()):raise ValueError('COMMON_SERVICE_MANAGER_BINDING')
        observer=report['observerAfter']
        if observer['selfIdentity']['pid']!=os.getpid() or observer['membership']!=cgroup(os.getpid()):raise ValueError('COMMON_SERVICE_OBSERVER_BINDING')
        self.service_report=report
        # Already physically streamed by the preflight pump, do not duplicate.
        raw=self.service.encode(report)
        self.documents['service']=raw;self.total=len(raw)
        self.completed['service']={'label':'service','bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}

    def capacity_pair(self,stage):
        self.owner._check()
        if self.cancelled or self.service_report is None:raise ValueError('COMMON_CAPACITY_BEFORE_ADMISSION')
        deadline=min(self.owner._observer.deadline,time.monotonic()+5)
        before=self.sampler.sample_self(deadline)
        self.link.match_view(before,self.service_report['observerAfter'],self.sampler)
        signal.pidfd_send_signal(self.owner._manager_fd,0)
        if manager_connection(self.owner._observer.probe)!=self.owner._manager:raise ValueError('COMMON_MANAGER_CHANGED')
        capacity=self.owner._capacity.check_capacity(deadline)
        after=self.sampler.sample_self(deadline)
        self.link.match_view(after,self.service_report['observerAfter'],self.sampler)
        if capacity.get('admitted') is not True or not before['sealedMonotonic']<=capacity['sealedMonotonic']<=after['startedMonotonic']:raise ValueError('COMMON_CAPACITY_TIME_OR_HEADROOM')
        signal.pidfd_send_signal(self.owner._manager_fd,0);self.owner._check()
        labels=('capacity-before-'+stage,'capacity-after-'+stage)
        self.add_document(labels[0],before);self.add_document(labels[1],after)
        if stage=='open':self.after_open=after
        else:
            names=set(self.service.FILES)|set(self.target.FILES)
            if self.link.validate_documents(self.documents,self.owner.unit,{n:self.owner._hashes[n] for n in names},
                    (self.service,self.sampler,self.target,self.owner._observer.events)) is not True:raise ValueError('COMMON_DOCUMENT_LINKAGE')
        return {'namespaceEvidenceProfile':'common-visible-cgroup2-v1','view':{'beforeDocument':labels[0],'afterDocument':labels[1]},'capacity':capacity}

    def bind_target(self):
        report=self.target.bind_target(self.owner._observer.reader,self.after_open,
            min(self.owner._observer.deadline,time.monotonic()+5),(self.sampler,self.owner._observer.events))
        self.add_document('target-ancestry',report)

    def cancel(self):
        self.cancelled=True;self.pending.clear();self.iterator=None
        if self.controller is not None and not self.controller._closed:self.controller.cancel()

    def close(self):
        if self.controller is not None:return self.controller.close() is True
        return True


def common_pretarget(owner):
    """No target Popen until complete service bytes and exact driver admission."""
    common=owner._common
    service_hashes={n:owner._hashes[n] for n in common.service.FILES}
    common.controller=common.controller_module.create_preflight(owner._observer.reader,service_hashes,
        min(owner._observer.deadline,time.monotonic()+35),(common.service,common.sampler,common.codec,owner._observer.events))
    selector=None;outbound=Buffer();inbound=Buffer();partial=bytearray();control_bytes=0
    ready=None;ready_written=None;admitted=False;last_control=time.monotonic();runner=None;success=False;receipt_sent=False
    try:
        selector=selectors.DefaultSelector();os.set_blocking(0,False);os.set_blocking(1,False)
        selector.register(0,selectors.EVENT_READ);common.controller.start()
        while True:
            owner._check();now=time.monotonic()
            if now-last_control>3:raise ValueError('COMMON_PRETARGET_CONTROL_LEASE')
            outbound.drain(1)
            if ready is None:
                if not outbound.data:
                    frame=common.controller.poll()
                    if frame is not None:outbound.append(frame)
                if common.controller.finished() and not outbound.data:
                    report=common.controller.result()
                    if report is None:raise ValueError('COMMON_PREFLIGHT_INCOMPLETE')
                    if not common.controller.close():raise ValueError('COMMON_PREFLIGHT_CLOSE_UNKNOWN')
                    common.accept_service(report)
                    item=common.completed['service']
                    outbound.frame(common.controller.terminal());receipt_sent=True
                    ready={'version':1,'type':'common_view_ready','unit':owner.unit,'sha256':item['sha256'],'bytes':item['bytes']}
                    outbound.frame(ready)
            elif ready_written is None and not outbound.data:ready_written=time.monotonic()
            if ready_written is not None and not admitted and now-ready_written>=5:raise ValueError('COMMON_DRIVER_ADMISSION_TIMEOUT')
            if admitted:
                pump_relay_buffers(outbound,inbound,None,runner,None,None)
                if runner.idle() and not outbound.data and not common.pending and common.iterator is None and not partial:
                    if tuple(common.completed)!=tuple(common.codec.LABELS[:3]):raise ValueError('COMMON_PREOPEN_DOCUMENTS_REQUIRED')
                    success=True;return
            for key,_ in selector.select(.01):
                try:block=os.read(key.fd,4096)
                except BlockingIOError:continue
                if not block:raise ValueError('COMMON_PRETARGET_CONTROL_EOF')
                control_bytes+=len(block)
                if control_bytes>CONTROL_LIMIT:raise ValueError('COMMON_PRETARGET_CONTROL_BOUND')
                partial.extend(block)
                while b'\n' in partial:
                    line,_,rest=partial.partition(b'\n');partial=bytearray(rest)
                    if len(line)>4096:raise ValueError('COMMON_PRETARGET_FRAME_BOUND')
                    value=strict_stress_json(bytes(line));last_control=time.monotonic()
                    if value=={'type':'heartbeat'}:continue
                    if value=={'type':'cancel'}:raise ValueError('COMMON_PRETARGET_CANCELLED')
                    if ready_written is None or admitted or value!={'type':'common_view_admission','unit':owner.unit,'sha256':ready['sha256']}:
                        raise ValueError('COMMON_DRIVER_ADMISSION_REQUIRED')
                    admitted=True;runner=StressObserverRunner(owner);runner.enqueue('preopen')
                if len(partial)>4096:raise ValueError('COMMON_PRETARGET_FRAME_BOUND')
    finally:
        if not success:
            common.cancel()
            if runner is not None:runner.cancel()
            # The service keeps ownership of its process/pins during cooperative
            # cleanup. Keep the pretarget pump alive; never close under its thread.
            until=min(owner._observer.deadline,common.controller.deadline)
            while not common.controller.finished() and time.monotonic()<until:
                outbound.drain(1)
                if selector is not None:
                    for key,_ in selector.select(.01):
                        try:part=os.read(key.fd,4096)
                        except BlockingIOError:continue
                        control_bytes+=len(part)
                        if not part:selector.unregister(key.fd)
                        if control_bytes>CONTROL_LIMIT:break
                else:time.sleep(.01)
            common.controller.close()
            if not receipt_sent:
                until=min(owner._observer.deadline,time.monotonic()+2)
                while outbound.data and time.monotonic()<until:outbound.drain(1);time.sleep(.01)
                if not outbound.data:
                    outbound.frame(common.controller.terminal())
                    while outbound.data and time.monotonic()<until:outbound.drain(1);time.sleep(.01)
        if selector is not None:selector.close()
        # In-flight service/metadata handles remain owned by their worker. The
        # outer owner's close method must prove join before touching its pins.


def accept_relay_cancel(inbound, runner):
    if runner is not None:runner.cancel()
    inbound.frame({'type':'cancel'})


def strict_stress_json(raw):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result: raise ValueError('STRESS_DUPLICATE_JSON')
            result[key]=value
        return result
    return json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('STRESS_NONFINITE_JSON')))


def create_stress_composition(phase, absolute_deadline, expected_source_hashes):
    global _STRESS_UNKNOWN
    if _STRESS_UNKNOWN: raise ValueError('PRIOR_STRESS_COMPOSITION_UNKNOWN')
    if phase not in ('tasks','memory') or type(expected_source_hashes) is not dict or set(expected_source_hashes)!=set(STRESS_OBSERVER_FILES) or any(type(v) is not str or re.fullmatch('[a-f0-9]{64}',v) is None for v in expected_source_hashes.values()): raise ValueError('FIXED_STRESS_COMPOSITION_SOURCES')
    modules={}
    for name in (STRESS_OBSERVER_FILES[0], STRESS_OBSERVER_FILES[-1]):
        path=ROOT/name
        fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=65536: raise ValueError('STRESS_OBSERVER_SOURCE_BOUND')
            raw=os.read(fd,65537);after=os.fstat(fd)
            if len(raw)!=before.st_size or (before.st_dev,before.st_ino,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_mtime_ns) or hashlib.sha256(raw).hexdigest()!=expected_source_hashes[name]: raise ValueError('STRESS_OBSERVER_SOURCE_HASH')
        finally:
            try:os.close(fd)
            except BaseException:_STRESS_UNKNOWN=True;raise
        module=types.ModuleType('private_'+name.replace('-','_'));module.__file__=str(path)
        exec(compile(raw,str(path),'exec'),module.__dict__);modules[name]=module
    observer=modules[STRESS_OBSERVER_FILES[0]].create_observer(absolute_deadline,{name:expected_source_hashes[name] for name in STRESS_OBSERVER_FILES[1:-1]})
    return StressComposition(phase,observer,expected_source_hashes,_STRESS_TOKEN,modules[STRESS_OBSERVER_FILES[-1]])


def create_common_composition(phase,deadline,hashes):
    global _STRESS_UNKNOWN
    if type(hashes) is not dict or set(hashes)!=set(COMMON_FILES) or any(type(v) is not str or re.fullmatch('[a-f0-9]{64}',v) is None for v in hashes.values()):raise ValueError('COMMON_SOURCE_TWELVE_REQUIRED')
    owner=create_stress_composition(phase,deadline,{n:hashes[n] for n in STRESS_OBSERVER_FILES})
    try:
        modules={}
        for name in COMMON_FILES[len(STRESS_OBSERVER_FILES):]:
            path=ROOT/name;fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                before=os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=131072:raise ValueError('COMMON_SOURCE_BOUND')
                raw=os.read(fd,131073);after=os.fstat(fd)
                if len(raw)!=before.st_size or (before.st_dev,before.st_ino,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_mtime_ns) or hashlib.sha256(raw).hexdigest()!=hashes[name]:raise ValueError('COMMON_SOURCE_HASH')
            finally:
                try:os.close(fd)
                except BaseException:_STRESS_UNKNOWN=True;raise
            module=types.ModuleType('private_common_'+name.replace('-','_'));module.__file__=str(path)
            exec(compile(raw,str(path),'exec'),module.__dict__);module.__source_sha256__=hashes[name];modules[name]=module
        owner.profile='candidate-common-view-stress-'+phase;owner._hashes=dict(hashes);owner._common=CommonEvidence(owner,modules)
        return owner
    except BaseException:
        if not owner.close():_STRESS_UNKNOWN=True
        raise


def create_ingress(profile='trusted-ingress-boundary'):
    if profile not in ('trusted-ingress-boundary', 'trusted-http-ingress-boundary'):
        raise ValueError('FIXED_INGRESS_PROFILE_REQUIRED')
    path = ROOT / 'subscription-systemd-ingress-rendezvous.py'
    raw = path.read_bytes()
    spec = importlib.util.spec_from_file_location('fixed_relay_ingress', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in module.SOURCES}
    if hashes.get(path.name) != hashlib.sha256(raw).hexdigest():
        raise ValueError('LOADED_INGRESS_SOURCE_DRIFT')
    return (module.create_http_rendezvous(hashes) if profile == 'trusted-http-ingress-boundary'
            else module.create_rendezvous(hashes))


def fixed_capsule_argv(probe, profile, ingress):
    if profile in COMMON_STRESS_PROFILES:return [*probe.CAPSULE,'--candidate-resource-stress-'+profile.rsplit('-',1)[1]]
    profile_contract(profile)
    needs_ingress = profile in ('trusted-ingress-boundary', 'trusted-http-ingress-boundary')
    if needs_ingress != (ingress is not None):
        raise ValueError('RELAY_INGRESS_TRANSPORT_MISMATCH')
    if needs_ingress:
        return ingress.receiver_argv()
    if profile in ('cli-proxy-refusal', 'trusted-cgroup-worker-boundary') + STRESS_PROFILES:
        return [*probe.CAPSULE, '--' + profile]
    return probe.CAPSULE


def bind_ingress_ready(frame, ownership, handoff, receipt):
    expected = {'fd': 198, 'socket': handoff['socket'],
                'bootstrapInheritance': 'trusted-setup-only', 'preservedAcrossPivot': True}
    def same(left, right):
        return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)
    if (handoff.get('unit') != ownership['unit'] or handoff.get('nonce') != ownership['nonce']
            or handoff.get('transferObserved') is not True or handoff.get('productionReady') is not False
            or not same(handoff.get('control'), receipt['control'])
            or not same(frame.get('trustedIngressFd'), expected)):
        raise ValueError('POST_PIVOT_INGRESS_BINDING')
    return {'nonce': ownership['nonce'], 'ownership': ownership, 'handoff': handoff}


def finish_ingress_route(ingress, unit):
    try:
        return ingress.finish_route()
    except (ValueError, OSError, RuntimeError) as error:
        return {'version': 1, 'unit': unit, 'passed': False, 'ownedCleanupVerified': False,
                'errorType': type(error).__name__, 'remoteUnitCleanup': 'NOT_ATTESTED', 'productionReady': False}


def close_relay_handles(selector, manager_fd, process):
    failure = None
    calls = ([] if selector is None else [selector.close])
    if manager_fd is not None:
        calls.append(lambda: os.close(manager_fd))
    calls.extend(pipe.close for pipe in (process.stdin, process.stdout, process.stderr) if not pipe.closed)
    for close in calls:
        try:
            close()
        except OSError as error:
            failure = failure or error
    if failure is not None:
        raise failure


class StageTrace:
    def __init__(self):
        self.began = time.monotonic()
        self.events = []
        self.events_dropped = 0
        self.main_pid = None
        self.manager = None
        self.main_stat = None
        self.main_stat_errno = None
        self.relay_state = None
        self.capsule_terminal = None
        self.capsule_ready_seen_ms = None

    def run(self, stage, call):
        began = time.monotonic()
        outcome, error_number = 'ok', None
        try:
            return call()
        except Exception as error:
            outcome = 'error'
            error_number = getattr(error, 'errno', None)
            raise
        finally:
            if len(self.events) < 64:
                self.events.append({'stage': stage, 'startedMs': round((began - self.began) * 1000),
                                    'durationMs': round((time.monotonic() - began) * 1000),
                                    'outcome': outcome, 'errno': error_number})
            else:
                self.events_dropped += 1

    def snapshot(self):
        return {'events': list(self.events), 'eventsDropped': self.events_dropped, 'mainPid': self.main_pid, 'manager': self.manager,
                'mainStat': self.main_stat, 'mainStatErrno': self.main_stat_errno, 'relayState': self.relay_state,
                'capsuleReadySeenMs': self.capsule_ready_seen_ms,
                'capsuleFailureTerminal': dict(self.capsule_terminal) if self.capsule_terminal else None}

    def capture_terminal(self, raw):
        if len(raw) > 65536:
            return
        try:
            frame = json.loads(raw)
        except (ValueError, RecursionError):
            return
        if isinstance(frame, dict) and frame.get('version') == 1 and frame.get('type') == 'terminal':
            encoded_size = len(json.dumps(frame, separators=(',', ':')).encode())
            self.capsule_terminal = {'frame': frame if encoded_size <= NESTED_TERMINAL_LIMIT else None,
                                     'rawSha256': hashlib.sha256(raw).hexdigest(), 'rawBytes': len(raw),
                                     'canonicalBytes': encoded_size,
                                     'omittedReason': None if encoded_size <= NESTED_TERMINAL_LIMIT else 'CANONICAL_TERMINAL_LIMIT'}


def observed(stage, call):
    return call() if TRACE is None else TRACE.run(stage, call)


def load_probe():
    spec = importlib.util.spec_from_file_location('fixed_systemd_probe', ROOT / 'subscription-systemd-cli-probe.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cgroup(pid):
    value = Path(f'/proc/{pid}/cgroup').read_text()
    if len(value) > 4096 or not value.startswith('0::/') or value.count('\n') != 1:
        raise ValueError('UNIFIED_PROCESS_CGROUP_REQUIRED')
    return value.strip()[3:]


def exact_readback(probe, unit):
    facts = observed('resource_readback', lambda: probe.readback(unit))
    if any(facts.get(key) != value for key, value in {
            'leaf': probe.leaf_path(unit), 'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '64'}.items()):
        raise ValueError('PRE_START_RESOURCE_MISMATCH')
    return {'memoryMax': facts['memory.max'], 'memorySwapMax': facts['memory.swap.max'], 'pidsMax': facts['pids.max']}


def manager_socket_metadata():
    """Fixed path only. Open every directory without following a symlink."""
    uid = os.getuid()
    path = '/run/user/' + str(uid) + '/systemd/private'
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open('/', flags)
    components = []
    try:
        for part in ('run', 'user', str(uid), 'systemd'):
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            item = os.fstat(fd)
            components.append({'dev': item.st_dev, 'ino': item.st_ino, 'mode': item.st_mode,
                               'uid': item.st_uid, 'gid': item.st_gid})
        item = os.stat('private', dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISSOCK(item.st_mode) or item.st_uid != uid:
            raise ValueError('PRIVATE_MANAGER_SOCKET_OWNER')
        components.append({'dev': item.st_dev, 'ino': item.st_ino, 'mode': item.st_mode,
                           'uid': item.st_uid, 'gid': item.st_gid})
        return {'path': path, 'components': components}
    finally:
        os.close(fd)


def process_start_ticks(pid):
    parts = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
    if len(parts) < 20 or not re.fullmatch(r'[0-9]{1,32}', parts[19]):
        raise ValueError('MANAGER_GENERATION_REQUIRED')
    return parts[19]


def manager_connection(probe):
    # Explicit private socket profile, not a fallback from a failed public RPC.
    before = observed('manager_socket_before', manager_socket_metadata)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.settimeout(1)
        observed('manager_private_connect', lambda: peer.connect(before['path']))
        raw = observed('manager_peer_metadata', lambda: peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        if len(raw) != struct.calcsize('3i'):
            raise ValueError('PRIVATE_MANAGER_PEER_SIZE')
        pid, uid, gid = struct.unpack('3i', raw)
        if pid < 2 or uid != os.getuid() or gid < 0:
            raise ValueError('PRIVATE_MANAGER_PEER_USER')
        fd = observed('manager_connection_pidfd', lambda: os.pidfd_open(pid))
        try:
            observed('manager_connection_live_before', lambda: signal.pidfd_send_signal(fd, 0))
            ticks = process_start_ticks(pid)
            group = cgroup(pid)
            after = observed('manager_socket_after', manager_socket_metadata)
            if after != before or process_start_ticks(pid) != ticks or cgroup(pid) != group:
                raise ValueError('PRIVATE_MANAGER_IDENTITY_CHANGED')
            observed('manager_connection_live_after', lambda: signal.pidfd_send_signal(fd, 0))
        finally:
            os.close(fd)
    result = {'managerIdentityProfile': 'private-socket-peer-v1', 'managerPid': pid, 'managerUid': uid,
              'managerGid': gid, 'managerStartTimeTicks': ticks, 'managerSocket': before, 'managerCgroup': group}
    if TRACE is not None:
        TRACE.manager = result
    return result


def binding(probe, unit, manager_identity=None, manager_fd=None):
    result = observed('unit_mainpid_query', lambda: subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'show', unit,
                             '--property=MainPID', '--property=ControlGroup'], env=probe.environment(),
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=True))
    if len(result.stdout) > 4096:
        raise ValueError('MANAGER_BINDING_LIMIT')
    fields = dict(line.split('=', 1) for line in result.stdout.decode('ascii').splitlines())
    pid = int(fields['MainPID'])
    if TRACE is not None:
        TRACE.main_pid = pid
        TRACE.main_stat = None
        TRACE.main_stat_errno = None
        try:
            raw_stat = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
            TRACE.main_stat = {'state': raw_stat[0], 'ppid': int(raw_stat[1]), 'startTimeTicks': raw_stat[19]}
        except (OSError, IndexError, ValueError) as error:
            TRACE.main_stat_errno = getattr(error, 'errno', None)
    leaf = probe.leaf_path(unit).removeprefix('/sys/fs/cgroup')
    if pid < 2 or fields['ControlGroup'] != leaf:
        raise ValueError('MANAGER_MAINPID_BINDING')
    fd = observed('main_pidfd_open', lambda: os.pidfd_open(pid))
    try:
        observed('main_pidfd_live_before', lambda: signal.pidfd_send_signal(fd, 0))
        if cgroup(pid) != leaf:
            raise ValueError('MAINPID_CGROUP_MISMATCH')
        parts = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        if len(parts) < 20:
            raise ValueError('MAINPID_STAT_INCOMPLETE')
        start_ticks = parts[19]
        if manager_identity is None:
            connection = manager_connection(probe)
        else:
            if manager_fd is None:
                raise ValueError('PINNED_MANAGER_REQUIRED')
            observed('manager_pidfd_live_before', lambda: signal.pidfd_send_signal(manager_fd, 0))
            connection = manager_connection(probe)
            if connection != manager_identity:
                raise ValueError('PRIVATE_MANAGER_IDENTITY_CHANGED')
        manager = connection['managerPid']
        if int(parts[1]) != manager:
            raise ValueError('PRIVATE_MANAGER_PARENT_MISMATCH')
        driver_cgroup, manager_cgroup = cgroup(os.getpid()), cgroup(manager)
        if manager_cgroup != connection['managerCgroup']:
            raise ValueError('PRIVATE_MANAGER_CGROUP_CHANGED')
        if any(value == leaf or value.startswith(leaf + '/') for value in (driver_cgroup, manager_cgroup)):
            raise ValueError('CONTROL_INSIDE_LEAF')
        observed('main_pidfd_live_after', lambda: signal.pidfd_send_signal(fd, 0))
        after = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        if len(after) < 20 or int(after[1]) != manager or after[19] != start_ticks:
            raise ValueError('MANAGER_PARENT_CHANGED')
        if manager_fd is not None:
            observed('manager_pidfd_live_after', lambda: signal.pidfd_send_signal(manager_fd, 0))
        return {'driverPid': os.getpid(), 'driverCgroup': driver_cgroup, **connection,
                'managerCgroup': manager_cgroup, 'unitMainPid': pid, 'unitMainCgroup': leaf,
                'unitMainStartTimeTicks': start_ticks}
    finally:
        os.close(fd)


def unit_absent(probe, unit):
    result = subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'show', unit, '--property=LoadState'],
                            env=probe.environment(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=2, check=False)
    return result.returncode in (0, 1, 4) and result.stdout.strip() == b'LoadState=not-found'


def admit_start(probe, unit, receipt, frame, fd, manager_identity=None, manager_fd=None):
    readback = exact_readback(probe, unit)
    current = binding(probe, unit) if manager_identity is None else binding(probe, unit, manager_identity, manager_fd)
    if current != receipt['control']:
        raise ValueError('PRE_START_IDENTITY_CHANGED')
    raw = (json.dumps(frame, separators=(',', ':')) + '\n').encode()
    if len(raw) > 4096 or os.write(fd, raw) != len(raw):
        raise ValueError('START_WRITE_NOT_ATOMIC')
    return readback


_WIRE_COUNTER=None


class WireCounter:
    def __init__(self):self.written=0;self.finalizing=False
    def remaining(self):return WIRE_LIMIT-(0 if self.finalizing else QUEUE_LIMIT)-self.written


class Buffer:
    def __init__(self, limit=QUEUE_LIMIT):
        self.data = bytearray()
        self.limit = limit
        self.counter=_WIRE_COUNTER

    def append(self, data):
        if len(self.data) + len(data) > self.limit:
            raise ValueError('RELAY_QUEUE_LIMIT')
        self.data.extend(data)

    def frame(self, value):
        self.append((json.dumps(value, separators=(',', ':')) + '\n').encode())

    def drain(self, fd):
        if self.data:
            try:
                data=self.data
                if fd==1 and self.counter is not None:
                    remaining=self.counter.remaining()
                    if remaining<len(self.data):raise ValueError('COMMON_ACTUAL_STDOUT_LIMIT')
                count = os.write(fd, data)
                if type(count) is not int or not 0<count<=len(data):raise ValueError('RELAY_WRITE_COUNT')
                if fd==1 and self.counter is not None:self.counter.written+=count
                del self.data[:count]
            except BlockingIOError:
                pass


def emit_before_spawn(frame):
    """No owned process exists until the immutable ownership frame is drained."""
    output = Buffer()
    output.frame(frame)
    os.set_blocking(1, False)
    until = time.monotonic() + 2
    while output.data and time.monotonic() < until:
        output.drain(1)
        time.sleep(0.01)
    if output.data:
        raise ValueError('OWNERSHIP_OUTPUT_BACKPRESSURE_NO_SPAWN')


def failure_evidence(probe, ownership, error, proc=None, diagnostics=b'', diagnostic_total=0, diagnostic_hash=None):
    absent = None
    try:
        absent = unit_absent(probe, ownership['unit'])
    except (ValueError, OSError, subprocess.SubprocessError):
        pass
    leaf_absent = None
    try:
        leaf_absent = not Path(ownership['leaf']).exists()
    except OSError:
        pass
    frame = {'version': 1, 'type': 'systemd_failure', 'ownership': ownership, 'error': error[:1024],
            'cleanup': {'unitAbsent': absent, 'leafAbsent': leaf_absent,
                        'systemdRunClosed': proc is not None and proc.poll() is not None},
            'stageEvidence': TRACE.snapshot() if TRACE is not None else None,
            'diagnostics': {'notSpawned': proc is None,
                            'stderrPrefix': diagnostics.decode(errors='replace'), 'stderrBytes': diagnostic_total,
                            'stderrPrefixTruncated': diagnostic_total > len(diagnostics),
                            'stderrSha256': diagnostic_hash or hashlib.sha256(diagnostics).hexdigest()}}
    def size():
        # Exactly the serialization used by Buffer.frame, including newline.
        return len((json.dumps(frame, separators=(',', ':')) + '\n').encode())
    stage = frame['stageEvidence']
    if size() > FAILURE_FRAME_LIMIT and stage and stage['capsuleFailureTerminal']:
        stage['capsuleFailureTerminal']['frame'] = None
        stage['capsuleFailureTerminal']['omittedReason'] = 'FAILURE_ENVELOPE_LIMIT'
    while size() > FAILURE_FRAME_LIMIT and stage and stage['events']:
        stage['events'].pop()
        stage['eventsDropped'] += 1
    while size() > FAILURE_FRAME_LIMIT and frame['diagnostics']['stderrPrefix']:
        prefix = frame['diagnostics']['stderrPrefix']
        frame['diagnostics']['stderrPrefix'] = prefix[:len(prefix) // 2]
        frame['diagnostics']['stderrPrefixTruncated'] = True
    # Remaining fields are fixed bounded ownership, primary reason and numeric
    # metadata. Neither primary reason nor unit identity is discarded.
    if size() > FAILURE_FRAME_LIMIT:
        raise ValueError('INVALID_UNBOUNDED_FAILURE_IDENTITY')
    return frame


def read_stress_composition(common=False):
    began=time.monotonic();deadline=began+180;raw=bytearray()
    os.set_blocking(0,False)
    selector=selectors.DefaultSelector()
    try:
        selector.register(0,selectors.EVENT_READ)
        while True:
            if time.monotonic()>=began+5: raise ValueError('STRESS_COMPOSITION_PRELUDE_DEADLINE')
            events=selector.select(min(.01,max(0,began+5-time.monotonic())))
            if time.monotonic()>=began+5: raise ValueError('STRESS_COMPOSITION_PRELUDE_DEADLINE')
            if not events: continue
            try:part=os.read(0,1)
            except BlockingIOError:continue
            if not part: raise ValueError('STRESS_COMPOSITION_PRELUDE_EOF')
            raw.extend(part)
            if len(raw)>4096: raise ValueError('STRESS_COMPOSITION_PRELUDE_LIMIT')
            if part==b'\n': break
    finally: selector.close()
    if time.monotonic()>=began+5: raise ValueError('STRESS_COMPOSITION_PRELUDE_DEADLINE')
    value=strict_stress_json(bytes(raw))
    if type(value) is not dict or set(value)!={'type','sourceSha256'} or value['type']!=('common_stress_composition' if common else 'stress_composition'): raise ValueError('STRESS_COMPOSITION_PRELUDE')
    return deadline,value['sourceSha256']


def main():
    if sys.platform!='linux': raise ValueError('FIXED_LINUX_ENTRY_REQUIRED')
    profile=select_profile(sys.argv[1:])
    if profile in ALL_STRESS_PROFILES:
        common=profile in COMMON_STRESS_PROFILES
        deadline,hashes=read_stress_composition(common)
        factory=create_common_composition if common else create_stress_composition
        owner=factory(profile.rsplit('-',1)[1],deadline,hashes)
        try:return owner.run()
        finally:owner.close()
    return _run_profile(profile)


def _run_profile(profile, stress_owner=None):
    global TRACE,_WIRE_COUNTER
    TRACE = StageTrace()
    _WIRE_COUNTER=WireCounter() if profile in COMMON_STRESS_PROFILES else None
    if sys.platform != 'linux':
        raise ValueError('FIXED_LINUX_ENTRY_REQUIRED')
    if (profile in ALL_STRESS_PROFILES) != (type(stress_owner) is StressComposition): raise ValueError('STRESS_OWNER_REQUIRED')
    if stress_owner is not None and stress_owner.profile != profile: raise ValueError('STRESS_OWNER_PROFILE')
    probe = stress_owner._observer.probe if stress_owner is not None else load_probe()
    ingress = None
    unit = None
    ingress_owner = None
    handoff = None
    ingress_result = None
    try:
        ingress = (create_ingress('trusted-http-ingress-boundary') if profile == 'trusted-http-ingress-boundary'
                   else create_ingress() if profile == 'trusted-ingress-boundary' else None)
        unit = stress_owner.unit if stress_owner is not None else ingress.unit if ingress is not None else 'codex-cli-resource-' + uuid.uuid4().hex + '.service'
        leaf = probe.leaf_path(unit)
        ownership = {'unit': unit, 'uid': os.getuid(), 'leaf': leaf, 'driverPid': os.getpid(),
                     'relaySha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                     'probeSha256': hashlib.sha256((ROOT / 'subscription-systemd-cli-probe.py').read_bytes()).hexdigest()}
        emit_before_spawn({'version': 1, 'type': 'systemd_ownership', 'ownership': ownership})
        if ingress is not None:
            ingress_owner = ingress.ownership()
            emit_before_spawn({'version': 1, 'type': 'systemd_ingress_ownership', 'ownership': ingress_owner})
        capsule_argv = fixed_capsule_argv(probe, profile, ingress)
    except (ValueError, OSError):
        if ingress is not None:
            finish_ingress_route(ingress, unit)
        raise
    argv = _unit_argv(probe, profile, unit, capsule_argv)
    # Never adopt a pre-existing name, even though UUID collision is unlikely.
    manager_fd = None
    try:
        if Path(leaf).exists() or not observed('before_spawn_unit_absence', lambda: unit_absent(probe, unit)):
            raise ValueError('OWN_UNIT_NAME_NOT_UNUSED')
        # Private metadata admission occurs before capsule START_SECONDS begins.
        manager_identity = observed('manager_preflight', lambda: manager_connection(probe))
        manager_fd = observed('manager_pidfd_open', lambda: os.pidfd_open(manager_identity['managerPid']))
        observed('manager_preflight_live', lambda: signal.pidfd_send_signal(manager_fd, 0))
        if process_start_ticks(manager_identity['managerPid']) != manager_identity['managerStartTimeTicks'] or cgroup(manager_identity['managerPid']) != manager_identity['managerCgroup']:
            raise ValueError('PRIVATE_MANAGER_GENERATION_CHANGED')
        if stress_owner is not None:
            initial=stress_owner.before_spawn(manager_identity,manager_fd)
            if stress_owner._common is not None:common_pretarget(stress_owner)
            else:emit_before_spawn(initial)
        proc = observed('systemd_run_spawn', lambda: subprocess.Popen(argv, env=probe.environment(), cwd='/', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        preflight_error = type(error).__name__ + ':' + str(error)
        if manager_fd is not None:
            try:
                os.close(manager_fd)
            except OSError:
                preflight_error += ';MANAGER_HANDLE_CLOSE_UNKNOWN'
        if ingress is not None:
            ingress_result = finish_ingress_route(ingress, unit)
            emit_before_spawn({'version': 1, 'type': 'systemd_ingress_terminal', 'result': ingress_result})
        if _WIRE_COUNTER is not None:_WIRE_COUNTER.finalizing=True
        emit_before_spawn(failure_evidence(probe, ownership, preflight_error))
        return 1
    selector = None
    outbound, inbound = Buffer(), Buffer()
    partial = {'control': bytearray(), 'capsule': bytearray()}
    totals = {'control': 0, 'capsule': 0, 'diagnostics': 0}
    diagnostic_prefix = bytearray()
    diagnostic_hash = hashlib.sha256()
    errors = []
    receipt = None
    prestart = None
    terminal = None
    ready_at = None
    started = False
    stress_actions = StressActions(profile) if profile in ALL_STRESS_PROFILES else None
    stress_runner = (stress_owner._runner or StressObserverRunner(stress_owner)) if stress_owner is not None else None
    pending_seq = None
    sequence = 0
    last_control = time.monotonic()
    began = last_control
    stop_at = None
    stop_requested = False
    finished = False
    capsule_eof = False

    def stop(reason):
        nonlocal stop_at, stop_requested
        if reason and reason not in errors and len(errors) < 16:
            errors.append(reason)
        if reason and stress_runner is not None:stress_runner.cancel()
        if stop_at is None:
            stop_at = time.monotonic()
            # Discard queued fixture input; EOF triggers the inner owned cleanup.
            inbound.data.clear()
            proc.stdin.close()
        if reason and not stop_requested:
            stop_requested = True
            # Fixed exact unit only. Nonblocking systemd job preserves its own 5s grace.
            try:
                stopped = observed('own_unit_stop', lambda: subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', '--no-block', 'stop', unit],
                                         env=probe.environment(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, timeout=2, check=False))
                if stopped.returncode != 0 and len(errors) < 16:
                    # A concurrently collected unit is already absent, not a
                    # second primary stop failure. Missing query stays unknown.
                    if not (observed('after_stop_unit_absence', lambda: unit_absent(probe, unit)) and not Path(leaf).exists()):
                        errors.append('OWN_UNIT_STOP_FAILED')
            except (OSError, subprocess.SubprocessError):
                if len(errors) < 16:
                    errors.append('OWN_UNIT_STOP_UNKNOWN')

    def finish_ingress():
        nonlocal ingress_result
        if ingress is not None and ingress_result is None:
            ingress_result = finish_ingress_route(ingress, unit)
        return ingress_result

    try:
        selector = selectors.DefaultSelector()
        for fd, kind in [(0, 'control'), (proc.stdout.fileno(), 'capsule'), (proc.stderr.fileno(), 'diagnostics')]:
            os.set_blocking(fd, False)
            selector.register(fd, selectors.EVENT_READ, kind)
        os.set_blocking(1, False)
        os.set_blocking(proc.stdin.fileno(), False)
        if ingress is not None:
            handoff = observed('ingress_fd_transfer', lambda: ingress.transfer(manager_identity, manager_fd))
            ingress.start_route()
            outbound.frame({'version': 1, 'type': 'systemd_ingress_handoff', 'handoff': handoff})
        while True:
            now = time.monotonic()
            TRACE.relay_state = {'ready': receipt is not None, 'started': started, 'terminal': terminal is not None}
            if stress_owner is not None and stop_at is None:
                if time.monotonic()>=stress_owner._observer.deadline: stop('STRESS_OWNER_DEADLINE')
            if now - began >= 200:
                stop('RELAY_COMMAND_DEADLINE')
            if ready_at is None and now - began > 20:
                stop('RELAY_READY_TIMEOUT')
            if ready_at is not None and not started and now - ready_at > 5:
                stop('RELAY_START_TIMEOUT')
            if started and terminal is None and now - last_control > 3:
                stop('RELAY_CONTROL_LEASE')
            if stop_at is not None and now - stop_at > 12:
                break
            pump_relay_buffers(outbound,inbound,proc,stress_runner,stop_at,terminal)
            for key, _ in selector.select(0.01):
                if key.data=='capsule' and stress_runner is not None and stress_runner.queued_bytes>131072:
                    continue  # Bounded backpressure; keep pumping control/diagnostics.
                try:
                    block = os.read(key.fd, 4096)
                except BlockingIOError:
                    continue
                kind = key.data
                if not block:
                    selector.unregister(key.fd)
                    if kind == 'control':
                        stop('CONTROL_PARTIAL_EOF' if partial['control'] else None)
                    if kind == 'capsule':
                        capsule_eof = True
                        if partial['capsule']:
                            stop('CAPSULE_PARTIAL_EOF')
                    continue
                totals[kind] += len(block)
                if kind == 'diagnostics':
                    diagnostic_hash.update(block)
                    diagnostic_prefix.extend(block[:max(0, 4096 - len(diagnostic_prefix))])
                if totals[kind] > (CONTROL_LIMIT if kind == 'control' else 65536 if kind == 'diagnostics' else WIRE_LIMIT):
                    stop('RELAY_WIRE_LIMIT')
                    continue
                if kind == 'diagnostics':
                    continue  # Fixed systemd-run diagnostics are not authored output.
                partial[kind].extend(block)
                while b'\n' in partial[kind]:
                    raw, _, rest = partial[kind].partition(b'\n')
                    partial[kind] = bytearray(rest)
                    if len(raw) > (4096 if kind == 'control' else 65536):
                        raise ValueError('RELAY_FRAME_LIMIT')
                    frame = json.loads(raw)
                    if not isinstance(frame, dict):
                        raise ValueError('RELAY_FRAME_OBJECT')
                    if kind == 'control':
                        last_control = time.monotonic()
                        if stop_at is not None or terminal is not None:
                            continue
                        if frame == {'type': 'cancel'}:
                            accept_relay_cancel(inbound, stress_runner)
                        elif frame == {'type': 'heartbeat'}:
                            if not inbound.data:
                                inbound.frame(frame)
                        elif frame.get('type') == 'start':
                            if receipt is None or started:
                                raise ValueError('RELAY_FIXED_START_REQUIRED')
                            if inbound.data:
                                raise ValueError('START_QUEUE_NOT_EMPTY')
                            # This fixed start is below PIPE_BUF: fail on EAGAIN,
                            # never defer first bytes beyond the admission check.
                            prestart = admit_profile_start(profile, probe, unit, receipt, ready_frame, frame,
                                                           proc.stdin.fileno(), manager_identity, manager_fd)
                            started = True
                            if stress_runner is not None: stress_runner.enqueue('baseline')
                        elif frame.get('type') == 'stress_action':
                            if not started or stress_actions is None: raise ValueError('RELAY_STRESS_ACTION_ORDER')
                            if inbound.data: raise ValueError('STRESS_ACTION_QUEUE_NOT_EMPTY')
                            stress_actions.accept(frame)
                            stress_runner.enqueue('action',frame)
                        elif frame.get('type') == 'fixture_input':
                            require_interactive_profile(profile)
                            if not started or pending_seq is not None or set(frame) != {'type', 'seq', 'data'} or type(frame['seq']) is not int or frame['seq'] != sequence + 1:
                                raise ValueError('RELAY_INPUT_ORDER')
                            sequence = frame['seq']
                            pending_seq = sequence
                            inbound.frame(frame)
                        else:
                            raise ValueError('RELAY_UNKNOWN_CONTROL')
                    else:
                        if terminal is not None:
                            raise ValueError('CAPSULE_FRAME_AFTER_TERMINAL')
                        if frame.get('type') == 'ready':
                            if receipt is not None:
                                raise ValueError('DUPLICATE_READY')
                            TRACE.capsule_ready_seen_ms = round((time.monotonic() - TRACE.began) * 1000)
                            receipt = {'unit': unit, 'uid': os.getuid(), 'leaf': leaf,
                                       'aggregateResourceReadbackValidated': True, 'candidateExhaustionValidated': False,
                                       'relaySha256': ownership['relaySha256'],
                                       'probeSha256': ownership['probeSha256'],
                                       'limits': LIMITS, 'control': binding(probe, unit, manager_identity, manager_fd), 'readback': stress_readback(probe, unit) if profile in ALL_STRESS_PROFILES else exact_readback(probe, unit)}
                            if ingress is not None:
                                frame['systemdIngressBoundary'] = bind_ingress_ready(frame, ingress_owner, handoff, receipt)
                            ready_frame = frame
                            frame['systemdFixtureBoundary'] = receipt
                            ready_at = time.monotonic()
                        elif receipt is None:
                            raise ValueError('CAPSULE_OUTPUT_BEFORE_READY')
                        if frame.get('type') == 'child_output' and stress_owner is not None:
                            stress_runner.enqueue('output',frame)
                        if frame.get('type') == 'stress_action_delivered':
                            if not started or stress_actions is None: raise ValueError('RELAY_STRESS_DELIVERY_ORDER')
                            stress_actions.delivered(frame)
                        if frame.get('type') == 'fixture_input_ack':
                            if type(frame.get('seq')) is not int or pending_seq != frame['seq']:
                                raise ValueError('RELAY_ACK_ORDER')
                            pending_seq = None
                        if frame.get('type') == 'terminal':
                            TRACE.capture_terminal(raw)
                            terminal = frame
                            stop(None)
                        else:
                            outbound.frame(frame)
                if len(partial[kind]) > (4096 if kind == 'control' else 65536):
                    raise ValueError('RELAY_PARTIAL_LIMIT')
            if proc.poll() is not None and capsule_eof:
                if terminal is None:
                    raise ValueError('CAPSULE_TERMINAL_MISSING')
                if stress_runner is not None and not stress_runner.idle(): continue
                absent = unit_absent(probe, unit)
                leaf_absent = not Path(leaf).exists()
                if not absent or not leaf_absent:
                    if stop_at is None:
                        stop(None)
                    continue
                terminal['systemdFixtureBoundary'] = {**receipt, 'preStartReadback': prestart,
                    'cleanup': {'unitAbsent': absent, 'leafAbsent': leaf_absent, 'systemdRunClosed': True}, 'relayErrors': errors}
                if ingress is not None and finish_ingress().get('passed') is not True:
                    raise ValueError('INGRESS_ROUTE_OR_CLEANUP_FAILED')
                if stress_owner is not None:
                    if stress_owner._partial: raise ValueError('STRESS_CHILD_PARTIAL_EOF')
                    if not stress_owner.close(): raise ValueError('STRESS_OBSERVER_CLOSE_UNKNOWN')
                    terminal['candidateStressObserver']={'sourceSha256':dict(stress_owner._hashes),'observationSha256':list(stress_owner._records),'localHandlesClosed':True,'exhaustionValidated':False}
                    if stress_owner._common is not None:
                        if tuple(stress_owner._common.completed)!=tuple(stress_owner._common.codec.LABELS):raise ValueError('COMMON_DOCUMENTS_NOT_DRAINED')
                        terminal['candidateStressObserver'].update(namespaceEvidenceProfile='common-visible-cgroup2-v1',documents=copy.deepcopy(stress_owner._common.completed))
                if _WIRE_COUNTER is not None:_WIRE_COUNTER.finalizing=True
                outbound.frame(terminal)
                if ingress is not None:
                    outbound.frame({'version': 1, 'type': 'systemd_ingress_terminal', 'result': ingress_result})
                until = time.monotonic() + 2
                while outbound.data and time.monotonic() < until:
                    outbound.drain(1)
                    time.sleep(0.01)
                finished = not outbound.data
                break
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        stop(type(error).__name__ + ':' + str(error)[:160])
    finally:
        if not finished:
            stop('RELAY_INCOMPLETE')
            failure_output_ready = False
            try:
                # Ownership emission already made stdout nonblocking before
                # spawn. Reconfirm before every failure write; if this fails,
                # preserve cleanup without risking an unbounded diagnostic.
                os.set_blocking(1, False)
                failure_output_ready = True
            except OSError:
                if len(errors) < 16:
                    errors.append('FAILURE_OUTPUT_UNKNOWN')
            # Setup may have failed before either output was made nonblocking.
            # Never enter a failure drain with an unbounded read on such a pipe.
            drainable = set()
            for name in ('stdout', 'stderr'):
                try:
                    os.set_blocking(getattr(proc, name).fileno(), False)
                    drainable.add(name)
                except OSError:
                    if len(errors) < 16:
                        errors.append('FAILURE_DRAIN_' + name.upper() + '_UNKNOWN')
            until = time.monotonic() + 8
            def drain_failed_stdout():
                if 'stdout' not in drainable:
                    return
                try:
                    block = os.read(proc.stdout.fileno(), 4096)
                except OSError:
                    return
                totals['capsule'] += len(block)
                if totals['capsule'] > WIRE_LIMIT:
                    return
                partial['capsule'].extend(block)
                while b'\n' in partial['capsule']:
                    raw, _, rest = partial['capsule'].partition(b'\n')
                    partial['capsule'] = bytearray(rest)
                    if len(raw) > 65536:
                        continue
                    TRACE.capture_terminal(raw)
                if len(partial['capsule']) > 65536:
                    partial['capsule'].clear()
            while proc.poll() is None and time.monotonic() < until:
                drain_failed_stdout()
                try:
                    block = os.read(proc.stderr.fileno(), 4096) if 'stderr' in drainable else b''
                    totals['diagnostics'] += len(block)
                    diagnostic_hash.update(block)
                    diagnostic_prefix.extend(block[:max(0, 4096 - len(diagnostic_prefix))])
                except OSError:
                    pass
                time.sleep(0.02)
            for _ in range(16):
                drain_failed_stdout()
                try:
                    block = os.read(proc.stderr.fileno(), 4096) if 'stderr' in drainable else b''
                except OSError:
                    break
                if not block:
                    break
                totals['diagnostics'] += len(block)
                diagnostic_hash.update(block)
                diagnostic_prefix.extend(block[:max(0, 4096 - len(diagnostic_prefix))])
            outbound.data.clear()
            if ingress is not None:
                outbound.frame({'version': 1, 'type': 'systemd_ingress_terminal', 'result': finish_ingress()})
            if _WIRE_COUNTER is not None:_WIRE_COUNTER.finalizing=True
            outbound.frame(failure_evidence(probe, ownership, ';'.join(errors), proc,
                                           bytes(diagnostic_prefix), totals['diagnostics'], diagnostic_hash.hexdigest()))
            until = time.monotonic() + 0.5
            while failure_output_ready and outbound.data and time.monotonic() < until:
                try:
                    outbound.drain(1)
                except OSError:
                    break
                time.sleep(0.01)
            # No success terminal on failed/uncertain cleanup. Manager guardian
            # is independent of this relay and owns remaining unit processes.
        close_relay_handles(selector, manager_fd, proc)
    return 0 if finished and not errors else 1


if __name__ == '__main__':
    sys.exit(main())
