"""Fixed WSL capsule measurement. No auth, caller commands or model inference.

Run from the repository root with Python -B and one named synthetic scenario.
Every attempt has a unique artifact; stdout persistence is outside the PID1 loop.
"""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid

ENVIRONMENT_MODES = ('exec-environment-metadata', 'exec-environment-bootstrap-metadata', 'exec-environment-bootstrap-controlled')
SCENARIOS = ('version', 'private-sentinel', 'cancel', 'eof', 'lease', 'partial-setup', 'flood', 'deadline', 'stopped-cli', 'paced-output', 'worker-boundary', 'appserver-noenv', *ENVIRONMENT_MODES)
SOURCES = ('scripts/subscription-cli-supervisor.py', 'scripts/subscription-cli-supervisor.sh',
           'scripts/subscription-cli-supervisor-child.py', 'scripts/subscription-runtime-probe.py',
           'scripts/subscription-runtime-child-probe.py', 'scripts/subscription-cli-supervisor.measure.py',
           'scripts/subscription-worker-lockdown.py', 'scripts/subscription-worker-boundary-child.py', 'scripts/subscription-worker-boundary.py',
           'scripts/subscription-appserver-noenv.py', 'scripts/subscription-text-model-catalog.json',
           'scripts/subscription-appserver-fixture-child.py', 'scripts/subscription-appserver-metadata-pipe-child.py',
           'scripts/subscription-exec-server-worker-gate.py', 'scripts/subscription-exec-server-worker-trampoline.py',
           'scripts/subscription-exec-worker-probe.py', 'scripts/subscription-exec-environment-metadata-parent.py',
           'scripts/subscription-trusted-control-boundary-parent.py',
    'scripts/subscription-trusted-ingress-child.py', 'scripts/subscription-trusted-ingress-worker-probe.py', 'scripts/subscription-trusted-control-boundary-probe.py')
ENVIRONMENT_HELPERS = ('subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py', 'subscription-appserver-noenv.py',
    'subscription-text-model-catalog.json', 'subscription-exec-environment-metadata-parent.py')
COMMAND = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
           '/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '200', '/usr/bin/unshare',
           '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--pid', '--uts', '--fork',
           '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh']


def source_hashes():
    return {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in SOURCES}


def validate_uts_ready(ready):
    boundary = ready.get('utsBoundary') if type(ready) is dict else None
    return (type(boundary) is dict and set(boundary) == {'hostname', 'namespace'}
            and boundary['hostname'] == 'reality-compiler-probe'
            and type(boundary['namespace']) is str
            and re.fullmatch(r'uts:\[[1-9][0-9]*\]', boundary['namespace']) is not None)


def worker_start(ready, before):
    names = ('subscription-worker-lockdown.py', 'subscription-worker-boundary-child.py')
    expected = {name: before.get('scripts/' + name, before.get(name)) for name in names}
    if any(not isinstance(v, str) or len(v) != 64 for v in expected.values()) or ready.get('workerBoundary', {}).get('helperSha256') != expected:
        raise ValueError('WORKER_PRE_DISPATCH_IMAGE_MISMATCH')
    return {'type': 'start', 'mode': 'worker-boundary', 'helperSha256': expected}


def worker_evaluation(report):
    try:
        ready = [f for f in report['frames'] if f.get('type') == 'ready']
        if len(ready) != 1:
            return False
        worker_start(ready[0], report['sourceSha256Before'])
        body = b''.join(base64.b64decode(f['data'], validate=True) for f in report['frames'] if f.get('type') == 'child_output' and f.get('stream') == 'stdout')
        if len(body) > 131072 or any(f.get('type') == 'child_output' and f.get('stream') == 'stderr' for f in report['frames']):
            return False
        spec = importlib.util.spec_from_file_location('worker_validator', Path(__file__).with_name('subscription-worker-boundary.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.validate_worker_report(json.loads(body), ready[0]['workerBoundary'])
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def appserver_start(ready, before):
    names = ('subscription-appserver-noenv.py', 'subscription-text-model-catalog.json')
    expected = {name: before.get('scripts/' + name, before.get(name)) for name in names}
    if any(type(v) is not str or re.fullmatch(r'[a-f0-9]{64}', v) is None for v in expected.values()) or ready.get('appServerBoundary', {}).get('helperSha256') != expected:
        raise ValueError('APPSERVER_PRE_DISPATCH_IMAGE_MISMATCH')
    return {'type': 'start', 'mode': 'appserver-noenv', 'helperSha256': expected}


def appserver_evaluation(report):
    try:
        ready = [f for f in report['frames'] if f.get('type') == 'ready']
        if len(ready) != 1:
            return False
        bound_start = appserver_start(ready[0], report['sourceSha256Before'])
        validator_path = Path(__file__).with_name('subscription-appserver-noenv.py')
        validator_source = validator_path.read_bytes()
        if hashlib.sha256(validator_source).hexdigest() != bound_start['helperSha256']['subscription-appserver-noenv.py']:
            return False
        catalog_source = Path(__file__).with_name('subscription-text-model-catalog.json').read_bytes()
        if hashlib.sha256(catalog_source).hexdigest() != bound_start['helperSha256']['subscription-text-model-catalog.json']:
            return False
        body = b''.join(base64.b64decode(f['data'], validate=True) for f in report['frames'] if f.get('type') == 'child_output' and f.get('stream') == 'stdout')
        # Metadata report contains both bounded base64 raw and parsed history.
        # This serialization cap is separate from the 128KiB app-server streams.
        if len(body) > 2 * 1024 * 1024 or any(f.get('type') == 'child_output' and f.get('stream') == 'stderr' for f in report['frames']):
            return False
        spec = importlib.util.spec_from_file_location('appserver_validator', validator_path)
        module = importlib.util.module_from_spec(spec)
        # Execute exactly the bytes whose identity was checked. A second file
        # read by the loader could race a workspace edit during offline replay.
        exec(compile(validator_source, str(validator_path), 'exec'), module.__dict__)
        return module.validate_report(json.loads(body))
    except (ValueError, KeyError, TypeError, AttributeError, OSError):
        return False



def environment_start(ready, before, mode='exec-environment-metadata'):
    if mode not in ENVIRONMENT_MODES:
        raise ValueError('FIXED_ENVIRONMENT_MODE_REQUIRED')
    expected = {name: before.get('scripts/' + name, before.get(name)) for name in ENVIRONMENT_HELPERS}
    boundary = ready.get('execEnvironmentMetadataBoundary') if type(ready) is dict else None
    if (any(type(value) is not str or re.fullmatch('[a-f0-9]{64}', value) is None for value in expected.values())
            or type(boundary) is not dict or set(boundary) != {'helperSha256'} or boundary['helperSha256'] != expected):
        raise ValueError('EXEC_ENVIRONMENT_PRE_DISPATCH_IMAGE_MISMATCH')
    return {'type': 'start', 'mode': mode, 'helperSha256': expected}


def environment_evaluation(report):
    try:
        ready = [frame for frame in report['frames'] if type(frame) is dict and frame.get('type') == 'ready']
        if len(ready) != 1: return False
        mode = report.get('scenario')
        hashes = environment_start(ready[0], report['sourceSha256Before'], mode)['helperSha256']
        sources = {}
        for name in ENVIRONMENT_HELPERS:
            source = Path(__file__).with_name(name).read_bytes()
            if hashlib.sha256(source).hexdigest() != hashes[name]: return False
            sources[name] = source
        body = bytearray()
        for frame in report['frames']:
            if type(frame) is not dict: return False
            if frame.get('type') != 'child_output': continue
            if frame.get('stream') != 'stdout' or frame.get('encoding') != 'base64': return False
            chunk = base64.b64decode(frame['data'], validate=True)
            if len(body) + len(chunk) > 2 * 1024 * 1024: return False
            body.extend(chunk)
        def load(name):
            path = Path(__file__).with_name(name)
            spec = importlib.util.spec_from_file_location('environment_measure_' + name.replace('-', '_'), path)
            module = importlib.util.module_from_spec(spec)
            exec(compile(sources[name], str(path), 'exec'), module.__dict__)
            return module
        parent = load('subscription-exec-environment-metadata-parent.py')
        policy = load('subscription-appserver-noenv.py')
        gate = load('subscription-exec-server-worker-gate.py')
        parsed = gate.strict_json(bytes(body))
        if parsed.get('helperSha256Before') != hashes or parsed.get('helperSha256After') != hashes: return False
        validator = (parent.validate_controlled_bootstrap_report if mode == 'exec-environment-bootstrap-controlled' else
            parent.validate_bootstrap_report if mode == 'exec-environment-bootstrap-metadata' else parent.validate_report)
        return validator(parsed, policy, gate) is True
    except (ValueError, KeyError, TypeError, AttributeError, OSError, RecursionError):
        return False


def transcript_check(frames, terminal):
    total = 0
    digest = hashlib.sha256()
    try:
        for frame in frames:
            if frame.get('type') == 'child_output':
                if frame.get('encoding') != 'base64' or frame.get('stream') not in ('stdout', 'stderr'):
                    raise ValueError('INVALID_CHILD_OUTPUT')
                block = base64.b64decode(frame['data'], validate=True)
                total += len(block)
                digest.update(block)
        complete = bool(terminal and terminal.get('outputComplete') is True and
                        terminal.get('outputBytes') == total and terminal.get('observedOutputSha256') == digest.hexdigest())
    except (ValueError, KeyError, TypeError):
        complete = False
    return {'receivedOutputBytes': total, 'receivedOutputSha256': digest.hexdigest(), 'transcriptIntegrity': complete}


def evaluate(scenario, report):
    terminal = report.get('terminal')
    if scenario in ENVIRONMENT_MODES and (type(terminal) is not dict
            or type(terminal.get('cleanup')) is not dict or type(report.get('frames')) is not list
            or any(type(frame) is not dict for frame in report['frames'])): return False
    if not terminal or report['sourceSha256Before'] != report['sourceSha256After'] or report['errors'] or report['driverTimeout']:
        return False
    ready = [frame for frame in report.get('frames', []) if type(frame) is dict and frame.get('type') == 'ready']
    if len(ready) != 1 or not validate_uts_ready(ready[0]):
        return False
    if not terminal.get('cleanup', {}).get('verified') or not terminal.get('outputComplete'):
        return False
    if terminal.get('productionReady') is not False or terminal.get('modelCalls') != 0:
        return False
    expected = {'version': ('EXITED',), 'private-sentinel': ('EXITED',), 'cancel': ('CANCELLED',),
                'eof': ('CONTROL_EOF',), 'lease': ('LEASE_EXPIRED',), 'partial-setup': ('CONTROL_OR_SETUP_ERROR',),
                'flood': ('OUTPUT_LIMIT', 'OUTPUT_BACKPRESSURE'), 'deadline': ('JOB_DEADLINE',), 'stopped-cli': ('CANCELLED',), 'paced-output': ('OUTPUT_LIMIT',), 'worker-boundary': ('EXITED',), 'appserver-noenv': ('EXITED',), **{mode: ('EXITED',) for mode in ENVIRONMENT_MODES}}
    if scenario not in ('flood', 'paced-output') and report.get('transcriptIntegrity') is not True:
        return False
    if scenario == 'worker-boundary' and (terminal['exitCode'] != 0 or not worker_evaluation(report)):
        return False
    if scenario == 'appserver-noenv' and (terminal['exitCode'] != 0 or not appserver_evaluation(report)):
        return False
    if scenario in ENVIRONMENT_MODES:
        cleanup = terminal.get('cleanup', {})
        starts = [frame for frame in report['frames'] if frame.get('type') == 'started']
        terminals = [frame for frame in report['frames'] if frame.get('type') == 'terminal']
        if (len(starts) != 1 or starts[0].get('mode') != scenario or terminals != [terminal]
                or report.get('scenario') != scenario or report.get('stderr') != ''
                or terminal.get('credentialFilesRead') is not False or terminal.get('registryOverflow') is not False
                or type(terminal.get('streamEOF')) is not dict or set(terminal['streamEOF']) != {'stdout', 'stderr'}
                or any(value is not True for value in terminal['streamEOF'].values()) or terminal.get('outputLimitExceeded') is not False
                or terminal.get('mode') != scenario or type(terminal.get('exitCode')) is not int or terminal['exitCode'] != 0
                or type(report.get('exitCode')) is not int or report['exitCode'] != 0
                or type(terminal.get('modelCalls')) is not int or terminal['modelCalls'] != 0
                or cleanup.get('verified') is not True or cleanup.get('namespaceEmpty') is not True
                or cleanup.get('allObservedPidfdsESRCH') is not True or cleanup.get('signalFailures') != []
                or type(cleanup.get('observedPidfds')) is not int or cleanup['observedPidfds'] < 1
                or transcript_check(report['frames'], terminal)['transcriptIntegrity'] is not True
                or not environment_evaluation(report)): return False
    if terminal['reason'] not in expected[scenario]:
        return False
    if scenario == 'stopped-cli':
        fixture = terminal.get('fixture')
        if not isinstance(fixture, dict) or fixture.get('kind') != 'owned-cli-stopped' or fixture.get('state') != 'T' or fixture.get('executable') != '/usr/bin/codex' or fixture.get('signal') != 'SIGSTOP':
            return False
        if terminal.get('terminationElapsedMs', 0) < 5000 or terminal['cleanup'].get('killSent') is not True or terminal['exitCode'] != -9:
            return False
    if scenario == 'paced-output':
        if terminal.get('outputLimitExceeded') is not True or terminal.get('outputBytes', 0) <= 8 * 1024 * 1024:
            return False
        if report.get('receivedOutputBytes', 8 * 1024 * 1024 + 1) > 8 * 1024 * 1024 or report.get('transcriptIntegrity') is not False:
            return False
    if scenario == 'deadline' and terminal.get('elapsedMs', 0) < 180000:
        return False
    if scenario in ('version', 'private-sentinel') and terminal['exitCode'] != 0:
        return False
    if scenario == 'private-sentinel':
        checks = terminal.get('privateChecks')
        if not isinstance(checks, dict) or len(checks) != 8 or not all(value is True for value in checks.values()):
            return False
    return report['exitCode'] in ((1,) if scenario == 'paced-output' else (0, 1) if scenario == 'flood' else (0,))


def measure(scenario):
    if scenario not in SCENARIOS:
        raise ValueError('FIXED_SCENARIO_REQUIRED')
    mode = {'cancel': 'setsid', 'eof': 'setsid', 'lease': 'setsid', 'deadline': 'sleep'}.get(scenario, scenario)
    before = source_hashes()
    frames, errors = [], []
    started = threading.Event()
    fixture_ready = threading.Event()
    stop = threading.Event()
    outgoing = queue.Queue(maxsize=4)
    artifact = Path('scratch') / ('session8-cli-' + scenario + '-measure-' + str(uuid.uuid4()) + '.json')
    prepared = {'version': 1, 'scenario': scenario, 'command': COMMAND, 'sourceSha256Before': before,
                'state': 'PREPARED', 'scenarioPassed': False, 'cleanupStatus': 'UNKNOWN', 'productionReady': False}
    artifact.write_text(json.dumps(prepared, indent=2), encoding='utf-8')
    try:
        proc = subprocess.Popen(COMMAND, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        prepared.update(state='SPAWN_FAILED', error=str(error))
        artifact.write_text(json.dumps(prepared, indent=2), encoding='utf-8')
        print(json.dumps({'artifact': str(artifact), 'scenarioPassed': False, 'error': str(error)}))
        return False

    def enqueue(frame):
        try:
            outgoing.put_nowait(frame)
        except queue.Full:
            if len(errors) < 32:
                errors.append('CONTROL_WRITER_BACKPRESSURE')

    def writer():
        while not stop.is_set():
            try:
                frame = outgoing.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                if frame is None:
                    proc.stdin.close()
                    return
                proc.stdin.write((json.dumps(frame) + '\n').encode())
                proc.stdin.flush()
            except (BrokenPipeError, OSError):
                return

    def reader():
        count = 0
        try:
            while True:
                line = proc.stdout.readline(65537)
                if not line:
                    return
                count += len(line)
                if len(line) > 65536 or count > 16 * 1024 * 1024:
                    errors.append('REPORT_READER_LIMIT')
                    return
                try:
                    frame = json.loads(line)
                    if not isinstance(frame, dict):
                        raise ValueError('INVALID_FRAME')
                except (ValueError, UnicodeError):
                    if len(errors) < 32:
                        errors.append({'invalidFramePrefixHex': line[:1024].hex()})
                    continue
                frames.append(frame)
                if frame.get('type') == 'ready':
                    try:
                        if not validate_uts_ready(frame):
                            raise ValueError('UTS_PRE_DISPATCH_READBACK_MISMATCH')
                        if mode in ENVIRONMENT_MODES and len([item for item in frames if item.get('type') == 'ready']) != 1:
                            raise ValueError('EXEC_ENVIRONMENT_DUPLICATE_READY')
                        enqueue(worker_start(frame, before) if mode == 'worker-boundary' else
                                appserver_start(frame, before) if mode == 'appserver-noenv' else
                                environment_start(frame, before) if mode == 'exec-environment-metadata' else
                                environment_start(frame, before, mode) if mode in ENVIRONMENT_MODES else {'type': 'start', 'mode': mode})
                    except ValueError as error:
                        errors.append(str(error))
                        enqueue({'type': 'cancel'})
                if frame.get('type') == 'started':
                    started.set()
                if frame.get('type') == 'fixture_ready' and frame.get('kind') == 'owned-cli-stopped':
                    fixture_ready.set()
        except OSError as error:
            errors.append({'readerError': str(error)})

    stderr = bytearray()

    def read_errors():
        while True:
            block = proc.stderr.read(4096)
            if not block:
                return
            if len(stderr) + len(block) > 65536:
                errors.append('STDERR_LIMIT')
                return
            stderr.extend(block)

    threads = [threading.Thread(target=target, daemon=True) for target in (writer, reader, read_errors)]
    for thread in threads:
        thread.start()
    began = time.monotonic()
    start_time = None
    heartbeat = began
    acted = False
    driver_timeout = False
    while proc.poll() is None:
        now = time.monotonic()
        if started.is_set() and start_time is None:
            start_time = now
        if start_time is not None:
            if scenario == 'stopped-cli' and fixture_ready.is_set() and not acted:
                enqueue({'type': 'cancel'})
                acted = True
            if scenario in ('cancel', 'eof') and not acted and now - start_time >= 0.8:
                enqueue({'type': 'cancel'} if scenario == 'cancel' else None)
                acted = True
            if scenario != 'lease' and not (scenario == 'eof' and acted) and now - heartbeat >= 0.5:
                enqueue({'type': 'heartbeat'})
                heartbeat = now
        if now - began >= 208:
            # Only our Windows WSL client is killed. No terminal => cleanup unknown.
            driver_timeout = True
            proc.kill()
            break
        time.sleep(0.02)
    proc.wait(timeout=2)
    stop.set()
    for thread in threads:
        thread.join(timeout=1)
    if any(thread.is_alive() for thread in threads):
        errors.append('DRIVER_THREADS_NOT_FINISHED')
    terminals = [frame for frame in frames if frame.get('type') == 'terminal']
    report = {'version': 1, 'scenario': scenario, 'command': COMMAND, 'sourceSha256Before': before,
              'sourceSha256After': source_hashes(), 'exitCode': proc.returncode,
              'elapsedMs': round((time.monotonic() - began) * 1000), 'frames': frames, 'errors': errors,
              'stderr': stderr.decode(errors='replace'), 'driverTimeout': driver_timeout,
              'terminal': terminals[0] if len(terminals) == 1 else None,
              'cleanupStatus': 'ACKNOWLEDGED' if len(terminals) == 1 else 'UNKNOWN',
              'productionReady': False, 'productionAuth': 'NOT_RUN', 'productionNetwork': 'NOT_RUN',
              'productionCleanup': 'NOT_RUN', 'jobDeadlineMeasured': scenario == 'deadline' and len(terminals) == 1 and terminals[0].get('reason') == 'JOB_DEADLINE', 'commandTimeoutMeasured': False}
    report.update(transcript_check(frames, report['terminal']))
    report['scenarioPassed'] = evaluate(scenario, report)
    report['state'] = 'FINISHED'
    artifact.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'artifact': str(artifact), 'scenario': scenario, 'scenarioPassed': report['scenarioPassed'],
                      'terminal': report['terminal'], 'errors': errors}))
    return report['scenarioPassed']


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in SCENARIOS:
        raise SystemExit('Expected one fixed scenario: ' + ', '.join(SCENARIOS))
    raise SystemExit(0 if measure(sys.argv[1]) else 1)
