"""Fixed, read-only systemd user-manager resource discovery; no CLI/auth."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid
import signal
import errno

MAX_BYTES = 65536
PROPERTIES = ('Version', 'SystemState', 'ControlGroup', 'LoadState',
              'ActiveState', 'MemoryAccounting', 'TasksAccounting')
SELF = '/mnt/d/claude/Hackaton/scripts/subscription-systemd-resource-probe.py'


def fixed_environment():
    runtime = '/run/user/' + str(os.getuid())
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
            'XDG_RUNTIME_DIR': runtime, 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus',
            'SYSTEMD_PAGER': 'cat', 'SYSTEMD_COLORS': '0'}


def own_leaf_files():
    membership = read_fixed('/proc/self/cgroup')
    expected = r'0::(/user\.slice/user-[0-9]+\.slice/user@[0-9]+\.service/app\.slice/codex-resource-probe-[a-f0-9]{32}\.service)'
    match = re.fullmatch(expected, membership)
    if not match:
        raise ValueError('OWN_TRANSIENT_LEAF_REQUIRED')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open('/sys/fs/cgroup', flags)
    try:
        for component in match[1].lstrip('/').split('/'):
            next_fd = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        result = {'membership': match[1]}
        for name in ('memory.max', 'memory.swap.max', 'pids.max', 'memory.events', 'pids.events', 'pids.current'):
            child = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=fd)
            try:
                value = os.read(child, 4097)
                if len(value) > 4096:
                    raise ValueError('LEAF_METADATA_SIZE')
                result[name] = value.decode('ascii').strip()
            finally:
                os.close(child)
        return result
    finally:
        os.close(fd)


def worker():
    # The timer bounds all synthetic work even if expected kernel failures do
    # not occur. systemd adds a separate RuntimeMaxSec and whole-unit cleanup.
    signal.alarm(12)
    before = own_leaf_files()
    if any(before[k] != v for k, v in {'memory.max': '67108864', 'memory.swap.max': '0', 'pids.max': '16'}.items()):
        raise ValueError('FIXED_LIMIT_READBACK_MISMATCH')
    boundary = {}
    leaf = '/sys/fs/cgroup' + before['membership']
    for label, path in [('ownMemoryLimit', leaf + '/memory.max'),
                        ('parentMigration', leaf.rsplit('/', 1)[0] + '/cgroup.procs')]:
        try:
            opened = os.open(path, os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        except OSError as error:
            boundary[label] = {'writeOpenAllowed': False, 'errno': error.errno, 'bytesWritten': 0}
        else:
            os.close(opened)  # Deliberately no write, truncation or migration.
            boundary[label] = {'writeOpenAllowed': True, 'errno': None, 'bytesWritten': 0}
    print(json.dumps({'type': 'before', 'facts': before, 'boundary': boundary}), flush=True)
    children = []
    fork_errno = None
    try:
        for _ in range(32):
            try:
                pid = os.fork()
            except OSError as error:
                fork_errno = error.errno
                break
            if pid == 0:
                time.sleep(2)
                os._exit(0)
            children.append(pid)
        peak = own_leaf_files()
    finally:
        for child in children:
            os.waitpid(child, 0)
    print(json.dumps({'type': 'fork', 'children': len(children), 'errno': fork_errno, 'facts': peak}), flush=True)
    memory_pid = os.fork()
    if memory_pid == 0:
        blocks = []
        for _ in range(128):
            blocks.append(bytearray(1024 * 1024))
        os._exit(0)
    _, status = os.waitpid(memory_pid, 0)
    after = own_leaf_files()
    print(json.dumps({'type': 'memory', 'childSignaled': os.WIFSIGNALED(status),
                      'childSignal': os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
                      'facts': after}), flush=True)
    return 0


def parse_events(value):
    result = {}
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError('EVENT_SIZE')
    for line in value.splitlines():
        fields = line.split()
        if len(fields) != 2 or not re.fullmatch('[a-z_]{1,40}', fields[0]) or not re.fullmatch('[0-9]{1,18}', fields[1]) or fields[0] in result:
            raise ValueError('EVENT_FORMAT')
        result[fields[0]] = int(fields[1])
    return result


def assess_experiment(stdout, returncode, unit_absent):
    try:
        if len(stdout) > MAX_BYTES:
            raise ValueError('OUTPUT_SIZE')
        frames = [json.loads(line) for line in stdout.splitlines()]
        if len(frames) != 3 or [frame['type'] for frame in frames] != ['before', 'fork', 'memory']:
            raise ValueError('THREE_FIXED_FRAMES_REQUIRED')
        before, fork, memory = frames
        limits = {'memory.max': '67108864', 'memory.swap.max': '0', 'pids.max': '16'}
        readback = all(frame['facts'][key] == value for frame in frames for key, value in limits.items())
        same_leaf = all(frame['facts']['membership'] == before['facts']['membership'] for frame in frames)
        fork_denied = fork['errno'] == errno.EAGAIN and 1 <= fork['children'] <= 15 and int(fork['facts']['pids.current']) <= 16
        pids_events = parse_events(fork['facts']['pids.events']).get('max', 0) > parse_events(before['facts']['pids.events']).get('max', 0)
        oom = parse_events(memory['facts']['memory.events']).get('oom_kill', 0) > parse_events(before['facts']['memory.events']).get('oom_kill', 0)
        checks = {'exactLimitReadback': readback, 'sameJobLeaf': same_leaf,
                  'forkDeniedAtLimit': fork_denied, 'pidsEventObserved': pids_events,
                  'oomKillObserved': oom and memory['childSignaled'] is True and memory['childSignal'] == 9,
                  'workerExitedZero': returncode == 0, 'ownedUnitCollected': unit_absent is True}
        boundary = before.get('boundary', {})
        boundary_denied = all(type(boundary.get(key)) is dict and boundary[key].get('writeOpenAllowed') is False
                              and boundary[key].get('errno') in (errno.EACCES, errno.EPERM, errno.EROFS)
                              and boundary[key].get('bytesWritten') == 0
                              for key in ('ownMemoryLimit', 'parentMigration'))
        return {'status': 'PASS' if all(checks.values()) else 'FAIL', 'checks': checks, 'frames': frames,
                'cgroupWriteOpenDenial': 'PASS' if boundary_denied else 'FAIL',
                'hostileEscapeResistance': 'NOT_VALIDATED'}
    except (ValueError, TypeError, KeyError):
        return {'status': 'FAIL', 'checks': {}, 'frames': None}


def experiment():
    discovered = discovery()
    if discovered['discoveryStatus'] != 'PASS':
        return discovered
    name = 'codex-resource-probe-' + uuid.uuid4().hex + '.service'
    env = fixed_environment()
    argv = ['/usr/bin/systemd-run', '--user', '--no-ask-password', '--quiet', '--wait', '--pipe', '--collect',
            '--unit=' + name, '--property=MemoryMax=64M', '--property=MemorySwapMax=0',
            '--property=TasksMax=16', '--property=RuntimeMaxSec=15', '--property=TimeoutStopSec=2',
            '--property=KillMode=control-group', '--property=NoNewPrivileges=yes',
            '--property=OOMPolicy=continue', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
            '/usr/bin/python3', '-I', '-B', SELF, '--worker']
    # Archive before dispatch. Exclusive create preserves every attempt.
    attempt = Path('/mnt/d/claude/Hackaton/scratch') / ('session7-systemd-attempt-' + name + '.json')
    with attempt.open('x', encoding='utf-8') as handle:
        json.dump({'unit': name, 'argv': argv, 'scope': 'fixed-synthetic-resources-only',
                   'productionReady': False, 'status': 'PRE_DISPATCH'}, handle, sort_keys=True)
    try:
        completed = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, timeout=25, check=False)
        output = completed.stdout.decode('utf-8', errors='strict')
        stderr = completed.stderr.decode('utf-8', errors='replace')[:4096]
        code = completed.returncode
    except subprocess.TimeoutExpired as error:
        # Fixed unit created by this invocation only; no wildcard/system stop.
        subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'stop', name], env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        output = (error.stdout or b'').decode('utf-8', errors='replace')[:MAX_BYTES]
        stderr = 'LOCAL_PROBE_TIMEOUT'
        code = None
    state = subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'show', name, '--property=LoadState'],
                           env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    leaf = '/sys/fs/cgroup/user.slice/user-' + str(os.getuid()) + '.slice/user@' + str(os.getuid()) + '.service/app.slice/' + name
    absent = state.returncode in (0, 1, 4) and state.stdout.strip() == b'LoadState=not-found' and not Path(leaf).exists()
    return {'kind': 'subscription-systemd-resource-experiment', 'version': 1,
            'productionReady': False, 'scope': 'fixed-synthetic-resources-only', 'unit': name,
            'argv': argv, 'discovery': discovered, 'returncode': code, 'stderr': stderr,
            'cleanup': {'unitQueryExitCode': state.returncode, 'unitQuery': state.stdout.decode('utf-8', errors='replace')[:4096],
                        'leaf': leaf, 'leafAbsent': not Path(leaf).exists(), 'verified': absent},
            'rawStdout': output, 'evaluation': assess_experiment(output, code, absent)}


def parse_properties(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > MAX_BYTES:
        raise ValueError('PROPERTY_SIZE')
    result = {}
    for line in text.splitlines():
        key, separator, value = line.partition('=')
        if not separator or key not in PROPERTIES or key in result or len(value) > 4096 or '\x00' in value:
            raise ValueError('PROPERTY_FORMAT')
        result[key] = value
    return result


def read_fixed(path):
    allowed = {'/proc/1/comm', '/proc/self/cgroup',
               '/sys/fs/cgroup/cgroup.controllers', '/sys/fs/cgroup/cgroup.subtree_control'}
    if path not in allowed:
        raise ValueError('FIXED_METADATA_ONLY')
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        value = os.read(fd, MAX_BYTES + 1)
        if len(value) > MAX_BYTES:
            raise ValueError('METADATA_SIZE')
        return value.decode('utf-8', errors='strict').strip()
    finally:
        os.close(fd)


def assess(facts):
    blockers = []
    if facts.get('pid1') != 'systemd' or facts.get('systemdRuntime') is not True:
        blockers.append('SYSTEMD_SYSTEM_MANAGER_NOT_OBSERVED')
    if facts.get('userBusSocket') is not True:
        blockers.append('USER_BUS_NOT_OBSERVED')
    if facts.get('userManagerQueryExitCode') != 0 or not facts.get('userManager', {}).get('Version'):
        blockers.append('USER_MANAGER_NOT_REACHABLE')
    if not {'memory', 'pids'}.issubset(facts.get('controllers', [])):
        blockers.append('ROOT_MEMORY_PIDS_CONTROLLERS_NOT_OBSERVED')
    return {'kind': 'subscription-systemd-resource-discovery', 'version': 1,
            'discoveryStatus': 'FAIL' if blockers else 'PASS',
            'productionReady': False, 'enforcementStatus': 'NOT_RUN',
            'blockers': blockers, 'facts': facts}


def discovery():
    if sys.platform != 'linux':
        raise ValueError('LINUX_REQUIRED')
    uid = os.getuid()
    runtime = '/run/user/' + str(uid)
    try:
        bus_socket = stat.S_ISSOCK(os.stat(runtime + '/bus', follow_symlinks=False).st_mode)
    except FileNotFoundError:
        bus_socket = False
    facts = {'uid': uid, 'pid1': read_fixed('/proc/1/comm'),
             'systemdRuntime': Path('/run/systemd/system').is_dir(),
             'userBusSocket': bus_socket, 'membership': read_fixed('/proc/self/cgroup'),
             'controllers': read_fixed('/sys/fs/cgroup/cgroup.controllers').split(),
             'subtreeControl': read_fixed('/sys/fs/cgroup/cgroup.subtree_control').split(),
             'userManagerQueryExitCode': None, 'userManager': None,
             'appSliceQueryExitCode': None, 'appSlice': None}
    # Explicit environment; never inherit or print credential-bearing values.
    env = fixed_environment()
    if bus_socket:
        for key, unit, properties in (
                ('userManager', [], ['Version', 'SystemState']),
                ('appSlice', ['app.slice'], ['ControlGroup', 'LoadState', 'ActiveState', 'MemoryAccounting', 'TasksAccounting'])):
            # systemctl show is read-only; output is bounded in a temporary
            # pipe by communicate only after a short timeout. Fixed properties
            # have bounded manager-generated values; reject oversized output.
            completed = subprocess.run(['/usr/bin/systemctl', '--user', '--no-pager', '--no-ask-password',
                                        'show', *unit, *['--property=' + p for p in properties]],
                                       env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, timeout=5, check=False)
            facts[key + 'QueryExitCode'] = completed.returncode
            facts[key] = parse_properties(completed.stdout.decode('utf-8', errors='strict'))
    return assess(facts)


def main():
    try:
        if sys.argv[1:] == ['--worker']:
            return worker()
        if sys.argv[1:] == ['--run']:
            result = experiment()
        elif len(sys.argv) != 1:
            raise ValueError('NO_ARGUMENTS_ALLOWED')
        else:
            result = discovery()
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        result = {'kind': 'subscription-systemd-resource-discovery', 'version': 1,
                  'discoveryStatus': 'FAIL', 'productionReady': False,
                  'enforcementStatus': 'NOT_RUN',
                  'blockers': [str(error) if isinstance(error, ValueError) else type(error).__name__], 'facts': None}
    print(json.dumps(result, sort_keys=True))
    if result.get('kind') == 'subscription-systemd-resource-experiment':
        report = Path('/mnt/d/claude/Hackaton/scratch') / ('session7-systemd-result-' + result['unit'] + '.json')
        with report.open('x', encoding='utf-8') as handle:
            json.dump(result, handle, sort_keys=True)
    return 0 if result.get('evaluation', {}).get('status', result.get('discoveryStatus')) == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
