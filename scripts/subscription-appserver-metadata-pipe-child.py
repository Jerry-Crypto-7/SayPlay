"""Fixed credential-free interactive metadata pipe. Never an inference entry."""
import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time

FIXED_SYSTEM = 'Metadata transport validation only; no inference.'
FIXED_SANDBOX_ADVISORY = "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces."
MAX_INPUT = 4096
MAX_LINE = 65536
MAX_QUEUE = 65536
MAX_OUTPUT = 8 * 1024 * 1024


def load_fixed(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError('FIXED_METADATA_HELPER_REQUIRED')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(frame):
    return json.dumps(frame, sort_keys=True, separators=(',', ':'), allow_nan=False)


def make_protocol(policy, home):
    class FixedGenerationMetadataProtocol(policy.Protocol):
        def __init__(self, home):
            self.sandbox_advisory_seen = False
            super().__init__(home)

        def receive(self, frame):
            if type(frame) is dict and frame.get('method') == 'configWarning':
                # A source-reviewed startup advisory, never permission to relax
                # worker lockdown or dispatch additional requests. Preserve the
                # received object in history and leave the original wire intact.
                self.history.append({'event': 'received', 'frame': frame})
                params = frame.get('params')
                if (not policy.notification_envelope(frame) or self.sandbox_advisory_seen
                        or 1 not in self.responses or type(params) is not dict
                        or set(params) != {'summary', 'details'}
                        or params['summary'] != FIXED_SANDBOX_ADVISORY or params['details'] is not None):
                    raise ValueError('METADATA_SANDBOX_ADVISORY_INVALID')
                self.sandbox_advisory_seen = True
                return
            super().receive(frame)

        def _queue(self, frame):
            # Fresh fixed dictionaries supplied by the read-only policy helper.
            # No caller-supplied system instruction or policy override exists.
            if frame['method'] == 'initialize':
                frame['params']['clientInfo']['name'] = 'reality_compiler_generation'
            elif frame['method'] == 'thread/start':
                frame['params']['developerInstructions'] = FIXED_SYSTEM
            super()._queue(frame)
    return FixedGenerationMetadataProtocol(home)


class WireGate:
    """Explicit client admission and actual app-server write are separate facts."""
    def __init__(self, policy, home):
        self.policy = policy
        self.protocol = make_protocol(policy, home)
        self.partial = bytearray()
        self.server_partial = bytearray()
        self.total = 0
        self.approved = 0
        self.authorized_bytes = 0
        self.failed = False

    def receive_client(self, raw):
        if self.failed:
            raise ValueError('METADATA_GATE_FAILED')
        try:
            self.total += len(raw)
            if self.total > MAX_INPUT:
                raise ValueError('METADATA_INPUT_LIMIT')
            self.partial.extend(raw)
            while b'\n' in self.partial:
                line, _, rest = self.partial.partition(b'\n')
                self.partial[:] = rest
                incoming = self.policy.strict_json(bytes(line))
                queued = [entry['frame'] for entry in self.protocol.history if entry['event'] == 'queued']
                if self.approved >= len(queued) or canonical(incoming) != canonical(queued[self.approved]):
                    raise ValueError('METADATA_REQUEST_REFUSED')
                # Forward the immutable policy serialization, not the caller's
                # byte representation. Python bool/int equality is insufficient.
                wire = (json.dumps(queued[self.approved], separators=(',', ':')) + '\n').encode()
                self.authorized_bytes += len(wire)
                self.approved += 1
        except (ValueError, TypeError, RecursionError):
            self.failed = True
            raise

    def drain(self, fd):
        if self.failed or not self.authorized_bytes:
            return 0
        try:
            count = os.write(fd, self.protocol.pending[:self.authorized_bytes])
        except BlockingIOError:
            return 0
        if not 0 < count <= self.authorized_bytes:
            self.failed = True
            raise ValueError('METADATA_WRITE_ACCOUNTING')
        self.protocol.written(count)
        self.authorized_bytes -= count
        return count

    def receive_server(self, raw):
        try:
            self._receive_server(raw)
        except (ValueError, TypeError, RecursionError):
            self.failed = True
            raise

    def _receive_server(self, raw):
        self.server_partial.extend(raw)
        while b'\n' in self.server_partial:
            line, _, rest = self.server_partial.partition(b'\n')
            self.server_partial[:] = rest
            if len(line) > MAX_LINE or len(self.protocol.history) >= 64:
                raise ValueError('METADATA_SERVER_FRAME_LIMIT')
            self.protocol.receive(self.policy.strict_json(bytes(line)))
        if len(self.server_partial) > MAX_LINE:
            raise ValueError('METADATA_SERVER_FRAME_LIMIT')

    def client_eof(self):
        if self.partial or self.authorized_bytes or 2 not in self.protocol.responses:
            raise ValueError('METADATA_CLIENT_EOF_INCOMPLETE')


def fresh_environment():
    # Parent supplies a dedicated writable mount; mkdtemp creates an exclusive
    # new directory. Existing auth/config contents are never opened or reused.
    home = tempfile.mkdtemp(prefix='fixed-', dir='/work/appserver-home')
    Path(home + '/tmp').mkdir(mode=0o700, exist_ok=False)
    return home, {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': home,
                  'CODEX_HOME': home, 'TMPDIR': home + '/tmp'}


def run_pipe(policy, home, environment):
    gate = WireGate(policy, home)
    began = time.monotonic()
    process = subprocess.Popen(policy.ARGV, cwd='/work', env=environment, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
    pin = None
    selector = selectors.DefaultSelector()
    pending = {'stdout': bytearray(), 'stderr': bytearray()}
    eof = set()
    cleanup = None
    error = None
    total = 0

    def close_input(reason=None):
        nonlocal cleanup, error
        if reason and error is None:
            # This fixed bridge diagnostic is distinct from app-server stderr.
            # Preserve chronology within the same bounded output queue.
            marker = ('METADATA_PIPE_DIAGNOSTIC:' + reason + '\n').encode()
            if len(pending['stderr']) + len(marker) <= MAX_QUEUE:
                pending['stderr'].extend(marker)
        error = error or reason
        if cleanup is None:
            cleanup = policy.Cleanup(time.monotonic())
            if not process.stdin.closed:
                process.stdin.close()
            if any(key.data == 'client' for key in selector.get_map().values()):
                selector.unregister(0)

    try:
        pin = os.pidfd_open(process.pid)
        for fd in (0, 1, 2, process.stdin.fileno(), process.stdout.fileno(), process.stderr.fileno()):
            os.set_blocking(fd, False)
        selector.register(0, selectors.EVENT_READ, 'client')
        for name in pending:
            selector.register(getattr(process, name).fileno(), selectors.EVENT_READ, name)
        while True:
            now = time.monotonic()
            if now - began >= 180:
                close_input('METADATA_JOB_DEADLINE')
            for name, fd in (('stdout', 1), ('stderr', 2)):
                if pending[name]:
                    try:
                        count = os.write(fd, pending[name])
                        del pending[name][:count]
                    except BlockingIOError:
                        pass
            if cleanup is None:
                try:
                    gate.drain(process.stdin.fileno())
                except (ValueError, OSError) as failure:
                    close_input(type(failure).__name__ + ':METADATA_WRITE_FAILED')
            if process.poll() is not None:
                close_input()
                if len(eof) == 2 and not any(pending.values()):
                    return 1 if error or process.returncode != 0 else 0
            if cleanup is not None:
                action = cleanup.action(now, process.poll() is not None)
                if action in ('term', 'kill'):
                    try:
                        signal.pidfd_send_signal(pin, signal.SIGTERM if action == 'term' else signal.SIGKILL)
                        cleanup.sent(action, time.monotonic())
                    except ProcessLookupError:
                        pass
                if action == 'unknown' or now - cleanup.began >= 12:
                    return 1  # Outer supervisor independently owns all descendants.
            for key, _ in selector.select(0.01):
                name = key.data
                if name != 'client' and len(pending[name]) >= MAX_QUEUE:
                    continue  # Bound queues without blocking cleanup/parent EOF.
                count = 4096 if name == 'client' else min(4096, MAX_QUEUE - len(pending[name]))
                raw = os.read(key.fd, count)
                if not raw:
                    selector.unregister(key.fd)
                    if name == 'client':
                        try:
                            gate.client_eof()
                            close_input()
                        except ValueError:
                            close_input('METADATA_CLIENT_EOF_INCOMPLETE')
                    else:
                        eof.add(name)
                        if name == 'stdout' and gate.server_partial:
                            close_input('METADATA_SERVER_EOF_INCOMPLETE')
                    continue
                if name == 'client':
                    try:
                        gate.receive_client(raw)
                    except (ValueError, TypeError, RecursionError):
                        close_input('METADATA_REQUEST_REFUSED')
                else:
                    # Exact app-server bytes, separate streams. No synthetic
                    # JSONL response, cleanup receipt or padding is generated.
                    pending[name].extend(raw)
                    total += len(raw)
                    if total > MAX_OUTPUT:
                        close_input('METADATA_OUTPUT_LIMIT')
                    if name == 'stdout' and cleanup is None:
                        try:
                            gate.receive_server(raw)
                        except (ValueError, TypeError, RecursionError):
                            close_input('METADATA_SERVER_PROTOCOL')
    finally:
        selector.close()
        if pin is not None:
            os.close(pin)
        for name in ('stdin', 'stdout', 'stderr'):
            getattr(process, name).close()
        # No signal-by-numeric-PID fallback, arbitrary child kill, or host cleanup.
        # Returning/exiting leaves descendant cleanup to the capsule pidfd owner.


def main():
    if sys.platform != 'linux' or len(sys.argv) != 1:
        raise ValueError('FIXED_METADATA_PIPE_ENTRY_REQUIRED')
    lockdown = load_fixed('fixed_metadata_lockdown', '/usr/bin/worker-lockdown.py')
    lockdown.install_worker_lockdown()
    policy = load_fixed('fixed_metadata_policy', '/usr/bin/appserver-noenv.py')
    home, environment = fresh_environment()
    return run_pipe(policy, home, environment)


if __name__ == '__main__':
    raise SystemExit(main())
