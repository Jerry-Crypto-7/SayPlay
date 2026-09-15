"""Fixed credential-free executor measurement; no arbitrary commands or model calls."""
import base64
import hashlib
import json
from pathlib import Path
import re
import importlib.util
import queue
import subprocess
import sys
import threading
import time
import uuid

PROBE_PATHS = (
    '/private/sentinel', '/private/config.toml', '/work/executor-home',
    '/work/executor-home/sentinel', '/proc/1/root/private/sentinel',
    '/proc/1/root/work/executor-home', '/proc/1/fd/0', '/proc/1/fd/1',
    '/sys/fs/cgroup', '/sys/fs/cgroup/cgroup.procs', '/oldroot', '/mnt', '/home', '/root',
)
SYSCALL_ERRNOS = {'unshare-user': 1, 'unshare-mount': 1, 'setns-invalid': 1,
                  'mount-invalid': 1, 'ptrace-invalid': 1, 'pidfd-getfd-invalid': 1, 'clone3-invalid': 38}
MAX_PROBE_BYTES = 65536
ENVIRONMENT_KEYS = ('HOME', 'LANG', 'PATH', 'TMPDIR')
HELPERS = ('subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
           'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py',
           'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json')
SOURCES = tuple('scripts/' + name for name in HELPERS) + (
    'scripts/subscription-cli-supervisor.py', 'scripts/subscription-cli-supervisor.sh',
    'scripts/subscription-cli-supervisor-child.py', 'scripts/subscription-runtime-probe.py',
    'scripts/subscription-runtime-child-probe.py', 'scripts/subscription-worker-boundary-child.py',
    'scripts/subscription-appserver-fixture-child.py', 'scripts/subscription-appserver-metadata-pipe-child.py',
    'scripts/subscription-exec-environment-metadata-parent.py',
    'scripts/subscription-trusted-control-boundary-parent.py',
    'scripts/subscription-trusted-ingress-child.py', 'scripts/subscription-trusted-ingress-worker-probe.py', 'scripts/subscription-trusted-control-boundary-probe.py',
    'scripts/subscription-exec-server-worker-gate.measure.py')
COMMAND = [r'C:\Windows\System32\wsl.exe', '--distribution', 'Ubuntu-24.04', '--exec', '/usr/bin/env', '-i',
           'PATH=/usr/bin:/bin', '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', '200s',
           '/usr/bin/unshare', '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--uts', '--pid', '--fork',
           '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh']
MODE = 'exec-server-worker'


def exact(value, keys):
    return type(value) is dict and set(value) == set(keys)


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 9007199254740991


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))


def validate_probe(report, environment_keys, outer):
    """Pure strict completeness validator. Every reported path remains open-only.

    environment_keys must come from the reviewed fixed trampoline contract, not
    from the observed report. Inner PID1 FD opens are classified by protected
    descriptor identity; successful opens never count as path denial.
    """
    errors = []
    if not exact(report, ('kind', 'schemaVersion', 'identity', 'status', 'environmentKeys', 'cwd',
                          'descriptors', 'paths', 'syscalls', 'actualModelCalls', 'credentialFilesRead', 'networkOperations')):
        return ['PROBE_FIELDS']
    if report['kind'] != 'ACTUAL_FIXED_EXECUTOR_WORKER_PROBE' or type(report['schemaVersion']) is not int or report['schemaVersion'] != 1:
        errors.append('PROBE_IDENTITY')
    if type(report['actualModelCalls']) is not int or report['actualModelCalls'] != 0 or report['credentialFilesRead'] is not False:
        errors.append('PROBE_MODEL_CREDENTIAL_CLAIM')
    if type(report['networkOperations']) is not int or report['networkOperations'] != 0:
        errors.append('PROBE_NETWORK_CLAIM')
    identity = report['identity']
    isolated = (type(outer) is dict and type(outer.get('namespace')) is str and type(outer.get('mountNamespace')) is str
                and exact(identity, ('pid', 'ppid', 'pidNamespace', 'mountNamespace', 'procInitPidNamespace', 'nspid'))
                and integer(identity['pid'], 1) and integer(identity['ppid'])
                and type(identity['pidNamespace']) is str and re.fullmatch(r'pid:\[[1-9][0-9]*\]', identity['pidNamespace'])
                and type(identity['mountNamespace']) is str and re.fullmatch(r'mnt:\[[1-9][0-9]*\]', identity['mountNamespace'])
                and identity['pidNamespace'] != outer['namespace'] and identity['mountNamespace'] != outer['mountNamespace']
                and exact(identity['procInitPidNamespace'], ('value', 'errno')) and identity['procInitPidNamespace']['errno'] is None
                and identity['procInitPidNamespace']['value'] == identity['pidNamespace']
                and type(identity['nspid']) is str and re.fullmatch(r'[1-9][0-9]*(?:\s+[1-9][0-9]*)*', identity['nspid'])
                and int(identity['nspid'].split()[-1]) == identity['pid'])
    protected = [outer.get(key) for key in ('control', 'output')] if type(outer) is dict else []
    if not isolated or len(protected) != 2 or any(not exact(value, ('dev', 'ino', 'type')) or not all(integer(n) for n in value.values()) for value in protected):
        errors.append('WORKER_NAMESPACE_OR_OUTER_IDENTITY')
    status = report['status']
    if not exact(status, ('NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapEff', 'CapBnd')):
        errors.append('STATUS_FIELDS')
    elif (status['NoNewPrivs'] != '1' or status['Seccomp'] != '2'
          or type(status['Seccomp_filters']) is not str or not re.fullmatch(r'[1-9][0-9]*', status['Seccomp_filters'])
          or status['CapEff'] != '0000000000000000' or status['CapBnd'] != '0000000000000000'):
        errors.append('STATUS_LOCKDOWN')
    if (type(environment_keys) not in (tuple, list) or not environment_keys
            or any(type(key) is not str for key in environment_keys) or len(set(environment_keys)) != len(environment_keys)
            or report['environmentKeys'] != sorted(environment_keys)):
        errors.append('ENVIRONMENT_KEYS')
    if report['cwd'] != '/work/exec-worker':
        errors.append('WORKER_CWD')
    descriptors = report['descriptors']
    if type(descriptors) is not list or len(descriptors) != 3:
        errors.append('DESCRIPTOR_COMPLETENESS')
    else:
        for expected_fd, descriptor in enumerate(descriptors):
            if (not exact(descriptor, ('fd', 'dev', 'ino', 'type'))
                    or not all(integer(value) for value in descriptor.values()) or descriptor['fd'] != expected_fd
                    or descriptor['type'] not in (0o010000, 0o020000, 0o140000)):
                errors.append('DESCRIPTOR_IDENTITY:' + str(expected_fd))
            elif any({key: descriptor[key] for key in ('dev', 'ino', 'type')} == value for value in protected):
                errors.append('STANDARD_DESCRIPTOR_ALIASES_OUTER:' + str(expected_fd))
    paths = report['paths']
    if not exact(paths, PROBE_PATHS):
        errors.append('PATH_COMPLETENESS')
    else:
        for path in PROBE_PATHS:
            observed = paths[path]
            if type(observed) is dict and observed.get('opened') is True and path in ('/proc/1/fd/0', '/proc/1/fd/1'):
                descriptor = observed.get('descriptor')
                if (not exact(observed, ('opened', 'errno', 'bytesRead', 'bytesWritten', 'descriptor'))
                        or observed['errno'] is not None or type(observed['bytesRead']) is not int or observed['bytesRead'] != 0
                        or type(observed['bytesWritten']) is not int or observed['bytesWritten'] != 0
                        or not exact(descriptor, ('fd', 'dev', 'ino', 'type')) or not all(integer(n) for n in descriptor.values())
                        or not isolated or any({key: descriptor[key] for key in ('dev', 'ino', 'type')} == value for value in protected)):
                    errors.append('PROTECTED_OUTER_DESCRIPTOR:' + path)
                continue
            if (not exact(observed, ('opened', 'errno', 'bytesRead', 'bytesWritten')) or observed['opened'] is not False
                    or not integer(observed['errno'], 1) or type(observed['bytesRead']) is not int or observed['bytesRead'] != 0
                    or type(observed['bytesWritten']) is not int or observed['bytesWritten'] != 0):
                errors.append('PATH_NOT_DENIED_OPEN_ONLY:' + path)
    calls = report['syscalls']
    if not exact(calls, SYSCALL_ERRNOS):
        errors.append('SYSCALL_COMPLETENESS')
    else:
        for name, error_number in SYSCALL_ERRNOS.items():
            value = calls[name]
            if (not exact(value, ('return', 'errno')) or type(value['return']) is not int or value['return'] != -1
                    or type(value['errno']) is not int or value['errno'] != error_number):
                errors.append('SYSCALL_DENIAL:' + name)
    return errors


def decode_probe(raw, environment_keys, outer):
    if type(raw) is not bytes or not raw or len(raw) > MAX_PROBE_BYTES:
        raise ValueError('PROBE_OUTPUT_BOUND')
    report = strict_json(raw)
    errors = validate_probe(report, environment_keys, outer)
    if errors:
        raise ValueError(';'.join(errors))
    return report


def source_hashes():
    return {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in SOURCES}


def admit_ready(frame, before):
    expected = {name: before['scripts/' + name] for name in HELPERS}
    if (type(frame) is not dict or type(frame.get('version')) is not int or frame.get('version') != 1 or frame.get('type') != 'ready'
            or frame.get('execServerWorkerBoundary') != {'helperSha256': expected}
            or frame.get('binarySha256') != 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'
            or frame.get('bwrapSha256') != '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'):
        raise ValueError('EXEC_READY_IDENTITY')
    sandbox = frame.get('sandbox', {})
    if (sandbox.get('pidNamespaceInit') is not True or sandbox.get('hostHomeMounted') is not False
            or sandbox.get('hostMntMounted') is not False or sandbox.get('networkInterfaces') != ['lo']
            or sandbox.get('ttyIsNullDevice') is not True or sandbox.get('runtimeWriteDenied') is not True
            or sandbox.get('parentNondumpable') is not True):
        raise ValueError('EXEC_READY_SANDBOX')
    if frame.get('limits') != {'jobMs': 180000, 'commandMs': 200000, 'termGraceMs': 5000,
                              'maxOutputBytes': 8388608, 'commandBudgetEnforcedHere': False, 'aggregateResourcesEnforced': False}:
        raise ValueError('EXEC_READY_LIMITS')
    uts = frame.get('utsBoundary', {})
    if uts.get('hostname') != 'reality-compiler-probe' or not re.fullmatch(r'uts:\[[1-9][0-9]*\]', str(uts.get('namespace'))):
        raise ValueError('EXEC_READY_UTS')
    return {'type': 'start', 'mode': MODE, 'helperSha256': expected}


class ProcessOutput:
    """Deduplicate identical read/notification chunks by sequence, never append twice."""
    def __init__(self):
        self.chunks = {}
        self.total = 0

    def add(self, chunk):
        if (not exact(chunk, ('seq', 'stream', 'chunk')) or not integer(chunk['seq'], 1)
                or chunk['stream'] not in ('stdout', 'stderr') or type(chunk['chunk']) is not str or len(chunk['chunk']) > 87384):
            raise ValueError('PROCESS_CHUNK_SHAPE')
        raw = base64.b64decode(chunk['chunk'], validate=True)
        if base64.b64encode(raw).decode() != chunk['chunk'] or len(raw) > MAX_PROBE_BYTES:
            raise ValueError('PROCESS_CHUNK_BYTES')
        previous = self.chunks.get(chunk['seq'])
        if previous is not None:
            if previous != chunk:
                raise ValueError('PROCESS_CHUNK_CONFLICT')
            return
        self.total += len(raw)
        if self.total > MAX_PROBE_BYTES:
            raise ValueError('PROCESS_OUTPUT_LIMIT')
        self.chunks[chunk['seq']] = dict(chunk)

    def bytes(self, stream):
        return b''.join(base64.b64decode(chunk['chunk']) for _, chunk in sorted(self.chunks.items()) if chunk['stream'] == stream)


def load_gate(before):
    path = Path('scripts/subscription-exec-server-worker-gate.py')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != before[str(path).replace('\\', '/')]:
        raise ValueError('GATE_SOURCE_CHANGED_BEFORE_IMPORT')
    spec = importlib.util.spec_from_file_location('fixed_measure_gate', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def valid_exit_notification(params):
    return (type(params) is dict
            and set(params) in ({'processId', 'seq', 'exitCode'}, {'processId', 'seq', 'exitCode', 'sandboxDenied'})
            and type(params['exitCode']) is int and params['exitCode'] == 0
            and (params.get('sandboxDenied') is None or params.get('sandboxDenied') is False))


def verify_terminal(terminal, received, digest, wrapper_exit=0):
    required = {'version', 'type', 'reason', 'mode', 'exitCode', 'elapsedMs', 'outputBytes', 'observedOutputSha256',
                'outputComplete', 'streamEOF', 'outputLimitExceeded', 'registryOverflow', 'cleanup', 'privateChecks',
                'credentialFilesRead', 'modelCalls', 'productionReady', 'productionAuth', 'productionNetwork', 'productionCleanup'}
    if (type(wrapper_exit) is not int or wrapper_exit != 0
            or type(terminal) is not dict or not required <= set(terminal) or set(terminal) - required - {'fixture', 'terminationElapsedMs'}
            or type(terminal['version']) is not int or terminal['version'] != 1 or terminal['type'] != 'terminal'
            or terminal['reason'] != 'CANCELLED' or type(terminal['exitCode']) is not int or terminal['exitCode'] != -15
            or terminal['mode'] != MODE or terminal['registryOverflow'] is not False or terminal['outputLimitExceeded'] is not False
            or terminal['outputComplete'] is not True or terminal['streamEOF'] != {'stdout': True, 'stderr': True}
            or type(terminal['outputBytes']) is not int or terminal['outputBytes'] != received
            or terminal['observedOutputSha256'] != digest or not integer(terminal['elapsedMs'])
            or type(terminal['modelCalls']) is not int or terminal['modelCalls'] != 0 or terminal['credentialFilesRead'] is not False
            or terminal['productionReady'] is not False or any(terminal[key] != 'NOT_RUN' for key in ('productionAuth', 'productionNetwork', 'productionCleanup'))
            or terminal['privateChecks'] is not None):
        return False
    cleanup = terminal['cleanup']
    return (exact(cleanup, ('verified', 'namespaceEmpty', 'observedPidfds', 'allObservedPidfdsESRCH', 'killSent', 'signalFailures'))
            and cleanup['verified'] is True and cleanup['namespaceEmpty'] is True and cleanup['allObservedPidfdsESRCH'] is True
            and integer(cleanup['observedPidfds'], 1) and type(cleanup['killSent']) is bool and cleanup['signalFailures'] == [])


def measure():
    """One fixed basic capsule; runtime only by explicit command-line opt-in."""
    before = source_hashes()
    gate = load_gate(before)
    directory = Path('scratch') / ('session8-exec-server-worker-' + str(uuid.uuid4()))
    directory.mkdir(parents=True, exist_ok=False)
    def save(name, value):
        with (directory / name).open('x', encoding='utf-8') as handle:
            json.dump(value, handle, indent=2, allow_nan=False)
    save('planned.json', {'version': 1, 'sourceSha256Before': before, 'command': COMMAND, 'protocolBudgetMs': 30000,
                         'cleanupWindowMs': 12000, 'aggregateResourcesValidated': False, 'actualModelCalls': 0,
                         'scope': 'FIXED_ACTUAL_EXECUTOR_WORKER_NO_AUTH', 'terminateWhenAlreadyClosed': 'NOT_NEEDED_NO_CREDIT'})
    events, outgoing = queue.Queue(maxsize=256), queue.Queue(maxsize=4)
    stop = threading.Event()
    frames, inner_frames, commands, errors = [], [], [], []
    stdout, stderr, wrapper_stderr = bytearray(), bytearray(), bytearray()
    wire_digest, stream_digest = hashlib.sha256(), hashlib.sha256()
    terminal, ready, proc, probe = None, None, None, None
    state = {'started': False, 'cancelled': False, 'localClosed': False, 'terminalVerified': False,
             'processReadComplete': False, 'terminateStatus': 'NOT_REQUESTED'}
    output = ProcessOutput()
    started_at = time.monotonic()
    wire_file = (directory / 'supervisor-wire.log').open('xb')
    try:
        proc = subprocess.Popen(COMMAND, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def reader(pipe, label):
            total = 0
            try:
                while True:
                    raw = pipe.readline(65537) if label == 'wire' else pipe.read(4096)
                    if not raw:
                        events.put((label + '_eof', b''), timeout=1)
                        return
                    total += len(raw)
                    if (label == 'wire' and (len(raw) > 65536 or total > 16777216)) or (label != 'wire' and total > 65536):
                        raise ValueError('OUTER_STREAM_LIMIT')
                    events.put((label, raw), timeout=1)
            except Exception as error:
                try: events.put(('reader_error', str(error)), timeout=1)
                except queue.Full: pass
        def writer():
            while not stop.is_set():
                try: frame = outgoing.get(timeout=0.1)
                except queue.Empty: continue
                try:
                    if frame is None:
                        proc.stdin.close()
                        return
                    proc.stdin.write((json.dumps(frame, separators=(',', ':')) + '\n').encode())
                    proc.stdin.flush()
                except OSError:
                    return
        threads = [threading.Thread(target=reader, args=(proc.stdout, 'wire'), daemon=True),
                   threading.Thread(target=reader, args=(proc.stderr, 'wrapper'), daemon=True), threading.Thread(target=writer, daemon=True)]
        for thread in threads: thread.start()
        def send_outer(frame):
            outgoing.put_nowait(frame)
        def cancel():
            if not state['cancelled']:
                state['cancelled'] = True
                send_outer({'type': 'cancel'})
        pending_chunks = []
        ack_seq, next_seq = None, 0
        waiting = None
        request_id = 2
        partial = bytearray()
        notification_seq = 0
        last_read_seq = 0
        def request(frame):
            nonlocal waiting
            raw = (json.dumps(frame, separators=(',', ':')) + '\n').encode()
            if len(raw) > 65536 or waiting is not None:
                raise ValueError('REQUEST_BOUNDS_OR_ORDER')
            commands.append(frame)
            waiting = (frame.get('method'), frame.get('id')) if 'id' in frame else None
            pending_chunks.extend(raw[index:index + 2048] for index in range(0, len(raw), 2048))
        def issue_read():
            nonlocal request_id
            request_id += 1
            if request_id > 128: raise ValueError('READ_REQUEST_LIMIT')
            request(gate.read_request(request_id))  # No cursor guess; identical repeated chunks are deduplicated.
        def inner(frame):
            nonlocal waiting, notification_seq, last_read_seq, request_id, probe
            inner_frames.append(frame)
            if len(inner_frames) > 1024 or type(frame) is not dict:
                raise ValueError('EXEC_FRAME_LIMIT')
            if 'method' in frame:
                if not exact(frame, ('method', 'params')) or not any(item['method'] == 'process/start' for item in commands):
                    raise ValueError('EXEC_NOTIFICATION_ORDER')
                params = frame['params']
                if type(params) is not dict or params.get('processId') != 'fixed-worker' or not integer(params.get('seq'), notification_seq + 1):
                    raise ValueError('EXEC_NOTIFICATION_IDENTITY')
                notification_seq = params['seq']
                if frame['method'] == 'process/output':
                    output.add({key: value for key, value in params.items() if key != 'processId'})
                elif frame['method'] == 'process/exited':
                    if not valid_exit_notification(params):
                        raise ValueError('EXEC_EXIT_FAILURE')
                elif frame['method'] == 'process/closed':
                    if not exact(params, ('processId', 'seq')): raise ValueError('EXEC_CLOSED_SHAPE')
                else: raise ValueError('EXEC_UNEXPECTED_NOTIFICATION')
                return
            if not exact(frame, ('id', 'result')) or waiting is None or type(frame['id']) is not int or frame['id'] != waiting[1]:
                raise ValueError('EXEC_RESPONSE_ORDER_OR_ERROR')
            method, _ = waiting
            waiting = None
            value = frame['result']
            if method == 'initialize':
                if not exact(value, ('sessionId',)) or type(value['sessionId']) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['sessionId']):
                    raise ValueError('EXEC_INITIALIZE_IDENTITY')
                request({'method': 'initialized', 'params': {}})
                request(gate.start_request())
            elif method == 'process/start':
                if value != {'processId': 'fixed-worker'}: raise ValueError('EXEC_START_IDENTITY')
                issue_read()
            elif method == 'process/terminate':
                if not exact(value, ('running',)) or type(value['running']) is not bool: raise ValueError('EXEC_TERMINATE_SHAPE')
                state['terminateStatus'] = 'ACK_ONLY_NOT_CLEANUP'
                issue_read()
            elif method == 'process/read':
                if (not exact(value, ('chunks', 'nextSeq', 'exited', 'exitCode', 'closed', 'failure', 'sandboxDenied'))
                        or type(value['chunks']) is not list or len(value['chunks']) > 64 or not integer(value['nextSeq'], max(1, last_read_seq))
                        or any(type(value[key]) is not bool for key in ('exited', 'closed', 'sandboxDenied'))
                        or value['failure'] is not None or value['sandboxDenied']):
                    raise ValueError('EXEC_READ_FAILURE')
                last_read_seq = value['nextSeq']
                for chunk in value['chunks']:
                    output.add(chunk)
                    if chunk['seq'] >= last_read_seq: raise ValueError('EXEC_READ_SEQUENCE')
                if output.bytes('stderr'): raise ValueError('WORKER_STDERR_PRESENT')
                if value['closed']:
                    if not value['exited'] or type(value['exitCode']) is not int or value['exitCode'] != 0:
                        raise ValueError('EXEC_CLOSED_WITHOUT_SUCCESSFUL_EXIT')
                    probe = decode_probe(output.bytes('stdout'), ENVIRONMENT_KEYS, ready['workerBoundary'])
                    state['processReadComplete'] = True
                    if state['terminateStatus'] == 'NOT_REQUESTED': state['terminateStatus'] = 'NOT_NEEDED_ALREADY_CLOSED'
                    cancel()
                elif not value['exited'] and output.bytes('stdout').endswith(b'\n') and state['terminateStatus'] == 'NOT_REQUESTED':
                    # Only an already-complete fixed report permits terminating our own still-running process.
                    probe = decode_probe(output.bytes('stdout'), ENVIRONMENT_KEYS, ready['workerBoundary'])
                    request_id += 1
                    state['terminateStatus'] = 'REQUESTED'
                    request(gate.terminate_request(request_id))
                else: issue_read()
            else: raise ValueError('EXEC_UNEXPECTED_RESPONSE')
        last_heartbeat = started_at
        cleanup_at = None
        while True:
            now = time.monotonic()
            if not state['cancelled'] and now - started_at >= 30:
                errors.append('PROTOCOL_DEADLINE'); cancel()
            if state['cancelled'] and cleanup_at is None: cleanup_at = now
            if cleanup_at is not None and now - cleanup_at >= 12:
                errors.append('CLEANUP_DEADLINE'); proc.kill(); break
            if state['started'] and not state['cancelled'] and now - last_heartbeat >= 0.5:
                send_outer({'type': 'heartbeat'}); last_heartbeat = now
            if pending_chunks and ack_seq is None and not state['cancelled']:
                next_seq += 1; ack_seq = next_seq
                send_outer({'type': 'fixture_input', 'seq': ack_seq, 'data': base64.b64encode(pending_chunks.pop(0)).decode()})
            try: label, raw = events.get(timeout=0.05)
            except queue.Empty:
                if proc.poll() is not None: break
                continue
            if label == 'wrapper':
                wrapper_stderr.extend(raw)
                if not errors: errors.append('WRAPPER_STDERR')
                cancel(); continue
            if label == 'reader_error': errors.append(raw); cancel(); continue
            if label.endswith('_eof'): continue
            wire_digest.update(raw)
            wire_file.write(raw)
            try:
                frame = strict_json(raw)
                frames.append(frame)
                if len(frames) > 8192 or type(frame) is not dict or type(frame.get('version')) is not int or frame.get('version') != 1: raise ValueError('OUTER_FRAME_IDENTITY')
                kind = frame.get('type')
                if terminal is not None: raise ValueError('FRAME_AFTER_TERMINAL')
                if kind == 'ready':
                    if ready is not None: raise ValueError('DUPLICATE_READY')
                    send_outer(admit_ready(frame, before)); ready = frame
                elif kind == 'started':
                    if ready is None or state['started'] or not exact(frame, ('version', 'type', 'mode', 'pid')) or frame['mode'] != MODE or not integer(frame['pid'], 2):
                        raise ValueError('STARTED_IDENTITY')
                    state['started'] = True; request(gate.initialize_request())
                elif kind == 'fixture_input_ack':
                    if not exact(frame, ('version', 'type', 'seq')) or type(frame['seq']) is not int or frame['seq'] != ack_seq: raise ValueError('INPUT_ACK_ORDER')
                    ack_seq = None
                elif kind == 'child_output':
                    if (not state['started'] or not exact(frame, ('version', 'type', 'stream', 'encoding', 'data'))
                            or frame['stream'] not in ('stdout', 'stderr') or frame['encoding'] != 'base64' or type(frame['data']) is not str):
                        raise ValueError('CHILD_OUTPUT_SHAPE')
                    chunk = base64.b64decode(frame['data'], validate=True)
                    if len(chunk) > 4096 or base64.b64encode(chunk).decode() != frame['data']: raise ValueError('CHILD_OUTPUT_BYTES')
                    stream_digest.update(chunk)
                    target = stdout if frame['stream'] == 'stdout' else stderr
                    target.extend(chunk)
                    if len(stdout) + len(stderr) > 8388608: raise ValueError('CHILD_OUTPUT_LIMIT')
                    if frame['stream'] == 'stdout' and not state['cancelled']:
                        partial.extend(chunk)
                        while b'\n' in partial:
                            line, _, rest = partial.partition(b'\n'); partial = bytearray(rest)
                            if len(line) > 131072: raise ValueError('INNER_FRAME_LIMIT')
                            inner(strict_json(bytes(line)))
                        if len(partial) > 131072: raise ValueError('INNER_FRAME_LIMIT')
                elif kind == 'terminal':
                    terminal = frame
                    send_outer(None)
                else: raise ValueError('OUTER_FAILURE_OR_UNKNOWN_FRAME')
            except (ValueError, TypeError, KeyError, UnicodeError) as error:
                errors.append(str(error)); cancel()
        proc.wait(timeout=2)
        state['localClosed'] = True
        stop.set()
        for thread in threads: thread.join(timeout=1)
        if any(thread.is_alive() for thread in threads): errors.append('DRIVER_THREADS_NOT_FINISHED')
        state['terminalVerified'] = verify_terminal(terminal, len(stdout) + len(stderr), stream_digest.hexdigest(), proc.returncode)
        if not state['terminalVerified']: errors.append('NAMESPACE_CLEANUP_OR_OUTPUT_UNKNOWN')
        if not state['processReadComplete'] or probe is None: errors.append('PROBE_OR_PROCESS_INCOMPLETE')
        if stderr: errors.append('EXEC_GATE_STDERR_PRESENT')
    except Exception as error:
        errors.append(type(error).__name__ + ':' + str(error))
        if proc is not None and proc.poll() is None:
            # No arbitrary PID cleanup: only the owned WSL client. This is NOT remote cleanup proof.
            proc.kill()
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired: pass
    finally:
        stop.set()
        wire_file.close()
        after = source_hashes()
        if after != before: errors.append('SOURCE_CHANGED')
        (directory / 'stdout.log').write_bytes(stdout)
        (directory / 'stderr.log').write_bytes(stderr)
        (directory / 'wrapper-stderr.log').write_bytes(wrapper_stderr)
        (directory / 'worker-stdout.log').write_bytes(output.bytes('stdout'))
        (directory / 'worker-stderr.log').write_bytes(output.bytes('stderr'))
        report = {'status': 'PASS' if not errors else 'FAIL', 'sourceSha256Before': before, 'sourceSha256After': after,
                  'frames': frames, 'innerFrames': inner_frames, 'commands': commands, 'errors': errors, 'state': state, 'probe': probe,
                  'elapsedMs': round((time.monotonic() - started_at) * 1000), 'exitCode': proc.returncode if proc else None,
                  'receivedOutputBytes': len(stdout) + len(stderr), 'observedOutputBytes': terminal.get('outputBytes') if terminal else None,
                  'stdoutSha256': hashlib.sha256(stdout).hexdigest(), 'stderrSha256': hashlib.sha256(stderr).hexdigest(),
                  'wireSha256': wire_digest.hexdigest(), 'actualModelCalls': 0, 'credentialFilesRead': False,
                  'aggregateResourcesValidated': False, 'productionReady': False, 'productionAuth': 'NOT_RUN', 'productionNetwork': 'NOT_RUN'}
        save('summary.json', report)
        print(json.dumps({'directory': str(directory), 'status': report['status'], 'errors': errors}))
    return not errors


if __name__ == '__main__':
    if sys.argv[1:] != ['--actual-fixed-executor-probe']:
        raise SystemExit('EXPLICIT_FIXED_EXECUTOR_OPT_IN_REQUIRED')
    raise SystemExit(0 if measure() else 1)
