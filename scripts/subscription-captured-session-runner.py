"""Exclusive Linux capsule: authored client, stock exec-server, real fixed probe.

No model, credentials or stock app-server. Protected pipes/socket are authored
objects with real kernel identities, not claimed app-server provenance.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

THREAD = '01a0905c-d025-73e0-9b43-40038e02cd46'
PROCESS = '1-00000000-0000-0000-0000-000000000001'
SECONDS = 20
LIMIT = 1048576
FILES = {
    'runner': '/usr/bin/captured-session-runner.py',
    'capture': '/usr/bin/tool-capture-runner.py',
    'harness': '/usr/bin/tool-capture-harness.py',
    'http': '/usr/bin/tool-capture-http.py',
    'capture_endpoint': '/usr/bin/exec-request-capture.py',
    'catalog': '/usr/bin/text-model-catalog.json',
    'session': '/usr/bin/captured-session.py',
    'transport': '/usr/bin/captured-worker-transport.py',
    'adapter': '/usr/bin/captured-start-adapter.py',
    'fixture': '/usr/bin/captured-start.fixture.json',
    'gate': '/usr/bin/exec-server-worker-gate.py',
    'policy': '/usr/bin/appserver-noenv.py',
    'parent': '/usr/bin/trusted-control-boundary-parent.py',
    'boundary': '/usr/bin/trusted-control-boundary-probe.py',
    'cli_probe': '/usr/bin/trusted-cli-worker-probe.py',
    'trampoline': '/usr/bin/exec-server-worker-trampoline.py',
    'lockdown': '/usr/bin/worker-lockdown.py',
    'exec_probe': '/usr/bin/exec-worker-probe.py',
    'probe': '/usr/bin/runtime_probe.py',
    'supervisor': '/usr/bin/supervisor.py',
}


def need(value, reason):
    if not value:
        raise ValueError(reason)


def load(name):
    spec = importlib.util.spec_from_file_location('session_runner_' + name, FILES[name])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_capsule():
    need(sys.platform == 'linux' and os.getpid() == 1 and os.uname().machine == 'x86_64',
         'EXCLUSIVE_LINUX_PID1_REQUIRED')


def enter_root(root_text):
    require_capsule()
    root = Path(root_text)
    need(root_text.startswith('/tmp/rc-runtime.') and root.resolve() == root,
         'FIXED_CAPSULE_ROOT_REQUIRED')
    path = root / 'usr/bin/tool-capture-runner.py'
    need(path.is_file() and not path.is_symlink() and os.statvfs(path).f_flag & os.ST_RDONLY,
         'READONLY_CAPTURE_RUNNER_REQUIRED')
    spec = importlib.util.spec_from_file_location('session_pivot_capture', str(path))
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)
    capture.FILES['runner'] = FILES['runner']
    capture.enter_root(root_text)


def encode(frame):
    return json.dumps(frame, separators=(',', ':'), allow_nan=False).encode() + b'\n'


def executor_argv(policy):
    # Match subscription-cli-supervisor.py trusted-child launch: PID1 retains
    # setup capabilities, but its executor must not inherit those capabilities.
    # The first actual session exposed bwrap rejecting inherited capabilities.
    return ('/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all',
            '--ambient-caps=-all', '--no-new-privs', *policy.ARGV[:-2],
            'exec-server', '--listen', 'stdio')


def discovery():
    def metadata(i, path):
        return {'id': i, 'method': 'fs/getMetadata', 'params': {'path': path, 'sandbox': None}}
    return [
        {'id': 1, 'method': 'initialize', 'params': {'clientName': 'codex-environment', 'resumeSessionId': None}},
        {'method': 'initialized', 'params': {}},
        {'id': 2, 'method': 'environment/info', 'params': None},
        *[metadata(i, path) for i, path in enumerate((
            'file:///work/.agents/skills', 'file:///work/exec-worker/.agents/skills',
            'file:///work/exec-worker', 'file:///work/exec-worker/.git',
            'file:///work/.git', 'file:///.git'), 3)]]


class Client:
    """Bounded observer; protocol admission itself remains in the pinned pump."""
    def __init__(self, start, parse):
        self.start, self.parse = start, parse
        self.frames, self.partial = [], bytearray()
        self.total = 0
        self.started = self.closed = self.exited = False
        self.output = {'stdout': bytearray(), 'stderr': bytearray()}

    def receive(self, peer):
        while b'\n' not in self.partial:
            raw = peer.recv(65536)
            need(raw, 'CLIENT_UNEXPECTED_EOF')
            self.total += len(raw)
            need(self.total <= LIMIT, 'CLIENT_OUTPUT_BOUND')
            self.partial.extend(raw)
            need(len(self.partial) <= 131072, 'CLIENT_FRAME_BOUND')
        line, _, rest = self.partial.partition(b'\n')
        self.partial[:] = rest
        frame = self.parse(bytes(line))
        self.frames.append(frame)
        need(len(self.frames) <= 64, 'CLIENT_EVENT_BOUND')
        return frame

    def lifecycle(self, frame):
        if 'id' in frame:
            need(frame == {'id': 9, 'result': {'processId': PROCESS}} and not self.started,
                 'CLIENT_START_REPLY')
            self.started = True
            return
        params = frame.get('params', {})
        need(params.get('processId') == PROCESS and not self.closed, 'CLIENT_PROCESS_ID')
        method = frame.get('method')
        if method == 'process/output':
            stream = params.get('stream')
            need(stream in self.output, 'CLIENT_OUTPUT_STREAM')
            raw = base64.b64decode(params['chunk'], validate=True)
            need(base64.b64encode(raw).decode() == params['chunk'], 'CLIENT_OUTPUT_ENCODING')
            self.output[stream].extend(raw)
            need(sum(map(len, self.output.values())) <= 65536, 'WORKER_OUTPUT_BOUND')
        elif method == 'process/exited':
            need(not self.exited and type(params.get('exitCode')) is int and
                 params['exitCode'] == 0 and params.get('sandboxDenied') is False, 'WORKER_EXIT')
            self.exited = True
        else:
            need(method == 'process/closed' and self.exited, 'WORKER_CLOSED')
            self.closed = True

    def run(self, peer):
        peer.settimeout(SECONDS)
        for frame in discovery():
            peer.sendall(encode(frame))
            if 'id' in frame:
                need(self.receive(peer).get('id') == frame['id'], 'CLIENT_DISCOVERY_REPLY')
        peer.sendall(encode(self.start))
        while not (self.started and self.closed):
            self.lifecycle(self.receive(peer))
        peer.shutdown(socket.SHUT_WR)
        need(not self.partial and peer.recv(1) == b'', 'CLIENT_TRAILING_OUTPUT')


def drive(probe):
    require_capsule()
    capture, session, gate = load('capture'), load('session'), load('gate')
    parent, boundary, cli = load('parent'), load('boundary'), load('cli_probe')
    validate_worker = cli.adapt(boundary)
    raw = {key: Path(FILES[key]).read_bytes() for key in ('transport', 'adapter', 'gate', 'fixture')}
    pid, mount = os.readlink('/proc/self/ns/pid'), os.readlink('/proc/self/ns/mnt')
    report = {'version': 1, 'kind': 'authored-client-real-worker-session', 'passed': False,
              'error': None, 'outerPidNamespace': pid, 'outerMountNamespace': mount, 'threadId': THREAD,
              'stockClientAttested': False, 'inferenceAttested': False, 'productionReady': False,
              'protectedObjectProvenance': 'authored-pipes-home-and-accepted-loopback-socket',
              'realWorkerValidated': False, 'pump': None, 'cleanup': None}
    owned, fds, sockets, threads, errors = {}, [], [], [], []
    process = client = None
    stderr = bytearray()
    stderr_eof = False
    began = time.monotonic()
    try:
        _, objects = parent.prepare_home()
        environment = gate.prepare_home()
        gate.verify_bootstrap_absence()
        for path in ('/work/exec-worker/.git', '/work/.git', '/.git'):
            need(not os.path.lexists(path), 'FIXED_GIT_MARKER_MUST_BE_ABSENT')
        protected = {}
        for role in boundary.DESCRIPTOR_ROLES:
            pair = os.pipe()
            fds.extend(pair)
            protected[role] = parent.identity(os.fstat(pair[0]))
        listener = socket.socket()
        sockets.append(listener)
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        connection = socket.create_connection(listener.getsockname(), timeout=2)
        sockets.append(connection)
        accepted, _ = listener.accept()
        sockets.append(accepted)
        address = list(listener.getsockname())
        listener.close()
        marker = {'version': 1, 'namespaces': {'trustedPid': pid, 'trustedMount': mount},
                  'protectedDescriptors': protected, 'authoredProtectedObjects': objects,
                  cli.ROLE: {'address': address, 'socket': parent.identity(os.fstat(accepted.fileno())),
                             'networkNamespace': os.readlink('/proc/self/ns/net'), 'listenerClosed': True}}
        report['marker'] = marker
        report['markerRecord'] = parent.publish_marker(marker, boundary)
        gate.verify_control_marker()
        transport = session.create(raw['transport'], raw['adapter'], raw['gate'], THREAD, pid, mount)
        start = json.loads(raw['fixture'])
        start['params']['processId'] = PROCESS
        start['params']['env']['CODEX_THREAD_ID'] = THREAD
        client = Client(start, gate.strict_json)
        client_local, client_peer = socket.socketpair()
        worker_local, worker_peer = socket.socketpair()
        sockets.extend((client_local, client_peer, worker_local, worker_peer))
        argv = executor_argv(load('policy'))
        process = subprocess.Popen(argv, stdin=worker_peer, stdout=worker_peer,
            stderr=subprocess.PIPE, cwd='/work', env=environment, close_fds=True, bufsize=0)
        owned[process.pid] = os.pidfd_open(process.pid)
        worker_peer.close()

        def client_task():
            try:
                client.run(client_peer)
            except BaseException as exc:
                errors.append('client:' + str(exc))
            finally:
                client_peer.close()

        def stderr_task():
            nonlocal stderr_eof
            try:
                while True:
                    block = process.stderr.read(65536)
                    if not block:
                        stderr_eof = True
                        return
                    need(len(stderr) + len(block) <= LIMIT, 'EXECUTOR_STDERR_BOUND')
                    stderr.extend(block)
            except BaseException as exc:
                errors.append('stderr:' + str(exc))

        for task in (client_task, stderr_task):
            thread = threading.Thread(target=task, daemon=True)
            threads.append(thread)
            thread.start()

        def cancelled():
            for child in probe.children():
                if child not in owned:
                    need(len(owned) < 64, 'PIDFD_BOUND')
                    try:
                        owned[child] = os.pidfd_open(child)
                    except ProcessLookupError:
                        pass
            return bool(errors)

        report['pump'] = session.pump(transport, client_local, worker_local, SECONDS, cancelled)
        need(report['pump']['complete'], report['pump']['error'] or 'PUMP_INCOMPLETE')
        need(session.validate_report(report['pump']['protocol'], raw['transport'], raw['adapter'],
             raw['gate'], THREAD, pid, mount), 'PROTOCOL_REPLAY_FAILED')
        report['workerReturncode'] = process.wait(timeout=2)
        need(report['workerReturncode'] == 0, 'EXECUTOR_EXIT')
        for thread in threads:
            thread.join(2)
        need(not any(thread.is_alive() for thread in threads) and not errors, 'PEER_THREADS_FAILED')
        need(not client.output['stderr'], 'WORKER_STDERR')
        worker = boundary.strict_json(bytes(client.output['stdout']))
        need(validate_worker(worker, marker), 'REAL_WORKER_REPORT_INVALID')
        need(parent.marker_observation(report['markerRecord'])['sha256'] == report['markerRecord']['sha256'],
             'MARKER_CHANGED')
        report.update(realWorkerValidated=True, workerReport=worker)
    except BaseException as exc:
        report['error'] = str(exc) or type(exc).__name__
    finally:
        for endpoint in sockets:
            try:
                endpoint.close()
            except OSError:
                errors.append('SOCKET_CLOSE_FAILED')
        try:
            report['cleanup'] = capture.cleanup(probe, process, owned)
        except BaseException as exc:
            errors.append('NAMESPACE_CLEANUP_FAILED:' + (str(exc) or type(exc).__name__))
            report['cleanup'] = {'namespaceEmpty': False, 'observedPidfds': len(owned),
                'allObservedPidfdsESRCH': False, 'errors': ['CLEANUP_OUTCOME_UNKNOWN']}
            for child, fd in list(owned.items()):
                del owned[child]
                try:
                    os.close(fd)
                except OSError:
                    errors.append('PIDFD_CLOSE_FAILED')
        for thread in threads:
            thread.join(2)
        if process is not None and process.stderr is not None and not any(t.is_alive() for t in threads):
            try:
                process.stderr.close()
            except OSError:
                errors.append('STDERR_CLOSE_FAILED')
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                errors.append('PROTECTED_PIPE_CLOSE_FAILED')
        report.update(peerErrors=errors, peerJoined=not any(t.is_alive() for t in threads),
                      executorStderrHex=bytes(stderr).hex(), stderrEof=stderr_eof,
                      clientFrames=client.frames if client else [], elapsedMs=(time.monotonic()-began)*1000)
        cleanup = report['cleanup']
        report['passed'] = (report['error'] is None and report['realWorkerValidated'] and
            report['peerJoined'] and stderr_eof and not errors and cleanup['namespaceEmpty'] and
            cleanup['allObservedPidfdsESRCH'] and not cleanup['errors'])
    return report


def main():
    require_capsule()
    probe, supervisor = load('probe'), load('supervisor')
    facts = probe.sandbox(allow_runtime_aliases=True)
    supervisor.validate_runtime_aliases()
    identities = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in FILES.items()}
    binaries = {name: hashlib.sha256(Path('/usr/bin/' + name).read_bytes()).hexdigest() for name in ('codex', 'bwrap')}
    probe.check_runtime_identity(binaries['codex'], binaries['bwrap'])
    loopback = supervisor.bootstrap_http_loopback()
    report = drive(probe)
    report.update(sandbox=facts, loopback=loopback, sourceSha256=identities, binarySha256=binaries)
    sys.stdout.buffer.write(encode(report))
    sys.stdout.buffer.flush()
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--inside']:
        raise SystemExit(main())
    if len(sys.argv) == 2 and sys.argv[1].startswith('/tmp/rc-runtime.'):
        enter_root(sys.argv[1])
    raise SystemExit('FIXED_SESSION_CAPSULE_ENTRY_REQUIRED')
