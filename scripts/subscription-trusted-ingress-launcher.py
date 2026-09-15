"""Fixed Linux AF_UNIX descriptor provisioning; no external connector."""
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid

EMIT_SECONDS = 2.0
FD = 198
_RUN_USED = False
ROOT = Path(__file__).parent
SOURCE_NAMES = ('subscription-trusted-ingress-launcher.py', 'subscription-trusted-egress-proxy.py',
    'subscription-cli-supervisor.sh', 'subscription-cli-supervisor.py',
    'subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-trusted-control-boundary-probe.py',
    'subscription-worker-lockdown.py', 'subscription-appserver-noenv.py',
    'subscription-text-model-catalog.json', 'subscription-trusted-control-boundary-parent.py',
    'subscription-trusted-ingress-child.py', 'subscription-trusted-ingress-worker-probe.py')
COMMAND = ('/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '200', '/usr/bin/unshare',
    '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--pid', '--uts', '--fork',
    '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh', '--trusted-ingress-fd')


def source_hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCE_NAMES}


def reserve_ingress_fd(peer):
    import fcntl
    try: os.fstat(FD)
    except OSError as error:
        if error.errno != errno.EBADF: raise
    else: raise ValueError('FIXED_INGRESS_FD_OCCUPIED')
    duplicate = fcntl.fcntl(peer.fileno(), fcntl.F_DUPFD_CLOEXEC, FD)
    if duplicate != FD:
        os.close(duplicate)
        raise ValueError('FIXED_INGRESS_FD_RACED')
    try:
        original, copied = os.fstat(peer.fileno()), os.fstat(duplicate)
        if not stat.S_ISSOCK(copied.st_mode) or (original.st_dev, original.st_ino) != (copied.st_dev, copied.st_ino):
            raise ValueError('INGRESS_IDENTITY_MISMATCH')
        if peer.family != socket.AF_UNIX or peer.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM:
            raise ValueError('FIXED_UNIX_STREAM_REQUIRED')
        peer.getpeername()
        if peer.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN): raise ValueError('INGRESS_LISTENER_REFUSED')
        return {'dev': copied.st_dev, 'ino': copied.st_ino, 'type': stat.S_IFMT(copied.st_mode),
            'family': int(socket.AF_UNIX), 'socketType': int(socket.SOCK_STREAM)}
    except BaseException:
        os.close(duplicate)
        raise


def challenge(phase, nonce):
    if phase not in ('BEFORE', 'AFTER') or len(nonce) != 32 or any(c not in '0123456789abcdef' for c in nonce):
        raise ValueError('FIXED_CHALLENGE_REQUIRED')
    return (phase + ' ' + nonce + '\n').encode('ascii')


def recv_exact(peer, expected, deadline):
    raw = bytearray()
    while len(raw) < len(expected):
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('FIXTURE_DEADLINE')
        peer.settimeout(min(1.0, remaining))
        try: chunk = peer.recv(len(expected) - len(raw))
        except socket.timeout: continue
        if not chunk: raise ValueError('FIXTURE_EARLY_EOF')
        raw.extend(chunk)
    if bytes(raw) != expected: raise ValueError('FIXTURE_CHALLENGE_MISMATCH')
    return len(raw)


def emit(frame):
    raw = (json.dumps(frame, separators=(',', ':'), allow_nan=False) + '\n').encode()
    if len(raw) > 16384: raise ValueError('OWNERSHIP_FRAME_LIMIT')
    began = time.monotonic()
    previous = os.get_blocking(1)
    try:
        os.set_blocking(1, False)
        offset = 0
        while offset < len(raw):
            if time.monotonic() - began >= EMIT_SECONDS: raise TimeoutError('INGRESS_FRAME_WRITE_DEADLINE')
            try: count = os.write(1, raw[offset:])
            except BlockingIOError:
                select.select([], [1], [], 0.01)
                continue
            if count <= 0: raise OSError('INGRESS_FRAME_WRITE_CLOSED')
            offset += count
        if time.monotonic() - began >= EMIT_SECONDS: raise TimeoutError('INGRESS_FRAME_WRITE_DEADLINE')
    finally:
        os.set_blocking(1, previous)


def run():
    global _RUN_USED
    if _RUN_USED: raise ValueError('LAUNCHER_SINGLE_USE_FENCE')
    _RUN_USED = True
    if sys.platform != 'linux': raise ValueError('FIXED_LINUX_REQUIRED')
    before = source_hashes(); raw = (ROOT / 'subscription-trusted-egress-proxy.py').read_bytes()
    if hashlib.sha256(raw).hexdigest() != before['subscription-trusted-egress-proxy.py']: raise ValueError('PROXY_SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('fixed_ingress_proxy', ROOT / 'subscription-trusted-egress-proxy.py')
    proxy = importlib.util.module_from_spec(spec); exec(compile(raw, str(spec.origin), 'exec'), proxy.__dict__)
    broker, ingress, upstream, control = proxy.create_offline_session()
    nonce = uuid.uuid4().hex
    process = None; pin = None; duplicate = False; started = []; reports = []; errors = []
    route = {'beforeBytes': 0, 'afterBytes': 0, 'eof': False}
    stop = threading.Event(); broker_started = threading.Event()
    def relay():
        try:
            deadline = time.monotonic() + 30
            while not stop.is_set():
                if time.monotonic() >= deadline: raise TimeoutError('INGRESS_NOT_READY')
                if select.select([broker._sockets[0]], [], [], 0.05)[0]:
                    broker_started.set(); reports.append(broker.run()); return
        except (ValueError, OSError) as error: errors.append(type(error).__name__)
    def fixture():
        try:
            while not broker_started.wait(0.05):
                if stop.is_set(): return
            deadline = time.monotonic() + proxy.SESSION_SECONDS
            for phase, key in (('BEFORE', 'beforeBytes'), ('AFTER', 'afterBytes')):
                body = challenge(phase, nonce)
                route[key] = recv_exact(upstream, body, deadline)
                upstream.sendall(b'ACK ' + body)
            upstream.settimeout(max(0.001, min(1.0, deadline - time.monotonic())))
            if upstream.recv(1) != b'': raise ValueError('FIXTURE_EXTRA_BYTES')
            upstream.shutdown(socket.SHUT_WR); route['eof'] = True
        except (ValueError, OSError) as error: errors.append(type(error).__name__)
    ownership_written = False; wait_known = False; wait_attempted = False; returncode = None; identity = None; spawned_at = None
    try:
        identity = reserve_ingress_fd(ingress); duplicate = True
        emit({'type': 'ingress_ownership', 'version': 1, 'nonce': nonce, 'fd': FD,
            'socket': identity, 'sourceSha256': before})
        ownership_written = True
        spawned_at = time.monotonic()
        process = subprocess.Popen(COMMAND, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
            close_fds=True, pass_fds=(FD,))
        os.close(FD); duplicate = False; ingress.close()
        pin = os.pidfd_open(process.pid)
        for target in (relay, fixture):
            thread = threading.Thread(target=target, daemon=True); thread.start(); started.append(thread)
        wait_attempted = True
        try: returncode = process.wait(timeout=max(0.0, 205 - (time.monotonic() - spawned_at))); wait_known = True
        except subprocess.TimeoutExpired: errors.append('CAPSULE_WAIT_UNKNOWN')
    except (ValueError, OSError, RuntimeError) as error: errors.append(type(error).__name__)
    finally:
        if process is not None and not wait_attempted:
            try:
                returncode = process.wait(timeout=max(0.0, 205 - (time.monotonic() - spawned_at)))
                wait_known = True
            except subprocess.TimeoutExpired: errors.append('CAPSULE_WAIT_UNKNOWN')
        stop.set()
        if duplicate: os.close(FD)
        ingress.close()
        try: control.send(b'C')
        except OSError: pass
        for thread in started: thread.join(1)
        for peer in (upstream, control): peer.close()
        if not broker_started.is_set():
            for endpoint in broker._sockets: endpoint.close()
            broker.cleanup_known = all(endpoint.fileno() == -1 for endpoint in broker._sockets)
        if pin is not None: os.close(pin)
    after = source_hashes()
    complete = (wait_known and returncode == 0 and not errors and before == after and len(reports) == 1
        and reports[0]['reason'] == 'EOF' and reports[0]['brokerDescriptorsClosed'] is True
        and route['eof'] and route['beforeBytes'] == len(challenge('BEFORE', nonce))
        and route['afterBytes'] == len(challenge('AFTER', nonce)) and all(not t.is_alive() for t in started))
    terminal = {'type': 'ingress_terminal', 'version': 1, 'nonce': nonce, 'socket': identity,
        'sourceBefore': before, 'sourceAfter': after, 'capsuleWaitKnown': wait_known, 'capsuleReturnCode': returncode,
        'remoteProcessCleanup': 'NOT_ATTESTED_BY_LAUNCHER', 'broker': reports[0] if len(reports) == 1 else None,
        'route': route, 'threadsClosed': all(not t.is_alive() for t in started),
        'peersClosed': all(peer.fileno() == -1 for peer in (ingress, upstream, control)),
        'errors': errors, 'passed': complete, 'productionReady': False, 'aggregateResourcesValidated': False}
    if ownership_written and (process is None or wait_known):
        try: emit(terminal)
        except (OSError, ValueError): return 1
    else:
        # No blocking diagnostic fallback, and no frame after partial ownership
        # or interleaved with an unconfirmed live capsule writer.
        return 1
    return 0 if complete else 1


def main():
    if sys.argv[1:]: raise ValueError('FIXED_NO_ARGUMENTS')
    return run()


if __name__ == '__main__': raise SystemExit(main())
