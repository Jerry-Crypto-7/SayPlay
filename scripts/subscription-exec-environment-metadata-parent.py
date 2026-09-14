"""Trusted, fixed environment metadata parent; no inference or caller requests."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

HOME = '/work/environment-appserver-home'
ENVIRONMENT_ID = 'fixed-worker'
SANDBOX_ADVISORY = "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces."
CATALOG_SHA256 = '59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791'
METADATA_SECONDS = 12
HARD_SECONDS = 22
HELPER_FILES = {
    'subscription-exec-server-worker-gate.py': '/usr/bin/exec-server-worker-gate.py',
    'subscription-exec-server-worker-trampoline.py': '/usr/bin/exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py': '/usr/bin/exec-worker-probe.py',
    'subscription-worker-lockdown.py': '/usr/bin/worker-lockdown.py',
    'subscription-appserver-noenv.py': '/usr/bin/appserver-noenv.py',
    'subscription-text-model-catalog.json': '/usr/bin/text-model-catalog.json',
    'subscription-exec-environment-metadata-parent.py': '/usr/bin/exec-environment-metadata-parent.py',
}
ENVIRONMENTS_TOML = b'''include_local = false
default = "fixed-worker"
[[environments]]
id = "fixed-worker"
program = "/usr/bin/python3"
args = ["-I", "-S", "/usr/bin/exec-server-worker-gate.py", "--environment-metadata"]
cwd = "/work"
'''
BOOTSTRAP_ENVIRONMENTS_TOML = ENVIRONMENTS_TOML.replace(b'"--environment-metadata"', b'"--environment-bootstrap-metadata"')


def profile_contract(bootstrap=False):
    if type(bootstrap) is not bool:
        raise ValueError('FIXED_PARENT_PROFILE_REQUIRED')
    return (('fixed-exec-environment-bootstrap-metadata-parent', BOOTSTRAP_ENVIRONMENTS_TOML,
             'environment-bootstrap-metadata') if bootstrap else
            ('fixed-exec-environment-metadata-parent', ENVIRONMENTS_TOML, 'environment-metadata'))


def fixed_environment_selection():
    return [{'environmentId': ENVIRONMENT_ID, 'cwd': '/work/exec-worker',
             'runtimeWorkspaceRoots': ['/work/exec-worker']}]


def helper_hashes():
    result = {}
    for name, path in HELPER_FILES.items():
        with open(path, 'rb') as handle:
            raw = handle.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('FIXED_HELPER_SIZE_LIMIT')
        result[name] = hashlib.sha256(raw).hexdigest()
    if result['subscription-text-model-catalog.json'] != CATALOG_SHA256:
        raise ValueError('FIXED_CATALOG_HASH_MISMATCH')
    return result


def prepare_home(bootstrap=False):
    environments_toml = profile_contract(bootstrap)[1]
    # Exclusive creation refuses reuse/reconnect leftovers. The environment gate
    # creates its separate executor home; this parent never reads an auth file.
    Path(HOME).mkdir(mode=0o700, exist_ok=False)
    Path(HOME + '/tmp').mkdir(mode=0o700, exist_ok=False)
    with open(HOME + '/environments.toml', 'xb') as handle:
        handle.write(environments_toml)
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': HOME,
            'CODEX_HOME': HOME, 'TMPDIR': HOME + '/tmp'}


def load_fixed_policy():
    spec = importlib.util.spec_from_file_location('fixed_environment_parent_policy', '/usr/bin/appserver-noenv.py')
    if spec is None or spec.loader is None:
        raise ValueError('FIXED_POLICY_REQUIRED')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    return policy


def load_fixed_gate():
    spec = importlib.util.spec_from_file_location('fixed_environment_parent_gate', '/usr/bin/exec-server-worker-gate.py')
    if spec is None or spec.loader is None:
        raise ValueError('FIXED_GATE_REQUIRED')
    gate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gate)
    return gate


def read_trace(policy, terminal=False, bootstrap=False):
    # Only the owned fresh gate metadata file, never its auth/config files. The
    # parent does not retry reads or reconnect if the gate has not finished.
    prefix = profile_contract(bootstrap)[2]
    path = '/work/executor-home/' + prefix + ('-terminal.json' if terminal else '-trace.json')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if info.st_mode & 0o170000 != 0o100000 or not 0 < info.st_size <= 32768:
            raise ValueError('HOOK_TRACE_FILE_INVALID')
        raw = os.read(fd, 32769)
        after = os.fstat(fd)
        if len(raw) != info.st_size or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError('HOOK_TRACE_CHANGED_OR_PARTIAL')
    finally:
        os.close(fd)
    try:
        report = policy.strict_json(raw)
    except ValueError:
        report = None  # Preserve rejected known bytes; never fabricate a report.
    return {'rawBase64': base64.b64encode(raw).decode(), 'rawBytes': len(raw),
            'rawSha256': hashlib.sha256(raw).hexdigest(), 'report': report}


def read_hook(policy, gate, bootstrap=False):
    profile_contract(bootstrap)
    snapshot = read_trace(policy, bootstrap=True) if bootstrap else read_trace(policy)
    try:
        terminal = read_trace(policy, terminal=True, bootstrap=True) if bootstrap else read_trace(policy, terminal=True)
    except FileNotFoundError:
        terminal = None
    except (ValueError, OSError) as failure:
        # Keep the already-read snapshot even when the separate terminal file
        # cannot be admitted. This deliberately cannot pass the strict replay.
        terminal = {'readError': type(failure).__name__ + ':' + str(failure)}
    snapshot['terminal'] = terminal
    validator = gate.validate_environment_bootstrap_metadata_report if bootstrap else gate.validate_environment_metadata_report
    snapshot['protocolValidated'] = (terminal is None or type(terminal.get('report')) is dict) and validator(
        snapshot['report'], terminal['report'] if terminal else None)
    return snapshot


def bootstrap_progress(policy, gate, process, began):
    """Observe the fixed atomic completion snapshot while keeping CLI alive."""
    evidence = {'snapshot': None, 'terminal': None}
    for name, terminal in (('snapshot', False), ('terminal', True)):
        try:
            evidence[name] = read_trace(policy, terminal=terminal, bootstrap=True)
        except FileNotFoundError:
            pass
        except (ValueError, OSError) as failure:
            return 'failed', evidence, 'BOOTSTRAP_TRACE:' + str(failure)
    snapshot, terminal = evidence['snapshot'], evidence['terminal']
    if terminal is not None and (snapshot is None or type(terminal['report']) is not dict):
        return 'failed', evidence, 'BOOTSTRAP_KNOWN_TERMINAL_FAILURE'
    if snapshot is None:
        return 'pending', evidence, None
    if not gate.validate_environment_bootstrap_metadata_report(snapshot['report'], terminal['report'] if terminal else None):
        return 'failed', evidence, 'BOOTSTRAP_TRACE_PROTOCOL_INVALID'
    if process.poll() is not None:
        return 'failed', evidence, 'BOOTSTRAP_APPSERVER_NOT_ALIVE'
    sampled_ms = (time.monotonic() - began) * 1000
    if not policy.metadata_completion_allowed(sampled_ms):
        return 'failed', evidence, 'METADATA_DEADLINE'
    return 'ready', {'rawSha256': snapshot['rawSha256'], 'capturedMs': sampled_ms,
                     'appServerPid': process.pid, 'appServerAlive': True}, None


def fixed_config(policy, bootstrap=False):
    profile_contract(bootstrap)
    config = policy.thread_request()['params']['config']
    config['features.shell_snapshot'] = False
    config['project_doc_max_bytes'] = 0
    if bootstrap:
        config['project_root_markers'] = []
    return config


def fixed_argv(policy, bootstrap=False):
    return ('/usr/bin/codex',) + tuple(argument for key, value in fixed_config(policy, bootstrap).items()
        for argument in ('-c', key + '=' + json.dumps(value))) + ('app-server', '--stdio')


def make_protocol(policy, bootstrap=False):
    profile_contract(bootstrap)
    class EnvironmentMetadataProtocol(policy.Protocol):
        def __init__(self):
            self.configuration_advisories = []
            super().__init__(HOME)

        def _queue(self, frame):
            if frame['method'] not in ('initialize', 'initialized', 'thread/start'):
                raise ValueError('METADATA_ONLY_RPC_REQUIRED')
            if frame['method'] == 'initialize':
                frame['params']['clientInfo']['name'] = 'reality_compiler_environment_metadata'
            elif frame['method'] == 'thread/start':
                frame['params']['config'] = fixed_config(policy, bootstrap)
                frame['params']['environments'] = fixed_environment_selection()
            super()._queue(frame)

        def receive(self, frame):
            if type(frame) is dict and type(frame.get('id')) is int and frame['id'] == 2:
                self.history.append({'event': 'received', 'frame': frame})
                result = frame.get('result')
                thread = result.get('thread') if type(result) is dict else None
                if (set(frame) != {'id', 'result'} or self.expected != 2 or 2 not in self.delivered or self.done
                        or type(result) is not dict or result.get('model') != 'gpt-5.6-sol'
                        or result.get('modelProvider') != 'openai' or result.get('reasoningEffort') != 'low'
                        or result.get('cwd') != '/work' or result.get('approvalPolicy') != 'never'
                        or result.get('runtimeWorkspaceRoots') != ['/work/exec-worker']
                        or result.get('sandbox') != {'type': 'readOnly', 'networkAccess': False}
                        or type(result['sandbox'].get('networkAccess')) is not bool
                        or type(thread) is not dict or thread.get('ephemeral') is not True
                        or 'path' not in thread or thread['path'] is not None
                        or type(thread.get('id')) is not str or not 1 <= len(thread['id']) <= 256):
                    raise ValueError('ENVIRONMENT_THREAD_PROFILE_MISMATCH')
                self.responses[2] = result
                self.done = True
                return
            if type(frame) is dict and frame.get('method') == 'configWarning':
                self.history.append({'event': 'received', 'frame': frame})
                if (not policy.notification_envelope(frame) or 1 not in self.responses or self.configuration_advisories
                        or type(frame.get('params')) is not dict or set(frame['params']) != {'summary', 'details'}
                        or frame['params']['summary'] != SANDBOX_ADVISORY or frame['params']['details'] is not None):
                    raise ValueError('ENVIRONMENT_METADATA_ADVISORY_INVALID')
                self.configuration_advisories.append(frame)
                return
            super().receive(frame)
    return EnvironmentMetadataProtocol()


def controlled_cleanup_outcome(child, history, delivery):
    if (type(child) is not dict or child.get('pinned') is not True or child.get('reaped') is not True
            or type(child.get('pid')) is not int or child['pid'] <= 1 or type(child.get('exitCode')) is not int
            or type(history) is not list or not history):
        return None
    if child['exitCode'] == 0 and len(history) == 1 and history[0].get('event') == 'stdin-eof' and delivery is None:
        return 'natural-exit-zero'
    if (child['exitCode'] != -15 or len(history) != 2
            or [item.get('event') for item in history] != ['stdin-eof', 'term-sent']
            or type(delivery) is not dict or set(delivery) != {'pid', 'signal', 'pidfdPinned', 'eofMs', 'sentMs'}
            or type(delivery['pid']) is not int or delivery['pid'] != child['pid']
            or type(delivery['signal']) is not int or delivery['signal'] != 15 or delivery['pidfdPinned'] is not True):
        return None
    for key in ('eofMs', 'sentMs'):
        if type(delivery[key]) not in (int, float) or not 0 <= delivery[key] < HARD_SECONDS * 1000:
            return None
    if (delivery['sentMs'] - delivery['eofMs'] < 2000
            or round(delivery['eofMs']) != history[0].get('elapsedMs')
            or round(delivery['sentMs']) != history[1].get('elapsedMs')):
        return None
    return 'owned-pidfd-term'


def run_parent(policy, began=None, bootstrap=False, gate=None, controlled=False):
    if type(controlled) is not bool or controlled and not bootstrap:
        raise ValueError('FIXED_CONTROLLED_BOOTSTRAP_PROFILE_REQUIRED')
    profile_name, environments_toml, _ = profile_contract(bootstrap)
    if controlled:
        profile_name = 'fixed-exec-environment-bootstrap-controlled-parent'
    if bootstrap and gate is None:
        raise ValueError('FIXED_BOOTSTRAP_VALIDATOR_REQUIRED')
    began = time.monotonic() if began is None else began
    environment = prepare_home(bootstrap=True) if bootstrap else prepare_home()
    protocol = make_protocol(policy, bootstrap)
    capture = policy.Capture(protocol)
    if time.monotonic() - began >= METADATA_SECONDS:
        raise ValueError('METADATA_DEADLINE_BEFORE_SPAWN')
    process = subprocess.Popen(fixed_argv(policy, bootstrap), cwd='/work', env=environment,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
    selector = selectors.DefaultSelector()
    pin = None
    cleanup = None
    cleanup_history = []
    error = None
    completed_ms = None
    bootstrap_ready = False
    bootstrap_before_eof = None
    signal_delivery = None
    eof_ms = None

    def close_input():
        nonlocal eof_ms
        if not process.stdin.closed:
            try:
                selector.unregister(process.stdin)
            except KeyError:
                pass
            process.stdin.close()
            eof_ms = (time.monotonic() - began) * 1000
            cleanup_history.append({'event': 'stdin-eof', 'elapsedMs': round(eof_ms)})

    try:
        pin = os.pidfd_open(process.pid)
        for name in ('stdin', 'stdout', 'stderr'):
            stream = getattr(process, name)
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_WRITE if name == 'stdin' else selectors.EVENT_READ, name)
        while True:
            now = time.monotonic()
            exited = process.poll() is not None
            if bootstrap and protocol.done and cleanup is None and not error:
                progress, evidence, progress_error = bootstrap_progress(policy, gate, process, began)
                if progress == 'ready':
                    bootstrap_ready = True
                    bootstrap_before_eof = evidence
                    completed_ms = evidence['capturedMs']
                elif progress == 'failed':
                    error = progress_error
                    bootstrap_before_eof = {'failureEvidence': evidence, 'error': progress_error}
            metadata_ready = protocol.done and (not bootstrap or bootstrap_ready)
            if cleanup is None and (error or metadata_ready or exited or now - began >= METADATA_SECONDS):
                if error is None and not metadata_ready:
                    error = 'EARLY_EXIT' if exited else 'METADATA_DEADLINE'
                close_input()
                cleanup = policy.Cleanup(time.monotonic())
            if cleanup is not None:
                action = cleanup.action(now, exited)
                if action in ('term', 'kill'):
                    try:
                        signal.pidfd_send_signal(pin, signal.SIGTERM if action == 'term' else signal.SIGKILL)
                        sent = time.monotonic()
                        if controlled and action == 'term':
                            signal_delivery = {'pid': process.pid, 'signal': 15, 'pidfdPinned': pin is not None,
                                               'eofMs': eof_ms, 'sentMs': (sent - began) * 1000}
                        cleanup.sent(action, sent)
                        cleanup_history.append({'event': action + '-sent', 'elapsedMs': round((sent - began) * 1000)})
                    except ProcessLookupError:
                        cleanup_history.append({'event': action + '-esrch', 'elapsedMs': round((time.monotonic() - began) * 1000)})
                if exited and all(capture.eof.values()):
                    break
                if action == 'unknown' or now - began >= HARD_SECONDS:
                    error = error or 'CLEANUP_OR_OUTPUT_UNKNOWN'
                    break
            if not process.stdin.closed:
                try:
                    selector.get_key(process.stdin)
                    if not protocol.pending:
                        selector.unregister(process.stdin)
                except KeyError:
                    if protocol.pending:
                        selector.register(process.stdin, selectors.EVENT_WRITE, 'stdin')
            for key, _ in selector.select(0.02):
                try:
                    if key.data == 'stdin':
                        if time.monotonic() - began >= METADATA_SECONDS:
                            error = error or 'METADATA_DEADLINE'
                        elif protocol.pending:
                            protocol.written(os.write(key.fileobj.fileno(), protocol.pending))
                    else:
                        raw = os.read(key.fileobj.fileno(), 8192)
                        if not raw:
                            selector.unregister(key.fileobj)
                        capture.feed(key.data, raw, parse=error is None)
                        if protocol.done and completed_ms is None and not bootstrap:
                            completed_ms = (time.monotonic() - began) * 1000
                            if completed_ms >= METADATA_SECONDS * 1000:
                                error = error or 'METADATA_DEADLINE'
                        if key.data == 'stdout' and not raw and not protocol.done:
                            error = error or 'STDOUT_EOF_BEFORE_METADATA'
                except BlockingIOError:
                    pass
                except (ValueError, OSError) as failure:
                    error = error or str(failure)
    except Exception as failure:
        # The outer supervisor remains the independent descendant cleanup
        # authority even if this parent cannot obtain its own direct pidfd.
        error = error or type(failure).__name__ + ':' + str(failure)
    finally:
        selector.close()
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()
        if pin is not None:
            os.close(pin)
    code = process.poll()
    child = {'pid': process.pid, 'pinned': pin is not None, 'reaped': code is not None, 'exitCode': code}
    outcome = controlled_cleanup_outcome(child, cleanup_history, signal_delivery) if controlled else None
    if (controlled and outcome is None) or (not controlled and code != 0):
        error = error or 'DIRECT_CHILD_EXIT_FAILURE_OR_UNKNOWN'
    if capture.partial:
        error = error or 'TRAILING_PARTIAL_SERVER_FRAME'
    report = {'version': 1, 'profile': profile_name,
            'success': error is None and protocol.done and (not bootstrap or bootstrap_ready) and (outcome is not None if controlled else code == 0) and all(capture.eof.values()),
            'error': error, 'argv': list(fixed_argv(policy, bootstrap)), 'freshHome': HOME,
            'environmentsTomlSha256': hashlib.sha256(environments_toml).hexdigest(),
            'history': protocol.history, 'configurationAdvisories': protocol.configuration_advisories,
            'stdoutBase64': base64.b64encode(capture.stdout).decode(),
            'stderrBase64': base64.b64encode(capture.stderr).decode(),
            'outputBytesObserved': capture.observed_bytes, 'outputComplete': all(capture.eof.values()) and capture.observed_bytes <= policy.MAX_OUTPUT,
            'streamEOF': capture.eof, 'controlBytesQueued': protocol.control_queued, 'controlBytesWritten': protocol.control_written,
            'cleanupHistory': cleanup_history, 'directChild': child,
            'elapsedMs': round((time.monotonic() - began) * 1000), 'metadataCompletedMs': completed_ms,
            'descendantCleanupVerifiedHere': False, 'runtimeRegistryValidated': False, 'actualModelCalls': 0,
            'credentialFilesRead': False, 'productionReady': False}
    if bootstrap:
        report['bootstrapHookBeforeEof'] = bootstrap_before_eof
    if controlled:
        report.update(cleanupOutcome=outcome, signalDelivery=signal_delivery)
    return report


def validate_report(report, policy, gate):
    return _validate_report(report, policy, gate, False)


def validate_bootstrap_report(report, policy, gate):
    return _validate_report(report, policy, gate, True)


def validate_controlled_bootstrap_report(report, policy, gate):
    return _validate_report(report, policy, gate, True, controlled=True)


def _validate_report(report, policy, gate, bootstrap, controlled=False):
    """Pure offline replay. Dependencies are read-only code, not caller evidence."""
    try:
        profile_name, environments_toml, _ = profile_contract(bootstrap)
        if controlled:
            profile_name = 'fixed-exec-environment-bootstrap-controlled-parent'
        def same(left, right):
            return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)
        expected_keys = {'version', 'profile', 'success', 'error', 'argv', 'freshHome', 'environmentsTomlSha256',
            'history', 'configurationAdvisories', 'stdoutBase64', 'stderrBase64', 'outputBytesObserved', 'outputComplete',
            'streamEOF', 'controlBytesQueued', 'controlBytesWritten', 'cleanupHistory', 'directChild', 'elapsedMs',
            'metadataCompletedMs', 'descendantCleanupVerifiedHere', 'runtimeRegistryValidated', 'actualModelCalls',
            'credentialFilesRead', 'productionReady', 'helperSha256Before', 'helperSha256After', 'environmentHook'}
        if bootstrap:
            expected_keys.add('bootstrapHookBeforeEof')
        if controlled:
            expected_keys.update(('cleanupOutcome', 'signalDelivery'))
        if type(report) is not dict or set(report) != expected_keys:
            return False
        if (type(report['version']) is not int or report['version'] != 1 or report['profile'] != profile_name
                or report['success'] is not True or report['error'] is not None or report['argv'] != list(fixed_argv(policy, bootstrap))
                or report['freshHome'] != HOME or report['environmentsTomlSha256'] != hashlib.sha256(environments_toml).hexdigest()
                or report['outputComplete'] is not True or not same(report['streamEOF'], {'stdout': True, 'stderr': True})
                or any(report[key] is not False for key in ('descendantCleanupVerifiedHere', 'runtimeRegistryValidated', 'credentialFilesRead', 'productionReady'))
                or type(report['actualModelCalls']) is not int or report['actualModelCalls'] != 0):
            return False
        hashes = report['helperSha256Before']
        if (type(hashes) is not dict or set(hashes) != set(HELPER_FILES) or not same(hashes, report['helperSha256After'])
                or any(type(value) is not str or re.fullmatch('[a-f0-9]{64}', value) is None for value in hashes.values())
                or hashes['subscription-text-model-catalog.json'] != CATALOG_SHA256):
            return False
        child = report['directChild']
        if (type(child) is not dict or set(child) != {'pid', 'pinned', 'reaped', 'exitCode'}
                or type(child['pid']) is not int or child['pid'] <= 1 or child['pinned'] is not True or child['reaped'] is not True
                or type(child['exitCode']) is not int or child['exitCode'] not in ((0, -15) if controlled else (0,))
                or type(report['elapsedMs']) is not int or not 0 <= report['elapsedMs'] < HARD_SECONDS * 1000
                or not policy.metadata_completion_allowed(report['metadataCompletedMs'])
                or report['metadataCompletedMs'] > report['elapsedMs'] + 0.5):
            return False
        raw = {}
        for stream in ('stdout', 'stderr'):
            encoded = report[stream + 'Base64']
            if type(encoded) is not str or len(encoded) > ((policy.MAX_OUTPUT + 2) // 3) * 4:
                return False
            raw[stream] = base64.b64decode(encoded, validate=True)
            if base64.b64encode(raw[stream]).decode() != encoded:
                return False
        total = sum(map(len, raw.values()))
        if type(report['outputBytesObserved']) is not int or report['outputBytesObserved'] != total or total > policy.MAX_OUTPUT:
            return False
        history = report['history']
        if type(history) is not list or not 1 <= len(history) <= 4096:
            return False
        replay = make_protocol(policy, bootstrap)
        for index, event in enumerate(history):
            if type(event) is not dict:
                return False
            if index >= len(replay.history):
                if set(event) == {'event', 'id'} and event['event'] == 'written' and replay.frames:
                    replay.written(replay.frames[0][0])
                elif set(event) == {'event', 'frame'} and event['event'] == 'received':
                    replay.receive(event['frame'])
                else:
                    return False
            if not same(replay.history[index], event):
                return False
        if (not replay.done or replay.pending or not same(history, replay.history)
                or not same(report['configurationAdvisories'], replay.configuration_advisories)
                or any(type(report[key]) is not int for key in ('controlBytesQueued', 'controlBytesWritten'))
                or report['controlBytesQueued'] != replay.control_queued or report['controlBytesWritten'] != replay.control_written):
            return False
        if not raw['stdout'].endswith(b'\n') or not same([policy.strict_json(line) for line in raw['stdout'].splitlines()],
                [item['frame'] for item in history if item['event'] == 'received']):
            return False
        cleanup = report['cleanupHistory']
        if type(cleanup) is not list or not 1 <= len(cleanup) <= 3:
            return False
        last = -1
        for index, item in enumerate(cleanup):
            if (type(item) is not dict or set(item) != {'event', 'elapsedMs'} or type(item['elapsedMs']) is not int
                    or not last <= item['elapsedMs'] <= report['elapsedMs']
                    or item['event'] not in (('stdin-eof',), ('term-sent', 'term-esrch'), ('kill-sent', 'kill-esrch'))[index]
                    or index and item['elapsedMs'] - last < (2000 if index == 1 else 5000)):
                return False
            last = item['elapsedMs']
        if controlled:
            outcome = controlled_cleanup_outcome(child, cleanup, report['signalDelivery'])
            if outcome is None or report['cleanupOutcome'] != outcome:
                return False
        hook = report['environmentHook']
        if type(hook) is not dict or set(hook) != {'rawBase64', 'rawBytes', 'rawSha256', 'report', 'protocolValidated', 'terminal'}:
            return False
        def valid_trace(trace):
            if type(trace['rawBase64']) is not str or len(trace['rawBase64']) > 43692:
                return False
            hook_raw = base64.b64decode(trace['rawBase64'], validate=True)
            return (0 < len(hook_raw) <= 32768 and type(trace['rawBytes']) is int and trace['rawBytes'] == len(hook_raw)
                    and base64.b64encode(hook_raw).decode() == trace['rawBase64']
                    and hashlib.sha256(hook_raw).hexdigest() == trace['rawSha256']
                    and type(trace['report']) is dict and same(policy.strict_json(hook_raw), trace['report']))
        terminal = hook['terminal']
        if terminal is not None and (type(terminal) is not dict or set(terminal) != {'rawBase64', 'rawBytes', 'rawSha256', 'report'} or not valid_trace(terminal)):
            return False
        validator = gate.validate_environment_bootstrap_metadata_report if bootstrap else gate.validate_environment_metadata_report
        if bootstrap:
            proof = report['bootstrapHookBeforeEof']
            if (type(proof) is not dict or set(proof) != {'rawSha256', 'capturedMs', 'appServerPid', 'appServerAlive'}
                    or proof['rawSha256'] != hook['rawSha256'] or proof['appServerAlive'] is not True
                    or type(proof['appServerPid']) is not int or proof['appServerPid'] != child['pid']
                    or not policy.metadata_completion_allowed(proof['capturedMs'])
                    or proof['capturedMs'] != report['metadataCompletedMs']
                    or proof['capturedMs'] > cleanup[0]['elapsedMs'] + 0.5):
                return False
        return (valid_trace(hook) and hook['protocolValidated'] is True
                and validator(hook['report'], terminal['report'] if terminal else None))
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError):
        return False


def main():
    began = time.monotonic()
    if sys.platform != 'linux' or sys.argv[1:] not in ([], ['--bootstrap-metadata'], ['--bootstrap-controlled-cleanup']):
        raise ValueError('FIXED_CAPSULE_ENTRY_REQUIRED')
    controlled = sys.argv[1:] == ['--bootstrap-controlled-cleanup']
    bootstrap = controlled or sys.argv[1:] == ['--bootstrap-metadata']
    if not os.statvfs('/usr/bin').f_flag & os.ST_RDONLY:
        raise ValueError('READONLY_CAPSULE_IMAGE_REQUIRED')
    before = helper_hashes()
    policy = load_fixed_policy()
    gate = load_fixed_gate()
    report = run_parent(policy, began, bootstrap, gate=gate if bootstrap else None, controlled=controlled)
    report['helperSha256Before'] = before
    try:
        report['environmentHook'] = read_hook(policy, gate, bootstrap)
    except (ValueError, OSError) as failure:
        report['environmentHook'] = None
        report['error'] = report['error'] or 'HOOK_EVIDENCE:' + str(failure)
    report['helperSha256After'] = helper_hashes()
    report['elapsedMs'] = round((time.monotonic() - began) * 1000)
    validator = validate_controlled_bootstrap_report if controlled else validate_bootstrap_report if bootstrap else validate_report
    if not validator(report, policy, gate):
        report['success'] = False
        report['error'] = report['error'] or 'ENVIRONMENT_METADATA_REPORT_INVALID'
    print(json.dumps(report, separators=(',', ':'), allow_nan=False), flush=True)
    return 0 if report['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
