"""Fixed credential-free app-server metadata handshake, only inside the capsule.

No account/auth RPC, turn/start, inference, tool execution, caller command or
caller environment is accepted. The outer supervisor owns descendant cleanup.
"""
import base64
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time

HOME = '/work/appserver-home'
MAX_OUTPUT = 128 * 1024
MAX_CONTROL = 4096
METADATA_SECONDS = 12
HARD_SECONDS = 22
KNOWN_NOTIFICATIONS = frozenset(('thread/started',))


def notification_envelope(frame):
    return (set(frame) in ({'method', 'params'}, {'method', 'params', 'emittedAtMs'})
            and ('emittedAtMs' not in frame or
                 (type(frame['emittedAtMs']) is int and 0 <= frame['emittedAtMs'] <= 9007199254740991)))


def disabled_remote_status(params):
    return (type(params) is dict and set(params) == {'status', 'serverName', 'installationId', 'environmentId'}
            and params['status'] == 'disabled' and params['environmentId'] is None
            and type(params['serverName']) is str and 0 < len(params['serverName'].encode('utf-8')) <= 256
            and not any(ord(char) < 32 or ord(char) == 127 for char in params['serverName'])
            and type(params['installationId']) is str
            and re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', params['installationId']) is not None)


def initialize_request():
    return {'id': 1, 'method': 'initialize', 'params': {
        'clientInfo': {'name': 'reality_compiler_probe', 'version': '1'},
        'capabilities': {'experimentalApi': True}}}


def thread_request():
    return {'id': 2, 'method': 'thread/start', 'params': {
        'model': 'gpt-5.6-sol', 'modelProvider': 'openai', 'allowProviderModelFallback': False,
        'cwd': '/work', 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True,
        'environments': [], 'dynamicTools': [], 'selectedCapabilityRoots': [], 'runtimeWorkspaceRoots': [],
        'config': {'model_reasoning_effort': 'low', 'features.shell_tool': False,
                   'features.apps': False, 'features.multi_agent': False,
                   'features.multi_agent_v2': False, 'agents.enabled': False,
                   'features.image_generation': False, 'features.goals': False,
                   'features.memories': False, 'features.plugins': False,
                   'features.code_mode': False, 'features.code_mode_only': False,
                   'features.deferred_executor': False, 'features.token_budget': False,
                   'features.current_time_reminder': False, 'features.skill_search': False,
                   'tools.experimental_request_user_input.enabled': False,
                   'orchestrator.skills.enabled': False, 'orchestrator.mcp.enabled': False,
                   'skills.include_instructions': False,
                   'model_catalog_json': '/usr/bin/text-model-catalog.json', 'web_search': 'disabled'}}}


# Apply the same literal policy before process-level managers/extensions exist.
# JSON strings and booleans here are valid TOML scalar literals; no caller values
# or shell parsing are involved. thread_request returns a fresh fixed dictionary.
ARGV = ('/usr/bin/codex',) + tuple(argument
    for key, value in thread_request()['params']['config'].items()
    for argument in ('-c', key + '=' + json.dumps(value))) + ('app-server', '--stdio')


def model_list_request():
    return {'id': 3, 'method': 'model/list', 'params': {'includeHidden': True}}


class ProbeError(ValueError):
    pass


def metadata_completion_allowed(milliseconds):
    """Strict measured completion bound, including a receive after select()."""
    return type(milliseconds) in (int, float) and math.isfinite(milliseconds) and 0 <= milliseconds < METADATA_SECONDS * 1000


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ProbeError('DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    def invalid_constant(_):
        raise ProbeError('NONFINITE_JSON')
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ProbeError('INVALID_JSONL') from error


class Protocol:
    """A fixed metadata state machine; responses cannot trigger arbitrary RPC."""
    def __init__(self, home):
        self.home = home
        self.expected = 1
        self.done = False
        self.history = []
        self.pending = bytearray()
        self.frames = []
        self.delivered = set()
        self.control_queued = 0
        self.control_written = 0
        self.responses = {}
        self.remote_status_seen = False
        self._queue(initialize_request())

    def _queue(self, frame):
        wire = (json.dumps(frame, separators=(',', ':')) + '\n').encode()
        if self.control_queued + len(wire) > MAX_CONTROL:
            raise ProbeError('CONTROL_LIMIT')
        self.control_queued += len(wire)
        self.pending.extend(wire)
        self.frames.append([len(wire), frame.get('id')])
        self.history.append({'event': 'queued', 'frame': frame})

    def written(self, count):
        if type(count) is not int or count <= 0 or count > len(self.pending):
            raise ProbeError('INVALID_WRITE_ACCOUNTING')
        self.control_written += count
        del self.pending[:count]
        while count:
            consumed = min(count, self.frames[0][0])
            self.frames[0][0] -= consumed
            count -= consumed
            if self.frames[0][0] == 0:
                _, identifier = self.frames.pop(0)
                if identifier is not None:
                    self.delivered.add(identifier)
                self.history.append({'event': 'written', 'id': identifier})

    def receive(self, frame):
        self.history.append({'event': 'received', 'frame': frame})
        if type(frame) is not dict or 'jsonrpc' in frame:
            raise ProbeError('INVALID_ENVELOPE')
        if 'method' in frame:
            if 'id' in frame:
                raise ProbeError('UNSOLICITED_SERVER_REQUEST')
            if not notification_envelope(frame):
                raise ProbeError('UNKNOWN_NOTIFICATION')
            if frame['method'] == 'remoteControl/status/changed':
                if 1 not in self.responses or self.remote_status_seen or not disabled_remote_status(frame['params']):
                    raise ProbeError('INVALID_REMOTE_CONTROL_STATUS')
                self.remote_status_seen = True
                return
            if frame['method'] not in KNOWN_NOTIFICATIONS or type(frame['params']) is not dict:
                raise ProbeError('UNKNOWN_NOTIFICATION')
            if 2 not in self.delivered:
                raise ProbeError('NOTIFICATION_BEFORE_THREAD_START')
            return
        if set(frame) not in ({'id', 'result'}, {'id', 'error'}):
            raise ProbeError('INVALID_RESPONSE')
        identifier = frame['id']
        if type(identifier) is not int or identifier != self.expected or identifier not in self.delivered or self.done:
            raise ProbeError('OUT_OF_ORDER_OR_DUPLICATE_RESPONSE')
        if 'error' in frame:
            raise ProbeError('SERVER_ERROR')
        result = frame['result']
        if type(result) is not dict:
            raise ProbeError('INVALID_RESULT')
        if identifier == 1:
            if (type(result.get('userAgent')) is not str or not result['userAgent']
                    or result.get('codexHome') != self.home or result.get('platformFamily') != 'unix'
                    or result.get('platformOs') != 'linux'):
                raise ProbeError('INITIALIZE_IDENTITY_MISMATCH')
            self.responses[1] = result
            self.expected = 2
            self._queue({'method': 'initialized', 'params': {}})
            self._queue(thread_request())
        elif identifier == 2:
            thread = result.get('thread')
            if (result.get('model') != 'gpt-5.6-sol' or result.get('modelProvider') != 'openai'
                    or result.get('reasoningEffort') != 'low' or result.get('cwd') != '/work'
                    or result.get('approvalPolicy') != 'never' or result.get('runtimeWorkspaceRoots') != []
                    or result.get('sandbox') != {'type': 'readOnly', 'networkAccess': False}
                    or type(result['sandbox'].get('networkAccess')) is not bool
                    or type(thread) is not dict or thread.get('ephemeral') is not True
                    or 'path' not in thread or thread['path'] is not None):
                raise ProbeError('THREAD_PROFILE_MISMATCH')
            self.responses[2] = result
            self.expected = 3
            self._queue(model_list_request())
        else:
            data = result.get('data')
            if ('nextCursor' not in result or result['nextCursor'] is not None
                    or type(data) is not list or len(data) != 1 or type(data[0]) is not dict
                    or data[0].get('id') != 'gpt-5.6-sol' or data[0].get('model') != 'gpt-5.6-sol'):
                raise ProbeError('MODEL_CATALOG_SELECTION_MISMATCH')
            self.responses[3] = result
            self.done = True


class Capture:
    def __init__(self, protocol):
        self.protocol = protocol
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.partial = bytearray()
        self.observed_bytes = 0
        self.eof = {'stdout': False, 'stderr': False}

    def feed(self, stream, block, parse=True):
        if stream not in self.eof or type(block) is not bytes:
            raise ProbeError('INVALID_STREAM')
        if self.eof[stream]:
            raise ProbeError('OUTPUT_AFTER_EOF')
        if not block:
            self.eof[stream] = True
            if stream == 'stdout' and self.partial and parse:
                raise ProbeError('TRUNCATED_JSONL')
            return
        self.observed_bytes += len(block)
        retained = len(self.stdout) + len(self.stderr)
        getattr(self, stream).extend(block[:max(0, MAX_OUTPUT - retained)])
        if self.observed_bytes > MAX_OUTPUT:
            raise ProbeError('OUTPUT_LIMIT')
        if stream == 'stdout' and parse:
            self.partial.extend(block)
            while b'\n' in self.partial:
                line, _, rest = self.partial.partition(b'\n')
                self.partial[:] = rest
                if not line:
                    raise ProbeError('EMPTY_JSONL')
                self.protocol.receive(strict_json(line))


class Cleanup:
    """Fixed direct-child EOF 2s -> TERM 5s -> KILL 1s schedule."""
    def __init__(self, began):
        self.began = began
        self.term_at = self.kill_at = None

    def action(self, now, exited):
        if exited:
            return 'done'
        if self.kill_at is not None:
            return 'unknown' if now - self.kill_at >= 1 else None
        if self.term_at is not None:
            if now - self.term_at >= 5:
                self.kill_at = now
                return 'kill'
            return None
        if now - self.began >= 2:
            self.term_at = now
            return 'term'
        return None

    def sent(self, action, now):
        # Start grace after the signal syscall returns, not before a possibly
        # delayed send. This can extend grace; it cannot shorten it.
        if action == 'term' and self.term_at is not None:
            self.term_at = max(self.term_at, now)
        elif action == 'kill' and self.kill_at is not None:
            self.kill_at = max(self.kill_at, now)
        else:
            raise ProbeError('INVALID_SIGNAL_ACCOUNTING')


def validate_report(report):
    """Offline transcript replay, not trust in the helper's success boolean.

    Source/image binding and independent descendant cleanup remain the caller's
    responsibility. This validates only the fixed metadata exchange and report.
    """
    try:
        def same_json(left, right):
            return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)
        keys = {'version', 'profile', 'success', 'error', 'argv', 'freshHome', 'history', 'cleanupHistory',
                'stdoutBase64', 'stderrBase64', 'outputBytesObserved', 'outputComplete', 'streamEOF',
                'controlBytesQueued', 'controlBytesWritten', 'directChild', 'descendantCleanupVerifiedHere',
                'elapsedMs', 'metadataCompletedMs', 'threadProfileValidated', 'environmentRequestEmpty', 'runtimeRegistryValidated',
                'modelCalls', 'credentialFilesRead', 'productionReady'}
        if type(report) is not dict or set(report) != keys:
            return False
        if type(report['version']) is not int or report['version'] != 2 or report['profile'] != 'fixed-appserver-noenv-metadata-v2':
            return False
        for key in ('success', 'outputComplete', 'threadProfileValidated', 'environmentRequestEmpty'):
            if report[key] is not True:
                return False
        for key in ('descendantCleanupVerifiedHere', 'runtimeRegistryValidated', 'credentialFilesRead', 'productionReady'):
            if report[key] is not False:
                return False
        if report['error'] is not None or type(report['modelCalls']) is not int or report['modelCalls'] != 0:
            return False
        if report['argv'] != list(ARGV) or not isinstance(report['freshHome'], str) or not re.fullmatch(re.escape(HOME) + r'/fixed-[a-z0-9_]{8}', report['freshHome']):
            return False
        if type(report['elapsedMs']) is not int or not 0 <= report['elapsedMs'] <= HARD_SECONDS * 1000:
            return False
        if not metadata_completion_allowed(report['metadataCompletedMs']) or report['metadataCompletedMs'] > report['elapsedMs'] + 0.5:
            return False
        child = report['directChild']
        if type(child) is not dict or set(child) != {'pid', 'pinned', 'reaped', 'exitCode'}:
            return False
        if type(child['pid']) is not int or child['pid'] <= 1 or child['pinned'] is not True or child['reaped'] is not True or type(child['exitCode']) is not int or child['exitCode'] != 0:
            return False
        if type(report['streamEOF']) is not dict or set(report['streamEOF']) != {'stdout', 'stderr'} or any(value is not True for value in report['streamEOF'].values()):
            return False
        raw = {}
        for name in ('stdout', 'stderr'):
            encoded = report[name + 'Base64']
            if type(encoded) is not str or len(encoded) > ((MAX_OUTPUT + 2) // 3) * 4:
                return False
            raw[name] = base64.b64decode(encoded, validate=True)
        output_bytes = len(raw['stdout']) + len(raw['stderr'])
        if output_bytes > MAX_OUTPUT or type(report['outputBytesObserved']) is not int or report['outputBytesObserved'] != output_bytes:
            return False
        history = report['history']
        if type(history) is not list or not history or len(history) > 4096:
            return False
        replay = Protocol(report['freshHome'])
        for index, event in enumerate(history):
            if type(event) is not dict:
                return False
            if index >= len(replay.history):
                if event.get('event') == 'written' and set(event) == {'event', 'id'} and replay.frames:
                    if event['id'] is not None and type(event['id']) is not int:
                        return False
                    replay.written(replay.frames[0][0])
                elif event.get('event') == 'received' and set(event) == {'event', 'frame'}:
                    replay.receive(event['frame'])
                else:
                    return False
            if not same_json(replay.history[index], event):
                return False
        if not same_json(replay.history, history) or not replay.done or replay.pending:
            return False
        if any(type(report[key]) is not int for key in ('controlBytesQueued', 'controlBytesWritten')):
            return False
        if report['controlBytesQueued'] != replay.control_queued or report['controlBytesWritten'] != replay.control_written:
            return False
        if not raw['stdout'].endswith(b'\n'):
            return False
        frames = [strict_json(line) for line in raw['stdout'].splitlines()]
        if not same_json(frames, [event['frame'] for event in history if event['event'] == 'received']):
            return False
        cleanup = report['cleanupHistory']
        if type(cleanup) is not list or not cleanup or len(cleanup) > 3:
            return False
        last = -1
        for index, event in enumerate(cleanup):
            if type(event) is not dict or set(event) != {'event', 'elapsedMs'} or type(event['elapsedMs']) is not int or not last <= event['elapsedMs'] <= report['elapsedMs']:
                return False
            allowed = (('stdin-eof',), ('term-sent', 'term-esrch'), ('kill-sent', 'kill-esrch'))[index]
            if event['event'] not in allowed:
                return False
            if index and event['elapsedMs'] - cleanup[index - 1]['elapsedMs'] < (2000 if index == 1 else 5000):
                return False
            last = event['elapsedMs']
        return True
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError):
        return False


def run_fixed_bridge():
    if sys.platform != 'linux':
        raise ProbeError('CAPSULE_LINUX_REQUIRED')
    # Supervisor supplies this writable mount. A new exclusive child directory
    # avoids reusing its prior contents; no existing auth/config is opened.
    home = tempfile.mkdtemp(prefix='fixed-', dir=HOME)
    Path(home + '/tmp').mkdir(mode=0o700, exist_ok=False)
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': home,
           'CODEX_HOME': home, 'TMPDIR': home + '/tmp'}
    protocol = Protocol(home)
    capture = Capture(protocol)
    history = []
    error = None
    started = time.monotonic()
    process = subprocess.Popen(ARGV, cwd='/work', env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
    child_fd = None
    selector = selectors.DefaultSelector()
    cleanup = None
    metadata_completed_ms = None
    direct_reaped = False
    try:
        child_fd = os.pidfd_open(process.pid)
        for name, stream in (('stdout', process.stdout), ('stderr', process.stderr), ('stdin', process.stdin)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_WRITE if name == 'stdin' else selectors.EVENT_READ, name)
        def close_input():
            if not process.stdin.closed:
                try:
                    selector.unregister(process.stdin)
                except KeyError:
                    pass
                process.stdin.close()
                history.append({'event': 'stdin-eof', 'elapsedMs': round((time.monotonic() - started) * 1000)})
        while True:
            now = time.monotonic()
            code = process.poll()
            direct_reaped = code is not None
            if cleanup is None and (error or protocol.done or direct_reaped or now - started >= METADATA_SECONDS):
                if error is None and not protocol.done:
                    error = 'EARLY_EXIT' if direct_reaped else 'METADATA_DEADLINE'
                close_input()
                cleanup = Cleanup(now)
            if cleanup is not None:
                action = cleanup.action(now, direct_reaped)
                if action in ('term', 'kill'):
                    try:
                        signal.pidfd_send_signal(child_fd, signal.SIGTERM if action == 'term' else signal.SIGKILL)
                        sent = time.monotonic()
                        cleanup.sent(action, sent)
                        history.append({'event': action + '-sent', 'elapsedMs': round((sent - started) * 1000)})
                    except ProcessLookupError:
                        history.append({'event': action + '-esrch', 'elapsedMs': round((now - started) * 1000)})
                if direct_reaped and all(capture.eof.values()):
                    break
                if action == 'unknown' or now - started >= HARD_SECONDS:
                    if error is None:
                        error = 'CLEANUP_UNKNOWN' if not direct_reaped else 'OUTPUT_EOF_UNKNOWN'
                    break
            # Do not busy-spin on a writable pipe while awaiting a response.
            if not process.stdin.closed:
                try:
                    selector.get_key(process.stdin)
                    if not protocol.pending:
                        selector.unregister(process.stdin)
                except KeyError:
                    if protocol.pending:
                        selector.register(process.stdin, selectors.EVENT_WRITE, 'stdin')
            for key, _ in selector.select(0.02):
                name = key.data
                try:
                    if name == 'stdin':
                        if protocol.pending:
                            if time.monotonic() - started >= METADATA_SECONDS:
                                error = error or 'METADATA_DEADLINE'
                                continue
                            count = os.write(key.fileobj.fileno(), protocol.pending)
                            protocol.written(count)
                    else:
                        block = os.read(key.fileobj.fileno(), 8192)
                        if not block:
                            selector.unregister(key.fileobj)
                        capture.feed(name, block, parse=error is None)
                        if protocol.done and metadata_completed_ms is None:
                            # Measure AFTER parsing/validating the complete response;
                            # a stale pre-select clock cannot grant completion credit.
                            metadata_completed_ms = (time.monotonic() - started) * 1000
                            if not metadata_completion_allowed(metadata_completed_ms):
                                error = error or 'METADATA_DEADLINE'
                        if name == 'stdout' and not block and not protocol.done and error is None:
                            error = 'STDOUT_EOF_BEFORE_METADATA'
                except BlockingIOError:
                    pass
                except (ProbeError, BrokenPipeError, OSError) as failure:
                    if error is None:
                        error = str(failure)
    except BaseException as failure:
        error = str(failure)
        # Exceptional paths preserve an already-started TERM grace too. Do not
        # shorten it with an immediate KILL or use blocking process.wait().
        if child_fd is not None and process.poll() is None:
            try:
                if not process.stdin.closed:
                    process.stdin.close()
                    history.append({'event': 'stdin-eof', 'elapsedMs': round((time.monotonic() - started) * 1000)})
            except OSError:
                pass
            cleanup = cleanup or Cleanup(time.monotonic())
            while process.poll() is None:
                now = time.monotonic()
                if now - started >= HARD_SECONDS:
                    break
                action = cleanup.action(now, False)
                if action == 'unknown':
                    break
                if action in ('term', 'kill'):
                    try:
                        signal.pidfd_send_signal(child_fd, signal.SIGTERM if action == 'term' else signal.SIGKILL)
                        sent = time.monotonic()
                        cleanup.sent(action, sent)
                        history.append({'event': action + '-sent', 'elapsedMs': round((sent - started) * 1000)})
                    except ProcessLookupError:
                        pass
                time.sleep(0.01)
        direct_reaped = process.poll() is not None
    finally:
        selector.close()
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()
        if child_fd is not None:
            os.close(child_fd)
    code = process.poll()
    direct_reaped = code is not None
    elapsed_ms = (time.monotonic() - started) * 1000
    if error is None and elapsed_ms >= HARD_SECONDS * 1000:
        error = 'HELPER_DEADLINE'
    if error is None and code != 0:
        error = 'DIRECT_CHILD_EXIT_FAILURE'
    return {'version': 2, 'profile': 'fixed-appserver-noenv-metadata-v2',
            'success': error is None and protocol.done and direct_reaped and code == 0 and all(capture.eof.values()),
            'error': error, 'argv': list(ARGV), 'freshHome': home, 'history': protocol.history, 'cleanupHistory': history,
            'stdoutBase64': base64.b64encode(capture.stdout).decode(), 'stderrBase64': base64.b64encode(capture.stderr).decode(),
            'outputBytesObserved': capture.observed_bytes, 'outputComplete': all(capture.eof.values()) and capture.observed_bytes <= MAX_OUTPUT,
            'streamEOF': capture.eof, 'controlBytesQueued': protocol.control_queued, 'controlBytesWritten': protocol.control_written,
            'directChild': {'pid': process.pid, 'pinned': child_fd is not None, 'reaped': direct_reaped, 'exitCode': code},
            'descendantCleanupVerifiedHere': False, 'elapsedMs': round(elapsed_ms),
            'metadataCompletedMs': metadata_completed_ms,
            'threadProfileValidated': protocol.done, 'environmentRequestEmpty': True, 'runtimeRegistryValidated': False,
            'modelCalls': 0, 'credentialFilesRead': False, 'productionReady': False}


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('FIXED_METADATA_BRIDGE_ONLY')
    try:
        report = run_fixed_bridge()
    except BaseException as failure:
        report = {'version': 2, 'profile': 'fixed-appserver-noenv-metadata-v2', 'success': False,
                  'error': str(failure), 'history': [], 'cleanupHistory': [], 'directChild': None,
                  'metadataCompletedMs': None,
                  'runtimeRegistryValidated': False, 'productionReady': False,
                  'modelCalls': 0, 'credentialFilesRead': False}
    print(json.dumps(report, separators=(',', ':')), flush=True)
    raise SystemExit(0 if report['success'] else 1)
