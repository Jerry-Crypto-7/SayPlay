import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import pytest


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


g = load('fixed_executor_gate_test', 'subscription-exec-server-worker-gate.py')
p = load('fixed_executor_policy_test', 'subscription-appserver-noenv.py')
INIT_REPLY = {'id': 1, 'result': {'sessionId': 'fixed-unit-session'}}
INITIALIZED = {'method': 'initialized', 'params': {}}
START_REPLY = {'id': 2, 'result': {'processId': 'fixed-worker'}}
OUTPUT = {'method': 'process/output', 'params': {'processId': 'fixed-worker', 'seq': 1, 'stream': 'stdout', 'chunk': 'e30K'}}
EXITED = {'method': 'process/exited', 'params': {'processId': 'fixed-worker', 'seq': 2, 'exitCode': 0, 'sandboxDenied': False}}
CLOSED = {'method': 'process/closed', 'params': {'processId': 'fixed-worker', 'seq': 3}}
INFO_REPLY = {'id': 2, 'result': {'shell': {'name': 'bash', 'path': '/bin/bash'},
    'cwd': 'file:///work', 'capabilities': {'networkProxyLaunch': True}}}
STAT_REPLY2 = {'id': 4, 'error': {'code': -32004, 'message': 'No such file or directory (os error 2)'}}
STAT_REPLY = {'id': 3, 'error': {'code': -32004, 'message': 'No such file or directory (os error 2)'}}


def fresh(): return g.Gate('pid:[1]', 'mnt:[2]')


def flush(gate):
    output = bytearray()
    def write(_fd, raw): output.extend(raw); return len(raw)
    with patch.object(g.os, 'write', side_effect=write): gate.drain(42)
    return bytes(output)


def initialized():
    gate = fresh()
    gate.admit(g.initialize_request())
    flush(gate)
    gate.receive(INIT_REPLY)
    return gate


def started():
    gate = initialized()
    gate.admit(INITIALIZED)
    gate.admit(g.start_request())
    flush(gate)
    gate.receive(START_REPLY)
    return gate


def test_exact_rewrite_is_inner_argv_with_clean_env_and_fixed_sandbox():
    gate = initialized()
    gate.admit(INITIALIZED)
    request = g.start_request()
    original = copy.deepcopy(request)
    gate.admit(request)
    frames = [g.strict_json(line) for line in flush(gate).splitlines()]
    assert frames[0] == INITIALIZED
    rewritten = frames[1]['params']
    assert rewritten['argv'] == g.TRAMPOLINE_ARGV
    assert rewritten['sandbox'] == g.fixed_sandbox()
    assert rewritten['env'] == {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/work/exec-worker',
        'TMPDIR': '/work/exec-worker/tmp', 'RC_EXEC_OUTER_PID_NS': 'pid:[1]', 'RC_EXEC_OUTER_MOUNT_NS': 'mnt:[2]'}
    assert request == original  # No caller-owned mutation or environment inheritance.
    assert gate.initialized and gate.started


def test_coalesced_initialized_start_partial_write_has_actual_delivery_fence():
    gate = initialized()
    gate.admit(INITIALIZED); gate.admit(g.start_request())
    with patch.object(g.os, 'write', side_effect=[BlockingIOError(), len(g.encode(INITIALIZED))]):
        gate.drain(42)
        assert not gate.initialized and not gate.started
        gate.drain(42)
    assert gate.initialized and not gate.started
    assert gate.awaiting is None
    with pytest.raises(ValueError): gate.receive(START_REPLY)
    with patch.object(g.os, 'write') as write: gate.drain(42)
    write.assert_not_called()


@pytest.mark.parametrize('method', ['fs/readFile', 'fs/open', 'http/request', 'account/login/start', 'auth/read',
    'environment/info', 'capabilityRoots/discoverV1', 'process/write', 'process/signal', 'unknown'])
def test_unknown_or_out_of_scope_rpc_never_forwards(method):
    gate = started()
    with pytest.raises(ValueError): gate.admit({'id': 3, 'method': method, 'params': {}})
    with patch.object(g.os, 'write') as write: gate.drain(42)
    write.assert_not_called()


@pytest.mark.parametrize('key,value', [('argv', ['/bin/sh']), ('env', {'TOKEN': 'not-a-secret-fixture'}),
    ('envPolicy', {'inherit': 'all'}), ('sandbox', None), ('cwd', 'file:///'), ('tty', True),
    ('pipeStdin', True), ('arg0', 'codex-linux-sandbox'), ('enforceManagedNetwork', True),
    ('managedNetwork', {}), ('networkProxy', {})])
def test_start_profile_changes_fail_before_forwarding(key, value):
    gate = initialized(); gate.admit(INITIALIZED)
    request = g.start_request(); request['params'][key] = value
    with pytest.raises(ValueError): gate.admit(request)
    with patch.object(g.os, 'write') as write: gate.drain(42)
    write.assert_not_called()


def test_sandbox_default_denies_root_and_auth_home_and_forbids_legacy_fallback():
    sandbox = g.fixed_sandbox()
    paths = {entry['path']['path']: entry['access'] for entry in sandbox['permissions']['file_system']['entries']}
    assert paths['file:///'] == paths['file:///private'] == paths['file:///work/executor-home'] == 'deny'
    assert paths['file:///usr'] == paths['file:///proc'] == 'read'
    assert paths['file:///work/exec-worker'] == 'write'
    assert sandbox['permissions']['network'] == 'restricted'
    assert sandbox['useLegacyLandlock'] is False


@pytest.mark.parametrize('case', ['bool-id', 'duplicate-id', 'jsonrpc', 'resume', 'start-before-init'])
def test_handshake_and_envelope_are_strict(case):
    gate = fresh(); frame = g.initialize_request()
    if case == 'bool-id': frame['id'] = True
    if case == 'duplicate-id': frame['id'] = 2
    if case == 'jsonrpc': frame['jsonrpc'] = '2.0'
    if case == 'resume': frame['params']['resumeSessionId'] = 'old-session'
    if case == 'start-before-init': frame = g.start_request()
    with pytest.raises(ValueError): gate.admit(frame)


def test_reply_requires_full_actual_write_and_exact_session_response():
    gate = fresh(); gate.admit(g.initialize_request())
    with pytest.raises(ValueError): gate.receive(INIT_REPLY)
    gate = fresh(); gate.admit(g.initialize_request()); flush(gate)
    with pytest.raises(ValueError): gate.receive({'id': 1, 'result': {}})  # README example is stale.


def test_one_fixed_process_lifecycle_and_monotonic_bound_identity():
    gate = started()
    for frame in (OUTPUT, EXITED, CLOSED): gate.receive(frame)
    assert gate.closed and gate.exited
    with pytest.raises(ValueError): gate.admit(g.start_request())


@pytest.mark.parametrize('case', ['foreign-process', 'duplicate-seq', 'pty', 'bad-base64', 'unknown-notification', 'request-from-server', 'closed-before-exit'])
def test_invalid_process_output_cannot_gain_lifecycle_credit(case):
    gate = started(); frame = copy.deepcopy(OUTPUT)
    if case == 'foreign-process': frame['params']['processId'] = 'other'
    if case == 'duplicate-seq': gate.receive(OUTPUT)
    if case == 'pty': frame['params']['stream'] = 'pty'
    if case == 'bad-base64': frame['params']['chunk'] = '@@@'
    if case == 'unknown-notification': frame['method'] = 'http/request/bodyDelta'
    if case == 'request-from-server': frame['id'] = 5
    if case == 'closed-before-exit': frame = CLOSED
    with pytest.raises(ValueError): gate.receive(frame)
    assert not gate.closed


def test_bounded_read_and_terminate_requests_only_for_own_handle():
    gate = started(); gate.admit(g.read_request(3)); flush(gate)
    gate.receive({'id': 3, 'result': {'chunks': [{'seq': 1, 'stream': 'stdout', 'chunk': 'e30K'}],
        'nextSeq': 2, 'exited': False, 'exitCode': None, 'closed': False, 'failure': None, 'sandboxDenied': False}})
    gate.admit(g.terminate_request(4)); flush(gate)
    gate.receive({'id': 4, 'result': {'running': True}})
    request = g.read_request(5); request['params']['maxBytes'] = 1000000
    with pytest.raises(ValueError): gate.admit(request)


@pytest.mark.parametrize('raw', [b'{"id":1,"id":1}', b'{"id":NaN}', b'\xff'])
def test_json_rejects_duplicate_nonfinite_and_invalid_utf8(raw):
    with pytest.raises(ValueError): g.strict_json(raw)


@pytest.mark.parametrize('reject', [False, True])
@pytest.mark.parametrize('metadata', [False, True])
def test_actual_stdio_loop_mock_preserves_raw_and_refuses_bad_request_without_dispatch(reject, metadata, tmp_path, backpressure=False):
    profile = 'environment-bootstrap-metadata' if metadata == 'bootstrap' else 'environment-metadata' if metadata else 'direct'
    process = SimpleNamespace(pid=123, returncode=None)
    process.poll = lambda: process.returncode
    class Stream:
        def __init__(self, fd): self.fd, self.closed = fd, False
        def fileno(self): return self.fd
        def close(self):
            self.closed = True
            if self.fd == 10: process.returncode = 0
    process.stdin, process.stdout, process.stderr = Stream(10), Stream(11), Stream(12)
    server_end = g.encode(START_REPLY) + g.encode(OUTPUT) + g.encode(EXITED) + g.encode(CLOSED)
    if metadata: server_end = g.encode(INFO_REPLY)
    turns = [[0], [11, 12], [0], [11], [0], [11, 12]] if reject is not True else [[0], [11, 12]]
    chunks = {0: [g.encode(g.initialize_request()), g.encode(INITIALIZED) + g.encode(g.start_request()), b''],
        11: [g.encode(INIT_REPLY), server_end, b''], 12: [b'fixed server stderr\n', b'']}
    if metadata: chunks[0] = [g.encode(g.environment_initialize_request()), g.encode(INITIALIZED) + g.encode(g.environment_info_request(2)), b'']
    if metadata == 'bootstrap':
        turns = [[0], [11, 12], [0], [11], [0], [11], [0], [11], [0], [11, 12]]
        chunks[0].insert(2, g.encode(g.environment_bootstrap_stat_request(3)))
        chunks[11].insert(2, g.encode(STAT_REPLY))
        chunks[0].insert(3, g.encode(g.environment_bootstrap_stat_request(4, g.BOOTSTRAP_PATHS[1])))
        chunks[11].insert(3, g.encode(STAT_REPLY2))
        server_end += g.encode(STAT_REPLY) + g.encode(STAT_REPLY2)
    if reject is True: chunks = {0: [g.encode({'id': 1, 'method': 'fs/readFile', 'params': {}})], 11: [b''], 12: [b'']}
    if reject == 'late': chunks[0][-1] = g.encode({'id': 3, 'method': 'fs/readFile', 'params': {}})
    pressure = {'stage': 0, 'used': False}
    class Selector:
        def __init__(self): self.keys = {}
        def register(self, fd, _events, data): self.keys[fd] = SimpleNamespace(fd=fd, data=data)
        def unregister(self, fd): del self.keys[fd]
        def get_map(self): return self.keys
        def close(self): pass
        def select(self, _timeout):
            if pressure['stage'] in (1, 2): return []
            assert turns, 'unexpected loop'
            return [(self.keys[fd], 1) for fd in turns.pop(0) if fd in self.keys]
    writes = {1: bytearray(), 2: bytearray(), 10: bytearray()}
    def write(fd, raw):
        if backpressure and fd == 1 and not pressure['used'] and b'"id":4' in raw:
            pressure.update(stage=1, used=True)
            writes[fd].extend(raw[:1]); return 1
        if fd == 1 and pressure['stage'] == 1:
            pressure['stage'] = 2
            assert not (tmp_path / (profile + '-trace.json')).exists()
            raise BlockingIOError()
        if fd == 1 and pressure['stage'] == 2:
            assert not (tmp_path / (profile + '-trace.json')).exists()
            pressure['stage'] = 0
        writes[fd].extend(raw); return len(raw)
    original_publish = g.publish_metadata_report
    def publish(report):
        if metadata == 'bootstrap' and report['phase'] == 'protocol-complete':
            assert bytes(writes[1]) == g.encode(INIT_REPLY) + server_end
        return original_publish(report)
    with patch.object(g, 'publish_metadata_report', side_effect=publish), patch.object(g.subprocess, 'Popen', return_value=process) as spawn, patch.object(g.os, 'pidfd_open', return_value=42, create=True), \
         patch.object(g.os, 'close'), patch.object(g.os, 'set_blocking'), patch.object(g.os, 'read', side_effect=lambda fd, _count: chunks[fd].pop(0)), \
         patch.object(g.os, 'write', side_effect=write), patch.object(g.selectors, 'DefaultSelector', Selector), patch.object(g, 'HOME', str(tmp_path) if metadata else g.HOME), \
         patch.object(g.os, 'lstat', side_effect=FileNotFoundError):
        assert g.run_gate(p, {'fixed': 'unit-env'}, 'pid:[1]', 'mnt:[2]', profile) == (1 if reject else 0), bytes(writes[2])
    if metadata:
        terminal_report = g.strict_json((tmp_path / (profile + '-terminal.json')).read_bytes())
        report = terminal_report if reject else g.strict_json((tmp_path / (profile + '-trace.json')).read_bytes())
        assert report['complete'] is (not reject)
        validator = g.validate_environment_bootstrap_metadata_report if metadata == 'bootstrap' else g.validate_environment_metadata_report
        assert validator(report, terminal_report) is (not reject)
        if reject is True: assert not (tmp_path / 'environment-metadata-trace.json').exists()
        elif reject == 'late':
            snapshot = g.strict_json((tmp_path / 'environment-metadata-trace.json').read_bytes())
            assert snapshot['complete'] and snapshot['phase'] == 'protocol-complete'
            assert terminal_report['error'] == 'PROTOCOL_REFUSED'
            rejected = terminal_report['rejectedRequest']
            assert g.validate_rejected_request_evidence(rejected)
            assert rejected['knownMethod'] == 'fs/readFile' and rejected['requestId'] == 3
            assert not any(entry['frame'].get('method') == 'fs/readFile' for entry in snapshot['history'])
            assert not g.validate_environment_metadata_report(snapshot, terminal_report)
        else: assert report['localReturnCode'] is None and terminal_report['localReturnCode'] == 0
        assert report['remoteCleanup'] == 'not-attested-by-gate'
        assert report['history'] == ([] if reject is True else [
            {'direction': 'request', 'frame': g.environment_initialize_request()}, {'direction': 'response', 'frame': INIT_REPLY},
            {'direction': 'request', 'frame': INITIALIZED}, {'direction': 'request', 'frame': g.environment_info_request(2)},
            {'direction': 'response', 'frame': INFO_REPLY}] + ([{'direction': 'request', 'frame': g.environment_bootstrap_stat_request(3)},
                {'direction': 'response', 'frame': STAT_REPLY},
                {'direction': 'request', 'frame': g.environment_bootstrap_stat_request(4, g.BOOTSTRAP_PATHS[1])},
                {'direction': 'response', 'frame': STAT_REPLY2}] if metadata == 'bootstrap' else []))
    if backpressure: assert pressure['used'] and pressure['stage'] == 0
    assert spawn.call_args.args[0][-3:] == ('exec-server', '--listen', 'stdio')
    assert spawn.call_args.kwargs['env'] == {'fixed': 'unit-env'}
    if reject is True:
        assert not writes[10] and not writes[1]
    else:
        assert writes[1] == g.encode(INIT_REPLY) + server_end
        if reject == 'late': assert b'PROTOCOL_REFUSED' in writes[2]
        else: assert writes[2] == b'fixed server stderr\n'
        forwarded = [g.strict_json(raw) for raw in writes[10].splitlines()]
        if metadata == 'bootstrap': assert forwarded[-1] == g.environment_bootstrap_stat_request(4, g.BOOTSTRAP_PATHS[1])
        elif metadata: assert forwarded[-1] == g.environment_info_request(2)
        else: assert forwarded[-1]['params']['argv'] == g.TRAMPOLINE_ARGV


def test_metadata_actual_loop_publishes_late_refusal_without_rewriting_snapshot(tmp_path):
    test_actual_stdio_loop_mock_preserves_raw_and_refuses_bad_request_without_dispatch('late', True, tmp_path)


def test_bootstrap_actual_loop_forwards_real_enoent_and_publishes_only_after_stat_reply(tmp_path):
    test_actual_stdio_loop_mock_preserves_raw_and_refuses_bad_request_without_dispatch(False, 'bootstrap', tmp_path)


def metadata_initialized():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'environment-metadata')
    gate.admit(g.environment_initialize_request()); flush(gate); gate.receive(INIT_REPLY)
    return gate


def test_metadata_trace_preserved_and_info_response_requires_complete_actual_write():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'environment-metadata')
    frame = g.environment_initialize_request(); frame['trace'] = {'traceparent': '00-' + 'a'*32 + '-' + 'b'*16 + '-01'}
    gate.admit(frame)
    assert not gate.history
    assert g.strict_json(flush(gate)) == frame
    gate.receive(INIT_REPLY); gate.admit(INITIALIZED); gate.admit(g.environment_info_request(2))
    with patch.object(g.os, 'write', return_value=1): gate.drain(42)
    with pytest.raises(ValueError, match='EXEC_RESPONSE_ORDER'): gate.receive(INFO_REPLY)
    assert not gate.complete


@pytest.mark.parametrize('frame', [g.start_request(), g.read_request(2), g.terminate_request(2),
    {'id': 2, 'method': 'fs/readFile', 'params': None}, {'id': 2, 'method': 'http/request', 'params': None},
    {'id': 2, 'method': 'account/login/start', 'params': None}, {'id': 2, 'method': 'environment/info', 'params': {}},
    {'id': 2, 'method': 'environment/info', 'params': None, 'trace': {'secret': 'x'}},
    {'id': 2, 'method': 'environment/info', 'params': None, 'trace': {'traceparent': '\n'}},
    {'id': 2, 'method': 'environment/info', 'params': None, 'trace': {'tracestate': 'x'*513}}])
def test_metadata_rejects_foreign_rpc_or_payload_before_write(frame):
    gate = metadata_initialized(); gate.admit(INITIALIZED); flush(gate)
    with pytest.raises(ValueError): gate.admit(frame)
    assert not gate.pending


@pytest.mark.parametrize('case', ['env-map', 'cwd', 'shell-path', 'shell-name', 'capability-int', 'extra-capability'])
def test_metadata_info_strict_shape_and_capsule_paths(case):
    gate = metadata_initialized(); gate.admit(INITIALIZED); gate.admit(g.environment_info_request(2)); flush(gate)
    frame = copy.deepcopy(INFO_REPLY); value = frame['result']
    if case == 'env-map': value['environment'] = {}
    if case == 'cwd': value['cwd'] = 'file:///home/host'
    if case == 'shell-path': value['shell']['path'] = '/private/bash'
    if case == 'shell-name': value['shell']['name'] = 'arbitrary'
    if case == 'capability-int': value['capabilities']['networkProxyLaunch'] = 1
    if case == 'extra-capability': value['capabilities']['execute'] = True
    with pytest.raises(ValueError): gate.receive(frame)
    assert not gate.complete


def test_profiles_do_not_accept_each_others_initialization_and_history_is_bounded():
    with pytest.raises(ValueError): fresh().admit(g.environment_initialize_request())
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'environment-metadata')
    with pytest.raises(ValueError): gate.admit(g.initialize_request())
    gate = metadata_initialized()
    gate.history = [{'direction': 'request', 'frame': {'bounded': 'x'*24576}}]
    with pytest.raises(ValueError, match='HISTORY_LIMIT'): gate.record('response', INFO_REPLY)


@pytest.mark.parametrize('case', ['complete-int', 'return-bool', 'model-bool', 'missing-info', 'reordered', 'foreign-method', 'extra'])
def test_metadata_offline_report_replay_rejects_incomplete_or_tampered_claims(case):
    report = {'version': 1, 'profile': 'environment-metadata', 'phase': 'protocol-complete', 'complete': True, 'error': None,
        'localReturnCode': None, 'modelCalls': 0, 'productionReady': False, 'remoteCleanup': 'not-attested-by-gate',
        'history': [{'direction': 'request', 'frame': g.environment_initialize_request()},
            {'direction': 'response', 'frame': INIT_REPLY}, {'direction': 'request', 'frame': INITIALIZED},
            {'direction': 'request', 'frame': g.environment_info_request(2)}, {'direction': 'response', 'frame': INFO_REPLY}]}
    assert g.validate_environment_metadata_report(report)
    if case == 'complete-int': report['complete'] = 1
    if case == 'return-bool': report['localReturnCode'] = False
    if case == 'model-bool': report['modelCalls'] = False
    if case == 'missing-info': report['history'] = report['history'][:3]
    if case == 'reordered': report['history'][0], report['history'][1] = report['history'][1], report['history'][0]
    if case == 'foreign-method': report['history'][3] = {'direction': 'request', 'frame': g.start_request()}
    if case == 'extra': report['credentialClaim'] = True
    assert not g.validate_environment_metadata_report(report)


def test_atomic_snapshot_survives_later_failure_and_cannot_be_overwritten(tmp_path):
    gate = metadata_initialized(); gate.admit(INITIALIZED); gate.admit(g.environment_info_request(2)); flush(gate); gate.receive(INFO_REPLY)
    snapshot = g.metadata_report(gate, 'protocol-complete', True, None, None)
    with patch.object(g, 'HOME', str(tmp_path)):
        g.publish_metadata_report(snapshot)
        before = (tmp_path / 'environment-metadata-trace.json').read_bytes()
        failed = g.metadata_report(gate, 'terminal', False, 'PROTOCOL_REFUSED', None)
        g.publish_metadata_report(failed)
        assert (tmp_path / 'environment-metadata-trace.json').read_bytes() == before
        assert g.validate_environment_metadata_report(snapshot)
        assert not g.validate_environment_metadata_report(snapshot, failed)
        with pytest.raises(FileExistsError): g.publish_metadata_report(snapshot)
        assert (tmp_path / 'environment-metadata-trace.json').read_bytes() == before


@pytest.mark.parametrize('case', ['error', 'unknown-exit', 'nonzero', 'history-drift', 'incomplete'])
def test_present_terminal_cannot_hide_known_late_error_or_identity_drift(case):
    gate = metadata_initialized(); gate.admit(INITIALIZED); gate.admit(g.environment_info_request(2)); flush(gate); gate.receive(INFO_REPLY)
    snapshot = g.metadata_report(gate, 'protocol-complete', True, None, None)
    terminal = copy.deepcopy(g.metadata_report(gate, 'terminal', True, None, 0))
    assert g.validate_environment_metadata_report(snapshot, terminal)
    if case == 'error': terminal['error'] = 'PROTOCOL_REFUSED'
    if case == 'unknown-exit': terminal['localReturnCode'] = None
    if case == 'nonzero': terminal['localReturnCode'] = -15
    if case == 'history-drift': terminal['history'][0]['frame']['params']['clientName'] = 'foreign'
    if case == 'incomplete': terminal['complete'] = False
    assert not g.validate_environment_metadata_report(snapshot, terminal)


def test_rejected_structural_projection_preserves_digest_without_secret_body_or_unknown_names():
    secret = 'synthetic-secret-value-never-retained'
    frame = {'id': 3, 'method': 'fs/getMetadata', 'params': {'path': 'file:///work/exec-worker/AGENTS.md',
        'env': {'BEARER': secret}, 'body': secret, secret: secret}}
    gate = metadata_initialized(); gate.admit(INITIALIZED); flush(gate)
    gate.admit(g.environment_info_request(2)); flush(gate); gate.receive(INFO_REPLY)
    with pytest.raises(ValueError): gate.admit(frame)
    rejected = gate.rejected_request
    assert rejected == {'kind': 'received-parsed-request-not-forwarded', 'canonicalBytes': len(g.encode(frame)),
        'canonicalSha256': g.hashlib.sha256(g.encode(frame)).hexdigest(), 'frameBodyOmitted': True,
        'validationCode': 'EXEC_REQUEST_REFUSED', 'knownMethod': 'fs/getMetadata', 'requestId': 3,
        'knownParameterKeys': ['body', 'env', 'path'], 'unknownParameterKeyCount': 1,
        'safePaths': {'path': 'file:///work/exec-worker/AGENTS.md'}}
    assert g.validate_rejected_request_evidence(rejected)
    assert secret.encode() not in g.encode(rejected)
    assert not gate.pending and not any(x['frame'].get('method') == 'fs/getMetadata' for x in gate.history)
    omitted = g.rejected_request_evidence({'id': secret, 'method': secret, 'params': {'path': '/private/' + secret}}, ValueError('unknown'))
    assert omitted['knownMethod'] is None and omitted['requestId'] is None and omitted['safePaths'] == {}
    assert secret.encode() not in g.encode(omitted)


@pytest.mark.parametrize('key,value', [('canonicalBytes', True), ('canonicalSha256', 'z'*64), ('frameBodyOmitted', 1),
    ('knownMethod', 'account/login/start'), ('requestId', True), ('knownParameterKeys', ['body', 'body']),
    ('unknownParameterKeyCount', -1), ('safePaths', {'path': '/private/credentials'}), ('validationCode', 'arbitrary')])
def test_rejected_projection_strict_schema_rejects_malformed_or_sensitive_extensions(key, value):
    receipt = g.rejected_request_evidence({'id': 3, 'method': 'fs/readFile', 'params': None}, ValueError('EXEC_REQUEST_REFUSED'))
    receipt[key] = value
    assert not g.validate_rejected_request_evidence(receipt)


def test_rejected_projection_large_unknown_body_remains_small_and_no_permission_is_added():
    frame = {'id': 3, 'method': 'http/request', 'params': {'body': 'x'*60000}}
    receipt = g.rejected_request_evidence(frame, ValueError('EXEC_REQUEST_REFUSED'))
    assert receipt['canonicalBytes'] > 60000 and len(g.encode(receipt)) < 1024
    assert g.validate_rejected_request_evidence(receipt)
    gate = metadata_initialized(); gate.admit(INITIALIZED); flush(gate)
    with pytest.raises(ValueError): gate.admit(frame)
    assert not gate.pending


def bootstrap_info():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'environment-bootstrap-metadata')
    gate.admit(g.environment_initialize_request()); flush(gate); gate.receive(INIT_REPLY)
    gate.admit(INITIALIZED); flush(gate)
    gate.admit(g.environment_info_request(2)); flush(gate); gate.receive(INFO_REPLY)
    assert not gate.complete
    return gate


def test_bootstrap_stat_actual_write_order_raw_reply_and_single_use():
    gate = bootstrap_info()
    request = g.environment_bootstrap_stat_request(3)
    request['trace'] = {'traceparent': 'bounded-observed-trace'}
    gate.admit(request)
    with patch.object(g.os, 'write', return_value=1): gate.drain(42)
    with pytest.raises(ValueError, match='RESPONSE_ORDER'): gate.receive(STAT_REPLY)
    assert gate.failed and not gate.complete
    gate = bootstrap_info(); gate.admit(request)
    flush(gate); gate.receive(STAT_REPLY)
    assert not gate.complete
    assert gate.history[-2:] == [{'direction': 'request', 'frame': request}, {'direction': 'response', 'frame': STAT_REPLY}]
    with pytest.raises(ValueError): gate.admit(g.environment_bootstrap_stat_request(4))
    assert not gate.pending


@pytest.mark.parametrize('case', ['path', 'parent', 'sandbox', 'extra', 'fs', 'process', 'auth'])
def test_bootstrap_refuses_other_paths_and_methods_before_write(case):
    gate = bootstrap_info(); frame = g.environment_bootstrap_stat_request(3)
    if case == 'path': frame['params']['path'] = 'file:///work/.agents/skills/child'
    if case == 'parent': frame['params']['path'] = 'file:///work/.agents/../private'
    if case == 'sandbox': frame['params']['sandbox'] = {}
    if case == 'extra': frame['params']['follow'] = True
    if case == 'fs': frame['method'] = 'fs/readFile'
    if case == 'process': frame['method'] = 'process/start'
    if case == 'auth': frame['method'] = 'account/login/start'
    with pytest.raises(ValueError): gate.admit(frame)
    assert not gate.pending


def test_bootstrap_stat_before_info_and_old_profile_always_refuse():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'environment-bootstrap-metadata')
    with pytest.raises(ValueError): gate.admit(g.environment_bootstrap_stat_request(1))
    gate = metadata_initialized(); gate.admit(INITIALIZED); flush(gate)
    gate.admit(g.environment_info_request(2)); flush(gate); gate.receive(INFO_REPLY)
    with pytest.raises(ValueError): gate.admit(g.environment_bootstrap_stat_request(3))
    assert not gate.pending


@pytest.mark.parametrize('case', ['code', 'bool', 'data', 'missing', 'empty', 'large', 'type', 'success'])
def test_bootstrap_requires_actual_exact_bounded_enoent(case):
    gate = bootstrap_info(); gate.admit(g.environment_bootstrap_stat_request(3)); flush(gate)
    frame = copy.deepcopy(STAT_REPLY)
    if case == 'code': frame['error']['code'] = -32000
    if case == 'bool': frame['error']['code'] = True
    if case == 'data': frame['error']['data'] = None
    if case == 'missing': del frame['error']['message']
    if case == 'empty': frame['error']['message'] = ''
    if case == 'large': frame['error']['message'] = '\u20ac' * 683
    if case == 'type': frame['error']['message'] = 1
    if case == 'success': frame = {'id': 3, 'result': {'isDirectory': True}}
    with pytest.raises(ValueError, match='EXPECTED_ENOENT'): gate.receive(frame)
    assert not gate.complete


@pytest.mark.parametrize('observed', [SimpleNamespace(st_mode=0o100600), SimpleNamespace(st_mode=0o40700), SimpleNamespace(st_mode=0o120777), PermissionError('denied')])
def test_bootstrap_existing_entry_or_failed_lstat_refuses_before_spawn(observed):
    with patch.object(g.os, 'lstat', side_effect=observed if isinstance(observed, Exception) else None, return_value=observed) as lookup, patch.object(g.subprocess, 'Popen') as spawn:
        with pytest.raises((ValueError, PermissionError)):
            g.run_gate(p, {}, 'pid:[1]', 'mnt:[2]', 'environment-bootstrap-metadata')
        lookup.assert_called_once_with('/work/.agents')
        spawn.assert_not_called()


def test_bootstrap_report_requires_stat_and_cannot_relabel_old_profile():
    gate = bootstrap_info()
    incomplete = g.metadata_report(gate, 'protocol-complete', True, None, None)
    assert not g.validate_environment_bootstrap_metadata_report(incomplete)
    gate.admit(g.environment_bootstrap_stat_request(3)); flush(gate); gate.receive(STAT_REPLY)
    assert not gate.complete
    gate.admit(g.environment_bootstrap_stat_request(4, g.BOOTSTRAP_PATHS[1])); flush(gate); gate.receive(STAT_REPLY2)
    report = g.metadata_report(gate, 'protocol-complete', True, None, None)
    assert g.validate_environment_bootstrap_metadata_report(report)
    assert not g.validate_environment_metadata_report(report)
    changed = copy.deepcopy(report); changed['profile'] = 'environment-metadata'
    assert not g.validate_environment_metadata_report(changed)
    terminal = g.metadata_report(gate, 'terminal', False, 'PROTOCOL_REFUSED', None)
    assert not g.validate_environment_bootstrap_metadata_report(report, terminal)


@pytest.mark.parametrize('paths', [g.BOOTSTRAP_PATHS, tuple(reversed(g.BOOTSTRAP_PATHS))])
def test_bootstrap_two_distinct_paths_complete_only_after_both_replies(paths):
    gate = bootstrap_info()
    for identifier, path in enumerate(paths, 3):
        gate.admit(g.environment_bootstrap_stat_request(identifier, path)); flush(gate)
        assert not gate.complete
        gate.receive({'id': identifier, 'error': {'code': -32004, 'message': 'actual bounded ENOENT'}})
        assert gate.complete is (identifier == 4)
    with pytest.raises(ValueError): gate.admit(g.environment_bootstrap_stat_request(5, paths[1]))
    assert not gate.pending


def test_bootstrap_second_absence_check_fails_before_spawn():
    with patch.object(g.os, 'lstat', side_effect=[FileNotFoundError(), SimpleNamespace(st_mode=0o120777)]) as lookup, patch.object(g.subprocess, 'Popen') as spawn:
        with pytest.raises(ValueError, match='AGENTS_MUST_BE_ABSENT'):
            g.run_gate(p, {}, 'pid:[1]', 'mnt:[2]', 'environment-bootstrap-metadata')
        assert [call.args[0] for call in lookup.call_args_list] == ['/work/.agents', '/work/exec-worker/.agents']
        spawn.assert_not_called()


def test_bootstrap_unexpected_second_response_does_not_complete():
    gate = bootstrap_info(); gate.admit(g.environment_bootstrap_stat_request(3)); flush(gate); gate.receive(STAT_REPLY)
    gate.admit(g.environment_bootstrap_stat_request(4, g.BOOTSTRAP_PATHS[1])); flush(gate)
    with pytest.raises(ValueError, match='RESPONSE_ORDER'): gate.receive(STAT_REPLY)
    assert not gate.complete


def test_bootstrap_snapshot_waits_for_partial_write_and_eagain(tmp_path):
    test_actual_stdio_loop_mock_preserves_raw_and_refuses_bad_request_without_dispatch(False, 'bootstrap', tmp_path, backpressure=True)


def control_initialized():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'trusted-control-boundary')
    gate.admit(g.initialize_request()); flush(gate); gate.receive(INIT_REPLY)
    gate.admit(INITIALIZED); flush(gate)
    return gate


def test_control_start_fixed_policy_rewrite_and_same_owned_lifecycle():
    gate = control_initialized(); request = g.control_start_request()
    original = copy.deepcopy(request)
    gate.admit(request); actual = g.strict_json(flush(gate))
    assert request == original
    assert actual['params']['argv'] == g.CONTROL_TRAMPOLINE_ARGV
    assert actual['params']['env'] == gate.worker_env
    old = g.start_request()['params']['sandbox']['permissions']['file_system']['entries']
    entries = actual['params']['sandbox']['permissions']['file_system']['entries']
    assert entries == old + [
        {'path': {'type': 'path', 'path': 'file:///work/trusted-control-boundary.json'}, 'access': 'read'},
        {'path': {'type': 'path', 'path': 'file:///work/environment-appserver-home'}, 'access': 'deny'}]
    gate.receive(START_REPLY); gate.admit(g.terminate_request(3)); flush(gate)
    gate.receive({'id': 3, 'result': {'running': True}})
    gate.receive(EXITED); gate.receive(CLOSED)
    assert gate.complete and not gate.is_metadata


@pytest.mark.parametrize('case', ['old', 'argv', 'marker-write', 'home-read', 'env', 'fs', 'foreign-process'])
def test_control_gate_refuses_caller_policy_or_operation_changes(case):
    gate = control_initialized(); frame = g.control_start_request()
    if case == 'old': frame = g.start_request()
    if case == 'argv': frame['params']['argv'].append('arbitrary')
    if case == 'marker-write': frame['params']['sandbox']['permissions']['file_system']['entries'][-2]['access'] = 'write'
    if case == 'home-read': frame['params']['sandbox']['permissions']['file_system']['entries'][-1]['access'] = 'read'
    if case == 'env': frame['params']['env']['HOME'] = '/private'
    if case == 'fs': frame = {'id': 2, 'method': 'fs/readFile', 'params': {'path': 'file:///work/trusted-control-boundary.json'}}
    if case == 'foreign-process': frame['params']['processId'] = 'foreign'
    with pytest.raises(ValueError): gate.admit(frame)
    assert not gate.pending


def test_old_gate_refuses_control_request_and_request_factory_is_fresh():
    gate = initialized(); gate.admit(INITIALIZED); flush(gate)
    with pytest.raises(ValueError): gate.admit(g.control_start_request())
    request = g.control_start_request(); request['params']['argv'].clear()
    assert g.control_start_request()['params']['argv'] == g.CONTROL_PROBE_ARGV


@pytest.mark.parametrize('case', ['valid', 'symlink', 'fifo', 'large', 'empty', 'drift', 'open-denied'])
def test_control_marker_metadata_no_content_read_and_fail_closed(case):
    info = SimpleNamespace(st_mode=0o100600, st_size=200, st_dev=1, st_ino=2, st_mtime_ns=3)
    if case == 'symlink': info.st_mode = 0o120777
    if case == 'fifo': info.st_mode = 0o10600
    if case == 'large': info.st_size = 4097
    if case == 'empty': info.st_size = 0
    after = copy.copy(info)
    if case == 'drift': after.st_ino = 99
    with patch.object(g.os, 'lstat', side_effect=[info, after]), patch.object(g.os, 'O_NOFOLLOW', 0x20000, create=True), \
         patch.object(g.os, 'O_NONBLOCK', 0x800, create=True), patch.object(g.os, 'open', return_value=42, side_effect=PermissionError() if case == 'open-denied' else None) as opened, \
         patch.object(g.os, 'fstat', return_value=info), patch.object(g.os, 'close') as closed, patch.object(g.os, 'read') as read:
        if case == 'valid':
            g.verify_control_marker()
            assert opened.call_args.args == (g.CONTROL_MARKER, g.os.O_RDONLY | g.os.O_NOFOLLOW | g.os.O_NONBLOCK)
            closed.assert_called_once_with(42)
        else:
            with pytest.raises((ValueError, PermissionError)): g.verify_control_marker()
        read.assert_not_called()


def test_control_marker_missing_prevents_process_spawn():
    with patch.object(g.os, 'lstat', side_effect=FileNotFoundError()), patch.object(g.subprocess, 'Popen') as spawn:
        with pytest.raises(FileNotFoundError): g.run_gate(p, {}, 'pid:[1]', 'mnt:[2]', 'trusted-control-boundary')
        spawn.assert_not_called()


def ingress_initialized():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'trusted-ingress-boundary')
    gate.admit(g.initialize_request()); flush(gate); gate.receive(INIT_REPLY)
    gate.admit(INITIALIZED); flush(gate)
    return gate


def test_ingress_profile_rewrites_only_fixed_worker_and_exact_separate_marker():
    gate = ingress_initialized()
    request = g.ingress_start_request(); original = copy.deepcopy(request)
    gate.admit(request); actual = g.strict_json(flush(gate))
    assert request == original
    assert actual['params']['argv'] == g.INGRESS_TRAMPOLINE_ARGV
    assert actual['params']['env'] == gate.worker_env
    assert '198' not in actual['params']['env'].values()
    assert actual['params']['sandbox']['permissions']['file_system']['entries'][-2:] == [
        {'path': {'type': 'path', 'path': 'file:///work/trusted-ingress-boundary.json'}, 'access': 'read'},
        {'path': {'type': 'path', 'path': 'file:///work/environment-appserver-home'}, 'access': 'deny'}]
    gate.receive(START_REPLY); gate.admit(g.read_request(3, 1)); flush(gate)
    assert gate.started


@pytest.mark.parametrize('case', ['control-profile', 'direct-profile', 'old-request', 'marker-write', 'home-read', 'fd-env', 'arbitrary-argv'])
def test_ingress_admission_rejects_cross_profile_or_descriptor_import(case):
    gate = control_initialized() if case == 'control-profile' else initialized() if case == 'direct-profile' else ingress_initialized()
    request = g.ingress_start_request()
    if case == 'old-request': request = g.control_start_request()
    if case == 'marker-write': request['params']['sandbox']['permissions']['file_system']['entries'][-2]['access'] = 'write'
    if case == 'home-read': request['params']['sandbox']['permissions']['file_system']['entries'][-1]['access'] = 'read'
    if case == 'fd-env': request['params']['env']['FD'] = '198'
    if case == 'arbitrary-argv': request['params']['argv'].append('198')
    with pytest.raises(ValueError): gate.admit(request)
    assert not gate.pending


def test_ingress_missing_marker_prevents_stock_executor_spawn():
    with patch.object(g.os, 'lstat', side_effect=FileNotFoundError()) as lookup, patch.object(g.subprocess, 'Popen') as spawn:
        with pytest.raises(FileNotFoundError): g.run_gate(p, {}, 'pid:[1]', 'mnt:[2]', 'trusted-ingress-boundary')
        lookup.assert_called_once_with(g.INGRESS_MARKER)
        spawn.assert_not_called()


def http_ingress_initialized():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'trusted-http-ingress-boundary')
    gate.admit(g.initialize_request()); flush(gate); gate.receive(INIT_REPLY)
    gate.admit(INITIALIZED); flush(gate)
    return gate


def cgroup_initialized():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'trusted-cgroup-worker-boundary')
    gate.admit(g.initialize_request()); flush(gate); gate.receive(INIT_REPLY)
    gate.admit(INITIALIZED); flush(gate)
    return gate


def test_cgroup_fixed_entry_preserves_control_policy_without_host_cgroup_mount():
    gate = cgroup_initialized()
    request = g.cgroup_start_request(); original = copy.deepcopy(request)
    assert request['params']['sandbox'] == g.control_start_request()['params']['sandbox']
    gate.admit(request); actual = g.strict_json(flush(gate))
    assert request == original
    assert actual['params']['argv'] == g.CGROUP_TRAMPOLINE_ARGV
    assert actual['params']['env'] == gate.worker_env
    assert actual['params']['sandbox'] == request['params']['sandbox']
    gate.receive(START_REPLY); gate.admit(g.read_request(3, 1)); flush(gate)
    assert gate.started


@pytest.mark.parametrize('case', ['old-profile', 'old-request', 'marker-write', 'home-read', 'fd-env', 'argv', 'host-cgroup'])
def test_cgroup_forbids_profile_crossing_and_control_capability_import(case):
    gate = control_initialized() if case == 'old-profile' else cgroup_initialized()
    frame = g.cgroup_start_request()
    if case == 'old-request': frame = g.control_start_request()
    if case == 'marker-write': frame['params']['sandbox']['permissions']['file_system']['entries'][-2]['access'] = 'write'
    if case == 'home-read': frame['params']['sandbox']['permissions']['file_system']['entries'][-1]['access'] = 'read'
    if case == 'fd-env': frame['params']['env']['CONTROL_FD'] = '198'
    if case == 'argv': frame['params']['argv'].append('/sys/fs/cgroup')
    if case == 'host-cgroup': frame['params']['sandbox']['permissions']['file_system']['entries'].append(
        {'path': {'type': 'path', 'path': 'file:///sys/fs/cgroup'}, 'access': 'write'})
    with pytest.raises(ValueError): gate.admit(frame)
    assert not gate.pending


def test_cgroup_missing_marker_stops_before_executor_spawn():
    with patch.object(g.os, 'lstat', side_effect=FileNotFoundError()) as lookup, patch.object(g.subprocess, 'Popen') as spawn:
        with pytest.raises(FileNotFoundError): g.run_gate(p, {}, 'pid:[1]', 'mnt:[2]', 'trusted-cgroup-worker-boundary')
        lookup.assert_called_once_with(g.CONTROL_MARKER)
        spawn.assert_not_called()


def trusted_cli_initialized():
    gate = g.Gate('pid:[1]', 'mnt:[2]', 'trusted-cli-worker-boundary')
    gate.admit(g.initialize_request()); flush(gate); gate.receive(INIT_REPLY)
    gate.admit(INITIALIZED); flush(gate)
    return gate


def test_trusted_cli_fixed_literal_policy_and_actual_rewrite():
    expected = g.control_start_request()
    expected['params']['argv'] = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-cli-worker-probe.py']
    assert g.trusted_cli_start_request() == expected
    gate = trusted_cli_initialized(); original = copy.deepcopy(expected)
    gate.admit(expected); actual = g.strict_json(flush(gate))
    assert expected == original
    assert actual['params']['argv'] == ['/usr/bin/python3', '-I', '-S', '/usr/bin/exec-server-worker-trampoline.py', '--trusted-cli-worker-boundary']
    assert actual['params']['sandbox'] == expected['params']['sandbox']
    assert actual['params']['env'] == gate.worker_env
    assert actual['params']['pipeStdin'] is False
    gate.receive(START_REPLY); gate.admit(g.read_request(3)); flush(gate)
    assert gate.started
    expected['params']['sandbox']['permissions']['network'] = 'enabled'
    assert g.trusted_cli_start_request() == original


@pytest.mark.parametrize('case', ['old-profile', 'old-request', 'argv', 'marker-write', 'home-read', 'network', 'env', 'stdin', 'write'])
def test_trusted_cli_refuses_crossprofile_and_capability_changes_before_forward(case):
    gate = control_initialized() if case == 'old-profile' else trusted_cli_initialized()
    frame = g.trusted_cli_start_request()
    if case == 'old-request': frame = g.control_start_request()
    if case == 'argv': frame['params']['argv'].append('--caller')
    if case == 'marker-write': frame['params']['sandbox']['permissions']['file_system']['entries'][-2]['access'] = 'write'
    if case == 'home-read': frame['params']['sandbox']['permissions']['file_system']['entries'][-1]['access'] = 'read'
    if case == 'network': frame['params']['sandbox']['permissions']['network'] = 'enabled'
    if case == 'env': frame['params']['env']['HTTPS_PROXY'] = 'http://127.0.0.1:1234'
    if case == 'stdin': frame['params']['pipeStdin'] = True
    if case == 'write': frame = g.stress_write_request(3, 'tasks', 'start')
    with pytest.raises(ValueError): gate.admit(frame)
    assert not gate.pending


def test_trusted_cli_missing_marker_refuses_before_spawn():
    with patch.object(g.os, 'lstat', side_effect=FileNotFoundError()) as lookup, patch.object(g.subprocess, 'Popen') as spawn:
        with pytest.raises(FileNotFoundError): g.run_gate(p, {}, 'pid:[1]', 'mnt:[2]', 'trusted-cli-worker-boundary')
        lookup.assert_called_once_with('/work/trusted-control-boundary.json')
        spawn.assert_not_called()


def test_http_ingress_selects_only_fixed_probe_and_unchanged_network_policy():
    gate = http_ingress_initialized()
    frame = g.http_ingress_start_request(); original = copy.deepcopy(frame)
    gate.admit(frame); actual = g.strict_json(flush(gate))
    assert frame == original
    assert actual['params']['argv'] == g.HTTP_INGRESS_TRAMPOLINE_ARGV
    assert actual['params']['env'] == gate.worker_env
    assert actual['params']['sandbox']['permissions']['network'] == g.start_request()['params']['sandbox']['permissions']['network']
    assert actual['params']['sandbox']['permissions']['file_system']['entries'][-2:] == [
        {'path': {'type': 'path', 'path': 'file:///work/trusted-http-ingress-boundary.json'}, 'access': 'read'},
        {'path': {'type': 'path', 'path': 'file:///work/environment-appserver-home'}, 'access': 'deny'}]
    gate.receive(START_REPLY); gate.admit(g.read_request(3, 1)); flush(gate)
    assert gate.started


@pytest.mark.parametrize('case', ['old-profile', 'old-request', 'marker-write', 'home-read', 'fd-env', 'argv'])
def test_http_ingress_forbids_profile_crossing_and_capability_import(case):
    gate = ingress_initialized() if case == 'old-profile' else http_ingress_initialized()
    frame = g.http_ingress_start_request()
    if case == 'old-request': frame = g.ingress_start_request()
    if case == 'marker-write': frame['params']['sandbox']['permissions']['file_system']['entries'][-2]['access'] = 'write'
    if case == 'home-read': frame['params']['sandbox']['permissions']['file_system']['entries'][-1]['access'] = 'read'
    if case == 'fd-env': frame['params']['env']['HTTP_PROXY'] = 'http://127.0.0.1:1'
    if case == 'argv': frame['params']['argv'].append('198')
    with pytest.raises(ValueError): gate.admit(frame)
    assert not gate.pending


def test_http_ingress_missing_marker_stops_before_executor_spawn():
    with patch.object(g.os, 'lstat', side_effect=FileNotFoundError()) as lookup, patch.object(g.subprocess, 'Popen') as spawn:
        with pytest.raises(FileNotFoundError): g.run_gate(p, {}, 'pid:[1]', 'mnt:[2]', 'trusted-http-ingress-boundary')
        lookup.assert_called_once_with(g.HTTP_INGRESS_MARKER)
        spawn.assert_not_called()


def stress_started(phase='tasks'):
    gate=g.Gate('pid:[1]','mnt:[2]','candidate-resource-stress-'+phase)
    gate.admit(g.initialize_request());flush(gate);gate.receive(INIT_REPLY)
    gate.admit(INITIALIZED);gate.admit(g.stress_start_request(phase))
    frames=[g.strict_json(line) for line in flush(gate).splitlines()]
    assert frames[-1]['params']['pipeStdin'] is True
    assert frames[-1]['params']['argv']==g.TRAMPOLINE_ARGV+['--candidate-resource-stress-'+phase]
    gate.receive(START_REPLY);return gate


def stress_held(phase='tasks'):
    value={'type':'held','phase':phase,'children':2,'workerIdentity':{'pid':3,'startTicks':'20','pidNamespace':'pid:[500]','procInitPidNamespace':'pid:[500]'},'childIdentities':[{'pid':4,'startTicks':'21'},{'pid':5,'startTicks':'22'}]}
    value.update({'forkErrno':11} if phase=='tasks' else {'bytesPerAllocator':805306368})
    return value


def stress_output(gate,raw,seq):
    import base64
    chunk={'seq':seq,'stream':'stdout','chunk':base64.b64encode(raw).decode()}
    gate.receive({'method':'process/output','params':{'processId':g.PROCESS_ID,**chunk}})
    return chunk


@pytest.mark.parametrize('phase',['tasks','memory'])
@pytest.mark.parametrize('progress_first',[True,False])
def test_stress_finite_sequence_requires_actual_progress_and_write_ack(phase,progress_first):
    gate=stress_started(phase);gate.admit(g.stress_write_request(3,phase,'start'));flush(gate)
    raw=g.encode(stress_held(phase))
    if not progress_first:gate.receive({'id':3,'result':{'status':'accepted'}})
    stress_output(gate,raw[:17],1);assert not gate.stress.held
    stress_output(gate,raw[17:],2);assert gate.stress.held
    if progress_first:gate.receive({'id':3,'result':{'status':'accepted'}})
    identifier=4
    if phase=='memory':
        gate.admit(g.stress_write_request(4,phase,'ramp'));flush(gate)
        stress_output(gate,g.encode({'type':'ramp-complete','phase':'memory','allocationCapPerChild':1207959552}),3)
        gate.receive({'id':4,'result':{'status':'accepted'}});identifier=5
    gate.admit(g.stress_write_request(identifier,phase,'release'));flush(gate)
    gate.receive({'id':identifier,'result':{'status':'accepted'}})
    assert gate.stress.acked >= {'start','release'} and bytes(gate.stress.raw).startswith(raw)


@pytest.mark.parametrize('case',['missing-writeid','changed-bytes','extra-eof','duplicate','release-before-held','wrong-phase','old-profile'])
def test_stress_write_rejects_nonfinite_or_unready_requests(case):
    gate=started() if case=='old-profile' else stress_started()
    frame=g.stress_write_request(3,'tasks','start')
    if case=='missing-writeid':del frame['params']['writeId']
    elif case=='changed-bytes':frame['params']['chunk']='e30K'
    elif case=='extra-eof':frame['params']['eof']=True
    elif case=='wrong-phase':frame=g.stress_write_request(3,'memory','start')
    elif case in ('duplicate','release-before-held'):
        gate.admit(frame);flush(gate);gate.receive({'id':3,'result':{'status':'accepted'}})
        frame=g.stress_write_request(4,'tasks','start' if case=='duplicate' else 'release')
    with pytest.raises(ValueError):gate.admit(frame)
    assert gate.failed


@pytest.mark.parametrize('status',['starting','stdinClosed','unknownProcess',True])
def test_stress_nonaccepted_write_is_failure_without_retry(status):
    gate=stress_started();gate.admit(g.stress_write_request(3,'tasks','start'));flush(gate)
    with pytest.raises(ValueError,match='NOT_ACCEPTED'):gate.receive({'id':3,'result':{'status':status}})
    assert gate.failed


def test_stress_read_duplicate_dedup_does_not_repeat_progress():
    gate=stress_started();gate.admit(g.stress_write_request(3,'tasks','start'));flush(gate)
    chunk=stress_output(gate,g.encode(stress_held()),1)
    gate.receive({'id':3,'result':{'status':'accepted'}})
    gate.admit(g.read_request(4));flush(gate)
    gate.receive({'id':4,'result':{'chunks':[chunk],'nextSeq':2,'exited':False,'exitCode':None,'closed':False,'failure':None,'sandboxDenied':False}})
    assert gate.stress.total==len(g.encode(stress_held()))
    changed=copy.deepcopy(chunk);changed['chunk']='e30K'
    with pytest.raises(ValueError,match='DUPLICATE_MISMATCH'):gate.stress.output(changed)


def test_stress_progress_before_actual_write_and_cancel_while_read_pending_refused():
    gate=stress_started();gate.admit(g.stress_write_request(3,'tasks','start'))
    with pytest.raises(ValueError,match='HELD_ORDER'):stress_output(gate,g.encode(stress_held()),1)
    gate=stress_started();gate.admit(g.read_request(3));flush(gate)
    with pytest.raises(ValueError,match='REQUEST_ORDER'):gate.admit(g.stress_write_request(4,'tasks','cancel'))


def test_stress_cancel_blocks_all_successful_continuation():
    gate=stress_started();gate.admit(g.stress_write_request(3,'tasks','cancel'));flush(gate)
    gate.receive({'id':3,'result':{'status':'accepted'}})
    with pytest.raises(ValueError):gate.admit(g.stress_write_request(4,'tasks','start'))
