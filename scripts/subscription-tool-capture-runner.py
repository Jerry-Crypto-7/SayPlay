"""Fixed Linux capsule parent for an authored Responses / stock-client capture.

Only the capsule builder may enter this launcher. No host client invocation.
"""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time

REPORT = '/work/capture-evidence.json'
SECONDS = 25
MAX_OUTPUT = 4 * 1024 * 1024
FILES = {
    'runner': '/usr/bin/tool-capture-runner.py',
    'harness': '/usr/bin/tool-capture-harness.py',
    'http': '/usr/bin/tool-capture-http.py',
    'capture': '/usr/bin/exec-request-capture.py',
    'probe': '/usr/bin/runtime_probe.py',
    'supervisor': '/usr/bin/supervisor.py',
    'catalog': '/usr/bin/text-model-catalog.json',
}


def need(value, reason):
    if not value:
        raise ValueError(reason)


def load(name):
    spec = importlib.util.spec_from_file_location('capture_' + name, FILES[name])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def enter_root(root_text):
    need(sys.platform == 'linux' and os.uname().machine == 'x86_64' and os.getpid() == 1,
         'EXCLUSIVE_LINUX_PID1_REQUIRED')
    root = Path(root_text)
    need(root_text.startswith('/tmp/rc-runtime.') and root.resolve() == root,
         'FIXED_CAPSULE_ROOT_REQUIRED')
    (root / 'oldroot').mkdir()
    libc = ctypes.CDLL(None, use_errno=True)
    os.chdir(root)
    need(libc.syscall(155, b'.', b'oldroot') == 0, 'PIVOT_FAILED')
    os.chdir('/')
    need(libc.umount2(b'/oldroot', 2) == 0, 'OLD_ROOT_DETACH_FAILED')
    os.rmdir('/oldroot')
    os.closerange(3, 65536)
    os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S', FILES['runner'],
        '--inside'], {'PATH': '/usr/bin:/bin'})


def capture_endpoint():
    """One exclusive evidence file, separate from appserver's stderr transport."""
    need(sys.platform == 'linux' and not any(Path(p).exists() for p in
         ('/home', '/mnt', '/root', '/oldroot')) and os.statvfs('/usr').f_flag & os.ST_RDONLY,
         'CAPTURE_IMAGE_REQUIRED')
    capture = load('capture')
    fd = os.open(REPORT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'wb') as evidence:
        return capture.run(sys.stdin.buffer, sys.stdout.buffer, evidence)


def read_capture(capture, diagnostics=False):
    """After namespace cleanup only: bounded regular file plus protocol replay."""
    fd = os.open(REPORT, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= 2 * 1024 * 1024,
             'CAPTURE_FILE_BOUND')
        raw = bytearray()
        while len(raw) <= before.st_size:
            block = os.read(fd, min(65536, before.st_size + 1 - len(raw)))
            if not block:
                break
            raw.extend(block)
        after = os.fstat(fd)
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
             and len(raw) == before.st_size, 'CAPTURE_FILE_CHANGED')
    finally:
        os.close(fd)
    report = json.loads(bytes(raw).decode(), object_pairs_hook=capture.unique,
                        parse_constant=capture.invalid_constant)
    if diagnostics and type(report) is dict and report.get('captureComplete') is False:
        return {'rawHex': bytes(raw).hex(), 'sha256': hashlib.sha256(raw).hexdigest(),
                'report': report, 'validated': False}
    need(type(report) is dict and report.get('captureComplete') is True
         and type(report.get('events')) is list, 'CAPTURE_REPORT_REQUIRED')
    replay = capture.Capture()
    pending = None
    for event in report['events']:
        need(type(event) is dict and set(event) == {'direction', 'rawHex'}, 'CAPTURE_EVENT')
        data = bytes.fromhex(event['rawHex'])
        need(data.hex() == event['rawHex'], 'CAPTURE_HEX')
        if event['direction'] == 'client':
            need(pending is None, 'CAPTURE_REPLY_MISSING')
            reply = replay.receive(data)
            pending = reply or None
        else:
            need(event['direction'] == 'fixture' and pending == data, 'CAPTURE_REPLY')
            replay.events.append(event)
            pending = None
    need(pending is None and capture.encode(replay.report(None)) == capture.encode(report),
         'CAPTURE_REPLAY_MISMATCH')
    return {'rawHex': bytes(raw).hex(), 'sha256': hashlib.sha256(raw).hexdigest(),
            'report': report, 'validated': True}


def cleanup(probe, process, owned):
    """PID1 owns this exclusive namespace; never operate on host PID numbers."""
    until = time.monotonic() + 3
    errors = []
    while probe.children() and time.monotonic() < until:
        if process is not None:
            process.poll()
        for pid in probe.children():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                errors.append('SIGNAL_FAILED')
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
        time.sleep(0.01)
    absent = []
    observed = len(owned)
    for pid, fd in list(owned.items()):
        try:
            signal.pidfd_send_signal(fd, 0)
            absent.append(False)
        except ProcessLookupError:
            absent.append(True)
        except OSError:
            errors.append('PIDFD_CHECK_FAILED')
        finally:
            del owned[pid]  # Close attempted once, even if its result is uncertain.
            try:
                os.close(fd)
            except OSError:
                errors.append('PIDFD_CLOSE_FAILED')
    return {'namespaceEmpty': not probe.children(), 'observedPidfds': observed,
            'allObservedPidfdsESRCH': observed > 0 and all(absent) and len(absent) == observed,
            'errors': errors}


def feed_output(controller, output, partial, eof, name, raw):
    need(not eof[name], 'OUTPUT_AFTER_EOF')
    if not raw:
        eof[name] = True
        need(name != 'stdout' or not partial, 'TRUNCATED_APPSERVER_FRAME')
        return
    output[name].extend(raw)
    need(sum(map(len, output.values())) <= MAX_OUTPUT, 'APPSERVER_OUTPUT_BOUND')
    if name == 'stdout':
        partial.extend(raw)
        while b'\n' in partial:
            line, _, rest = partial.partition(b'\n')
            partial[:] = rest
            controller.receive(bytes(line) + b'\n')
        need(len(partial) <= 131072, 'APPSERVER_FRAME_BOUND')


def drive(harness, http, probe):
    controller, peer = harness.Controller(), harness.ResponsesPeer()
    listener = None
    selector = selectors.DefaultSelector()
    process = None
    owned = {}
    sockets = {}
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    eof = {'stdout': False, 'stderr': False}
    partial = bytearray()
    accepted = 0
    error = None
    began = time.monotonic()
    deadline = began + SECONDS
    cleanup_result = None
    try:
        home = Path(harness.HOME)
        home.mkdir(mode=0o700)
        (home / 'tmp').mkdir(mode=0o700)
        Path('/work/exec-worker').mkdir(mode=0o700)
        for name, raw in harness.home_files().items():
            if name == 'environments.toml':
                raw = raw.replace(b'/usr/bin/exec-request-capture.py', FILES['runner'].encode())
                raw = raw.replace(b'--stdio-fixture', b'--capture-endpoint')
            with (home / name).open('xb') as stream:
                stream.write(raw)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setblocking(False)
        listener.bind(('127.0.0.1', 31317))
        listener.listen(2)
        selector.register(listener, selectors.EVENT_READ, ('listener', None))
        process = subprocess.Popen(['/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all',
            '--ambient-caps=-all', '--no-new-privs', '/usr/bin/codex', 'app-server', '--stdio'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            close_fds=True, start_new_session=True, cwd='/work', bufsize=0,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': harness.HOME,
                 'CODEX_HOME': harness.HOME, 'TMPDIR': harness.HOME + '/tmp'})
        owned[process.pid] = os.pidfd_open(process.pid)
        for name in ('stdin', 'stdout', 'stderr'):
            pipe = getattr(process, name)
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_WRITE if name == 'stdin' else selectors.EVENT_READ,
                              ('pipe', name))
        while True:
            need(time.monotonic() < deadline, 'CAPTURE_DEADLINE')
            for pid in probe.children():
                if pid not in owned:
                    need(len(owned) < 64, 'CAPTURE_PID_BOUND')
                    try:
                        owned[pid] = os.pidfd_open(pid)
                    except ProcessLookupError:
                        pass
            if controller.completed and peer.step == 2 and not sockets:
                break
            need(process.poll() is None, 'APPSERVER_EXIT_BEFORE_COMPLETION')
            for key, mask in selector.select(min(0.05, max(0, deadline - time.monotonic()))):
                need(time.monotonic() < deadline, 'CAPTURE_DEADLINE')
                kind, name = key.data
                if kind == 'listener':
                    connection, address = listener.accept()
                    connection.setblocking(False)
                    sockets[connection] = http.Connection(peer)
                    accepted += 1
                    need(accepted <= 2 and address[0] == '127.0.0.1', 'FIXED_HTTP_CONNECTIONS')
                    selector.register(connection, selectors.EVENT_READ, ('http', connection))
                elif kind == 'http':
                    connection = name
                    state = sockets[connection]
                    try:
                        if mask & selectors.EVENT_READ:
                            raw = connection.recv(16384)
                            if raw:
                                state.feed(raw)
                            else:
                                state.eof()
                            if state.pending:
                                selector.modify(connection, selectors.EVENT_WRITE, ('http', connection))
                        if mask & selectors.EVENT_WRITE:
                            state.written(connection.send(state.pending[:16384]))
                        if state.complete:
                            selector.unregister(connection)
                            connection.close()
                            del sockets[connection]
                    except BlockingIOError:
                        pass
                elif name == 'stdin':
                    try:
                        controller.written(os.write(key.fd, controller.pending[:16384]))
                    except BlockingIOError:
                        pass
                    if not controller.pending:
                        selector.unregister(process.stdin)
                else:
                    try:
                        raw = os.read(key.fd, 16384)
                    except BlockingIOError:
                        continue
                    feed_output(controller, output, partial, eof, name, raw)
                    if not raw:
                        selector.unregister(key.fileobj)
                        continue
                    if name == 'stdout':
                        if controller.pending:
                            try:
                                selector.get_key(process.stdin)
                            except KeyError:
                                selector.register(process.stdin, selectors.EVENT_WRITE, ('pipe', 'stdin'))
    except (OSError, ValueError, TypeError, KeyError, RecursionError) as failure:
        error = type(failure).__name__ + ':' + str(failure)[:256]
    finally:
        try:
            cleanup_result = cleanup(probe, process, owned)
        except (OSError, ValueError):
            cleanup_result = {'namespaceEmpty': False, 'observedPidfds': len(owned),
                'allObservedPidfdsESRCH': False, 'errors': ['CLEANUP_UNKNOWN']}
            error = error or 'CLEANUP_UNKNOWN'
        for pid, fd in list(owned.items()):
            del owned[pid]
            try:
                os.close(fd)
            except OSError:
                error = error or 'PIDFD_CLOSE_UNKNOWN'
        # Drain final pipe bytes after all namespace writers are gone, bounded.
        if process is not None:
            for name in ('stdout', 'stderr'):
                pipe = getattr(process, name)
                try:
                    os.set_blocking(pipe.fileno(), False)
                    while not eof[name]:
                        raw = os.read(pipe.fileno(), 16384)
                        feed_output(controller, output, partial, eof, name, raw)
                        if not raw:
                            break
                except (OSError, ValueError, TypeError, KeyError, RecursionError):
                    error = error or 'PIPE_DRAIN_FAILED'
            for pipe in (process.stdin, process.stdout, process.stderr):
                try:
                    pipe.close()
                except OSError:
                    error = error or 'PIPE_CLOSE_FAILED'
        for connection in sockets:
            try:
                connection.close()
            except OSError:
                error = error or 'SOCKET_CLOSE_FAILED'
        if listener is not None:
            try:
                listener.close()
            except OSError:
                error = error or 'LISTENER_CLOSE_FAILED'
        try:
            selector.close()
        except OSError:
            error = error or 'SELECTOR_CLOSE_FAILED'
    evidence = None
    if cleanup_result['namespaceEmpty']:
        try:
            evidence = read_capture(load('capture'), diagnostics=True)
            if not evidence['validated']:
                error = error or 'CAPTURE_ENDPOINT_REFUSED'
        except (OSError, ValueError, TypeError, KeyError, RecursionError):
            error = error or 'CAPTURE_EVIDENCE_FAILED'
    passed = (error is None and controller.completed and not controller.failed
              and peer.report()['complete'] and evidence is not None
              and evidence['validated'] and all(eof.values())
              and not partial
              and cleanup_result['namespaceEmpty'] and cleanup_result['allObservedPidfdsESRCH']
              and not cleanup_result['errors'])
    return {'kind': 'stock-client-authored-response-capture', 'passed': passed,
        'error': error, 'elapsedMs': round((time.monotonic() - began) * 1000),
        'controller': controller.report(), 'peer': peer.report(), 'capture': evidence,
        'appserverOutput': {k: bytes(v).hex() for k, v in output.items()},
        'streamEOF': eof, 'cleanup': cleanup_result, 'inferenceAttested': False,
        'toolExecutionSucceeded': False, 'productionReady': False}


def main():
    need(sys.platform == 'linux' and os.getpid() == 1 and os.uname().machine == 'x86_64',
         'EXCLUSIVE_LINUX_PID1_REQUIRED')
    probe, supervisor = load('probe'), load('supervisor')
    facts = probe.sandbox(allow_runtime_aliases=True)
    supervisor.validate_runtime_aliases()
    identities = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest()
                  for name, path in FILES.items()}
    binaries = {name: hashlib.sha256(Path('/usr/bin/' + name).read_bytes()).hexdigest()
                for name in ('codex', 'bwrap')}
    probe.check_runtime_identity(binaries['codex'], binaries['bwrap'])
    loopback = supervisor.bootstrap_http_loopback()
    report = drive(load('harness'), load('http'), probe)
    report.update(sandbox=facts, loopback=loopback, sourceSha256=identities, binarySha256=binaries)
    raw = json.dumps(report, separators=(',', ':'), allow_nan=False).encode() + b'\n'
    # Outer host driver must drain and bound this finite terminal document.
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--inside']:
        raise SystemExit(main())
    if sys.argv[1:] == ['--capture-endpoint']:
        raise SystemExit(capture_endpoint())
    if len(sys.argv) == 2 and sys.argv[1].startswith('/tmp/rc-runtime.'):
        enter_root(sys.argv[1])
    raise SystemExit('FIXED_CAPTURE_CAPSULE_ENTRY_REQUIRED')
