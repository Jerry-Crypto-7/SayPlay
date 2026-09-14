"""Fixed Linux host driver; one owned resource unit, no credentials or arguments."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path('/mnt/d/claude/Hackaton')
SOURCES = (
    'subscription-tool-capture.measure.py', 'subscription-tool-capture-capsule.sh',
    'subscription-tool-capture-runner.py', 'subscription-tool-capture-harness.py',
    'subscription-tool-capture-http.py', 'subscription-exec-request-capture.py',
    'subscription-cli-supervisor.py', 'subscription-runtime-probe.py',
    'subscription-text-model-catalog.json')
LIMIT = 32 * 1024 * 1024
RUNTIME_SOURCES = {'runner': 'subscription-tool-capture-runner.py',
    'harness': 'subscription-tool-capture-harness.py', 'http': 'subscription-tool-capture-http.py',
    'capture': 'subscription-exec-request-capture.py', 'probe': 'subscription-runtime-probe.py',
    'supervisor': 'subscription-cli-supervisor.py', 'catalog': 'subscription-text-model-catalog.json'}


def valid_terminal(value, source_hashes):
    try:
        expected = {key: source_hashes[name] for key, name in RUNTIME_SOURCES.items()}
        return (type(value) is dict and value.get('passed') is True and value.get('error') is None
            and value.get('sourceSha256') == expected
            and value.get('binarySha256') == {
                'codex': 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
                'bwrap': '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'}
            and value['controller']['turnCompleted'] is True
            and value['controller']['failed'] is False and value['peer']['complete'] is True
            and value['peer']['failed'] is False and value['capture']['report']['captureComplete'] is True
            and value['streamEOF'] == {'stdout': True, 'stderr': True}
            and value['cleanup']['namespaceEmpty'] is True
            and value['cleanup']['allObservedPidfdsESRCH'] is True and not value['cleanup']['errors'])
    except (KeyError, TypeError):
        return False


def hashes():
    return {name: hashlib.sha256((ROOT / 'scripts' / name).read_bytes()).hexdigest()
            for name in SOURCES}


def environment():
    runtime = '/run/user/' + str(os.getuid())
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
        'XDG_RUNTIME_DIR': runtime, 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus',
        'SYSTEMD_PAGER': 'cat'}


def command(unit):
    return ['/usr/bin/systemd-run', '--user', '--quiet', '--wait', '--pipe', '--collect',
        '--unit=' + unit, '--property=MemoryMax=2G', '--property=MemorySwapMax=0',
        '--property=TasksMax=64', '--property=RuntimeMaxSec=180', '--property=TimeoutStopSec=5',
        '--property=KillMode=control-group', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
        '/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '170',
        '/usr/bin/unshare', '--user', '--map-current-user', '--keep-caps', '--mount',
        '--net', '--pid', '--uts', '--fork', '/bin/sh',
        str(ROOT / 'scripts/subscription-tool-capture-capsule.sh')]


def close_process(process):
    error = None
    try:
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        error = 'OWN_DRIVER_PROCESS_CLEANUP_UNKNOWN'
    finally:
        for pipe in (process.stdout, process.stderr):
            try:
                pipe.close()
            except OSError:
                error = error or 'OWN_DRIVER_PIPE_CLOSE_UNKNOWN'
    return error


def run():
    if sys.platform != 'linux' or sys.argv[1:]:
        raise ValueError('FIXED_LINUX_DRIVER_REQUIRED')
    identifier = uuid.uuid4().hex
    unit = 'codex-tool-capture-' + identifier + '.service'
    prefix = ROOT / 'scratch' / ('continuation-tool-capture-actual-' + identifier)
    before = hashes()
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    eof = {'stdout': False, 'stderr': False}
    error = None
    process = None
    selector = selectors.DefaultSelector()
    began = time.monotonic()
    unit_absent = False
    try:
        process = subprocess.Popen(command(unit), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment(),
            close_fds=True, start_new_session=True, bufsize=0)
        for name in buffers:
            pipe = getattr(process, name)
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, name)
        while selector.get_map():
            if time.monotonic() - began >= 190:
                raise ValueError('OUTER_CAPTURE_DEADLINE')
            for key, _ in selector.select(0.1):
                raw = os.read(key.fd, 65536)
                if not raw:
                    eof[key.data] = True
                    selector.unregister(key.fileobj)
                else:
                    buffers[key.data].extend(raw)
                    if sum(map(len, buffers.values())) > LIMIT:
                        raise ValueError('OUTER_CAPTURE_OUTPUT_BOUND')
        if process.wait(timeout=3) != 0:
            error = 'CAPTURE_PROCESS_FAILED'
    except (OSError, ValueError, subprocess.TimeoutExpired) as failure:
        error = type(failure).__name__ + ':' + str(failure)[:256]
    finally:
        # Stop only this invocation's UUID unit. Never enumerate or stop other units.
        try:
            stop = subprocess.run(['/usr/bin/systemctl', '--user', 'stop', unit],
                env=environment(), capture_output=True, timeout=10)
            state = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit,
                '--property=LoadState', '--value'], env=environment(), capture_output=True, timeout=5)
            unit_absent = state.stdout.strip() == b'not-found'
        except (OSError, subprocess.TimeoutExpired):
            error = error or 'OWN_UNIT_CLEANUP_UNKNOWN'
        if process is not None:
            close_error = close_process(process)
            error = error or close_error
        try:
            selector.close()
        except OSError:
            error = error or 'OWN_DRIVER_SELECTOR_CLOSE_UNKNOWN'
    after = hashes()
    terminal = None
    try:
        terminal = json.loads(bytes(buffers['stdout']).decode())
    except (ValueError, UnicodeError):
        error = error or 'TERMINAL_JSON_MISSING'
    passed = (error is None and before == after and all(eof.values()) and unit_absent
              and valid_terminal(terminal, before))
    paths = {}
    for name, raw in buffers.items():
        path = str(prefix) + '.' + name + '.bin'
        with open(path, 'xb') as stream:
            stream.write(raw)
        paths[name] = {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    report = {'kind': 'fixed-stock-client-capture-measure', 'passed': passed, 'error': error,
        'unit': unit, 'ownUnitAbsent': unit_absent, 'streamEOF': eof,
        'sourceSha256Before': before, 'sourceSha256After': after,
        'command': command(unit), 'elapsedMs': round((time.monotonic() - began) * 1000),
        'artifacts': paths, 'terminalPassed': terminal.get('passed') if type(terminal) is dict else None,
        'terminalError': terminal.get('error') if type(terminal) is dict else None,
        'resourceLimitsRequested': {'MemoryMax': '2G', 'MemorySwapMax': 0, 'TasksMax': 64},
        'resourceReadbackAttested': False, 'inferenceAttested': False, 'productionReady': False}
    path = str(prefix) + '.json'
    with open(path, 'x', encoding='utf-8') as stream:
        json.dump(report, stream, separators=(',', ':'), allow_nan=False)
    print(json.dumps({'passed': passed, 'report': path, 'error': error,
                      'terminalError': report['terminalError']}))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(run())
