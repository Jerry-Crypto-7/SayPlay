"""Fixed credential-free CLI capsule in an owned systemd resource unit.

Linux host driver. No caller-supplied command, resource budget or unit name.
The 2GiB/64-task envelope is candidate synthetic configuration, not production.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path('/mnt/d/claude/Hackaton')
SCENARIOS = ('version', 'private-sentinel', 'stopped-cli', 'worker-boundary', 'appserver-noenv')
CAPSULE = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/timeout',
           '--signal=TERM', '--kill-after=5', '200', '/usr/bin/unshare', '--user',
           '--map-current-user', '--keep-caps', '--mount', '--net', '--pid', '--uts', '--fork',
           '/bin/sh', str(ROOT / 'scripts/subscription-cli-supervisor.sh')]
SOURCES = ('subscription-systemd-cli-probe.py', 'subscription-cli-supervisor.py',
           'subscription-cli-supervisor.sh', 'subscription-cli-supervisor-child.py',
           'subscription-cli-supervisor.measure.py', 'subscription-runtime-probe.py',
           'subscription-runtime-child-probe.py', 'subscription-worker-lockdown.py',
           'subscription-worker-boundary-child.py', 'subscription-worker-boundary.py', 'subscription-appserver-noenv.py',
           'subscription-text-model-catalog.json', 'subscription-appserver-fixture-child.py')


def hashes():
    return {name: hashlib.sha256((ROOT / 'scripts' / name).read_bytes()).hexdigest() for name in SOURCES}


def environment():
    runtime = '/run/user/' + str(os.getuid())
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'XDG_RUNTIME_DIR': runtime,
            'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus', 'SYSTEMD_PAGER': 'cat'}


def leaf_path(unit):
    if not re.fullmatch(r'codex-cli-resource-[a-f0-9]{32}\.service', unit):
        raise ValueError('OWN_UNIQUE_UNIT_REQUIRED')
    uid = str(os.getuid())
    return '/sys/fs/cgroup/user.slice/user-' + uid + '.slice/user@' + uid + '.service/app.slice/' + unit


def readback(unit):
    path = leaf_path(unit)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open('/', flags)
    try:
        for part in path.lstrip('/').split('/'):
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        facts = {'leaf': path}
        for name in ('memory.max', 'memory.swap.max', 'pids.max', 'memory.events',
                     'pids.events', 'cgroup.events', 'cgroup.procs', 'memory.current', 'pids.current'):
            child = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=fd)
            try:
                value = os.read(child, 4097)
                if len(value) > 4096:
                    raise ValueError('OWN_LEAF_METADATA_LIMIT')
                facts[name] = value.decode('ascii').strip()
            finally:
                os.close(child)
        return facts
    finally:
        os.close(fd)


def evaluate_resources(samples, absent, unit):
    try:
        expected = leaf_path(unit)
        checks = {'beforeDispatchReadback': any(s['phase'] == 'ready-before-start' for s in samples),
                  'exactCandidateLimits': bool(samples) and all(s['facts']['memory.max'] == '2147483648'
                      and s['facts']['memory.swap.max'] == '0' and s['facts']['pids.max'] == '64'
                      and s['facts']['leaf'] == expected for s in samples),
                  'ownedLeafRemoved': absent is True}
        return {'status': 'PASS' if all(checks.values()) else 'FAIL', 'checks': checks}
    except (KeyError, TypeError, ValueError):
        return {'status': 'FAIL', 'checks': {}}


def dispatch_after_readback(unit, facts, scenario, send, worker_frame=None):
    """Fail before child dispatch if the current own leaf lacks exact limits."""
    if scenario not in SCENARIOS or type(facts) is not dict or any(
            facts.get(key) != value for key, value in {
                'leaf': leaf_path(unit), 'memory.max': '2147483648',
                'memory.swap.max': '0', 'pids.max': '64'}.items()):
        raise ValueError('PRE_DISPATCH_RESOURCE_READBACK_MISMATCH')
    if scenario in ('worker-boundary', 'appserver-noenv'):
        if type(worker_frame) is not dict or worker_frame.get('type') != 'start' or worker_frame.get('mode') != scenario or set(worker_frame) != {'type', 'mode', 'helperSha256'}:
            raise ValueError('WORKER_IMAGE_BOUND_START_REQUIRED')
        send(worker_frame)
    else:
        send({'type': 'start', 'mode': scenario})


def run(scenario):
    if sys.platform != 'linux' or scenario not in SCENARIOS:
        raise ValueError('FIXED_LINUX_SCENARIO_REQUIRED')
    spec = importlib.util.spec_from_file_location('capsule_measure', ROOT / 'scripts/subscription-cli-supervisor.measure.py')
    capsule = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capsule)
    unit = 'codex-cli-resource-' + uuid.uuid4().hex + '.service'
    argv = ['/usr/bin/systemd-run', '--user', '--no-ask-password', '--quiet', '--wait', '--pipe', '--collect',
            '--unit=' + unit, '--property=MemoryMax=2G', '--property=MemorySwapMax=0', '--property=TasksMax=64',
            '--property=RuntimeMaxSec=220', '--property=TimeoutStopSec=5', '--property=KillMode=control-group',
            '--property=WorkingDirectory=/', *CAPSULE]
    before = hashes()
    artifact = ROOT / 'scratch' / ('session8-systemd-cli-' + scenario + '-' + unit + '.json')
    report = {'kind': 'subscription-systemd-cli-candidate-probe', 'version': 1, 'scenario': scenario,
              'unit': unit, 'argv': argv, 'sourceSha256Before': before, 'state': 'PRE_DISPATCH',
              'productionReady': False, 'productionAuth': 'NOT_RUN', 'productionNetwork': 'NOT_RUN',
              'productionCleanup': 'NOT_RUN', 'candidateMemoryBytes': 2147483648, 'candidateTasks': 64,
              'guardianCeilingSeconds': 220, 'unchangedCommandDeadlineSeconds': 200}
    with artifact.open('x', encoding='utf-8') as handle:
        json.dump(report, handle, indent=2)
    proc = subprocess.Popen(argv, env=environment(), cwd='/', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frames, samples, errors = [], [], []
    outgoing = queue.Queue(maxsize=4)
    stop = threading.Event()
    ready = threading.Event()
    fixture = threading.Event()
    stderr = bytearray()

    def send(frame):
        try:
            outgoing.put_nowait(frame)
        except queue.Full:
            errors.append('CONTROL_QUEUE_FULL')

    def writer():
        while not stop.is_set():
            try:
                frame = outgoing.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                proc.stdin.write((json.dumps(frame) + '\n').encode())
                proc.stdin.flush()
            except (OSError, ValueError):
                return

    def reader():
        size = 0
        while True:
            line = proc.stdout.readline(65537)
            if not line:
                return
            size += len(line)
            if len(line) > 65536 or size > 16 * 1024 * 1024:
                errors.append('OUTPUT_LIMIT')
                return
            try:
                frame = json.loads(line)
                if not isinstance(frame, dict):
                    raise ValueError('FRAME_OBJECT_REQUIRED')
                frames.append(frame)
                if frame.get('type') == 'ready':
                    if not capsule.validate_uts_ready(frame):
                        raise ValueError('UTS_PRE_DISPATCH_READBACK_MISMATCH')
                    facts = readback(unit)
                    samples.append({'phase': 'ready-before-start', 'facts': facts})
                    bound_start = (capsule.worker_start(frame, before) if scenario == 'worker-boundary' else
                                   capsule.appserver_start(frame, before) if scenario == 'appserver-noenv' else None)
                    dispatch_after_readback(unit, facts, scenario, send, bound_start)
                    ready.set()
                if frame.get('type') == 'fixture_ready':
                    samples.append({'phase': 'fixture-ready', 'facts': readback(unit)})
                    fixture.set()
            except (ValueError, OSError, KeyError) as error:
                errors.append(type(error).__name__)
                return

    def error_reader():
        while True:
            block = proc.stderr.read(4096)
            if not block:
                return
            if len(stderr) + len(block) > 65536:
                errors.append('STDERR_LIMIT')
                return
            stderr.extend(block)

    threads = [threading.Thread(target=fn, daemon=True) for fn in (writer, reader, error_reader)]
    for thread in threads:
        thread.start()
    began = time.monotonic()
    heartbeat = began
    cancelled = False
    timed_out = False
    while proc.poll() is None:
        now = time.monotonic()
        if ready.is_set() and now - heartbeat >= 0.5:
            send({'type': 'heartbeat'})
            heartbeat = now
        if scenario == 'stopped-cli' and fixture.is_set() and not cancelled:
            send({'type': 'cancel'})
            cancelled = True
        if now - began > 230:
            timed_out = True
            # Stop only this invocation's exact transient unit; never a glob.
            subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'stop', unit], env=environment(),
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False)
            break
        time.sleep(0.02)
    proc.wait(timeout=8)
    stop.set()
    for thread in threads:
        thread.join(timeout=1)
    if any(thread.is_alive() for thread in threads):
        errors.append('THREADS_NOT_FINISHED')
    state = subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'show', unit, '--property=LoadState'],
                           env=environment(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    absent = state.returncode in (0, 1, 4) and state.stdout.strip() == b'LoadState=not-found' and not Path(leaf_path(unit)).exists()
    terminals = [f for f in frames if f.get('type') == 'terminal']
    report.update(state='FINISHED', sourceSha256After=hashes(), exitCode=proc.returncode,
                  frames=frames, errors=errors, terminal=terminals[0] if len(terminals) == 1 else None,
                  resourceSamples=samples, cleanup={'unitQuery': state.stdout.decode(errors='replace'),
                  'leafAbsent': not Path(leaf_path(unit)).exists(), 'verified': absent},
                  driverTimeout=timed_out, stderr=stderr.decode(errors='replace'), elapsedMs=round((time.monotonic() - began) * 1000))
    report.update(capsule.transcript_check(frames, report['terminal']))
    report['capsuleScenarioPassed'] = capsule.evaluate(scenario, report)
    report['resourceEvaluation'] = evaluate_resources(samples, absent, unit)
    report['scenarioPassed'] = report['capsuleScenarioPassed'] and report['resourceEvaluation']['status'] == 'PASS'
    artifact.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'artifact': str(artifact), 'scenarioPassed': report['scenarioPassed'],
                      'capsuleScenarioPassed': report['capsuleScenarioPassed'], 'resourceEvaluation': report['resourceEvaluation'],
                      'cleanup': report['cleanup'], 'errors': errors, 'stderr': report['stderr']}))
    return report['scenarioPassed']


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in SCENARIOS:
        raise SystemExit('Expected one fixed scenario: ' + ', '.join(SCENARIOS))
    raise SystemExit(0 if run(sys.argv[1]) else 1)
