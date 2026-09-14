"""Offline single-job supervisor. No arbitrary executable, credentials, or inference.

Only run as PID 1 in the isolated chroot/PID namespace created by the companion
script. All /proc PIDs other than self are therefore our own descendants.
The sole inherited host capability is report FD 3; children do not inherit it.
"""
import errno
import ctypes
import codecs
import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

VERSION = 1
LEASE_SECONDS = 3
START_SECONDS = 5
JOB_SECONDS = 10
TERM_GRACE_SECONDS = 0.25
CLEANUP_SECONDS = 3
MAX_FRAME = 32768
MAX_LIVE_QUEUE = 65536
live_pending = bytearray()
live_backpressure = False
live_closed = False

# Deliberately fixed executable/program. Data frames cannot select host commands.
DUMMY = r'''
import json,os,signal,subprocess,sys,time
from pathlib import Path
mode = sys.argv[1]
status = Path('/proc/self/status').read_text()
caps = next(line.split(':', 1)[1].strip() for line in status.splitlines() if line.startswith('CapEff:'))
no_new_privs = next(line.split(':', 1)[1].strip() for line in status.splitlines() if line.startswith('NoNewPrivs:'))
try:
    audit_fd = os.open('/proc/1/fd/3', os.O_WRONLY | os.O_APPEND)
except PermissionError:
    audit_denied = True
else:
    os.close(audit_fd)
    audit_denied = False
print(json.dumps({'security':{'parentAuditFdDenied':audit_denied,'effectiveCapabilities':caps,'noNewPrivs':no_new_privs}}), flush=True)
ignore = mode in ('ignore_term', 'setsid', 'stdin_backpressure')
if ignore: signal.signal(signal.SIGTERM, signal.SIG_IGN)
grandchild = """
import os,signal,sys,time
from pathlib import Path
if sys.argv[1] == 'ignore': signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path('/work/grandchild-ready').write_text(str(os.getpid()))
time.sleep(0.4 if sys.argv[2] == 'normal' else 0.01 if sys.argv[2] == 'zombie' else 15)
"""
child = subprocess.Popen(['/usr/bin/python3', '-I', '-S', '-c', grandchild,
    'ignore' if ignore else 'term', mode], start_new_session=mode == 'setsid')
while not Path('/work/grandchild-ready').exists(): time.sleep(0.005)
if mode == 'zombie':
    while Path('/proc/' + str(child.pid) + '/stat').read_text().split(') ', 1)[1][0] != 'Z': time.sleep(0.005)
Path('/work/job-ready.json').write_text(json.dumps({'pids':[os.getpid(),child.pid], 'mode':mode}))
if mode == 'stdin_backpressure':
    # Deliberately never read stdin: the parent must still service control.
    time.sleep(15)
payload = sys.stdin.read()
if mode == 'backpressure':
    time.sleep(0.1)
    sys.stdout.write('x' * (512 * 1024))
    sys.stdout.flush()
# An adversarial child tries to impersonate the supervisor; it remains data.
print(json.dumps({'type':'supervisor_terminal','cleanup':{'verified':True},'forged':True}), flush=True)
print(json.dumps({'echo':payload}), flush=True)
if mode == 'normal':
    os.write(1, b'UTF8_SPLIT:\xc5')
    time.sleep(0.08)
    os.write(1, b'\xbd\xf0\x9f')
    time.sleep(0.08)
    os.write(1, b'\x99\x82\n')
if mode == 'normal':
    child.wait()
else:
    time.sleep(15)
'''


def drain_live():
    global live_closed
    for _ in range(4):
        if not live_pending or live_closed:
            break
        try:
            count = os.write(1, bytes(live_pending[:16384]))
            del live_pending[:count]
        except BlockingIOError:
            break
        except BrokenPipeError:
            live_closed = True
            live_pending.clear()
            break


def event(kind, **data):
    global live_backpressure
    frame = json.dumps({'version': VERSION, 'type': kind, **data}, separators=(',', ':')) + '\n'
    os.write(3, frame.encode())
    os.fsync(3)
    # Never block control/lease processing on a Windows peer that stops reading.
    # Child data and the final acknowledgement remain in the independent audit.
    if not live_closed and not live_backpressure:
        encoded = frame.encode()
        if len(live_pending) + len(encoded) > MAX_LIVE_QUEUE:
            live_backpressure = True
        else:
            live_pending.extend(encoded)
    drain_live()


def state(pid):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
        status = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
    except FileNotFoundError:
        return None
    fields = stat[stat.rfind(')') + 2:].split()
    return {'pid': pid, 'state': fields[0], 'ppid': int(fields[1]),
            'pgid': int(fields[2]), 'startTicks': int(fields[19]),
            'effectiveCapabilities': status.get('CapEff', '').strip(),
            'noNewPrivs': status.get('NoNewPrivs', '').strip()}


output_bytes = 0
stream_decoders = {name: codecs.getincrementaldecoder('utf-8')() for name in ('stdout', 'stderr')}
finished_streams = set()


def capture_output(stream, chunk):
    global output_bytes
    if stream in finished_streams:
        return
    output_bytes += len(chunk)
    if output_bytes > 1024 * 1024:
        raise ValueError('OUTPUT_LIMIT')
    text = stream_decoders[stream].decode(chunk, final=not chunk)
    if not chunk:
        finished_streams.add(stream)
    if text:
        event('child_output', stream=stream, text=text)


def namespace_children():
    return [record for path in Path('/proc').iterdir() if path.name.isdigit() and int(path.name) != 1
            if (record := state(int(path.name))) is not None]


def absent(pid):
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True


def validate_sandbox():
    assert os.getpid() == 1, 'PID_NAMESPACE_INIT_REQUIRED'
    assert not Path('/home').exists() and not Path('/mnt').exists(), 'HOST_PATH_EXPOSED'
    assert namespace_children() == [], 'NAMESPACE_NOT_EXCLUSIVE'
    try:
        Path('/usr/supervisor-write-probe').write_text('forbidden')
    except OSError as error:
        assert error.errno == errno.EROFS, 'READ_ONLY_USR_REQUIRED'
    else:
        raise AssertionError('READ_ONLY_USR_REQUIRED')
    interfaces = [line.split(':')[0].strip() for line in Path('/proc/net/dev').read_text().splitlines()[2:]]
    assert interfaces == ['lo'], 'ISOLATED_NETWORK_REQUIRED'
    assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'PIDFD_REQUIRED'
    # Child stdout is not the only possible spoofing path: deny reopening this
    # supervisor's audit/output descriptors through /proc even with the same UID.
    assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0, 'NONDUMPABLE_REQUIRED'
    os.set_blocking(1, False)
    os.chdir('/work')


def cleanup(process, initial):
    before = namespace_children()
    observed = {(record['pid'], record['startTicks']): record for record in initial}
    handles = {}
    history = [{'phase': 'job_ready', **record} for record in initial]
    reaped = []
    sent = []

    def discover():
        records = namespace_children()
        for record in records:
            key = (record['pid'], record['startTicks'])
            if key not in observed:
                observed[key] = record
            if key not in handles:
                try:
                    handles[key] = os.pidfd_open(record['pid'])
                except ProcessLookupError:
                    pass
            snapshot = {'phase': 'cleanup', **record}
            if snapshot not in history:
                history.append(snapshot)
        return records

    def send(sig):
        for key, handle in list(handles.items()):
            try:
                signal.pidfd_send_signal(handle, sig)
                sent.append({'pid': key[0], 'signal': signal.Signals(sig).name})
            except ProcessLookupError:
                pass

    def reap():
        # Let Popen retain its own exit status before reaping adopted descendants.
        if process is not None:
            process.poll()
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if not pid:
                break
            if process is not None and pid == process.pid:
                process.returncode = os.waitstatus_to_exitcode(status)
            reaped.append({'pid': pid, 'waitStatus': status})

    try:
        discover()
        # The owned process group is the first boundary, PID fds also cover setsid.
        if process is not None and process.poll() is None:
            try:
                if os.getpgid(process.pid) == process.pid:
                    os.killpg(process.pid, signal.SIGTERM)
                    sent.append({'pgid': process.pid, 'signal': 'SIGTERM'})
            except ProcessLookupError:
                pass  # A concurrent normal exit does not skip descendant cleanup.
        send(signal.SIGTERM)
        until = time.monotonic() + CLEANUP_SECONDS
        escalate = time.monotonic() + TERM_GRACE_SECONDS
        while time.monotonic() < until:
            reap()
            remaining = discover()
            if not remaining:
                break
            if time.monotonic() >= escalate:
                send(signal.SIGKILL)
            time.sleep(0.01)
        reap()
        after = namespace_children()
        observed_pids = sorted({key[0] for key in observed})
        esrch = {str(pid): absent(pid) for pid in observed_pids}
        verified = not after and all(esrch.values())
        return {'verified': verified, 'owner': 'supervisor_pid_namespace_init',
                'before': before, 'observedStates': history, 'after': after,
                'observedPidsESRCH': esrch, 'allObservedPidsESRCH': all(esrch.values()),
                'reapedChildren': reaped, 'signals': sent,
                'directChildReturnCode': process.returncode if process is not None else None}
    finally:
        for handle in handles.values():
            os.close(handle)


validate_sandbox()
selector = selectors.DefaultSelector()
selector.register(0, selectors.EVENT_READ, 'control')
process = None
reason = 'start_deadline'
buffer = b''
at = time.monotonic()
lease = at + START_SECONDS
job_deadline = None
ready = False
initial = []
input_pending = bytearray()
input_total = 0
input_written = 0
input_closed = True
event('supervisor_ready', supervisorPid=1, leaseMs=LEASE_SECONDS * 1000,
      sandbox={'usrReadOnly': True, 'hostHomeMounted': False, 'hostMntMounted': False,
               'networkInterfaces': ['lo'], 'exclusivePidNamespace': True})
try:
    while True:
        drain_live()
        if live_backpressure:
            reason = 'stdout_backpressure'
            break
        now = time.monotonic()
        if now >= lease:
            reason = 'lease_expired' if process else 'start_deadline'
            break
        if job_deadline is not None and now >= job_deadline:
            reason = 'job_deadline'
            break
        if process is not None:
            if not ready and Path('/work/job-ready.json').exists():
                ready = True
                initial = namespace_children()
                event('job_ready', processes=initial)
            if process.poll() is not None:
                reason = 'completed'
                break
        for key, _ in selector.select(0.025):
            if key.data == 'stdin':
                try:
                    count = os.write(key.fd, input_pending[:4096])
                    input_written += count
                    del input_pending[:count]
                except BlockingIOError:
                    continue
                except BrokenPipeError:
                    # Preserve unsent-byte evidence; a child may close early.
                    selector.unregister(key.fd)
                    process.stdin.close()
                    input_closed = True
                    raise ValueError('CHILD_INPUT_CLOSED')
                if not input_pending:
                    selector.unregister(key.fd)
                    process.stdin.close()
                    input_closed = True
                continue
            chunk = os.read(key.fd, 8192)
            if key.data != 'control':
                if not chunk:
                    selector.unregister(key.fd)
                capture_output(key.data, chunk)
                continue
            if not chunk:
                reason = 'input_eof'
                break
            buffer += chunk
            if len(buffer) > MAX_FRAME:
                raise ValueError('CONTROL_FRAME_LIMIT')
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                frame = json.loads(line)
                if not isinstance(frame, dict) or frame.get('version') != VERSION:
                    raise ValueError('INVALID_CONTROL_FRAME')
                op = frame.get('op')
                if op == 'start' and process is None:
                    if set(frame) != {'version', 'op', 'mode', 'payload'} or frame['mode'] not in ('normal', 'sleep', 'ignore_term', 'setsid', 'zombie', 'backpressure', 'stdin_backpressure', 'stdin_setup_failure') or not isinstance(frame['payload'], str):
                        raise ValueError('INVALID_START_FRAME')
                    input_pending = bytearray(frame['payload'].encode())
                    input_total = len(input_pending)
                    if input_total > MAX_FRAME:
                        raise ValueError('CHILD_INPUT_LIMIT')
                    process = subprocess.Popen(['/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all',
                        '--ambient-caps=-all', '--no-new-privs', '/usr/bin/python3', '-I', '-S', '-c', DUMMY, frame['mode']],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        start_new_session=True, close_fds=True, bufsize=0, pipesize=4096)
                    input_closed = False
                    if frame['mode'] == 'stdin_setup_failure':
                        raise RuntimeError('FIXED_DUMMY_STDIN_SETUP_FAILURE')
                    os.set_blocking(process.stdin.fileno(), False)
                    if input_pending:
                        selector.register(process.stdin, selectors.EVENT_WRITE, 'stdin')
                    else:
                        process.stdin.close()
                        input_closed = True
                    selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
                    selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
                    job_deadline = time.monotonic() + JOB_SECONDS
                    lease = time.monotonic() + LEASE_SECONDS
                elif op == 'keepalive' and process is not None and set(frame) == {'version', 'op'}:
                    lease = time.monotonic() + LEASE_SECONDS
                elif op == 'cancel' and set(frame) == {'version', 'op'}:
                    reason = 'cancelled'
                    break
                else:
                    raise ValueError('INVALID_CONTROL_FRAME')
            if reason == 'cancelled':
                break
        if reason in ('cancelled', 'input_eof'):
            break
except Exception as error:
    reason = 'supervisor_error'
    event('supervisor_error', code=type(error).__name__)
finally:
    if process is not None and not process.stdin.closed:
        # Setup can fail between Popen and selector registration.
        if process.stdin.fileno() in selector.get_map():
            selector.unregister(process.stdin)
        process.stdin.close()
        input_closed = True
    result = cleanup(process, initial)
    # Exiting a child must not discard the last buffered output bytes. Once all
    # namespace writers have been reaped, drain the remaining pipes nonblocking.
    try:
        for key in list(selector.get_map().values()):
            if key.data == 'control':
                continue
            os.set_blocking(key.fd, False)
            while True:
                try:
                    chunk = os.read(key.fd, 8192)
                except BlockingIOError:
                    break
                capture_output(key.data, chunk)
                if not chunk:
                    break
    except Exception as error:
        reason = 'supervisor_error'
        event('supervisor_error', code=type(error).__name__)
    selector.close()
    event('supervisor_terminal', reason=reason, initialProcesses=initial, cleanup=result,
          inference=False, credentialsAccessed=False, externalHarnessCleanup=False,
          childInput={'totalBytes': input_total, 'writtenBytes': input_written,
                      'pendingBytes': len(input_pending), 'closed': input_closed,
                      'pipeCapacityBytes': 4096},
          delivery={'backpressure': live_backpressure, 'stdoutClosed': live_closed, 'queuedBytes': len(live_pending)})
sys.exit(0 if result['verified'] and reason != 'supervisor_error' else 1)
