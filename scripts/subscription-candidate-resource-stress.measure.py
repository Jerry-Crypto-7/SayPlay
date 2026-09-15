"""Fixed Windows evidence driver for separately owned tasks/memory diagnostics."""
import base64
import hashlib
import json
import math
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import types
import uuid

SELF = 'scripts/subscription-candidate-resource-stress.measure.py'
BASE = 'scripts/subscription-cli-supervisor.measure.py'
RESOURCE = 'scripts/subscription-exec-environment-systemd.measure.py'
RELAY = 'scripts/subscription-systemd-fixture-transport.py'
CHILD = 'scripts/subscription-candidate-resource-stress-child.py'
EVENTS = 'scripts/subscription-candidate-resource-events.py'
CAPACITY = 'scripts/subscription-candidate-resource-capacity.py'
EVIDENCE = 'scripts/subscription-candidate-resource-stress-evidence.py'
OBSERVER_FILES = ('subscription-candidate-resource-stress-observer.py', 'subscription-candidate-resource-events.py',
    'subscription-systemd-fixture-transport.py', 'subscription-systemd-cli-probe.py', 'subscription-candidate-resource-capacity.py')
ADDITIONAL = (SELF, RESOURCE, CHILD, EVENTS, CAPACITY, RELAY, EVIDENCE,
    'scripts/subscription-candidate-resource-stress-observer.py', 'scripts/subscription-systemd-cli-probe.py',
    'scripts/subscription-candidate-resource-stress-worker.py', 'scripts/subscription-candidate-resource-stress-protocol.py')
READBACK = {'memoryMax': '2147483648', 'memorySwapMax': '0', 'pidsMax': '64', 'memoryOomGroup': '0', 'oomPolicy': 'continue'}
COMMON_FILES = tuple('subscription-cgroup-'+name+'.py' for name in (
    'common-view-service','common-view','common-view-child','common-view-preflight',
    'target-ancestry','evidence-stream','evidence-validation'))
COMMON_OBSERVER_FILES = OBSERVER_FILES + COMMON_FILES
COMMON_PROFILE = 'common-visible-cgroup2-v1'
_UNKNOWN = False


def encode(value): return (json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n').encode()
def same(a, b): return json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False)
def strict(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))


def command(phase, common=False):
    if phase not in ('tasks', 'memory'): raise ValueError('FIXED_PHASE')
    if type(common) is not bool: raise ValueError('FIXED_PROFILE')
    return ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
        '/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/' + RELAY,
        ('--candidate-common-view-stress-' if common else '--candidate-resource-stress-') + phase]


def load(path, raw):
    module = types.ModuleType('private_measure_' + Path(path).name.replace('-', '_'))
    module.__file__ = path
    exec(compile(raw, path, 'exec'), module.__dict__)
    module.__source_sha256__ = hashlib.sha256(raw).hexdigest()
    return module


def failure_label(failure):
    # Only fixed symbolic reasons are copied into the concise error list.
    reason = str(failure)
    if type(failure) is ValueError and re.fullmatch(r'[A-Z][A-Z0-9_]{0,127}', reason):
        return 'ValueError:' + reason
    return type(failure).__name__


def drain_reader(stream, captured, limit, done, incoming, errors, evidence, canonical_evidence=False):
    """After invalid framing, retain remaining bounded bytes without dispatch."""
    parsing = incoming is not None
    evidence.update(eofObserved=False, captureTruncated=False, parseFailed=False)
    try:
        while True:
            line = stream.readline(min(65537, limit-len(captured)+1))
            if not line:
                evidence['eofObserved'] = True
                return
            remaining = limit-len(captured)
            captured.extend(line[:remaining])
            if len(line)>remaining:
                evidence['captureTruncated'] = True
                errors.append('DRIVER_OUTPUT_BOUND')
                return
            if not parsing: continue
            try:
                if len(line)>65536 or not line.endswith(b'\n'): raise ValueError('DRIVER_FRAME_BOUND')
                frame=strict(line)
                if (canonical_evidence and type(frame) is dict and frame.get('type')=='cgroup_evidence'
                        and (json.dumps(frame,sort_keys=True,separators=(',',':'),ensure_ascii=True,
                                        allow_nan=False)+'\n').encode('ascii')!=line):
                    raise ValueError('DRIVER_DOCUMENT_CANONICAL')
                incoming.put_nowait(frame)
            except (ValueError, UnicodeError, queue.Full) as failure:
                parsing = False
                evidence['parseFailed'] = True
                evidence['failure'] = failure_label(failure)
                errors.append('DRIVER_READ_FAILED')
    except (OSError, ValueError) as failure:
        errors.append('DRIVER_READ_FAILED:'+failure_label(failure))
    finally: done.set()


def classify_failure(frame, owner, hashes, resource):
    # A diagnostic interpretation, never remote cleanup or stress credit.
    result = {'classification':'CLEANUP_UNKNOWN','ownershipMatched':False,
              'remoteCleanupCredit':False,'stressValidated':False}
    if (type(frame) is not dict or set(frame)!={'version','type','ownership','error','cleanup','stageEvidence','diagnostics'}
            or type(frame['version']) is not int or frame['version']!=1 or frame['type']!='systemd_failure'
            or owner is None or not same(frame['ownership'],owner)
            or not resource.validate_ownership(owner,hashes)):
        return result
    result['ownershipMatched']=True
    cleanup=frame['cleanup'];diagnostics=frame['diagnostics']
    if (type(cleanup) is dict and set(cleanup)=={'unitAbsent','leafAbsent','systemdRunClosed'}
            and type(diagnostics) is dict and diagnostics.get('notSpawned') is True
            and cleanup['unitAbsent'] is True and cleanup['leafAbsent'] is True
            and cleanup['systemdRunClosed'] is False):
        result['classification']='PRE_SPAWN_FAILURE_ABSENCE_REPORTED'
    return result


def capture_sources(common=False):
    if type(common) is not bool: raise ValueError('FIXED_PROFILE')
    base_raw = Path(BASE).read_bytes(); base = load(BASE, base_raw)
    paths = tuple(dict.fromkeys((*base.SOURCES, *ADDITIONAL,
        *(('scripts/'+name for name in COMMON_FILES) if common else ()))))
    if len(paths)>40 or any(type(path) is not str or re.fullmatch(r'scripts/subscription-[a-z0-9.-]+\.(py|sh|json)',path) is None for path in paths):
        raise ValueError('FIXED_REPOSITORY_SOURCE_PATHS')
    raw = {path: Path(path).read_bytes() for path in paths}
    if raw[BASE] != base_raw or any(not 0 < len(value) <= 1048576 for value in raw.values()):
        raise ValueError('SOURCE_CAPTURE_DRIFT_OR_BOUND')
    hashes = {path: hashlib.sha256(value).hexdigest() for path, value in raw.items()}
    return raw, hashes


class Wire:
    """Only fixed phase actions; observer events cannot substitute final evidence."""
    def __init__(self, phase, raw, hashes, common=False):
        command(phase, common)
        self.common = common
        self.phase, self.raw, self.hashes = phase, raw, hashes
        self.base = load(BASE, raw[BASE]); self.resource = load(RESOURCE, raw[RESOURCE])
        # Private validator compares the complete new readback; raw reports are
        # never normalized into historical profile evidence.
        self.resource.READBACK = dict(READBACK)
        self.child = load(CHILD, raw[CHILD])
        self.frames = []; self.owner = None; self.ready = None; self.started = False
        self.baseline = False; self.actions = []; self.delivered = []; self.terminal = None
        self.observations = []; self.stdout = bytearray(); self.stderr = bytearray()
        self.failure = None
        self.documents = {}; self.preflight = None; self.common_ready = None; self.decoder = None
        if common:
            names = ('subscription-cgroup-evidence-stream.py','subscription-cgroup-common-view-service.py',
                'subscription-cgroup-common-view.py','subscription-cgroup-target-ancestry.py',
                'subscription-candidate-resource-events.py','subscription-cgroup-evidence-validation.py')
            self.common_deps = tuple(load('scripts/'+name,raw['scripts/'+name]) for name in names)
            self.codec,self.service,self.sampler,self.target,self.events,self.linkage = self.common_deps

    def prelude(self):
        return {'type': 'common_stress_composition' if self.common else 'stress_composition',
            'sourceSha256': {name: self.hashes['scripts/' + name] for name in
                (COMMON_OBSERVER_FILES if self.common else OBSERVER_FILES)}}

    def action(self, name):
        expected = ['start', 'release'] if self.phase == 'tasks' else ['start', 'ramp', 'release']
        if len(self.actions) >= len(expected) or expected[len(self.actions)] != name: raise ValueError('DRIVER_ACTION_ORDER')
        self.actions.append(name)
        return {'type': 'stress_action', 'action': name}

    def validate_preflight(self, frame):
        keys = {'version','type','targetUnit','sourceSha256','dependencySha256','documentSha256',
            'documentBytes','framesEnqueued','framesPolled','wireBytesPolled','maxQueueBytes',
            'workerFinished','queueDocumentDrained','localHandlesKnown','closeKnown','cancelled',
            'error','releaseAdmitted','productionReady'}
        raw = self.documents.get('service')
        if (set(frame)!=keys or self.owner is None or raw is None
                or frame['targetUnit']!=self.owner['unit']): raise ValueError('DRIVER_PREFLIGHT_BINDING')
        deps = (self.service.FILES[0],self.service.FILES[1],
            'subscription-cgroup-evidence-stream.py','subscription-candidate-resource-events.py')
        if (not same(frame['sourceSha256'],{n:self.hashes['scripts/'+n] for n in self.service.FILES})
                or not same(frame['dependencySha256'],{n:self.hashes['scripts/'+n] for n in deps})
                or frame['documentSha256']!=hashlib.sha256(raw).hexdigest()
                or type(frame['documentBytes']) is not int or frame['documentBytes']!=len(raw)
                or any(frame[n] is not True for n in ('workerFinished','queueDocumentDrained','localHandlesKnown','closeKnown'))
                or any(frame[n] is not False for n in ('cancelled','releaseAdmitted','productionReady'))
                or frame['error'] is not None): raise ValueError('DRIVER_PREFLIGHT_KNOWN')
        encoded=list(self.codec.encode_document(self.owner['unit'],'service',raw))
        for name,value in (('framesEnqueued',len(encoded)),('framesPolled',len(encoded)),
                           ('wireBytesPolled',sum(map(len,encoded)))):
            if type(frame[name]) is not int or frame[name]!=value: raise ValueError('DRIVER_PREFLIGHT_ACCOUNTING')
        if type(frame['maxQueueBytes']) is not int or not 0<frame['maxQueueBytes']<=262144:
            raise ValueError('DRIVER_PREFLIGHT_QUEUE')
        body=self.service.strict(raw)
        if (body.get('commonViewValidated') is not True or body.get('unit')==self.owner['unit'] or not self.service.validate_report(body,
                {n:self.hashes['scripts/'+n] for n in self.service.FILES},(self.sampler,))):
            raise ValueError('DRIVER_PREFLIGHT_SERVICE')

    def receive(self, frame):
        if type(frame) is not dict or type(frame.get('version')) is not int or frame['version'] != 1 or self.terminal is not None:
            raise ValueError('DRIVER_FRAME_ENVELOPE')
        self.frames.append(frame); kind = frame.get('type'); outgoing = []
        if kind == 'systemd_ownership':
            if self.owner is not None or set(frame) != {'version', 'type', 'ownership'} or not self.resource.validate_ownership(frame['ownership'], self.hashes):
                raise ValueError('DRIVER_OWNERSHIP')
            self.owner = frame['ownership']
            if self.common: self.decoder = self.codec.Decoder(self.owner['unit'])
            if self.observations and self.owner['unit'] != self.observations[0]['unit']:
                raise ValueError('DRIVER_OBSERVER_UNIT')
        elif kind == 'cgroup_evidence':
            if not self.common or self.decoder is None: raise ValueError('DRIVER_DOCUMENT_PROFILE')
            completed=self.decoder.feed(self.codec.canonical(frame))
            if completed is not None: self.documents[completed['label']]=completed['raw']
        elif kind == 'common_view_preflight':
            if not self.common or self.preflight is not None or self.ready is not None:
                raise ValueError('DRIVER_PREFLIGHT_ORDER')
            self.validate_preflight(frame);self.preflight=frame
        elif kind == 'common_view_ready':
            if (not self.common or self.common_ready is not None or self.preflight is None
                    or self.ready is not None or set(frame)!={'version','type','unit','sha256','bytes'}
                    or frame['unit']!=self.owner['unit'] or frame['sha256']!=self.preflight['documentSha256']
                    or type(frame['bytes']) is not int or frame['bytes']!=self.preflight['documentBytes']):
                raise ValueError('DRIVER_COMMON_ADMISSION')
            self.common_ready=frame
            outgoing.append({'type':'common_view_admission','unit':frame['unit'],'sha256':frame['sha256']})
        elif kind == 'ready':
            if self.common and self.common_ready is None: raise ValueError('DRIVER_COMMON_ADMISSION_REQUIRED')
            if self.ready is not None or self.owner is None or not self.resource.validate_ready(frame, self.owner, self.hashes) or not self.base.validate_uts_ready(frame):
                raise ValueError('DRIVER_RESOURCE_READY')
            boundary = frame.get('candidateResourceStressBoundary')
            expected = {name: self.hashes['scripts/' + name] for name in self.child.HELPERS}
            if not same(boundary, {'phase': self.phase, 'helperSha256': expected}): raise ValueError('DRIVER_HELPER_IDENTITY')
            if frame.get('limits') != {'jobMs':180000,'commandMs':200000,'termGraceMs':5000,'maxOutputBytes':8388608,
                    'commandBudgetEnforcedHere':False,'aggregateResourcesEnforced':False}: raise ValueError('DRIVER_CAPSULE_LIMITS')
            self.ready = frame
            outgoing.append({'type':'start','mode':'candidate-resource-stress-'+self.phase,'helperSha256':expected})
        elif kind == 'started':
            if self.started or self.ready is None or frame.get('mode') != 'candidate-resource-stress-' + self.phase:
                raise ValueError('DRIVER_STARTED_ORDER')
            self.started = True
        elif kind == 'candidate_stress_observation':
            if set(frame) != {'version','type','phase','unit','stage','evidence','exhaustionValidated'} or frame['phase'] != self.phase or frame['exhaustionValidated'] is not False:
                raise ValueError('DRIVER_OBSERVATION_ENVELOPE')
            if self.owner is not None and frame['unit'] != self.owner['unit']: raise ValueError('DRIVER_OBSERVER_UNIT')
            if self.observations and frame['unit'] != self.observations[0]['unit']: raise ValueError('DRIVER_OBSERVER_UNIT')
            stage = frame['stage']
            if stage not in ('before-unit-capacity','baseline','before-work-capacity','workers-held','release-observation'):
                raise ValueError('DRIVER_OBSERVATION_STAGE')
            if stage != 'release-observation' and any(v['stage'] == stage for v in self.observations): raise ValueError('DRIVER_DUPLICATE_OBSERVATION')
            prior = {v['stage'] for v in self.observations}
            if (stage == 'before-unit-capacity' and self.ready is not None
                    or stage == 'baseline' and 'before-unit-capacity' not in prior
                    or stage == 'before-work-capacity' and self.actions != ['start']
                    or stage == 'workers-held' and ('before-work-capacity' not in prior or self.actions != ['start'])
                    or stage == 'release-observation' and 'workers-held' not in prior):
                raise ValueError('DRIVER_OBSERVATION_ORDER')
            self.observations.append(frame)
            if stage == 'baseline':
                if self.ready is None: raise ValueError('DRIVER_BASELINE_ORDER')
                if self.common and 'target-ancestry' not in self.documents:
                    raise ValueError('DRIVER_TARGET_DOCUMENT_REQUIRED')
                if self.common:
                    target=self.service.strict(self.documents['target-ancestry'])
                    after=self.service.strict(self.documents['capacity-after-open'])
                    anchor=self.service.strict(self.documents['service'])['observerAfter']
                    if (not self.target.validate_report(target,
                            {n:self.hashes['scripts/'+n] for n in self.target.FILES},(self.sampler,self.events))
                            or target['unit']!=self.owner['unit'] or not same(target['commonSnapshot'],after)):
                        raise ValueError('DRIVER_TARGET_DOCUMENT_REJECTED')
                    self.linkage.match_view(after,anchor,self.sampler)
                self.baseline = True
            elif stage == 'workers-held' and self.phase == 'memory':
                if self.actions != ['start']: raise ValueError('DRIVER_HELD_ORDER')
                outgoing.append(self.action('ramp'))
            elif stage == 'release-observation' and frame['evidence'].get('releaseAdmitted') is True and 'release' not in self.actions:
                outgoing.append(self.action('release'))
        elif kind == 'stress_action_delivered':
            if (set(frame) != {'version','type','action','workerAcknowledged','observerAdmissionAttestedHere'}
                    or frame['workerAcknowledged'] is not False or frame['observerAdmissionAttestedHere'] is not False
                    or len(self.delivered) >= len(self.actions) or frame['action'] != self.actions[len(self.delivered)]):
                raise ValueError('DRIVER_DELIVERY_ORDER')
            self.delivered.append(frame['action'])
        elif kind == 'child_output':
            if set(frame) != {'version','type','stream','encoding','data'} or frame['stream'] not in ('stdout','stderr') or frame['encoding'] != 'base64':
                raise ValueError('DRIVER_CHILD_OUTPUT')
            raw = base64.b64decode(frame['data'], validate=True)
            if base64.b64encode(raw).decode() != frame['data'] or len(self.stdout)+len(self.stderr)+len(raw)>8388608:
                raise ValueError('DRIVER_CHILD_OUTPUT_LIMIT')
            getattr(self, frame['stream']).extend(raw)
        elif kind == 'systemd_failure':
            self.failure = classify_failure(frame,self.owner,self.hashes,self.resource)
            raise ValueError('DRIVER_SYSTEMD_FAILURE')
        elif kind == 'terminal': self.terminal = frame
        else: raise ValueError('DRIVER_FAILURE_OR_UNKNOWN_FRAME')
        if self.started and self.baseline and not self.actions: outgoing.append(self.action('start'))
        return outgoing


def cleanup_driver(process, threads, started_threads, readers_done, stop, errors):
    """Every independent owned cleanup is attempted, even if a prior stage fails."""
    def attempt(name, call, default=None):
        try:return call()
        except BaseException as failure:
            if len(errors)<64:errors.append(name+':'+type(failure).__name__)
            return default
    attempt('DRIVER_STOP_UNKNOWN',stop.set)
    if process is None:return False
    if not threads or threads[0] not in started_threads:
        attempt('DRIVER_UNSTARTED_WRITER_CLOSE_UNKNOWN',process.stdin.close)
    killed=False
    status=attempt('DRIVER_POLL_UNKNOWN',process.poll)
    if status is None:
        try:process.wait(timeout=12)
        except BaseException as failure:
            errors.append('DRIVER_WAIT_UNKNOWN:'+type(failure).__name__)
            killed=True
            attempt('WINDOWS_CLIENT_KILL_UNKNOWN',process.kill)
            attempt('WINDOWS_CLIENT_REAP_UNKNOWN',lambda:process.wait(timeout=2))
    for thread in started_threads:
        attempt('DRIVER_JOIN_UNKNOWN',lambda thread=thread:thread.join(timeout=1))
    alive={id(thread):attempt('DRIVER_THREAD_STATE_UNKNOWN',thread.is_alive,True) for thread in started_threads}
    if any(alive.values()):errors.append('DRIVER_THREADS_UNKNOWN')
    if attempt('DRIVER_FINAL_POLL_UNKNOWN',process.poll) is None:errors.append('DRIVER_PROCESS_UNKNOWN')
    for index,stream in enumerate(('stdout','stderr')):
        reader=threads[index+1] if len(threads)>index+1 else None
        if reader is None or reader not in started_threads or alive.get(id(reader)) is False:
            attempt('DRIVER_'+stream.upper()+'_CLOSE_UNKNOWN',lambda stream=stream:getattr(process,stream).close())
        else:errors.append('DRIVER_'+stream.upper()+'_HANDLE_IN_USE')
    return killed


def after_hashes(paths, errors):
    result={}
    for path in paths:
        try:result[path]=hashlib.sha256(Path(path).read_bytes()).hexdigest()
        except BaseException as failure:
            result[path]=None
            if len(errors)<64:errors.append('SOURCE_AFTER_UNKNOWN:'+type(failure).__name__)
    return result


def measure(phase, expected_sources, common=False):
    global _UNKNOWN
    if _UNKNOWN: raise ValueError('PRIOR_STRESS_DRIVER_UNKNOWN')
    if sys.platform != 'win32': raise ValueError('FIXED_WINDOWS_DRIVER')
    raw, before = capture_sources(True) if common else capture_sources()
    if not same(before,expected_sources):raise ValueError('SEQUENCE_SOURCE_DRIFT_BEFORE_DISPATCH')
    wire = Wire(phase, raw, before, common)
    tag = str(uuid.uuid4()); directory = Path('scratch') / ('session8-stress-source-' + tag)
    directory.mkdir()
    archived = {}
    for path, data in raw.items():
        target = directory / Path(path).name
        with target.open('xb') as handle: handle.write(data)
        archived[path] = str(target)
    path = Path('scratch') / ('session8-candidate-stress-' + phase + '-' + tag + '.json')
    report = {'version':1,'phase':phase,'command':command(phase,common),'sourceSha256Before':before,
        'sourceArchive':archived,'state':'PREPARED','stressValidated':False,'productionReady':False,
        'modelCalls':0,'productionAuth':'NOT_RUN','productionNetwork':'NOT_RUN'}
    if common: report['namespaceEvidenceProfile']=COMMON_PROFILE
    with path.open('x',encoding='utf8') as handle: json.dump(report,handle,indent=2)
    began=time.monotonic(); errors=[]; control=[]; output=bytearray(); diagnostics=bytearray()
    outgoing=queue.Queue(maxsize=4); incoming=queue.Queue(maxsize=128); stop=threading.Event()
    readers_done = [threading.Event(), threading.Event()]
    process=None; threads=[]; started_threads=[]; timeout=False
    reader_evidence={'stdout':{},'stderr':{}}
    # Pessimistic fence survives every exception after dispatch admission. Only
    # fully validated, closed and durably recorded evidence can clear it.
    _UNKNOWN=True
    try:
        process=subprocess.Popen(command(phase,common),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        def writer():
            try:
                while not stop.is_set():
                    try: frame=outgoing.get(timeout=.1)
                    except queue.Empty: continue
                    raw=encode(frame);process.stdin.write(raw);process.stdin.flush();control.append({'rawHex':raw.hex(),'elapsedMs':(time.monotonic()-began)*1000})
            except (OSError,ValueError): errors.append('CONTROL_WRITE_FAILED')
            finally:
                try:process.stdin.close()
                except Exception:errors.append('CONTROL_CLOSE_UNKNOWN')
        def reader(stream, captured, limit, done):
            name='stdout' if captured is output else 'stderr'
            drain_reader(stream,captured,limit,done,incoming if name=='stdout' else None,errors,reader_evidence[name],common)
        threads=[threading.Thread(target=writer,daemon=True),threading.Thread(target=reader,args=(process.stdout,output,16*1024*1024,readers_done[0]),daemon=True),threading.Thread(target=reader,args=(process.stderr,diagnostics,65536,readers_done[1]),daemon=True)]
        for thread in threads:
            thread.start();started_threads.append(thread)
        outgoing.put_nowait(wire.prelude());heartbeat=time.monotonic()
        while process.poll() is None or not incoming.empty() or not all(event.is_set() for event in readers_done):
            if errors:break
            try:frame=incoming.get(timeout=.02)
            except queue.Empty:frame=None
            if frame is not None:
                for request in wire.receive(frame):outgoing.put_nowait(request)
            now=time.monotonic()
            if (wire.started or common) and wire.terminal is None and now-heartbeat>=.5:
                outgoing.put_nowait({'type':'heartbeat'});heartbeat=now
            if now-began>=230:timeout=True;errors.append('DRIVER_DEADLINE');break
    except BaseException as failure:
        errors.append(failure_label(failure))
    finally:
        timeout=cleanup_driver(process,threads,started_threads,readers_done,stop,errors) or timeout
        after=after_hashes(before,errors)
        report.update(state='FINISHED',sourceSha256After=after,frames=wire.frames,control=control,
            rawOutputHex=bytes(output).hex(),rawOutputSha256=hashlib.sha256(output).hexdigest(),
            diagnosticsHex=bytes(diagnostics).hex(),errors=errors,driverTimeout=timeout,
            readerEvidence=reader_evidence,systemdFailure=wire.failure,
            elapsedMs=(time.monotonic()-began)*1000,exitCode=process.returncode if process is not None else None)
        try:report['stressValidated']=evaluate(report,raw) is True
        except BaseException as failure:
            errors.append('EVALUATOR_FAILED:'+type(failure).__name__);report['stressValidated']=False
        saved=False
        try:
            path.write_text(json.dumps(report,indent=2),encoding='utf8');saved=True
        except BaseException as failure:
            errors.append('EVIDENCE_WRITE_UNKNOWN:'+type(failure).__name__);report['stressValidated']=False
            fallback=path.with_suffix('.failure.json')
            try:
                with fallback.open('x',encoding='utf8') as handle:
                    json.dump({'version':1,'state':'EVIDENCE_WRITE_UNKNOWN','originalArtifact':str(path),
                        'errors':errors,'stressValidated':False,'cleanupCredit':'NOT_ASSIGNED','sourceArchive':archived},handle)
            except BaseException:pass
        passed=saved and report['stressValidated'] and not errors
        _UNKNOWN=not passed
        print(json.dumps({'artifact':str(path),'stressValidated':passed,'errors':errors}))
    return passed


def evaluate(report, raw):
    try:
        expected_reader = {'eofObserved':True,'captureTruncated':False,'parseFailed':False}
        if (not same(report['readerEvidence'], {'stdout':expected_reader,'stderr':expected_reader})
                or report['systemdFailure'] is not None):return False
        if (report['state']!='FINISHED' or report['errors']!=[] or report['driverTimeout'] is not False
                or type(report['exitCode']) is not int or report['exitCode']!=0 or report['diagnosticsHex']!=''
                or report['productionReady'] is not False or type(report['modelCalls']) is not int or report['modelCalls']!=0
                or report['productionAuth']!='NOT_RUN' or report['productionNetwork']!='NOT_RUN'
                or type(report['elapsedMs']) not in (int,float) or not math.isfinite(report['elapsedMs']) or not 0<=report['elapsedMs']<260000):
            return False
        before=report['sourceSha256Before']
        if type(before) is not dict or not same(before,report['sourceSha256After']) or set(before)!=set(raw):return False
        if any(hashlib.sha256(data).hexdigest()!=before[path] for path,data in raw.items()):return False
        common='namespaceEvidenceProfile' in report
        if common and report['namespaceEvidenceProfile']!=COMMON_PROFILE:return False
        base=load(BASE,raw[BASE]);expected=set(base.SOURCES)|set(ADDITIONAL)
        if common:expected.update('scripts/'+n for n in COMMON_FILES)
        if set(raw)!=expected or not same(report['command'],command(report['phase'],common)):return False
        wire=Wire(report['phase'],raw,before,common);received=bytes.fromhex(report['rawOutputHex'])
        if (received.hex()!=report['rawOutputHex'] or len(received)>16*1024*1024
                or hashlib.sha256(received).hexdigest()!=report['rawOutputSha256'] or not received.endswith(b'\n')):return False
        lines=received.splitlines(keepends=True)
        if any(not line.endswith(b'\n') or len(line)>65536 for line in lines):return False
        frames=[strict(line) for line in lines]
        if common and any(frame.get('type')=='cgroup_evidence' and wire.codec.canonical(frame)!=line
                          for frame,line in zip(frames,lines)):return False
        if not same(frames,report['frames']):return False
        required=[wire.prelude()]
        for frame in frames:required.extend(wire.receive(frame))
        written=[];last=-1
        for item in report['control']:
            if type(item) is not dict or set(item)!={'rawHex','elapsedMs'}:return False
            data=bytes.fromhex(item['rawHex']);frame=strict(data)
            if data.hex()!=item['rawHex'] or encode(frame)!=data or type(item['elapsedMs']) not in (int,float) or not last<=item['elapsedMs']<=report['elapsedMs']:return False
            last=item['elapsedMs']
            if frame!={'type':'heartbeat'}:written.append(frame)
        if not same(written,required) or wire.actions!=wire.delivered or wire.terminal is None:return False
        terminal=wire.terminal
        if (terminal.get('reason')!='EXITED' or type(terminal.get('exitCode')) is not int or terminal['exitCode']!=0
                or terminal.get('mode')!='candidate-resource-stress-'+wire.phase
                or terminal.get('outputLimitExceeded') is not False or terminal.get('registryOverflow') is not False
                or terminal.get('credentialFilesRead') is not False or terminal.get('productionReady') is not False
                or type(terminal.get('modelCalls')) is not int or terminal['modelCalls']!=0
                or terminal.get('productionAuth')!='NOT_RUN' or terminal.get('productionNetwork')!='NOT_RUN'
                or terminal.get('streamEOF')!={'stdout':True,'stderr':True}):return False
        cleanup=terminal['cleanup']
        if (cleanup.get('verified') is not True or cleanup.get('namespaceEmpty') is not True
                or cleanup.get('allObservedPidfdsESRCH') is not True or cleanup.get('ownedControlCloseKnown') is not True
                or cleanup.get('signalFailures')!=[] or type(cleanup.get('observedPidfds')) is not int or cleanup['observedPidfds']<1):return False
        if base.transcript_check(frames,terminal)['transcriptIntegrity'] is not True or wire.stderr:return False
        resource=terminal['systemdFixtureBoundary'];ready=wire.ready['systemdFixtureBoundary']
        if (set(resource)!=set(ready)|{'preStartReadback','cleanup','relayErrors'}
                or not same({k:resource[k] for k in ready},ready) or resource['preStartReadback']!=READBACK
                or resource['cleanup']!={'unitAbsent':True,'leafAbsent':True,'systemdRunClosed':True} or resource['relayErrors']!=[]):return False
        child_lines=bytes(wire.stdout).splitlines(keepends=True)
        if not child_lines or any(not line.endswith(b'\n') for line in child_lines):return False
        bodies=[strict(line) for line in child_lines];child_report=bodies[-1]
        if not same(bodies[:-1],child_report['progress']):return False
        helpers={name:raw['scripts/'+name] for name in wire.child.HELPERS}
        if not same(child_report['helperSha256Before'],{n:before['scripts/'+n] for n in helpers}):return False
        if not wire.child.validate_report(child_report,wire.child.dependencies(helpers),wire.ready['workerBoundary']):return False
        evidence=load(EVIDENCE,raw[EVIDENCE])
        if common:
            if wire.decoder is None or not wire.decoder.complete:return False
            return evidence.validate_common_observations(wire.phase,frames,child_report,
                {name:before['scripts/'+name] for name in COMMON_OBSERVER_FILES},wire.common_deps) is True
        return evidence.validate_observations(wire.phase,frames,child_report,
            {name:before['scripts/'+name] for name in OBSERVER_FILES}) is True
    except (ValueError,TypeError,KeyError,AttributeError,IndexError,OverflowError,OSError):return False


def main():
    common=sys.argv[1:]==['--common-view']
    if sys.argv[1:] and not common:raise ValueError('FIXED_TASKS_THEN_MEMORY_NO_ARGUMENTS')
    if _UNKNOWN:raise ValueError('PRIOR_STRESS_DRIVER_UNKNOWN')
    _,expected=capture_sources(True) if common else capture_sources()
    if not (measure('tasks',expected,True) if common else measure('tasks',expected)):return 1
    if _UNKNOWN:raise ValueError('TASKS_CLEANUP_UNKNOWN')
    return 0 if (measure('memory',expected,True) if common else measure('memory',expected)) else 1


if __name__=='__main__':raise SystemExit(main())
