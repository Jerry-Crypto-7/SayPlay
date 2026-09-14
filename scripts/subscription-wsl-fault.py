"""Credential-free GNU timeout process-family experiment in an isolated chroot."""
import ctypes
import errno
import json
import os
import platform
import subprocess
import signal
import sys
import time
from pathlib import Path


def gone(pid):
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True


os.chdir('/work')
assert not Path('/home').exists() and not Path('/mnt').exists()
try:
    Path('/usr/rc-write-probe').write_text('forbidden')
except OSError as error:
    assert error.errno == errno.EROFS
else:
    raise AssertionError('SYSTEM_MOUNT_WRITABLE')
interfaces = [line.split(':')[0].strip() for line in Path('/proc/net/dev').read_text().splitlines()[2:]]
assert interfaces == ['lo'], interfaces
# The harness adopts and reaps simulator grandchildren after forced group kill.
# It is not evidence that the production WSL dispatcher is a subreaper.
assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
if sys.argv[1:] == ['wrapper-abort']:
    # FD 3 is the sole pre-opened scratch report capability. No host mount exists.
    def audit(record):
        os.write(3, (json.dumps(record) + '\n').encode())
        os.fsync(3)
    child_code = '''
import json,os,subprocess,time
from pathlib import Path
child = subprocess.Popen(['/usr/bin/python3', '-c', 'import time; time.sleep(15)'])
Path('/work/wrapper.pids.json').write_text(json.dumps([os.getpid(), child.pid]))
time.sleep(15)
'''
    child = subprocess.Popen(['/usr/bin/python3', '-I', '-S', '-c', child_code], start_new_session=True)
    try:
        deadline = time.monotonic() + 2
        while not Path('/work/wrapper.pids.json').exists():
            assert time.monotonic() < deadline, 'CHILD_START_FAILED'
            time.sleep(0.01)
        pids = json.loads(Path('/work/wrapper.pids.json').read_text())
        audit({'event': 'ready', 'namespacePids': pids})
        try:
            print(json.dumps({'type': 'thread.started'}), flush=True)
        except BrokenPipeError:
            pass  # Still audit and clean up if the wrapper ended during startup.
        time.sleep(2)
        alive = [pid for pid in pids if not gone(pid)]
    finally:
        # Signal only the group created above, wholly inside our PID namespace.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=2)
        while True:
            try:
                os.waitpid(-1, 0)
            except ChildProcessError:
                break
    audit({'event': 'completed', 'kind': 'offline-wsl-wrapper-abort',
           'namespacePids': pids, 'aliveAfterWrapperAbort': alive,
           'allPidsESRCHAfterHarnessCleanup': all(gone(pid) for pid in pids),
           'cleanupOwner': 'isolated PID namespace harness', 'inference': False,
           'credentialsAccessed': False, 'hostReportCapability': 'preopened FD 3 only'})
    sys.exit(0)
results = []
for ignore_term in (False, True):
    name = 'kill-after' if ignore_term else 'term'
    child_code = 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)' if ignore_term else 'import time; time.sleep(30)'
    parent_code = f'''
import json,os,signal,subprocess,time
from pathlib import Path
child = subprocess.Popen(['/usr/bin/python3', '-c', {child_code!r}])
Path({name!r} + '.pids.json').write_text(json.dumps([os.getpid(), child.pid]))
signal.signal(signal.SIGTERM, signal.SIG_IGN if {ignore_term!r} else lambda *_: exit(0))
time.sleep(30)
'''
    at = time.monotonic()
    process = subprocess.Popen(['/usr/bin/timeout', '--signal=TERM', '--kill-after=0.2s', '0.5s', '/usr/bin/python3', '-c', parent_code])
    return_code = process.wait(timeout=5)
    code = 128 - return_code if return_code < 0 else return_code
    pids = json.loads(Path(name + '.pids.json').read_text())
    # Reap only this harness's children, never enumerate or signal host processes.
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
        if all(gone(pid) for pid in pids):
            break
        time.sleep(0.01)
    absent = all(gone(pid) for pid in pids)
    assert code == (137 if ignore_term else 124), (name, code)
    assert absent, (name, pids)
    results.append({'case': name, 'exitCode': code, 'namespacePids': pids, 'allPidsESRCH': absent,
                    'wallMs': round((time.monotonic() - at) * 1000), 'reapedByHarness': True})
report = {'kind': 'offline-wsl-timeout-process-family', 'kernel': platform.release(),
          'inference': False, 'credentialsAccessed': False, 'wslWrapperAbortTested': False,
          'sandbox': {'userMountNetPidNamespaces': True, 'chroot': True, 'usrReadOnly': True,
                      'hostHomeMounted': False, 'hostMntMounted': False, 'interfaces': interfaces,
                      'writableHostPath': None, 'runtime': 'copied system Python stdlib, timeout and ldd dependencies'}, 'cases': results}
Path('report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
