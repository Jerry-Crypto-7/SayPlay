"""Fixed trusted app-server/control parent; worker integration remains explicit."""
import hashlib
import base64
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

HOME = '/work/environment-appserver-home'
SENTINEL_PATH = HOME + '/sentinel'
SENTINEL = b'authored credential-free app-server boundary sentinel\n'
MARKER_PATH = '/work/trusted-control-boundary.json'
MARKER_PENDING = '/work/trusted-control-boundary.json.pending'
TOTAL_SECONDS = 30
STARTUP_SECONDS = 2
MAX_STARTUP_BYTES = 4096
WORK_SECONDS = 22
GATE_ARGV = ('/usr/bin/python3', '-I', '-S', '/usr/bin/exec-server-worker-gate.py', '--trusted-control-boundary')
HELPER_FILES = {
    'subscription-exec-server-worker-gate.py': '/usr/bin/exec-server-worker-gate.py',
    'subscription-exec-server-worker-trampoline.py': '/usr/bin/exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py': '/usr/bin/exec-worker-probe.py',
    'subscription-trusted-control-boundary-probe.py': '/usr/bin/trusted-control-boundary-probe.py',
    'subscription-worker-lockdown.py': '/usr/bin/worker-lockdown.py',
    'subscription-appserver-noenv.py': '/usr/bin/appserver-noenv.py',
    'subscription-text-model-catalog.json': '/usr/bin/text-model-catalog.json',
    'subscription-trusted-control-boundary-parent.py': '/usr/bin/trusted-control-boundary-parent.py',
}
CATALOG_SHA256 = '59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791'


def load_fixed(name):
    path = HELPER_FILES[name]
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    if spec is None or spec.loader is None:
        raise ValueError('READONLY_HELPER_REQUIRED')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def helper_hashes():
    hashes = {}
    for name, path in HELPER_FILES.items():
        with open(path, 'rb') as handle:
            raw = handle.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('HELPER_SIZE_LIMIT')
        hashes[name] = hashlib.sha256(raw).hexdigest()
    if hashes['subscription-text-model-catalog.json'] != CATALOG_SHA256:
        raise ValueError('FIXED_CATALOG_REQUIRED')
    return hashes


class Budget:
    def __init__(self):
        self.began = time.monotonic()

    def require_remaining(self):
        remaining = TOTAL_SECONDS - (time.monotonic() - self.began)
        if remaining <= 0:
            raise ValueError('TRUSTED_BOUNDARY_SHARED_DEADLINE')
        return remaining


def identity(info):
    return {'dev': info.st_dev, 'ino': info.st_ino, 'type': stat.S_IFMT(info.st_mode)}


def prepare_home():
    Path(HOME).mkdir(mode=0o700, exist_ok=False)
    Path(HOME + '/tmp').mkdir(mode=0o700, exist_ok=False)
    with open(SENTINEL_PATH, 'xb') as handle:
        handle.write(SENTINEL)
        handle.flush()
        os.fsync(handle.fileno())
        sentinel = identity(os.fstat(handle.fileno()))
    objects = {'appServerHome': identity(os.stat(HOME)), 'appServerSentinel': sentinel}
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': HOME,
                   'CODEX_HOME': HOME, 'TMPDIR': HOME + '/tmp'}
    return environment, objects


def appserver_argv(policy):
    config = policy.thread_request()['params']['config']
    config.update({'features.shell_snapshot': False, 'project_doc_max_bytes': 0, 'project_root_markers': []})
    return ('/usr/bin/codex',) + tuple(argument for key, value in config.items()
        for argument in ('-c', key + '=' + json.dumps(value))) + ('app-server', '--stdio')


def make_initialize_protocol(policy):
    class InitializeOnlyProtocol(policy.Protocol):
        def __init__(self):
            self.initialize_validated = False
            self.advisory_seen = False
            super().__init__(HOME)

        def _queue(self, frame):
            if frame['method'] == 'thread/start':
                # Base initialize handling would queue a thread next. Never
                # serialize it: completion also waits for initialized delivery.
                self.initialize_validated = True
                return
            if frame['method'] not in ('initialize', 'initialized'):
                raise ValueError('INITIALIZE_ONLY_RPC_REQUIRED')
            if frame['method'] == 'initialize':
                frame['params']['clientInfo']['name'] = 'reality_compiler_trusted_boundary'
            super()._queue(frame)

        @property
        def initialized_complete(self):
            return self.initialize_validated and not self.pending and 1 in self.responses

        def receive(self, frame):
            if type(frame) is dict and frame.get('method') == 'configWarning':
                self.history.append({'event': 'received', 'frame': frame})
                if (self.advisory_seen or 1 not in self.responses or not policy.notification_envelope(frame)
                        or frame.get('params') != {'summary': "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.", 'details': None}):
                    raise ValueError('TRUSTED_PARENT_ADVISORY_INVALID')
                self.advisory_seen = True
                return
            super().receive(frame)

    return InitializeOnlyProtocol()


def capture_appserver_pipes(process):
    if process.poll() is not None:
        raise ValueError('TRUSTED_APPSERVER_NOT_ALIVE')
    pipes = {'appServerControl': identity(os.fstat(process.stdin.fileno())),
             'appServerOutput': identity(os.fstat(process.stdout.fileno()))}
    if any(value['type'] != stat.S_IFIFO for value in pipes.values()):
        raise ValueError('TRUSTED_APPSERVER_PIPE_REQUIRED')
    return pipes


def validate_outer_packet(packet):
    def exact(value, keys):
        return type(value) is dict and set(value) == set(keys)
    if (not exact(packet, ('version', 'sourceOfOuter', 'namespaces', 'protectedDescriptors'))
            or type(packet['version']) is not int or packet['version'] != 1
            or packet['sourceOfOuter'] != 'supervisor-fixed-startup-pipe'
            or not exact(packet['namespaces'], ('trustedPid', 'trustedMount'))
            or not exact(packet['protectedDescriptors'], ('outerSupervisorControl', 'outerSupervisorOutput'))):
        return False
    for field, kind in (('trustedPid', 'pid'), ('trustedMount', 'mnt')):
        value = packet['namespaces'][field]
        if type(value) is not str or re.fullmatch(kind + r':\[[0-9]{1,20}\]', value) is None:
            return False
    tuples = []
    for value in packet['protectedDescriptors'].values():
        if (not exact(value, ('dev', 'ino', 'type')) or any(type(value[key]) is not int for key in value)
                or not 0 <= value['dev'] <= 9007199254740991 or not 1 <= value['ino'] <= 9007199254740991
                or value['type'] != stat.S_IFIFO):
            return False
        tuples.append((value['dev'], value['ino'], value['type']))
    return tuples[0] != tuples[1]


def packet_matches_ready(packet, expected_worker_boundary):
    if not validate_outer_packet(packet) or type(expected_worker_boundary) is not dict:
        return False
    expected = {'version': 1, 'sourceOfOuter': 'supervisor-fixed-startup-pipe',
        'namespaces': {'trustedPid': expected_worker_boundary.get('namespace'), 'trustedMount': expected_worker_boundary.get('mountNamespace')},
        'protectedDescriptors': {'outerSupervisorControl': expected_worker_boundary.get('control'),
                                 'outerSupervisorOutput': expected_worker_boundary.get('output')}}
    return validate_outer_packet(expected) and json.dumps(packet, sort_keys=True) == json.dumps(expected, sort_keys=True)


def read_startup_packet(budget, probe):
    # Only PID1's future private startup pipe, not caller input. Shape/source
    # strings alone are not attestation: the external driver must bind ready.
    began = time.monotonic()
    raw = bytearray()
    os.set_blocking(0, False)
    selector = selectors.DefaultSelector()
    try:
        selector.register(0, selectors.EVENT_READ)
        while True:
            remaining = min(budget.require_remaining(), STARTUP_SECONDS - (time.monotonic() - began))
            if remaining <= 0:
                raise ValueError('SUPERVISOR_STARTUP_EOF_DEADLINE')
            if not selector.select(min(remaining, 0.05)):
                continue
            try:
                block = os.read(0, MAX_STARTUP_BYTES + 1 - len(raw))
            except BlockingIOError:
                continue
            if not block:
                break
            raw.extend(block)
            if len(raw) > MAX_STARTUP_BYTES:
                raise ValueError('SUPERVISOR_STARTUP_PACKET_LIMIT')
    finally:
        selector.close()
    if time.monotonic() - began >= STARTUP_SECONDS:
        raise ValueError('SUPERVISOR_STARTUP_EOF_DEADLINE')
    budget.require_remaining()
    packet = probe.strict_json(bytes(raw))
    if not validate_outer_packet(packet):
        raise ValueError('FIXED_SUPERVISOR_PACKET_REQUIRED')
    if (os.readlink('/proc/self/ns/pid') != packet['namespaces']['trustedPid']
            or os.readlink('/proc/self/ns/mnt') != packet['namespaces']['trustedMount']):
        raise ValueError('SUPERVISOR_PACKET_NAMESPACE_MISMATCH')
    return {'value': packet, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'rawHex': raw.hex(),
            'eofObserved': True, 'sourceOfOuter': 'supervisor-fixed-startup-pipe'}


def make_marker(outer, appserver_pipes, objects, probe):
    marker = {'version': 1, 'namespaces': outer['namespaces'],
              'protectedDescriptors': {**outer['protectedDescriptors'], **appserver_pipes},
              'authoredProtectedObjects': objects}
    if not probe.validate_marker(marker):
        raise ValueError('FIXED_TRUSTED_MARKER_INVALID')
    return marker


def publish_marker(marker, probe):
    if not probe.validate_marker(marker):
        raise ValueError('FIXED_TRUSTED_MARKER_INVALID')
    raw = json.dumps(marker, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    if not 0 < len(raw) <= probe.MAX_MARKER_BYTES:
        raise ValueError('FIXED_TRUSTED_MARKER_SIZE')
    # link is atomic and refuses an existing final name. This writes only owned
    # metadata; readonly mounting is the later sandbox's independent obligation.
    fd = os.open(MARKER_PENDING, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise ValueError('MARKER_WRITE_INCOMPLETE')
            view = view[count:]
        os.fsync(fd)
        info = os.fstat(fd)
        os.link(MARKER_PENDING, MARKER_PATH, follow_symlinks=False)
        os.unlink(MARKER_PENDING)
    finally:
        os.close(fd)
    return {'path': MARKER_PATH, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
            'rawHex': raw.hex(), 'file': identity(info), 'value': marker, 'readonlyMountClaimedHere': False}


def require_fixed_worker_entry(gate):
    # This capability must be implemented by the separately owned readonly gate
    # before any actual worker invocation. Existing direct probes are not reused
    # under a misleading new label, and no caller argv is accepted.
    constructor = getattr(gate, 'control_start_request', None)
    if not callable(constructor):
        raise ValueError('TRUSTED_CONTROL_WORKER_ENTRY_NOT_INTEGRATED')
    frame = constructor()
    if (type(frame) is not dict or frame.get('method') != 'process/start'
            or frame.get('params', {}).get('argv') != ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-control-boundary-probe.py']):
        raise ValueError('FIXED_TRUSTED_CONTROL_WORKER_ENTRY_REQUIRED')
    return GATE_ARGV


class WorkerProtocol:
    """One fixed gate initialize/start/read sequence, never a caller RPC."""
    def __init__(self, gate, probe, marker):
        require_fixed_worker_entry(gate)
        self.gate, self.probe, self.marker = gate, probe, marker
        self.pending = bytearray()
        self.frames = []
        self.delivered = set()
        self.expected = 1
        self.next_id = 3
        self.history = []
        self.control_queued = self.control_written = 0
        self.chunks = {}
        self.output_bytes = 0
        self.done = False
        self.worker_report = None
        self.last_next_seq = 1
        self.after_seq = None
        self.queue(gate.initialize_request())

    def queue(self, frame):
        raw = (json.dumps(frame, separators=(',', ':'), allow_nan=False) + '\n').encode()
        if self.control_queued + len(raw) > 32768:
            raise ValueError('FIXED_WORKER_CONTROL_LIMIT')
        self.pending.extend(raw)
        self.frames.append([len(raw), frame.get('id')])
        self.control_queued += len(raw)
        self.history.append({'event': 'queued', 'frame': frame})

    def written(self, count):
        if type(count) is not int or not 0 < count <= len(self.pending):
            raise ValueError('WORKER_WRITE_ACCOUNTING')
        del self.pending[:count]
        self.control_written += count
        while count:
            used = min(count, self.frames[0][0])
            self.frames[0][0] -= used
            count -= used
            if self.frames[0][0] == 0:
                _, identifier = self.frames.pop(0)
                if identifier is not None:
                    self.delivered.add(identifier)
                self.history.append({'event': 'written', 'id': identifier})

    def add_chunk(self, value):
        if (type(value) is not dict or set(value) != {'seq', 'stream', 'chunk'}
                or not self.gate.integer(value['seq'], 1) or value['stream'] not in ('stdout', 'stderr')
                or type(value['chunk']) is not str or len(value['chunk']) > 87384):
            raise ValueError('WORKER_CHUNK_INVALID')
        raw = base64.b64decode(value['chunk'], validate=True)
        if len(raw) > 65536 or base64.b64encode(raw).decode() != value['chunk']:
            raise ValueError('WORKER_CHUNK_ENCODING')
        prior = self.chunks.get(value['seq'])
        if prior is not None:
            if prior != (value['stream'], raw):
                raise ValueError('WORKER_CHUNK_CONFLICT')
            return
        self.output_bytes += len(raw)
        if self.output_bytes > 65536:
            raise ValueError('WORKER_PROBE_OUTPUT_LIMIT')
        self.chunks[value['seq']] = (value['stream'], raw)

    def output(self, stream):
        return b''.join(raw for _, (name, raw) in sorted(self.chunks.items()) if name == stream)

    def queue_read(self):
        if self.next_id > 128:
            raise ValueError('WORKER_READ_COUNT_LIMIT')
        self.expected = self.next_id
        self.queue(self.gate.read_request(self.next_id, self.after_seq))
        self.next_id += 1

    def receive(self, frame):
        self.history.append({'event': 'received', 'frame': frame})
        if type(frame) is not dict:
            raise ValueError('WORKER_FRAME_INVALID')
        if 'method' in frame:
            params = frame.get('params')
            if (set(frame) != {'method', 'params'} or 2 not in self.delivered or type(params) is not dict
                    or params.get('processId') != 'fixed-worker' or not self.gate.integer(params.get('seq'), 1)):
                raise ValueError('WORKER_NOTIFICATION_IDENTITY')
            if frame['method'] == 'process/output':
                self.add_chunk({key: value for key, value in params.items() if key != 'processId'})
            elif frame['method'] == 'process/exited':
                if (set(params) not in ({'processId', 'seq', 'exitCode'}, {'processId', 'seq', 'exitCode', 'sandboxDenied'})
                        or type(params['exitCode']) is not int or params['exitCode'] != 0
                        or params.get('sandboxDenied') is not None and params.get('sandboxDenied') is not False):
                    raise ValueError('WORKER_EXIT_FAILURE')
            elif frame['method'] == 'process/closed':
                if set(params) != {'processId', 'seq'}:
                    raise ValueError('WORKER_CLOSE_INVALID')
            else:
                raise ValueError('WORKER_NOTIFICATION_REFUSED')
            return
        if (set(frame) != {'id', 'result'} or type(frame['id']) is not int or frame['id'] != self.expected
                or frame['id'] not in self.delivered or self.done or type(frame['result']) is not dict):
            raise ValueError('WORKER_REPLY_ORDER_OR_ERROR')
        value = frame['result']
        if frame['id'] == 1:
            if set(value) != {'sessionId'} or type(value['sessionId']) is not str or re.fullmatch('[A-Za-z0-9_-]{1,128}', value['sessionId']) is None:
                raise ValueError('WORKER_SESSION_INVALID')
            self.expected = 2
            self.queue({'method': 'initialized', 'params': {}})
            self.queue(self.gate.control_start_request())
        elif frame['id'] == 2:
            if value != {'processId': 'fixed-worker'}:
                raise ValueError('WORKER_PROCESS_IDENTITY')
            self.queue_read()
        else:
            if (set(value) != {'chunks', 'nextSeq', 'exited', 'exitCode', 'closed', 'failure', 'sandboxDenied'}
                    or type(value['chunks']) is not list or len(value['chunks']) > 64
                    or not self.gate.integer(value['nextSeq'], self.last_next_seq)
                    or any(type(value[key]) is not bool for key in ('exited', 'closed', 'sandboxDenied'))
                    or value['failure'] is not None or value['sandboxDenied']):
                raise ValueError('WORKER_READ_INVALID')
            previous_chunk_seq = self.after_seq or 0
            for chunk in value['chunks']:
                if not self.gate.integer(chunk.get('seq') if type(chunk) is dict else None, previous_chunk_seq + 1):
                    raise ValueError('WORKER_READ_REPLAY_OR_ORDER')
                self.add_chunk(chunk)
                if chunk['seq'] >= value['nextSeq']:
                    raise ValueError('WORKER_READ_CURSOR_INVALID')
                previous_chunk_seq = chunk['seq']
            if value['chunks'] and value['nextSeq'] != previous_chunk_seq + 1:
                raise ValueError('WORKER_READ_CURSOR_SKIP')
            if self.output('stderr'):
                raise ValueError('WORKER_PROBE_STDERR')
            # Pinned exec_read returns only seq > afterSeq; bounded reads report
            # the last included chunk + 1. Notifications never advance this
            # cursor: a higher notification must not skip earlier retained data.
            self.last_next_seq = value['nextSeq']
            self.after_seq = value['nextSeq'] - 1
            if value['closed']:
                if not value['exited'] or type(value['exitCode']) is not int or value['exitCode'] != 0:
                    raise ValueError('WORKER_TERMINATION_UNKNOWN')
                self.worker_report = self.probe.strict_json(self.output('stdout'))
                if not self.probe.validate_report(self.worker_report, self.marker):
                    raise ValueError('WORKER_BOUNDARY_PROBE_FAILED')
                self.done = True
            else:
                self.queue_read()


def marker_observation(marker_record):
    fd = os.open(MARKER_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if identity(info) != marker_record['file'] or not stat.S_ISREG(info.st_mode) or info.st_size != marker_record['bytes']:
            raise ValueError('MARKER_IDENTITY_CHANGED')
        raw = os.read(fd, MAX_STARTUP_BYTES + 1)
        if raw.hex() != marker_record['rawHex'] or identity(os.fstat(fd)) != identity(info):
            raise ValueError('MARKER_CONTENT_CHANGED')
    finally:
        os.close(fd)
    return {'file': marker_record['file'], 'sha256': hashlib.sha256(raw).hexdigest()}


def trusted_observation(process, marker, budget):
    pipes = capture_appserver_pipes(process)
    objects = {'appServerHome': identity(os.stat(HOME, follow_symlinks=False)),
               'appServerSentinel': identity(os.stat(SENTINEL_PATH, follow_symlinks=False))}
    observed_marker = marker_observation(marker)
    if (pipes != {key: marker['value']['protectedDescriptors'][key] for key in ('appServerControl', 'appServerOutput')}
            or objects != marker['value']['authoredProtectedObjects'] or process.poll() is not None):
        raise ValueError('TRUSTED_OBJECT_OR_LIVENESS_CHANGED')
    budget.require_remaining()
    return {'pid': process.pid, 'alive': True, 'pipes': pipes, 'objects': objects, 'marker': observed_marker,
            'elapsedMs': (time.monotonic() - budget.began) * 1000}


class Session:
    def __init__(self, name, argv, environment, protocol, policy, selector, budget):
        budget.require_remaining()
        if time.monotonic() - budget.began >= WORK_SECONDS:
            raise ValueError('TRUSTED_BOUNDARY_WORK_DEADLINE_BEFORE_SPAWN')
        self.name, self.protocol = name, protocol
        self.argv, self.environment = list(argv), dict(environment)
        self.process = subprocess.Popen(argv, cwd='/work', env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
        self.capture = policy.Capture(protocol)
        self.pin = None
        self.error = None
        self.cleanup = None
        self.cleanup_history = []
        self.signal_deliveries = []
        try:
            self.pin = os.pidfd_open(self.process.pid)
            for stream in ('stdin', 'stdout', 'stderr'):
                handle = getattr(self.process, stream)
                os.set_blocking(handle.fileno(), False)
                selector.register(handle, selectors.EVENT_WRITE if stream == 'stdin' else selectors.EVENT_READ, (self, stream))
        except Exception as failure:
            self.error = 'SESSION_ADMISSION:' + type(failure).__name__ + ':' + str(failure)

    def begin_cleanup(self, policy, selector, budget):
        if self.cleanup is not None:
            return
        try:
            selector.unregister(self.process.stdin)
        except KeyError:
            pass
        self.process.stdin.close()
        now = time.monotonic()
        self.cleanup_history.append({'event': 'stdin-eof', 'elapsedMs': (now - budget.began) * 1000})
        self.cleanup = policy.Cleanup(now)

    def advance_cleanup(self, budget):
        if self.cleanup is None:
            return
        now = time.monotonic()
        action = self.cleanup.action(now, self.process.poll() is not None)
        if action in ('term', 'kill'):
            number = signal.SIGTERM if action == 'term' else signal.SIGKILL
            try:
                if self.pin is None:
                    raise ValueError('MISSING_OWN_PIDFD')
                signal.pidfd_send_signal(self.pin, number)
                sent = time.monotonic()
                self.cleanup.sent(action, sent)
                self.signal_deliveries.append({'pid': self.process.pid, 'signal': int(number),
                    'pidfdPinned': True, 'elapsedMs': (sent - budget.began) * 1000})
                self.cleanup_history.append({'event': action + '-sent', 'elapsedMs': (sent - budget.began) * 1000})
            except ProcessLookupError:
                self.cleanup_history.append({'event': action + '-esrch', 'elapsedMs': (time.monotonic() - budget.began) * 1000})
            except Exception as failure:
                self.error = self.error or 'SIGNAL_FAILURE:' + str(failure)
        if action == 'unknown':
            self.error = self.error or 'DIRECT_CLEANUP_UNKNOWN'

    def report(self):
        code = self.process.poll()
        return {'argv': self.argv, 'environment': self.environment, 'pid': self.process.pid,
            'pinned': self.pin is not None, 'reaped': code is not None, 'exitCode': code, 'error': self.error,
            'history': self.protocol.history, 'controlBytesQueued': self.protocol.control_queued,
            'controlBytesWritten': self.protocol.control_written, 'cleanupHistory': self.cleanup_history,
            'signalDeliveries': self.signal_deliveries, 'stdoutBase64': base64.b64encode(self.capture.stdout).decode(),
            'stderrBase64': base64.b64encode(self.capture.stderr).decode(), 'observedBytes': self.capture.observed_bytes,
            'streamEOF': self.capture.eof, 'partialBytes': len(self.capture.partial)}

    def close(self):
        for stream in ('stdin', 'stdout', 'stderr'):
            getattr(self.process, stream).close()
        if self.pin is not None:
            os.close(self.pin)


def feed_output(session, sessions, stream, raw, policy, parse):
    if raw and sum(item.capture.observed_bytes for item in sessions) + len(raw) > policy.MAX_OUTPUT:
        retained = sum(len(item.capture.stdout) + len(item.capture.stderr) for item in sessions)
        session.capture.observed_bytes += len(raw)
        getattr(session.capture, stream).extend(raw[:max(0, policy.MAX_OUTPUT - retained)])
        raise ValueError('SHARED_OUTPUT_LIMIT')
    session.capture.feed(stream, raw, parse=parse)


def run_parent(policy, gate, probe, budget, packet):
    require_fixed_worker_entry(gate)
    environment, objects = prepare_home()
    selector = selectors.DefaultSelector()
    sessions = []
    marker = before = after = None
    error = None
    completed_ms = None
    try:
        app = Session('appserver', appserver_argv(policy), environment, make_initialize_protocol(policy), policy, selector, budget)
        sessions.append(app)
        worker = None
        while True:
            now = time.monotonic()
            error = error or next((session.error for session in sessions if session.error), None)
            if not error and completed_ms is None:
                if app.process.poll() is not None:
                    error = 'TRUSTED_APPSERVER_EARLY_EXIT'
                elif now - budget.began >= WORK_SECONDS:
                    error = 'TRUSTED_BOUNDARY_WORK_DEADLINE'
                elif worker is None and app.protocol.initialized_complete:
                    try:
                        marker = publish_marker(make_marker(packet['value'], capture_appserver_pipes(app.process), objects, probe), probe)
                        before = trusted_observation(app.process, marker, budget)
                        worker = Session('executor', GATE_ARGV, environment, WorkerProtocol(gate, probe, marker['value']), policy, selector, budget)
                        sessions.append(worker)
                    except Exception as failure:
                        error = 'WORKER_SETUP:' + type(failure).__name__ + ':' + str(failure)
                elif worker is not None and worker.protocol.done:
                    try:
                        after = trusted_observation(app.process, marker, budget)
                        completed_ms = after['elapsedMs']
                        if completed_ms >= WORK_SECONDS * 1000:
                            error = 'TRUSTED_BOUNDARY_WORK_DEADLINE'
                    except Exception as failure:
                        error = 'WORKER_COMPLETION:' + type(failure).__name__ + ':' + str(failure)
                elif worker is not None and worker.process.poll() is not None:
                    error = 'WORKER_PROTOCOL_EARLY_EXIT'
            if error or completed_ms is not None:
                for session in sessions:
                    session.begin_cleanup(policy, selector, budget)
            for session in sessions:
                session.advance_cleanup(budget)
            if all(session.cleanup is not None and session.process.poll() is not None and all(session.capture.eof.values()) for session in sessions):
                break
            if now - budget.began >= TOTAL_SECONDS:
                error = error or 'TRUSTED_BOUNDARY_SHARED_DEADLINE'
                break
            for session in sessions:
                handle = session.process.stdin
                if not handle.closed:
                    try:
                        selector.get_key(handle)
                        if not session.protocol.pending:
                            selector.unregister(handle)
                    except KeyError:
                        if session.protocol.pending:
                            selector.register(handle, selectors.EVENT_WRITE, (session, 'stdin'))
            for key, _ in selector.select(0.02):
                session, stream = key.data
                try:
                    if stream == 'stdin':
                        if time.monotonic() - budget.began >= WORK_SECONDS or error or completed_ms is not None:
                            continue
                        if session.protocol.pending:
                            session.protocol.written(os.write(key.fileobj.fileno(), session.protocol.pending))
                    else:
                        raw = os.read(key.fileobj.fileno(), 8192)
                        if not raw:
                            selector.unregister(key.fileobj)
                        feed_output(session, sessions, stream, raw, policy, parse=error is None)
                except BlockingIOError:
                    pass
                except Exception as failure:
                    session.error = session.error or type(failure).__name__ + ':' + str(failure)
                    error = error or session.error
    except Exception as failure:
        error = error or type(failure).__name__ + ':' + str(failure)
        # Best-effort bounded owned cleanup also runs if selector/setup fails.
        # The original failure remains primary and cannot receive success.
        for session in sessions:
            try:
                session.begin_cleanup(policy, selector, budget)
            except Exception as cleanup_failure:
                session.error = session.error or 'CLEANUP_SETUP:' + str(cleanup_failure)
        while sessions and time.monotonic() - budget.began < TOTAL_SECONDS:
            for session in sessions:
                session.advance_cleanup(budget)
                for stream in ('stdout', 'stderr'):
                    if session.capture.eof[stream]:
                        continue
                    try:
                        handle = getattr(session.process, stream)
                        os.set_blocking(handle.fileno(), False)
                        raw = os.read(handle.fileno(), 8192)
                        if raw:
                            retained = sum(len(item.capture.stdout) + len(item.capture.stderr) for item in sessions)
                            session.capture.observed_bytes += len(raw)
                            getattr(session.capture, stream).extend(raw[:max(0, policy.MAX_OUTPUT - retained)])
                        else:
                            session.capture.eof[stream] = True
                    except (OSError, ValueError):
                        pass
            if all(session.process.poll() is not None and all(session.capture.eof.values()) for session in sessions):
                break
            time.sleep(0.01)
    finally:
        reports = {session.name: session.report() for session in sessions}
        selector.close()
        for session in sessions:
            session.close()
    return {'version': 1, 'profile': 'fixed-trusted-control-boundary-parent', 'success': False, 'error': error,
        'startupPacket': packet, 'marker': marker, 'beforeWorker': before, 'afterWorker': after,
        'sessions': reports, 'completedMs': completed_ms, 'elapsedMs': (time.monotonic() - budget.began) * 1000,
        'actualModelCalls': 0, 'credentialFilesRead': False, 'productionReady': False,
        'appServerToolInvocation': False, 'descendantCleanupVerifiedHere': False}


def valid_direct_cleanup(value):
    if (value['pinned'] is not True or value['reaped'] is not True or value['error'] is not None
            or type(value['pid']) is not int or value['pid'] <= 1 or type(value['exitCode']) is not int):
        return False
    history, deliveries = value['cleanupHistory'], value['signalDeliveries']
    if type(history) is not list or type(deliveries) is not list or not 1 <= len(history) <= 2:
        return False
    for entry in history:
        if (type(entry) is not dict or set(entry) != {'event', 'elapsedMs'}
                or type(entry['elapsedMs']) not in (int, float) or not 0 <= entry['elapsedMs'] < TOTAL_SECONDS * 1000):
            return False
    if history[0]['event'] != 'stdin-eof':
        return False
    if value['exitCode'] == 0:
        return len(history) == 1 and deliveries == []
    if value['exitCode'] != -15 or len(history) != 2 or history[1]['event'] != 'term-sent' or len(deliveries) != 1:
        return False
    delivery = deliveries[0]
    return (type(delivery) is dict and set(delivery) == {'pid', 'signal', 'pidfdPinned', 'elapsedMs'}
        and type(delivery['pid']) is int and delivery['pid'] == value['pid']
        and type(delivery['signal']) is int and delivery['signal'] == 15 and delivery['pidfdPinned'] is True
        and type(delivery['elapsedMs']) in (int, float) and delivery['elapsedMs'] == history[1]['elapsedMs']
        and history[1]['elapsedMs'] - history[0]['elapsedMs'] >= 2000)


def replay_session(value, protocol, policy, argv, environment):
    def same(left, right):
        return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)
    keys = {'argv', 'environment', 'pid', 'pinned', 'reaped', 'exitCode', 'error', 'history', 'controlBytesQueued',
        'controlBytesWritten', 'cleanupHistory', 'signalDeliveries', 'stdoutBase64', 'stderrBase64', 'observedBytes', 'streamEOF', 'partialBytes'}
    if (type(value) is not dict or set(value) != keys or value['argv'] != list(argv) or value['environment'] != environment
            or not valid_direct_cleanup(value) or value['streamEOF'] != {'stdout': True, 'stderr': True}
            or any(type(flag) is not bool for flag in value['streamEOF'].values())
            or type(value['partialBytes']) is not int or value['partialBytes'] != 0):
        return False
    history = value['history']
    if type(history) is not list or len(history) > 4096:
        return False
    for index, event in enumerate(history):
        if index >= len(protocol.history):
            if event.get('event') == 'written' and protocol.frames:
                protocol.written(protocol.frames[0][0])
            elif event.get('event') == 'received':
                protocol.receive(event['frame'])
            else:
                return False
        if not same(protocol.history[index], event):
            return False
    if not same(protocol.history, history) or protocol.pending:
        return False
    received = []
    total = 0
    for stream in ('stdout', 'stderr'):
        encoded = value[stream + 'Base64']
        if type(encoded) is not str or len(encoded) > ((policy.MAX_OUTPUT + 2) // 3) * 4:
            return False
        raw = base64.b64decode(encoded, validate=True)
        if base64.b64encode(raw).decode() != encoded:
            return False
        total += len(raw)
        if stream == 'stdout':
            if not raw.endswith(b'\n'):
                return False
            received = [policy.strict_json(line) for line in raw.splitlines()]
    return (type(value['observedBytes']) is int and total == value['observedBytes'] <= policy.MAX_OUTPUT
        and same(received, [item['frame'] for item in history if item['event'] == 'received'])
        and type(value['controlBytesQueued']) is int and value['controlBytesQueued'] == protocol.control_queued
        and type(value['controlBytesWritten']) is int and value['controlBytesWritten'] == protocol.control_written)


def validate_report(report, policy, gate, probe, expected_worker_boundary):
    """Offline replay requires independently received outer ready identities."""
    try:
        keys = {'version', 'profile', 'success', 'error', 'startupPacket', 'marker', 'beforeWorker', 'afterWorker', 'sessions',
            'completedMs', 'elapsedMs', 'actualModelCalls', 'credentialFilesRead', 'productionReady', 'appServerToolInvocation',
            'descendantCleanupVerifiedHere', 'helperSha256Before', 'helperSha256After'}
        if (type(report) is not dict or set(report) != keys or type(report['version']) is not int or report['version'] != 1
                or report['profile'] != 'fixed-trusted-control-boundary-parent' or report['error'] is not None
                or report['success'] is not True or type(report['actualModelCalls']) is not int or report['actualModelCalls'] != 0
                or any(report[key] is not False for key in ('credentialFilesRead', 'productionReady', 'appServerToolInvocation', 'descendantCleanupVerifiedHere'))):
            return False
        for name, ceiling in (('completedMs', WORK_SECONDS), ('elapsedMs', TOTAL_SECONDS)):
            if type(report[name]) not in (int, float) or not 0 <= report[name] < ceiling * 1000:
                return False
        if report['completedMs'] > report['elapsedMs']:
            return False
        hashes = report['helperSha256Before']
        if (type(hashes) is not dict or set(hashes) != set(HELPER_FILES) or hashes != report['helperSha256After']
                or any(type(value) is not str or re.fullmatch('[a-f0-9]{64}', value) is None for value in hashes.values())
                or hashes['subscription-text-model-catalog.json'] != CATALOG_SHA256):
            return False
        packet = report['startupPacket']
        if (type(packet) is not dict or set(packet) != {'value', 'bytes', 'sha256', 'rawHex', 'eofObserved', 'sourceOfOuter'}
                or packet['eofObserved'] is not True or packet['sourceOfOuter'] != 'supervisor-fixed-startup-pipe'
                or not packet_matches_ready(packet['value'], expected_worker_boundary)):
            return False
        def raw_record(value, max_bytes):
            if type(value['rawHex']) is not str or len(value['rawHex']) > max_bytes * 2:
                return False
            raw = bytes.fromhex(value['rawHex'])
            return (type(value['bytes']) is int and 0 < len(raw) == value['bytes'] <= max_bytes
                    and raw.hex() == value['rawHex'] and hashlib.sha256(raw).hexdigest() == value['sha256']
                    and probe.strict_json(raw) == value['value'])
        if not raw_record(packet, MAX_STARTUP_BYTES):
            return False
        marker = report['marker']
        if (type(marker) is not dict or set(marker) != {'path', 'bytes', 'sha256', 'rawHex', 'file', 'value', 'readonlyMountClaimedHere'}
                or marker['path'] != MARKER_PATH or marker['readonlyMountClaimedHere'] is not False
                or not raw_record(marker, MAX_STARTUP_BYTES) or not probe.validate_marker(marker['value'])
                or marker['value']['namespaces'] != packet['value']['namespaces']
                or any(marker['value']['protectedDescriptors'][key] != value for key, value in packet['value']['protectedDescriptors'].items())):
            return False
        sessions = report['sessions']
        if type(sessions) is not dict or set(sessions) != {'appserver', 'executor'}:
            return False
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': HOME, 'CODEX_HOME': HOME, 'TMPDIR': HOME + '/tmp'}
        app_protocol = make_initialize_protocol(policy)
        worker_protocol = WorkerProtocol(gate, probe, marker['value'])
        if (not replay_session(sessions['appserver'], app_protocol, policy, appserver_argv(policy), environment)
                or not app_protocol.initialized_complete
                or not replay_session(sessions['executor'], worker_protocol, policy, GATE_ARGV, environment)
                or not worker_protocol.done or sessions['appserver']['pid'] == sessions['executor']['pid']
                or worker_protocol.worker_report['marker']['file'] != marker['file']
                or worker_protocol.worker_report['marker']['sha256'] != marker['sha256']
                or sum(value['observedBytes'] for value in sessions.values()) > policy.MAX_OUTPUT):
            return False
        previous = -1
        for field in ('beforeWorker', 'afterWorker'):
            observation = report[field]
            if (type(observation) is not dict or set(observation) != {'pid', 'alive', 'pipes', 'objects', 'marker', 'elapsedMs'}
                    or type(observation['pid']) is not int or observation['pid'] != sessions['appserver']['pid']
                    or observation['alive'] is not True or observation['objects'] != marker['value']['authoredProtectedObjects']
                    or observation['pipes'] != {key: marker['value']['protectedDescriptors'][key] for key in ('appServerControl', 'appServerOutput')}
                    or observation['marker'] != {'file': marker['file'], 'sha256': marker['sha256']}
                    or type(observation['elapsedMs']) not in (int, float) or not previous <= observation['elapsedMs'] <= report['completedMs']):
                return False
            previous = observation['elapsedMs']
        if previous != report['completedMs']:
            return False
        return all(report['completedMs'] <= value['cleanupHistory'][0]['elapsedMs']
            and value['cleanupHistory'][-1]['elapsedMs'] <= report['elapsedMs'] for value in sessions.values())
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError):
        return False


def main():
    budget = Budget()
    if sys.platform != 'linux' or sys.argv[1:]:
        raise ValueError('FIXED_CAPSULE_ENTRY_REQUIRED')
    if not os.statvfs('/usr/bin').f_flag & os.ST_RDONLY:
        raise ValueError('READONLY_CAPSULE_IMAGE_REQUIRED')
    before = helper_hashes()
    policy = load_fixed('subscription-appserver-noenv.py')
    gate = load_fixed('subscription-exec-server-worker-gate.py')
    probe = load_fixed('subscription-trusted-control-boundary-probe.py')
    packet = read_startup_packet(budget, probe)
    report = run_parent(policy, gate, probe, budget, packet)
    report['helperSha256Before'] = before
    report['helperSha256After'] = helper_hashes()
    report['elapsedMs'] = (time.monotonic() - budget.began) * 1000
    # Internal completeness is not external source attestation. External caller
    # must validate this report again against the actual received ready frame.
    report['success'] = report['error'] is None
    local_expected = {'namespace': packet['value']['namespaces']['trustedPid'],
        'mountNamespace': packet['value']['namespaces']['trustedMount'],
        'control': packet['value']['protectedDescriptors']['outerSupervisorControl'],
        'output': packet['value']['protectedDescriptors']['outerSupervisorOutput']}
    if not validate_report(report, policy, gate, probe, local_expected):
        report['success'] = False
        report['error'] = report['error'] or 'TRUSTED_CONTROL_REPORT_INVALID'
    print(json.dumps(report, separators=(',', ':'), allow_nan=False), flush=True)
    return 0 if report['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
