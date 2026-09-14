"""Fixed credential-free stdio executor gate; one readonly probe per connection."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

HOME = '/work/executor-home'
WORK = '/work/exec-worker'
PROCESS_ID = 'fixed-worker'
PROBE_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/exec-worker-probe.py']
TRAMPOLINE_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/exec-server-worker-trampoline.py']
CONTROL_MARKER = '/work/trusted-control-boundary.json'
CONTROL_PROBE_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-control-boundary-probe.py']
CONTROL_TRAMPOLINE_ARGV = TRAMPOLINE_ARGV + ['--trusted-control-boundary']
CGROUP_PROBE_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-cgroup-worker-probe.py']
CGROUP_TRAMPOLINE_ARGV = TRAMPOLINE_ARGV + ['--trusted-cgroup-worker-boundary']
TRUSTED_CLI_PROBE_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-cli-worker-probe.py']
TRUSTED_CLI_TRAMPOLINE_ARGV = TRAMPOLINE_ARGV + ['--trusted-cli-worker-boundary']
INGRESS_MARKER = '/work/trusted-ingress-boundary.json'
INGRESS_PROBE_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-ingress-worker-probe.py']
INGRESS_TRAMPOLINE_ARGV = TRAMPOLINE_ARGV + ['--trusted-ingress-boundary']
HTTP_INGRESS_MARKER = '/work/trusted-http-ingress-boundary.json'
HTTP_INGRESS_PROBE_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-http-worker-probe.py']
HTTP_INGRESS_TRAMPOLINE_ARGV = TRAMPOLINE_ARGV + ['--trusted-http-ingress-boundary']
MAX_LINE = 131072
MAX_QUEUE = 262144
MAX_INPUT = 65536
MAX_OUTPUT = 8388608
REJECTION_METHODS = frozenset(('initialize', 'initialized', 'environment/info', 'environment/status',
    'process/start', 'process/read', 'process/write', 'process/signal', 'process/terminate', 'process/output', 'process/exited', 'process/closed',
    'fs/readFile', 'fs/open', 'fs/readBlock', 'fs/close', 'fs/writeFile', 'fs/createDirectory', 'fs/getMetadata',
    'fs/canonicalize', 'fs/readDirectory', 'fs/walk', 'fs/remove', 'fs/copy', 'capabilityRoots/discoverV1', 'http/request', 'http/request/bodyDelta'))
REJECTION_KEYS = frozenset(('path', 'paths', 'sandbox', 'cwd', 'argv', 'env', 'envPolicy', 'processId',
    'clientName', 'resumeSessionId', 'offset', 'length', 'maxBytes', 'afterSeq', 'waitMs', 'recursive', 'options', 'handle', 'url', 'method', 'headers', 'body'))
REJECTION_PATHS = frozenset(('file:///', 'file:///work', 'file:///work/exec-worker', 'file:///work/AGENTS.md',
    'file:///work/exec-worker/AGENTS.md', '/', '/work', '/work/exec-worker', '/work/AGENTS.md', '/work/exec-worker/AGENTS.md'))
REJECTION_CODES = frozenset(('EXEC_REQUEST_REFUSED', 'EXEC_REQUEST_ENVELOPE', 'EXEC_INITIALIZED_ORDER',
    'EXEC_REQUEST_ORDER', 'EXEC_TRACE_METADATA_SHAPE', 'EXEC_GATE_FAILED', 'INVALID_PARSED_REQUEST'))


def fixed_sandbox():
    entries = [('/', 'deny'), ('/usr', 'read'), ('/bin', 'read'), ('/lib', 'read'),
               ('/lib64', 'read'), ('/proc', 'read'), ('/dev/null', 'read'),
               ('/dev/urandom', 'read'), (WORK, 'write'), (HOME, 'deny'), ('/private', 'deny')]
    return {'permissions': {'type': 'managed', 'file_system': {'type': 'restricted', 'entries': [
        {'path': {'type': 'path', 'path': 'file://' + path}, 'access': access} for path, access in entries]},
        'network': 'restricted'}, 'cwd': 'file://' + WORK, 'workspaceRoots': ['file://' + WORK],
        'windowsSandboxLevel': 'disabled', 'windowsSandboxPrivateDesktop': False, 'useLegacyLandlock': False}


def initialize_request():
    return {'id': 1, 'method': 'initialize', 'params': {'clientName': 'reality_compiler_executor', 'resumeSessionId': None}}


def environment_initialize_request():
    return {'id': 1, 'method': 'initialize', 'params': {'clientName': 'codex-environment', 'resumeSessionId': None}}


def environment_info_request(identifier):
    return {'id': identifier, 'method': 'environment/info', 'params': None}


BOOTSTRAP_PATHS = ('file:///work/.agents/skills', 'file:///work/exec-worker/.agents/skills')


def environment_bootstrap_stat_request(identifier, path=BOOTSTRAP_PATHS[0]):
    if path not in BOOTSTRAP_PATHS: raise ValueError('FIXED_BOOTSTRAP_PATH_REQUIRED')
    return {'id': identifier, 'method': 'fs/getMetadata', 'params': {'path': path, 'sandbox': None}}


def start_request():
    return {'id': 2, 'method': 'process/start', 'params': {'processId': PROCESS_ID, 'argv': list(PROBE_ARGV),
        'cwd': 'file://' + WORK, 'env': {}, 'envPolicy': None, 'tty': False, 'pipeStdin': False, 'arg0': None,
        'sandbox': fixed_sandbox(), 'enforceManagedNetwork': False, 'managedNetwork': None}}


def control_start_request():
    frame = start_request()
    frame['params']['argv'] = list(CONTROL_PROBE_ARGV)
    frame['params']['sandbox']['permissions']['file_system']['entries'].extend([
        {'path': {'type': 'path', 'path': 'file://' + CONTROL_MARKER}, 'access': 'read'},
        {'path': {'type': 'path', 'path': 'file:///work/environment-appserver-home'}, 'access': 'deny'}])
    return frame


def ingress_start_request():
    frame = start_request()
    frame['params']['argv'] = list(INGRESS_PROBE_ARGV)
    frame['params']['sandbox']['permissions']['file_system']['entries'].extend([
        {'path': {'type': 'path', 'path': 'file://' + INGRESS_MARKER}, 'access': 'read'},
        {'path': {'type': 'path', 'path': 'file:///work/environment-appserver-home'}, 'access': 'deny'}])
    return frame


def cgroup_start_request():
    frame = control_start_request()
    frame['params']['argv'] = list(CGROUP_PROBE_ARGV)
    return frame


def trusted_cli_start_request():
    frame = control_start_request()
    frame['params']['argv'] = list(TRUSTED_CLI_PROBE_ARGV)
    return frame


def http_ingress_start_request():
    frame = start_request()
    frame['params']['argv'] = list(HTTP_INGRESS_PROBE_ARGV)
    frame['params']['sandbox']['permissions']['file_system']['entries'].extend([
        {'path': {'type': 'path', 'path': 'file://' + HTTP_INGRESS_MARKER}, 'access': 'read'},
        {'path': {'type': 'path', 'path': 'file:///work/environment-appserver-home'}, 'access': 'deny'}])
    return frame


STRESS_PROFILES = ('candidate-resource-stress-tasks', 'candidate-resource-stress-memory')
STRESS_ACTIONS = {'tasks': ('start', 'release', 'cancel'), 'memory': ('start', 'ramp', 'release', 'cancel')}


def stress_start_request(phase):
    if phase not in STRESS_ACTIONS: raise ValueError('FIXED_STRESS_PHASE')
    frame = control_start_request()
    frame['params']['argv'] = ['/usr/bin/python3', '-I', '-S', '/usr/bin/candidate-resource-stress-worker.py', '--inside-' + phase]
    frame['params']['pipeStdin'] = True
    return frame


def stress_write_request(identifier, phase, action):
    if phase not in STRESS_ACTIONS or action not in STRESS_ACTIONS[phase] or not integer(identifier, 3, 128): raise ValueError('FIXED_STRESS_WRITE')
    raw = ('{"version":1,"action":"' + action + '"}\n').encode('ascii')
    return {'id': identifier, 'method': 'process/write', 'params': {'processId': PROCESS_ID,
        'chunk': base64.b64encode(raw).decode('ascii'), 'writeId': 'stress-' + phase + '-' + action}}


def profile_start_request(profile):
    if profile == 'trusted-cli-worker-boundary': return trusted_cli_start_request()
    if profile in STRESS_PROFILES: return stress_start_request(profile.rsplit('-', 1)[1])
    if profile == 'trusted-cgroup-worker-boundary': return cgroup_start_request()
    return http_ingress_start_request() if profile == 'trusted-http-ingress-boundary' else ingress_start_request() if profile == 'trusted-ingress-boundary' else control_start_request() if profile == 'trusted-control-boundary' else start_request()


def read_request(identifier, after_seq=None):
    return {'id': identifier, 'method': 'process/read', 'params': {'processId': PROCESS_ID,
        'afterSeq': after_seq, 'maxBytes': 65536, 'waitMs': 1000}}


def terminate_request(identifier):
    return {'id': identifier, 'method': 'process/terminate', 'params': {'processId': PROCESS_ID}}


def integer(value, low=0, high=9007199254740991):
    return type(value) is int and low <= value <= high


def encode(frame):
    return (json.dumps(frame, separators=(',', ':'), allow_nan=False) + '\n').encode()


def equal(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    def constant(_): raise ValueError('NONFINITE_JSON')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def output_chunk(value):
    if (type(value) is not dict or set(value) != {'seq', 'stream', 'chunk'}
            or not integer(value['seq'], 1) or value['stream'] not in ('stdout', 'stderr')
            or type(value['chunk']) is not str or len(value['chunk']) > 87384):
        raise ValueError('EXEC_OUTPUT_SHAPE')
    decoded = base64.b64decode(value['chunk'], validate=True)
    if len(decoded) > 65536 or base64.b64encode(decoded).decode() != value['chunk']:
        raise ValueError('EXEC_OUTPUT_BYTES')


def rejected_request_evidence(frame, error):
    """Structural projection only: never retain arbitrary params, env or body."""
    raw = encode(frame)
    mapping = frame if type(frame) is dict else {}
    params = mapping.get('params') if type(mapping.get('params')) is dict else {}
    method = mapping.get('method')
    return {'kind': 'received-parsed-request-not-forwarded', 'canonicalBytes': len(raw),
        'canonicalSha256': hashlib.sha256(raw).hexdigest(), 'frameBodyOmitted': True,
        'validationCode': str(error) if str(error) in REJECTION_CODES else 'INVALID_PARSED_REQUEST',
        'knownMethod': method if type(method) is str and method in REJECTION_METHODS else None,
        'requestId': mapping.get('id') if integer(mapping.get('id'), 1, 128) else None,
        'knownParameterKeys': sorted(set(params) & REJECTION_KEYS), 'unknownParameterKeyCount': len(set(params) - REJECTION_KEYS),
        'safePaths': {key: value for key, value in params.items() if key in ('path', 'cwd') and type(value) is str and value in REJECTION_PATHS}}


def validate_rejected_request_evidence(value):
    return (type(value) is dict and set(value) == {'kind', 'canonicalBytes', 'canonicalSha256', 'frameBodyOmitted',
            'validationCode', 'knownMethod', 'requestId', 'knownParameterKeys', 'unknownParameterKeyCount', 'safePaths'}
        and value['kind'] == 'received-parsed-request-not-forwarded' and integer(value['canonicalBytes'], 1, MAX_LINE * 6 + 1)
        and type(value['canonicalSha256']) is str and re.fullmatch('[a-f0-9]{64}', value['canonicalSha256']) is not None
        and value['frameBodyOmitted'] is True and type(value['validationCode']) is str and value['validationCode'] in REJECTION_CODES
        and (value['knownMethod'] is None or type(value['knownMethod']) is str and value['knownMethod'] in REJECTION_METHODS)
        and (value['requestId'] is None or integer(value['requestId'], 1, 128))
        and type(value['knownParameterKeys']) is list and all(type(key) is str and key in REJECTION_KEYS for key in value['knownParameterKeys'])
        and value['knownParameterKeys'] == sorted(set(value['knownParameterKeys'])) and integer(value['unknownParameterKeyCount'], 0, MAX_LINE)
        and type(value['safePaths']) is dict and all(key in ('path', 'cwd') and type(path) is str and path in REJECTION_PATHS for key, path in value['safePaths'].items()))


class StressProgress:
    """Only finite progress admission; never external observer permission."""
    def __init__(self, phase):
        self.phase=phase;self.used=set();self.delivered=set();self.acked=set();self.waiting=None
        self.seen={};self.last_seq=0;self.total=0;self.raw=bytearray();self.pending=bytearray()
        self.held=False;self.ramped=False;self.terminal=False

    def admit(self, frame):
        action=next((a for a in STRESS_ACTIONS[self.phase] if equal(frame,stress_write_request(frame['id'],self.phase,a))),None)
        if action is None or action in self.used or 'cancel' in self.used or self.terminal: return False
        valid=(action=='cancel' or (action=='start' and not self.used)
            or (action=='ramp' and self.held and 'start' in self.acked and 'release' not in self.used)
            or (action=='release' and self.held and 'start' in self.acked
                and (self.phase=='tasks' or self.ramped and 'ramp' in self.acked)))
        if valid: self.used.add(action)
        return valid

    def written(self, frame):
        action=frame['params']['writeId'].rsplit('-',1)[1]
        self.delivered.add(action);self.waiting=action

    def accepted(self):
        if self.waiting is None: raise ValueError('STRESS_WRITE_ACK_ORDER')
        self.acked.add(self.waiting);self.waiting=None

    def output(self, chunk):
        fingerprint=(chunk['stream'],hashlib.sha256(chunk['chunk'].encode('ascii')).hexdigest())
        seq=chunk['seq']
        if seq in self.seen:
            if self.seen[seq]!=fingerprint: raise ValueError('STRESS_OUTPUT_DUPLICATE_MISMATCH')
            return
        if seq<=self.last_seq or len(self.seen)>=1024: raise ValueError('STRESS_OUTPUT_ORDER')
        raw=base64.b64decode(chunk['chunk'],validate=True)
        self.total+=len(raw)
        if self.total>65536: raise ValueError('STRESS_OUTPUT_LIMIT')
        self.seen[seq]=fingerprint;self.last_seq=seq
        if chunk['stream']!='stdout': return
        self.raw.extend(raw);self.pending.extend(raw)
        while b'\n' in self.pending:
            line,_,tail=self.pending.partition(b'\n');self.pending=bytearray(tail)
            value=strict_json(bytes(line))
            if type(value) is not dict or value.get('phase')!=self.phase or self.terminal: raise ValueError('STRESS_PROGRESS_SHAPE')
            if value.get('type')=='held':
                keys={'type','phase','children','workerIdentity','childIdentities'}|({'forkErrno'} if self.phase=='tasks' else {'bytesPerAllocator'})
                if (set(value)!=keys or self.held or 'start' not in self.delivered
                    or not integer(value['children'],1,64) or type(value['childIdentities']) is not list
                    or len(value['childIdentities'])!=value['children']): raise ValueError('STRESS_HELD_ORDER')
                worker=value['workerIdentity']
                if (type(worker) is not dict or set(worker)!={'pid','startTicks','pidNamespace','procInitPidNamespace'}
                    or worker['pidNamespace']!=worker['procInitPidNamespace'] or type(worker['pidNamespace']) is not str
                    or not re.fullmatch(r'pid:\[[1-9][0-9]{0,19}\]',worker['pidNamespace'])): raise ValueError('STRESS_HELD_IDENTITY')
                records=[{'pid':worker['pid'],'startTicks':worker['startTicks']}]+value['childIdentities']
                for record in records:
                    if (type(record) is not dict or set(record)!={'pid','startTicks'} or not integer(record['pid'],1,2147483647)
                        or type(record['startTicks']) is not str or not re.fullmatch('[1-9][0-9]{0,19}',record['startTicks'])): raise ValueError('STRESS_HELD_IDENTITY')
                if len({v['pid'] for v in records})!=len(records): raise ValueError('STRESS_HELD_IDENTITY')
                if self.phase=='tasks':
                    if value['forkErrno'] is not None and not (type(value['forkErrno']) is int and value['forkErrno']==11): raise ValueError('STRESS_HELD_SHAPE')
                elif value['children']!=2 or type(value['bytesPerAllocator']) is not int or value['bytesPerAllocator']!=805306368: raise ValueError('STRESS_HELD_SHAPE')
                self.held=True
            elif value.get('type')=='ramp-complete':
                if (self.phase!='memory' or not self.held or self.ramped or 'ramp' not in self.delivered
                    or not equal(value,{'type':'ramp-complete','phase':'memory','allocationCapPerChild':1207959552})): raise ValueError('STRESS_RAMP_ORDER')
                self.ramped=True
            elif value.get('kind')=='FIXED_CANDIDATE_RESOURCE_WORKLOAD' and type(value.get('version')) is int and value['version']==1:
                # Preserve terminal bytes; the dedicated child validates the full workload report.
                self.terminal=True
            else: raise ValueError('STRESS_PROGRESS_REFUSED')


class Gate:
    def __init__(self, outer_pid_ns, outer_mount_ns, profile='direct'):
        if profile not in ('direct', 'environment-metadata', 'environment-bootstrap-metadata', 'trusted-control-boundary', 'trusted-ingress-boundary', 'trusted-http-ingress-boundary', 'trusted-cgroup-worker-boundary', 'trusted-cli-worker-boundary') + STRESS_PROFILES: raise ValueError('FIXED_EXEC_PROFILE_REQUIRED')
        self.profile = profile
        self.stress = StressProgress(profile.rsplit('-', 1)[1]) if profile in STRESS_PROFILES else None
        self.is_metadata = profile in ('environment-metadata', 'environment-bootstrap-metadata')
        self.metadata_ok = False
        self.stat_requested = set()
        self.stat_pending = None
        self.stat_ok = set()
        self.history = []
        if not re.fullmatch(r'pid:\[[0-9]+\]', outer_pid_ns) or not re.fullmatch(r'mnt:\[[0-9]+\]', outer_mount_ns):
            raise ValueError('OUTER_NAMESPACE_IDENTITY_REQUIRED')
        self.worker_env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': WORK, 'TMPDIR': WORK + '/tmp',
            'RC_EXEC_OUTER_PID_NS': outer_pid_ns, 'RC_EXEC_OUTER_MOUNT_NS': outer_mount_ns}
        self.pending = bytearray()
        self.pending_frames = []
        self.awaiting = None
        self.identifier = 0
        self.initialized = False
        self.init_ok = False
        self.started = False
        self.closed = False
        self.exited = False
        self.notification_seq = 0
        self.failed = False
        self.rejected_request = None

    @property
    def complete(self):
        if self.profile == 'environment-bootstrap-metadata': return self.metadata_ok and self.stat_ok == set(BOOTSTRAP_PATHS)
        return self.metadata_ok if self.is_metadata else self.closed

    def record(self, direction, frame):
        if not self.is_metadata: return
        entry = {'direction': direction, 'frame': frame}
        if len(encode(self.history + [entry])) > 24576: raise ValueError('EXEC_METADATA_HISTORY_LIMIT')
        self.history.append(entry)

    def admit(self, frame):
        if self.failed: raise ValueError('EXEC_GATE_FAILED')
        try:
            self._admit(frame)
        except (ValueError, TypeError, KeyError) as error:
            if self.is_metadata and self.rejected_request is None:
                self.rejected_request = rejected_request_evidence(frame, error)
            self.failed = True
            raise

    def _admit(self, frame):
        original = frame
        if self.is_metadata and type(frame) is dict and 'trace' in frame:
            trace = frame['trace']
            if ('id' not in frame or type(trace) is not dict or not set(trace) <= {'traceparent', 'tracestate'}
                    or any(type(value) is not str or not 1 <= len(value) <= 512
                           or any(ord(character) < 32 or ord(character) > 126 for character in value)
                           for value in trace.values())):
                raise ValueError('EXEC_TRACE_METADATA_SHAPE')
            frame = {key: value for key, value in frame.items() if key != 'trace'}
        initialized_queued = bool(self.pending_frames) and all(item[1] == 'initialized' for item in self.pending_frames)
        if (self.awaiting or type(frame) is not dict
                or (self.pending and not (initialized_queued and frame.get('method') ==
                    ('environment/info' if self.is_metadata else 'process/start')))):
            raise ValueError('EXEC_REQUEST_ORDER')
        if equal(frame, {'method': 'initialized', 'params': {}}):
            if not self.init_ok or self.initialized: raise ValueError('EXEC_INITIALIZED_ORDER')
            method, identifier = 'initialized', None
        else:
            if set(frame) != {'id', 'method', 'params'} or not integer(frame['id'], 1, 128) or frame['id'] != self.identifier + 1:
                raise ValueError('EXEC_REQUEST_ENVELOPE')
            method = frame['method']
            if method == 'initialize':
                valid = not self.init_ok and equal(frame, environment_initialize_request() if self.is_metadata else initialize_request())
            elif self.is_metadata:
                valid = (self.initialized or initialized_queued) and equal(frame, environment_info_request(frame['id']))
                if method == 'fs/getMetadata' and self.profile == 'environment-bootstrap-metadata':
                    path = frame.get('params', {}).get('path') if type(frame.get('params')) is dict else None
                    valid = (self.initialized and self.metadata_ok and path in BOOTSTRAP_PATHS and path not in self.stat_requested
                        and equal(frame, environment_bootstrap_stat_request(frame['id'], path)))
                    if valid:
                        self.stat_requested.add(path)
                        self.stat_pending = path
            elif method == 'process/start':
                valid = (self.initialized or initialized_queued) and not self.started and equal(frame, profile_start_request(self.profile))
            elif method == 'process/read':
                after = frame['params'].get('afterSeq') if type(frame['params']) is dict else None
                valid = self.started and (after is None or integer(after)) and equal(frame, read_request(frame['id'], after))
            elif method == 'process/write' and self.stress is not None:
                valid = self.started and not self.closed and self.stress.admit(frame)
            elif method == 'process/terminate':
                valid = self.started and not self.closed and equal(frame, terminate_request(frame['id']))
            else:
                valid = False
            if not valid: raise ValueError('EXEC_REQUEST_REFUSED')
            self.identifier = frame['id']
            identifier = frame['id']
            if method == 'process/start':
                frame = profile_start_request(self.profile)
                frame['params']['argv'] = (TRAMPOLINE_ARGV + ['--' + self.profile]) if self.stress is not None else list(TRUSTED_CLI_TRAMPOLINE_ARGV if self.profile == 'trusted-cli-worker-boundary' else CGROUP_TRAMPOLINE_ARGV if self.profile == 'trusted-cgroup-worker-boundary' else HTTP_INGRESS_TRAMPOLINE_ARGV if self.profile == 'trusted-http-ingress-boundary' else INGRESS_TRAMPOLINE_ARGV if self.profile == 'trusted-ingress-boundary' else CONTROL_TRAMPOLINE_ARGV if self.profile == 'trusted-control-boundary' else TRAMPOLINE_ARGV)
                frame['params']['env'] = dict(self.worker_env)
        raw = encode(original if self.is_metadata else frame)
        self.pending.extend(raw)
        self.pending_frames.append([len(raw), method, identifier, strict_json(raw)])

    def drain(self, fd):
        if self.failed or not self.pending: return
        try: count = os.write(fd, self.pending)
        except BlockingIOError: return
        self.written(count)

    def written(self, count):
        if not 0 < count <= len(self.pending):
            self.failed = True
            raise ValueError('EXEC_WRITE_ACCOUNTING')
        del self.pending[:count]
        while count:
            used = min(count, self.pending_frames[0][0])
            self.pending_frames[0][0] -= used
            count -= used
            if self.pending_frames[0][0] == 0:
                _, method, identifier, frame = self.pending_frames.pop(0)
                self.record('request', frame)
                if method == 'initialized': self.initialized = True
                else:
                    self.awaiting = (method, identifier)
                    if method == 'process/start': self.started = True
                    if method == 'process/write' and self.stress is not None: self.stress.written(frame)

    def receive(self, frame):
        try:
            self._receive(frame)
            self.record('response', frame)
        except (ValueError, TypeError, KeyError):
            self.failed = True
            raise

    def _receive(self, frame):
        if self.failed or type(frame) is not dict: raise ValueError('EXEC_RESPONSE_SHAPE')
        if 'method' in frame:
            if set(frame) != {'method', 'params'} or not self.started or self.closed:
                raise ValueError('EXEC_NOTIFICATION_ORDER')
            value = frame['params']
            if type(value) is not dict or value.get('processId') != PROCESS_ID or not integer(value.get('seq'), self.notification_seq + 1):
                raise ValueError('EXEC_PROCESS_IDENTITY')
            if frame['method'] == 'process/output':
                chunk = {key: val for key, val in value.items() if key != 'processId'}
                output_chunk(chunk)
                if self.stress is not None: self.stress.output(chunk)
            elif frame['method'] == 'process/exited':
                if (set(value) not in ({'processId', 'seq', 'exitCode'}, {'processId', 'seq', 'exitCode', 'sandboxDenied'})
                        or self.exited or not integer(value['exitCode'], -2147483648, 2147483647)
                        or ('sandboxDenied' in value and value['sandboxDenied'] is not None and type(value['sandboxDenied']) is not bool)):
                    raise ValueError('EXEC_EXIT_SHAPE')
                self.exited = True
            elif frame['method'] == 'process/closed':
                if set(value) != {'processId', 'seq'} or not self.exited: raise ValueError('EXEC_CLOSED_ORDER')
                self.closed = True
            else: raise ValueError('EXEC_SERVER_METHOD_REFUSED')
            self.notification_seq = value['seq']
            return
        if (set(frame) not in ({'id', 'result'}, {'id', 'error'}) or not self.awaiting
                or type(frame['id']) is not int or frame['id'] != self.awaiting[1]):
            raise ValueError('EXEC_RESPONSE_ORDER')
        method, _ = self.awaiting
        if method == 'fs/getMetadata' and self.profile == 'environment-bootstrap-metadata':
            error = frame.get('error')
            if (set(frame) != {'id', 'error'} or type(error) is not dict or set(error) != {'code', 'message'}
                    or type(error['code']) is not int or error['code'] != -32004
                    or type(error['message']) is not str or not 1 <= len(error['message'].encode('utf-8')) <= 2048):
                raise ValueError('EXEC_BOOTSTRAP_EXPECTED_ENOENT')
            self.stat_ok.add(self.stat_pending)
            self.stat_pending = None
            self.awaiting = None
            return
        if 'error' in frame: raise ValueError('EXEC_SERVER_ERROR')
        value = frame['result']
        if method == 'initialize':
            if type(value) is not dict or set(value) != {'sessionId'} or type(value['sessionId']) is not str or not re.fullmatch('[A-Za-z0-9_-]{1,128}', value['sessionId']):
                raise ValueError('EXEC_SESSION_IDENTITY')
            self.init_ok = True
        elif method == 'environment/info':
            if (type(value) is not dict or set(value) != {'shell', 'cwd', 'capabilities'}
                    or value['cwd'] != 'file:///work' or type(value['shell']) is not dict
                    or set(value['shell']) != {'name', 'path'} or value['shell']['name'] not in ('bash', 'sh')
                    or value['shell']['path'] not in ('/bin/' + value['shell']['name'], '/usr/bin/' + value['shell']['name'])
                    or type(value['capabilities']) is not dict or set(value['capabilities']) != {'networkProxyLaunch'}
                    or type(value['capabilities']['networkProxyLaunch']) is not bool):
                raise ValueError('EXEC_ENVIRONMENT_INFO_SHAPE')
            self.metadata_ok = True
        elif method == 'process/start':
            if not equal(value, {'processId': PROCESS_ID}): raise ValueError('EXEC_START_RESPONSE')
        elif method == 'process/write' and self.stress is not None:
            if not equal(value, {'status': 'accepted'}): raise ValueError('STRESS_WRITE_NOT_ACCEPTED')
            self.stress.accepted()
        elif method == 'process/terminate':
            if type(value) is not dict or set(value) != {'running'} or type(value['running']) is not bool:
                raise ValueError('EXEC_TERMINATE_RESPONSE')
        elif method == 'process/read':
            if (type(value) is not dict or set(value) != {'chunks', 'nextSeq', 'exited', 'exitCode', 'closed', 'failure', 'sandboxDenied'}
                    or type(value['chunks']) is not list or len(value['chunks']) > 64 or not integer(value['nextSeq'], 1)
                    or any(type(value[key]) is not bool for key in ('exited', 'closed', 'sandboxDenied'))
                    or (value['exitCode'] is not None and not integer(value['exitCode'], -2147483648, 2147483647))
                    or (value['failure'] is not None and (type(value['failure']) is not str or len(value['failure']) > 1024))):
                raise ValueError('EXEC_READ_RESPONSE')
            for chunk in value['chunks']:
                output_chunk(chunk)
                if self.stress is not None: self.stress.output(chunk)
        self.awaiting = None


def validate_environment_metadata_report(report, terminal=None):
    return _validate_metadata_report(report, terminal, 'environment-metadata')


def validate_environment_bootstrap_metadata_report(report, terminal=None):
    return _validate_metadata_report(report, terminal, 'environment-bootstrap-metadata')


def _validate_metadata_report(report, terminal, profile):
    """Replay bounded admitted metadata, not a kernel or cleanup attestation."""
    try:
        if (type(report) is not dict or set(report) != {'version', 'profile', 'phase', 'history', 'complete', 'error',
                'localReturnCode', 'modelCalls', 'productionReady', 'remoteCleanup'}
                | ({'completionEvidence'} if profile == 'environment-bootstrap-metadata' else set())
                or (profile == 'environment-bootstrap-metadata' and report.get('completionEvidence') != 'client-pipe-written-not-acknowledged')
                or type(report['version']) is not int or report['version'] != 1
                or report['profile'] != profile or report['phase'] != 'protocol-complete' or report['complete'] is not True
                or report['error'] is not None or report['localReturnCode'] is not None
                or type(report['modelCalls']) is not int or report['modelCalls'] != 0 or report['productionReady'] is not False
                or report['remoteCleanup'] != 'not-attested-by-gate' or type(report['history']) is not list
                or len(encode(report)) > 32768): return False
        gate = Gate('pid:[1]', 'mnt:[2]', profile)
        for entry in report['history']:
            if type(entry) is not dict or set(entry) != {'direction', 'frame'}: return False
            if entry['direction'] == 'request':
                gate.admit(entry['frame']); gate.written(len(gate.pending))
            elif entry['direction'] == 'response': gate.receive(entry['frame'])
            else: return False
        if not (gate.complete and not gate.awaiting and not gate.pending and equal(gate.history, report['history'])): return False
        if terminal is not None:
            if (type(terminal) is not dict or set(terminal) != set(report) | {'rejectedRequest'} or terminal.get('phase') != 'terminal'
                    or terminal['rejectedRequest'] is not None
                    or type(terminal.get('localReturnCode')) is not int or terminal['localReturnCode'] != 0
                    or type(terminal.get('history')) is not list
                    or not equal(terminal['history'][:len(report['history'])], report['history'])): return False
            # Reuse the same strict protocol replay while retaining distinct
            # terminal semantics; a present failed/unknown terminal cannot pass.
            normalized = {key: value for key, value in terminal.items() if key != 'rejectedRequest'}
            normalized.update(phase='protocol-complete', localReturnCode=None)
            if not _validate_metadata_report(normalized, None, profile): return False
        return True
    except (ValueError, TypeError, KeyError, RecursionError): return False


def metadata_report(gate, phase, complete, error, returncode):
    report = {'version': 1, 'profile': gate.profile, 'phase': phase, 'history': gate.history,
        'complete': complete, 'error': error, 'localReturnCode': returncode, 'modelCalls': 0,
        'productionReady': False, 'remoteCleanup': 'not-attested-by-gate'}
    if gate.profile == 'environment-bootstrap-metadata': report['completionEvidence'] = 'client-pipe-written-not-acknowledged' if complete else None
    if phase == 'terminal': report['rejectedRequest'] = gate.rejected_request
    return report


def publish_metadata_report(report):
    raw = encode(report)
    if len(raw) > 32768: raise ValueError('EXEC_METADATA_REPORT_LIMIT')
    if report['profile'] not in ('environment-metadata', 'environment-bootstrap-metadata'): raise ValueError('FIXED_METADATA_REPORT_PROFILE')
    names = {'protocol-complete': report['profile'] + '-trace.json', 'terminal': report['profile'] + '-terminal.json'}
    target = HOME + '/' + names[report['phase']]
    temporary = target + '.publishing'
    # Same-directory atomic no-overwrite publication: abrupt termination leaves
    # either a complete file or no published file, never a partial success JSON.
    with open(temporary, 'xb') as output_file:
        output_file.write(raw)
        output_file.flush()
    os.link(temporary, target)
    os.unlink(temporary)


def load_policy():
    spec = importlib.util.spec_from_file_location('fixed_exec_policy', '/usr/bin/appserver-noenv.py')
    if spec is None or spec.loader is None: raise ValueError('READONLY_POLICY_REQUIRED')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    return policy


def prepare_home():
    Path(HOME).mkdir(mode=0o700, exist_ok=False)
    Path(HOME + '/tmp').mkdir(mode=0o700, exist_ok=False)
    Path(HOME + '/sentinel').write_text('credential-free executor sentinel\n')
    Path(WORK).mkdir(mode=0o700, exist_ok=False)
    Path(WORK + '/tmp').mkdir(mode=0o700, exist_ok=False)
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': HOME, 'CODEX_HOME': HOME, 'TMPDIR': HOME + '/tmp'}


def verify_bootstrap_absence():
    for path in ('/work/.agents', '/work/exec-worker/.agents'):
        try: os.lstat(path)
        except FileNotFoundError: continue
        raise ValueError('EXEC_BOOTSTRAP_AGENTS_MUST_BE_ABSENT')


def verify_control_marker(ingress=False, http_ingress=False):
    if type(ingress) is not bool or type(http_ingress) is not bool or ingress and http_ingress:
        raise ValueError('FIXED_MARKER_PROFILE_REQUIRED')
    path = HTTP_INGRESS_MARKER if http_ingress else INGRESS_MARKER if ingress else CONTROL_MARKER
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or not 1 <= before.st_size <= 4096:
        raise ValueError('FIXED_CONTROL_MARKER_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        after = os.lstat(path)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns)
        if identity(before) != identity(opened) or identity(opened) != identity(after):
            raise ValueError('CONTROL_MARKER_IDENTITY_CHANGED')
    finally: os.close(fd)


def run_gate(policy, environment, outer_pid_ns, outer_mount_ns, profile='direct'):
    gate = Gate(outer_pid_ns, outer_mount_ns, profile)
    if profile == 'environment-bootstrap-metadata': verify_bootstrap_absence()
    if profile in ('trusted-control-boundary', 'trusted-cgroup-worker-boundary', 'trusted-cli-worker-boundary') + STRESS_PROFILES: verify_control_marker()
    if profile == 'trusted-ingress-boundary': verify_control_marker(ingress=True)
    if profile == 'trusted-http-ingress-boundary': verify_control_marker(http_ingress=True)
    argv = tuple(policy.ARGV[:-2]) + ('exec-server', '--listen', 'stdio')
    process = subprocess.Popen(argv, cwd='/work', env=environment, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
    selector = selectors.DefaultSelector()
    pin = None
    buffers = {'client': bytearray(), 'server': bytearray()}
    output = {'server': bytearray(), 'stderr': bytearray()}
    totals = {'client': 0, 'server': 0, 'stderr': 0}
    eof = set()
    began = time.monotonic()
    cleanup = None
    error = None
    loop_succeeded = False
    snapshot_written = False
    terminal_written = False

    def stop(reason=None):
        nonlocal cleanup, error, terminal_written
        if reason and error is None:
            diagnostic = ('EXEC_WORKER_GATE_DIAGNOSTIC:' + reason + '\n').encode()
            if len(output['stderr']) + len(diagnostic) <= MAX_QUEUE: output['stderr'].extend(diagnostic)
        error = error or reason
        if gate.is_metadata and error and not terminal_written:
            publish_metadata_report(metadata_report(gate, 'terminal', False, error, process.poll()))
            terminal_written = True
        gate.failed = True
        if cleanup is None:
            cleanup = policy.Cleanup(time.monotonic())
            process.stdin.close()
            if 0 in selector.get_map(): selector.unregister(0)

    try:
        pin = os.pidfd_open(process.pid)
        for fd in (0, 1, 2, process.stdin.fileno(), process.stdout.fileno(), process.stderr.fileno()): os.set_blocking(fd, False)
        for fd, name in ((0, 'client'), (process.stdout.fileno(), 'server'), (process.stderr.fileno(), 'stderr')):
            selector.register(fd, selectors.EVENT_READ, name)
        while True:
            now = time.monotonic()
            if now - began >= 180: stop('JOB_DEADLINE')
            for name, fd in (('server', 1), ('stderr', 2)):
                if output[name]:
                    try:
                        count = os.write(fd, output[name]); del output[name][:count]
                    except BlockingIOError: pass
            # Bootstrap's asynchronous second stat needs its response fully
            # written to the client pipe before the parent may observe completion.
            if (profile == 'environment-bootstrap-metadata' and gate.complete and not gate.awaiting
                    and not gate.pending and not gate.pending_frames and not buffers['server']
                    and not output['server'] and not error and not snapshot_written):
                publish_metadata_report(metadata_report(gate, 'protocol-complete', True, None, None))
                snapshot_written = True
            if cleanup is None:
                try: gate.drain(process.stdin.fileno())
                except (ValueError, OSError): stop('WRITE_FAILED')
            if process.poll() is not None:
                stop(None if gate.complete else 'SERVER_EXIT_BEFORE_PROCESS_CLOSED')
                if len(eof) == 2 and not any(output.values()):
                    loop_succeeded = not error and process.returncode == 0
                    return 0 if loop_succeeded else 1
            if cleanup is not None:
                action = cleanup.action(now, process.poll() is not None)
                if action in ('term', 'kill'):
                    try:
                        signal.pidfd_send_signal(pin, signal.SIGTERM if action == 'term' else signal.SIGKILL)
                        cleanup.sent(action, time.monotonic())
                    except ProcessLookupError: pass
                if action == 'unknown' or now - cleanup.began >= 12: return 1
            for key, _ in selector.select(0.01):
                name = key.data
                if name != 'client' and len(output[name]) >= MAX_QUEUE: continue
                raw = os.read(key.fd, 4096 if name == 'client' else min(4096, MAX_QUEUE - len(output[name])))
                if not raw:
                    selector.unregister(key.fd)
                    if name == 'client': stop(None if gate.complete and not buffers['client'] and not gate.pending and
                        (not gate.is_metadata or not gate.awaiting) else 'CLIENT_EOF_INCOMPLETE')
                    else:
                        eof.add(name)
                        if name == 'server' and buffers['server']: stop('SERVER_PARTIAL_EOF')
                    continue
                totals[name] += len(raw)
                if name != 'client': output[name].extend(raw)
                if totals['client'] > MAX_INPUT or totals['server'] + totals['stderr'] > MAX_OUTPUT: stop('BYTE_LIMIT')
                if name == 'stderr' or cleanup is not None: continue
                buffers[name].extend(raw)
                try:
                    while b'\n' in buffers[name]:
                        line, _, rest = buffers[name].partition(b'\n'); buffers[name][:] = rest
                        if len(line) > MAX_LINE: raise ValueError('LINE_LIMIT')
                        frame = strict_json(bytes(line))
                        if name == 'client': gate.admit(frame)
                        else:
                            gate.receive(frame)
                            if profile == 'environment-metadata' and gate.complete and not gate.awaiting and not snapshot_written:
                                publish_metadata_report(metadata_report(gate, 'protocol-complete', True, None, None))
                                snapshot_written = True
                    if len(buffers[name]) > MAX_LINE: raise ValueError('LINE_LIMIT')
                except (ValueError, TypeError, KeyError, RecursionError): stop('PROTOCOL_REFUSED')
    finally:
        selector.close()
        if pin is not None: os.close(pin)
        for name in ('stdin', 'stdout', 'stderr'): getattr(process, name).close()
        if gate.is_metadata and not terminal_written:
            publish_metadata_report(metadata_report(gate, 'terminal',
                loop_succeeded and gate.complete and not gate.awaiting and not gate.pending, error, process.poll()))
        # The outer capsule is the descendant/pidfd cleanup authority. No
        # protocol process/closed or local wait becomes remote cleanup proof.


def main():
    if sys.platform != 'linux' or sys.argv[1:] not in (['--inside'], ['--environment-metadata'], ['--environment-bootstrap-metadata'], ['--trusted-control-boundary'], ['--trusted-ingress-boundary'], ['--trusted-http-ingress-boundary'], ['--trusted-cgroup-worker-boundary'], ['--trusted-cli-worker-boundary'], ['--candidate-resource-stress-tasks'], ['--candidate-resource-stress-memory']): raise ValueError('FIXED_CAPSULE_ENTRY_REQUIRED')
    if not os.statvfs('/usr/bin').f_flag & os.ST_RDONLY: raise ValueError('READONLY_CAPSULE_IMAGE_REQUIRED')
    policy = load_policy()
    environment = prepare_home()
    profile = 'direct' if sys.argv[1:] == ['--inside'] else sys.argv[1][2:]
    return run_gate(policy, environment, os.readlink('/proc/self/ns/pid'), os.readlink('/proc/self/ns/mnt'), profile)


if __name__ == '__main__':
    raise SystemExit(main())
