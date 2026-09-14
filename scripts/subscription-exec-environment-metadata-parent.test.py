import copy
import base64
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load('subscription-exec-environment-metadata-parent')
policy = load('subscription-appserver-noenv')
gate = load('subscription-exec-server-worker-gate')


def initialized():
    p = m.make_protocol(policy)
    p.written(len(p.pending))
    p.receive({'id': 1, 'result': {'userAgent': 'fixed-test', 'codexHome': m.HOME,
                                 'platformFamily': 'unix', 'platformOs': 'linux'}})
    return p


def thread_reply():
    return {'id': 2, 'result': {'model': 'gpt-5.6-sol', 'modelProvider': 'openai', 'reasoningEffort': 'low',
        'cwd': '/work', 'approvalPolicy': 'never', 'runtimeWorkspaceRoots': ['/work/exec-worker'],
        'sandbox': {'type': 'readOnly', 'networkAccess': False},
        'thread': {'id': 'owned-thread', 'ephemeral': True, 'path': None}}}


def test_fixed_config_keeps_every_prior_policy_and_disables_snapshot_before_spawn():
    old = copy.deepcopy(policy.thread_request()['params']['config'])
    assert m.fixed_config(policy) == {**old, 'features.shell_snapshot': False, 'project_doc_max_bytes': 0}
    assert policy.thread_request()['params']['config'] == old
    argv = m.fixed_argv(policy)
    assert argv[0] == '/usr/bin/codex' and argv[-2:] == ('app-server', '--stdio')
    assert 'features.shell_snapshot=false' in argv
    assert 'project_doc_max_bytes=0' in argv
    assert type(m.fixed_config(policy)['project_doc_max_bytes']) is int
    assert len(m.fixed_config(policy)) == len(old) + 2
    assert 'model_catalog_json="/usr/bin/text-model-catalog.json"' in argv


def test_exact_toml_has_one_owned_stdio_environment_without_local_or_url_fallback():
    import tomllib
    data = tomllib.loads(m.ENVIRONMENTS_TOML.decode())
    assert data == {'include_local': False, 'default': 'fixed-worker', 'environments': [{
        'id': 'fixed-worker', 'program': '/usr/bin/python3',
        'args': ['-I', '-S', '/usr/bin/exec-server-worker-gate.py', '--environment-metadata'], 'cwd': '/work'}]}


def test_protocol_sends_only_fixed_init_notification_and_explicit_environment_thread():
    p = initialized()
    queued = [x['frame'] for x in p.history if x['event'] == 'queued']
    assert [x['method'] for x in queued] == ['initialize', 'initialized', 'thread/start']
    assert queued[-1]['params']['environments'] == m.fixed_environment_selection()
    assert queued[-1]['params']['runtimeWorkspaceRoots'] == []
    p.written(len(p.pending))
    reply = thread_reply()
    p.receive(reply)
    assert p.done and not p.pending
    assert p.responses[2] is reply['result']
    assert [x['frame'] for x in p.history if x['event'] == 'received'][-1] is reply
    assert len([x for x in p.history if x['event'] == 'queued']) == 3


@pytest.mark.parametrize('change', [
    {'runtimeWorkspaceRoots': []}, {'cwd': '/work/exec-worker'}, {'model': 'other'},
    {'modelProvider': 'other'}, {'reasoningEffort': 'high'}, {'approvalPolicy': 'on-request'},
    {'sandbox': {'type': 'readOnly', 'networkAccess': 0}},
    {'thread': {'id': 'x', 'ephemeral': False, 'path': None}},
    {'thread': {'id': '', 'ephemeral': True, 'path': None}},
])
def test_environment_reply_profile_drift_fails_without_normalizing_raw(change):
    p = initialized()
    p.written(len(p.pending))
    frame = thread_reply()
    frame['result'].update(change)
    with pytest.raises(ValueError):
        p.receive(frame)
    assert p.history[-1]['frame'] is frame
    assert not p.done


def test_response_requires_actual_complete_write_and_no_duplicate():
    p = initialized()
    with pytest.raises(ValueError):
        p.receive(thread_reply())
    p = initialized()
    p.written(len(p.pending))
    p.receive(thread_reply())
    with pytest.raises(ValueError):
        p.receive(thread_reply())


@pytest.mark.parametrize('method', ['turn/start', 'model/list', 'account/read', 'process/start', 'fs/readFile', 'unknown'])
def test_no_extra_rpc_constructor_can_be_queued(method):
    p = initialized()
    before = bytes(p.pending)
    with pytest.raises(ValueError):
        p._queue({'method': method, 'params': {}})
    assert bytes(p.pending) == before


def advisory():
    return {'method': 'configWarning', 'params': {'summary': m.SANDBOX_ADVISORY, 'details': None}, 'emittedAtMs': 1}


def test_advisory_keeps_raw_identity_once_after_initialize():
    p = initialized()
    frame = advisory()
    p.receive(frame)
    assert p.configuration_advisories == [frame]
    assert p.history[-1]['frame'] is frame
    with pytest.raises(ValueError):
        p.receive(frame)
    with pytest.raises(ValueError):
        m.make_protocol(policy).receive(frame)


@pytest.mark.parametrize('timestamp', [True, -1, 0.5, None, '1', 9007199254740992])
def test_malformed_advisory_timestamp_fails(timestamp):
    p = initialized()
    frame = advisory()
    frame['emittedAtMs'] = timestamp
    with pytest.raises(ValueError):
        p.receive(frame)


def test_home_is_exclusive_and_does_not_touch_executor_home(monkeypatch):
    import io
    created = []
    writes = []
    def mkdir(path, *, mode, exist_ok):
        assert mode == 0o700 and exist_ok is False
        if str(path) in created:
            raise FileExistsError(str(path))
        created.append(str(path))
    class Written(io.BytesIO):
        def close(self):
            writes.append(self.getvalue())
            super().close()
    def open_file(path, mode):
        assert path == m.HOME + '/environments.toml' and mode == 'xb'
        return Written()
    monkeypatch.setattr(m.Path, 'mkdir', mkdir)
    monkeypatch.setattr(m, 'open', open_file, raising=False)
    env = m.prepare_home()
    assert set(env) == {'PATH', 'LANG', 'HOME', 'CODEX_HOME', 'TMPDIR'}
    assert writes == [m.ENVIRONMENTS_TOML]
    with pytest.raises(FileExistsError):
        m.prepare_home()
    assert created == [str(Path(m.HOME)), str(Path(m.HOME + '/tmp'))]


def complete_report():
    p = initialized()
    while p.frames:
        p.written(p.frames[0][0])
    p.receive(thread_reply())
    raw = b''.join((json.dumps(item['frame']) + '\n').encode() for item in p.history if item['event'] == 'received')
    hook = {'version': 1, 'profile': 'environment-metadata', 'phase': 'protocol-complete', 'complete': True, 'error': None,
        'localReturnCode': None, 'modelCalls': 0, 'productionReady': False, 'remoteCleanup': 'not-attested-by-gate',
        'history': [{'direction': 'request', 'frame': gate.environment_initialize_request()},
            {'direction': 'response', 'frame': {'id': 1, 'result': {'sessionId': 'fixture-session'}}},
            {'direction': 'request', 'frame': {'method': 'initialized', 'params': {}}},
            {'direction': 'request', 'frame': gate.environment_info_request(2)},
            {'direction': 'response', 'frame': {'id': 2, 'result': {'shell': {'name': 'bash', 'path': '/bin/bash'},
                'cwd': 'file:///work', 'capabilities': {'networkProxyLaunch': True}}}}]}
    hook_raw = json.dumps(hook).encode()
    hashes = {name: 'a' * 64 for name in m.HELPER_FILES}
    hashes['subscription-text-model-catalog.json'] = m.CATALOG_SHA256
    return {'version': 1, 'profile': 'fixed-exec-environment-metadata-parent', 'success': True, 'error': None,
        'argv': list(m.fixed_argv(policy)), 'freshHome': m.HOME,
        'environmentsTomlSha256': hashlib.sha256(m.ENVIRONMENTS_TOML).hexdigest(),
        'history': p.history, 'configurationAdvisories': [], 'stdoutBase64': base64.b64encode(raw).decode(), 'stderrBase64': '',
        'outputBytesObserved': len(raw), 'outputComplete': True, 'streamEOF': {'stdout': True, 'stderr': True},
        'controlBytesQueued': p.control_queued, 'controlBytesWritten': p.control_written,
        'cleanupHistory': [{'event': 'stdin-eof', 'elapsedMs': 20}],
        'directChild': {'pid': 7, 'pinned': True, 'reaped': True, 'exitCode': 0},
        'elapsedMs': 30, 'metadataCompletedMs': 19, 'descendantCleanupVerifiedHere': False,
        'runtimeRegistryValidated': False, 'actualModelCalls': 0, 'credentialFilesRead': False, 'productionReady': False,
        'helperSha256Before': hashes, 'helperSha256After': copy.deepcopy(hashes),
        'environmentHook': {'rawBase64': base64.b64encode(hook_raw).decode(), 'rawBytes': len(hook_raw),
            'rawSha256': hashlib.sha256(hook_raw).hexdigest(), 'report': hook, 'protocolValidated': True, 'terminal': None}}


def test_full_offline_report_replays_actual_frame_shapes_without_live_credit():
    assert m.validate_report(complete_report(), policy, gate)


@pytest.mark.parametrize('case', [
    'partial-history', 'raw-thread-tamper', 'control-count', 'bool-count', 'unknown-output', 'late-deadline',
    'direct-failure', 'unknown-cleanup', 'fake-ready', 'wrong-home', 'catalog-drift', 'source-drift',
    'missing-hook', 'hook-raw-tamper', 'hook-typed-tamper', 'hook-incomplete', 'hook-process-method',
    'hook-local-failure', 'hook-count', 'hook-bool', 'truncated-stdout', 'bool-version', 'early-term',
])
def test_full_report_rejects_incomplete_or_forged_claims(case):
    r = complete_report()
    if case == 'partial-history': r['history'].pop()
    if case == 'raw-thread-tamper': r['stdoutBase64'] = base64.b64encode(b'{}\n').decode()
    if case == 'control-count': r['controlBytesWritten'] -= 1
    if case == 'bool-count': r['outputBytesObserved'] = True
    if case == 'unknown-output': r['streamEOF']['stderr'] = False
    if case == 'late-deadline': r.update(metadataCompletedMs=12000, elapsedMs=12001)
    if case == 'direct-failure': r['directChild']['exitCode'] = 1
    if case == 'unknown-cleanup': r['directChild']['reaped'] = False
    if case == 'fake-ready': r['productionReady'] = True
    if case == 'wrong-home': r['freshHome'] = '/work/executor-home'
    if case == 'catalog-drift': r['helperSha256Before']['subscription-text-model-catalog.json'] = 'b' * 64
    if case == 'source-drift': r['helperSha256After']['subscription-exec-server-worker-gate.py'] = 'b' * 64
    if case == 'missing-hook': r['environmentHook'] = None
    if case == 'hook-raw-tamper': r['environmentHook']['rawBase64'] = base64.b64encode(b'{}').decode()
    if case == 'hook-typed-tamper': r['environmentHook']['report']['complete'] = False
    if case == 'hook-count': r['environmentHook']['rawBytes'] += 1
    if case == 'hook-bool': r['environmentHook']['protocolValidated'] = 1
    if case == 'truncated-stdout': r['stdoutBase64'] = base64.b64encode(base64.b64decode(r['stdoutBase64'])[:-1]).decode()
    if case == 'bool-version': r['version'] = True
    if case == 'early-term': r['cleanupHistory'].append({'event': 'term-sent', 'elapsedMs': 21})
    if case in ('hook-incomplete', 'hook-process-method', 'hook-local-failure'):
        hook = r['environmentHook']['report']
        if case == 'hook-incomplete': hook['history'] = hook['history'][:3]
        if case == 'hook-process-method': hook['history'][3]['frame'] = gate.start_request()
        if case == 'hook-local-failure': hook['localReturnCode'] = 1
        raw = json.dumps(hook).encode()
        r['environmentHook'].update(rawBase64=base64.b64encode(raw).decode(), rawBytes=len(raw), rawSha256=hashlib.sha256(raw).hexdigest())
    assert not m.validate_report(r, policy, gate)


def test_hook_fifo_is_rejected_before_read_and_open_is_nonblocking(monkeypatch):
    from types import SimpleNamespace
    closed = []
    def open_fd(path, flags):
        assert path == '/work/executor-home/environment-metadata-trace.json'
        assert flags & m.os.O_NONBLOCK and flags & m.os.O_NOFOLLOW
        return 7
    monkeypatch.setattr(m.os, 'O_NONBLOCK', 2048, raising=False)
    monkeypatch.setattr(m.os, 'O_NOFOLLOW', 131072, raising=False)
    monkeypatch.setattr(m.os, 'open', open_fd)
    monkeypatch.setattr(m.os, 'fstat', lambda _: SimpleNamespace(st_mode=0o010600, st_size=1))
    monkeypatch.setattr(m.os, 'read', lambda *_: pytest.fail('FIFO must not be read'))
    monkeypatch.setattr(m.os, 'close', closed.append)
    with pytest.raises(ValueError, match='HOOK_TRACE_FILE_INVALID'):
        m.read_hook(policy, gate)
    assert closed == [7]


def test_shared_budget_expired_during_setup_never_spawns(monkeypatch):
    monkeypatch.setattr(m, 'prepare_home', lambda: {})
    monkeypatch.setattr(m.time, 'monotonic', lambda: 12.0)
    monkeypatch.setattr(m.subprocess, 'Popen', lambda *_args, **_kwargs: pytest.fail('deadline must precede spawn'))
    with pytest.raises(ValueError, match='DEADLINE_BEFORE_SPAWN'):
        m.run_parent(policy, began=0.0)


@pytest.mark.parametrize('platform,argv', [('win32', ['parent']), ('linux', ['parent', '--other'])])
def test_entry_refuses_wrong_platform_or_caller_args_before_file_reads(monkeypatch, platform, argv):
    monkeypatch.setattr(m.sys, 'platform', platform)
    monkeypatch.setattr(m.sys, 'argv', argv)
    monkeypatch.setattr(m, 'helper_hashes', lambda: pytest.fail('no helper reads before admission'))
    with pytest.raises(ValueError, match='FIXED_CAPSULE_ENTRY_REQUIRED'):
        m.main()


@pytest.mark.parametrize('exit_code,error,valid', [(0, None, True), (1, None, False), (None, None, False), (0, 'late-failure', False)])
def test_known_terminal_is_separate_and_cannot_hide_failure(exit_code, error, valid):
    r = complete_report()
    terminal = {**copy.deepcopy(r['environmentHook']['report']), 'phase': 'terminal', 'localReturnCode': exit_code, 'error': error,
                'rejectedRequest': None}
    raw = json.dumps(terminal).encode()
    r['environmentHook']['terminal'] = {'rawBase64': base64.b64encode(raw).decode(), 'rawBytes': len(raw),
        'rawSha256': hashlib.sha256(raw).hexdigest(), 'report': terminal}
    assert m.validate_report(r, policy, gate) is valid


def test_malformed_known_terminal_never_becomes_missing_terminal():
    r = complete_report()
    raw = b'invalid-json'
    r['environmentHook']['terminal'] = {'rawBase64': base64.b64encode(raw).decode(), 'rawBytes': len(raw),
        'rawSha256': hashlib.sha256(raw).hexdigest(), 'report': None}
    assert not m.validate_report(r, policy, gate)


def test_missing_terminal_grants_only_protocol_credit():
    r = complete_report()
    assert r['environmentHook']['terminal'] is None
    assert r['environmentHook']['report']['localReturnCode'] is None
    assert m.validate_report(r, policy, gate)
    assert r['descendantCleanupVerifiedHere'] is False


def test_terminal_file_admission_failure_preserves_known_snapshot(monkeypatch):
    snapshot = {key: value for key, value in complete_report()['environmentHook'].items() if key not in ('terminal', 'protocolValidated')}
    def read(_policy, terminal=False):
        if terminal:
            raise ValueError('HOOK_TRACE_FILE_INVALID')
        return copy.deepcopy(snapshot)
    monkeypatch.setattr(m, 'read_trace', read)
    hook = m.read_hook(policy, gate)
    assert hook['rawBase64'] == snapshot['rawBase64']
    assert hook['protocolValidated'] is False
    assert hook['terminal']['readError'] == 'ValueError:HOOK_TRACE_FILE_INVALID'


@pytest.mark.parametrize('replacement', ['project_doc_max_bytes=false', 'project_doc_max_bytes=32768'])
def test_report_cannot_restore_project_docs_or_substitute_boolean_zero(replacement):
    r = complete_report()
    r['argv'][r['argv'].index('project_doc_max_bytes=0')] = replacement
    assert not m.validate_report(r, policy, gate)


def complete_bootstrap_report():
    r = complete_report()
    p = m.make_protocol(policy, bootstrap=True)
    p.written(len(p.pending))
    p.receive({'id': 1, 'result': {'userAgent': 'fixed-test', 'codexHome': m.HOME,
                                 'platformFamily': 'unix', 'platformOs': 'linux'}})
    while p.frames:
        p.written(p.frames[0][0])
    p.receive(thread_reply())
    raw = b''.join((json.dumps(item['frame']) + '\n').encode() for item in p.history if item['event'] == 'received')
    r.update(profile='fixed-exec-environment-bootstrap-metadata-parent', argv=list(m.fixed_argv(policy, True)),
        environmentsTomlSha256=hashlib.sha256(m.BOOTSTRAP_ENVIRONMENTS_TOML).hexdigest(),
        history=p.history, stdoutBase64=base64.b64encode(raw).decode(), outputBytesObserved=len(raw),
        controlBytesQueued=p.control_queued, controlBytesWritten=p.control_written)
    hook = r['environmentHook']['report']
    hook['profile'] = 'environment-bootstrap-metadata'
    hook['completionEvidence'] = 'client-pipe-written-not-acknowledged'
    hook['history'].extend([
        {'direction': 'request', 'frame': {'id': 3, 'method': 'fs/getMetadata',
                                         'params': {'path': 'file:///work/.agents/skills', 'sandbox': None}}},
        {'direction': 'response', 'frame': {'id': 3, 'error': {'code': -32004, 'message': 'fixture path not found'}}},
        {'direction': 'request', 'frame': {'id': 4, 'method': 'fs/getMetadata',
                                         'params': {'path': 'file:///work/exec-worker/.agents/skills', 'sandbox': None}}},
        {'direction': 'response', 'frame': {'id': 4, 'error': {'code': -32004, 'message': 'fixture nested path not found'}}},
    ])
    rebind_hook_raw(r)
    r['bootstrapHookBeforeEof'] = {'rawSha256': r['environmentHook']['rawSha256'], 'capturedMs': r['metadataCompletedMs'],
                                  'appServerPid': r['directChild']['pid'], 'appServerAlive': True}
    return r


def rebind_hook_raw(report):
    hook = report['environmentHook']
    raw = json.dumps(hook['report']).encode()
    hook.update(rawBase64=base64.b64encode(raw).decode(), rawBytes=len(raw), rawSha256=hashlib.sha256(raw).hexdigest())
    if 'bootstrapHookBeforeEof' in report:
        report['bootstrapHookBeforeEof']['rawSha256'] = hook['rawSha256']


def test_bootstrap_is_distinct_profile_with_only_supported_root_marker_override():
    assert m.fixed_config(policy, True) == {**m.fixed_config(policy), 'project_root_markers': []}
    assert 'project_root_markers=[]' in m.fixed_argv(policy, True)
    assert 'project_root_markers=[]' not in m.fixed_argv(policy)
    assert m.BOOTSTRAP_ENVIRONMENTS_TOML == m.ENVIRONMENTS_TOML.replace(b'"--environment-metadata"', b'"--environment-bootstrap-metadata"')
    r = complete_bootstrap_report()
    queued = [entry['frame'] for entry in r['history'] if entry['event'] == 'queued']
    assert [frame['method'] for frame in queued] == ['initialize', 'initialized', 'thread/start']
    assert queued[-1]['params']['config']['project_root_markers'] == []
    assert m.validate_bootstrap_report(r, policy, gate)
    assert not m.validate_report(r, policy, gate)
    assert not m.validate_bootstrap_report(complete_report(), policy, gate)


@pytest.mark.parametrize('case', ['missing-stat', 'wrong-path', 'content-method', 'sandbox', 'data-null', 'wrong-error',
                                'stat-success', 'duplicate-stat', 'metadata-profile', 'wrong-id'])
def test_bootstrap_requires_both_actual_stats_and_enoent_shape(case):
    r = complete_bootstrap_report()
    hook = r['environmentHook']['report']
    request = hook['history'][-2]['frame']
    response = hook['history'][-1]['frame']
    if case == 'missing-stat': hook['history'] = hook['history'][:-2]
    if case == 'wrong-path': request['params']['path'] = 'file:///work/.agents/other'
    if case == 'content-method': request['method'] = 'fs/readFile'
    if case == 'sandbox': request['params']['sandbox'] = {}
    if case == 'data-null': response['error']['data'] = None
    if case == 'wrong-error': response['error']['code'] = -32001
    if case == 'stat-success': hook['history'][-1]['frame'] = {'id': 3, 'result': {}}
    if case == 'duplicate-stat': hook['history'].extend(copy.deepcopy(hook['history'][-2:]))
    if case == 'metadata-profile': hook['profile'] = 'environment-metadata'
    if case == 'wrong-id': response['id'] = 5
    rebind_hook_raw(r)
    assert not m.validate_bootstrap_report(r, policy, gate)


@pytest.mark.parametrize('value', [1, 'bootstrap', None, {}])
def test_internal_profile_selector_is_not_caller_config(value, monkeypatch):
    monkeypatch.setattr(m.Path, 'mkdir', lambda *_args, **_kwargs: pytest.fail('invalid profile before mutations'))
    with pytest.raises(ValueError, match='FIXED_PARENT_PROFILE_REQUIRED'):
        m.prepare_home(value)


def test_bootstrap_hook_reads_only_new_fixed_trace_paths(monkeypatch):
    paths = []
    snapshot = complete_bootstrap_report()['environmentHook']
    def read(_policy, terminal=False, bootstrap=False):
        assert bootstrap is True
        paths.append(terminal)
        if terminal:
            raise FileNotFoundError()
        return {key: value for key, value in copy.deepcopy(snapshot).items() if key not in ('terminal', 'protocolValidated')}
    monkeypatch.setattr(m, 'read_trace', read)
    assert m.read_hook(policy, gate, True)['protocolValidated'] is True
    assert paths == [False, True]


@pytest.mark.parametrize('terminal', [False, True])
def test_bootstrap_trace_path_is_literal_not_report_or_caller_path(monkeypatch, terminal):
    monkeypatch.setattr(m.os, 'O_NONBLOCK', 2048, raising=False)
    monkeypatch.setattr(m.os, 'O_NOFOLLOW', 131072, raising=False)
    def open_path(path, _flags):
        expected = '/work/executor-home/environment-bootstrap-metadata-' + ('terminal' if terminal else 'trace') + '.json'
        assert path == expected
        raise FileNotFoundError()
    monkeypatch.setattr(m.os, 'open', open_path)
    with pytest.raises(FileNotFoundError):
        m.read_trace(policy, terminal, True)


@pytest.mark.parametrize('case', ['pending', 'known-failure-without-snapshot', 'malformed-snapshot', 'dead', 'deadline', 'ready'])
def test_bootstrap_progress_keeps_missing_pending_but_rejects_known_failure(case, monkeypatch):
    from types import SimpleNamespace
    snapshot = complete_bootstrap_report()['environmentHook']
    if case == 'malformed-snapshot':
        snapshot['report'] = None
    terminal = {'report': {'error': 'PROTOCOL_REFUSED'}, 'rawBase64': 'e30=', 'rawBytes': 2, 'rawSha256': 'a' * 64}
    reads = []
    def read(_policy, terminal=False, bootstrap=False):
        assert bootstrap is True
        reads.append(terminal)
        if terminal:
            if case == 'known-failure-without-snapshot':
                return copy.deepcopy(known_terminal)
            raise FileNotFoundError()
        if case in ('pending', 'known-failure-without-snapshot'):
            raise FileNotFoundError()
        return snapshot
    known_terminal = terminal
    monkeypatch.setattr(m, 'read_trace', read)
    monkeypatch.setattr(m.time, 'monotonic', lambda: 12.0 if case == 'deadline' else 1.00049)
    process = SimpleNamespace(pid=7, poll=lambda: 0 if case == 'dead' else None)
    status, evidence, error = m.bootstrap_progress(policy, gate, process, 0)
    assert reads == [False, True]
    assert status == ('pending' if case == 'pending' else 'ready' if case == 'ready' else 'failed')
    if case == 'known-failure-without-snapshot':
        assert evidence['terminal'] == known_terminal
        assert error == 'BOOTSTRAP_KNOWN_TERMINAL_FAILURE'
    if case == 'ready':
        assert evidence == {'rawSha256': snapshot['rawSha256'], 'capturedMs': 1.00049 * 1000,
                            'appServerPid': 7, 'appServerAlive': True}


@pytest.mark.parametrize('field,value', [('rawSha256', 'f' * 64), ('appServerPid', 8), ('appServerPid', True),
    ('appServerAlive', False), ('capturedMs', 12000), ('capturedMs', 19.001)])
def test_bootstrap_snapshot_observation_must_bind_final_raw_live_child_and_time(field, value):
    r = complete_bootstrap_report()
    r['bootstrapHookBeforeEof'][field] = value
    assert not m.validate_bootstrap_report(r, policy, gate)


def test_bootstrap_shared_unrounded_time_accepts_only_pre_eof_sample():
    r = complete_bootstrap_report()
    r['metadataCompletedMs'] = r['bootstrapHookBeforeEof']['capturedMs'] = 19.49
    assert m.validate_bootstrap_report(r, policy, gate)
    r['metadataCompletedMs'] = r['bootstrapHookBeforeEof']['capturedMs'] = 20.51
    assert not m.validate_bootstrap_report(r, policy, gate)


@pytest.mark.parametrize('controlled', [False, True])
@pytest.mark.parametrize('termination', ['natural', 'term', 'esrch'])
def test_bootstrap_loop_drains_after_thread_reply_before_snapshot_and_eof(monkeypatch, controlled, termination):
    from types import SimpleNamespace
    events = []
    clock = [1.00049]
    signalled = []
    class Stream:
        def __init__(self, name, fd): self.name, self.fd, self.closed = name, fd, False
        def fileno(self): return self.fd
        def close(self):
            if not self.closed: events.append('close-' + self.name)
            self.closed = True
    process = SimpleNamespace(pid=7, stdin=Stream('stdin', 0), stdout=Stream('stdout', 1), stderr=Stream('stderr', 2))
    process.poll = lambda: (-15 if signalled else None) if termination != 'natural' else (0 if process.stdin.closed else None)
    protocol = SimpleNamespace(done=True, pending=b'', history=[], configuration_advisories=[], control_queued=0, control_written=0)
    capture = SimpleNamespace(eof={'stdout': False, 'stderr': False}, stdout=b'', stderr=b'', partial=b'', observed_bytes=0)
    def feed(name, raw, parse):
        events.append('drain-' + name)
        if not raw: capture.eof[name] = True
    capture.feed = feed
    class Selector:
        def __init__(self): self.keys = {}
        def register(self, stream, mask, name): self.keys[stream] = SimpleNamespace(fileobj=stream, data=name)
        def unregister(self, stream): del self.keys[stream]
        def get_key(self, stream): return self.keys[stream]
        def select(self, _timeout):
            if process.stdin.closed and termination != 'natural': clock[0] += 2.1
            return [(key, 1) for key in list(self.keys.values()) if key.data != 'stdin']
        def close(self): pass
    polls = []
    def progress(*_args):
        assert not process.stdin.closed
        polls.append(True)
        events.append('snapshot-poll')
        if len(polls) == 1: return 'pending', {}, None
        return 'ready', {'rawSha256': 'a' * 64, 'capturedMs': 1000.49, 'appServerPid': 7, 'appServerAlive': True}, None
    monkeypatch.setattr(m, 'prepare_home', lambda **_kwargs: {})
    monkeypatch.setattr(m, 'make_protocol', lambda *_args: protocol)
    monkeypatch.setattr(policy, 'Capture', lambda _: capture)
    monkeypatch.setattr(m, 'bootstrap_progress', progress)
    monkeypatch.setattr(m.subprocess, 'Popen', lambda *_args, **_kwargs: process)
    monkeypatch.setattr(m.selectors, 'DefaultSelector', Selector)
    monkeypatch.setattr(m.os, 'pidfd_open', lambda _: 9, raising=False)
    monkeypatch.setattr(m.os, 'set_blocking', lambda *_args: None)
    monkeypatch.setattr(m.os, 'close', lambda _: None)
    monkeypatch.setattr(m.os, 'read', lambda *_args: b'')
    monkeypatch.setattr(m.time, 'monotonic', lambda: clock[0])
    def send(pin, sent_signal):
        assert pin == 9 and sent_signal == m.signal.SIGTERM
        signalled.append(True)
        if termination == 'esrch': raise ProcessLookupError()
    monkeypatch.setattr(m.signal, 'pidfd_send_signal', send, raising=False)
    report = m.run_parent(policy, began=0, bootstrap=True, gate=gate, controlled=controlled)
    assert report['success'] is (termination == 'natural' or controlled and termination == 'term')
    assert len(polls) == 2
    assert events.index('drain-stdout') < events.index('close-stdin')
    assert report['metadataCompletedMs'] == report['bootstrapHookBeforeEof']['capturedMs'] == 1000.49
    if controlled:
        if termination == 'term':
            assert report['cleanupOutcome'] == 'owned-pidfd-term'
            assert report['signalDelivery']['pid'] == 7
            assert report['signalDelivery']['sentMs'] - report['signalDelivery']['eofMs'] >= 2000
        else:
            assert report['cleanupOutcome'] == ('natural-exit-zero' if termination == 'natural' else None)
            assert report['signalDelivery'] is None


def complete_controlled_bootstrap_report(term=True):
    report = complete_bootstrap_report()
    report['profile'] = 'fixed-exec-environment-bootstrap-controlled-parent'
    report['cleanupOutcome'] = 'owned-pidfd-term' if term else 'natural-exit-zero'
    report['signalDelivery'] = None
    if term:
        report['directChild']['exitCode'] = -15
        report['cleanupHistory'] = [{'event': 'stdin-eof', 'elapsedMs': 20}, {'event': 'term-sent', 'elapsedMs': 2021}]
        report['elapsedMs'] = 2100
        report['signalDelivery'] = {'pid': report['directChild']['pid'], 'signal': 15, 'pidfdPinned': True,
                                    'eofMs': 20.1, 'sentMs': 2020.6}
    return report


@pytest.mark.parametrize('term', [False, True])
def test_controlled_profile_is_explicit_and_cannot_relabel_natural_profile(term):
    report = complete_controlled_bootstrap_report(term)
    assert m.validate_controlled_bootstrap_report(report, policy, gate)
    assert not m.validate_bootstrap_report(report, policy, gate)
    assert not m.validate_report(report, policy, gate)
    assert not m.validate_controlled_bootstrap_report(complete_bootstrap_report(), policy, gate)
    assert report['argv'] == list(m.fixed_argv(policy, True))


@pytest.mark.parametrize('case', ['kill', 'unknown', 'external', 'esrch', 'early', 'different-pid', 'bool-pid',
    'unpinned', 'unreaped', 'different-signal', 'bool-signal', 'false-pin', 'nan-time', 'rounding-too-early',
    'wrong-history', 'natural-label', 'no-eof', 'incomplete-output', 'known-protocol-failure'])
def test_controlled_term_requires_actual_owned_delivery_and_complete_protocol(case):
    report = complete_controlled_bootstrap_report()
    delivery = report['signalDelivery']
    if case == 'kill': report['directChild']['exitCode'] = -9
    if case == 'unknown': report['directChild']['exitCode'] = None
    if case == 'external': report['signalDelivery'] = None
    if case == 'esrch': report['cleanupHistory'][1]['event'] = 'term-esrch'
    if case == 'early': delivery['sentMs'] = 2019.9
    if case == 'different-pid': delivery['pid'] += 1
    if case == 'bool-pid': delivery['pid'] = True
    if case == 'unpinned': report['directChild']['pinned'] = False
    if case == 'unreaped': report['directChild']['reaped'] = False
    if case == 'different-signal': delivery['signal'] = 9
    if case == 'bool-signal': delivery['signal'] = True
    if case == 'false-pin': delivery['pidfdPinned'] = False
    if case == 'nan-time': delivery['sentMs'] = float('nan')
    if case == 'rounding-too-early':
        delivery.update(eofMs=20.49, sentMs=2020.48)
        report['cleanupHistory'][1]['elapsedMs'] = 2020
    if case == 'wrong-history': report['cleanupHistory'][1]['elapsedMs'] += 2
    if case == 'natural-label': report['cleanupOutcome'] = 'natural-exit-zero'
    if case == 'no-eof': report['cleanupHistory'] = report['cleanupHistory'][1:]
    if case == 'incomplete-output': report['streamEOF']['stderr'] = False
    if case == 'known-protocol-failure': report['error'] = 'PROTOCOL_REFUSED'
    assert not m.validate_controlled_bootstrap_report(report, policy, gate)


def test_controlled_natural_zero_does_not_hide_signal_race():
    report = complete_controlled_bootstrap_report()
    report['directChild']['exitCode'] = 0
    report['cleanupOutcome'] = 'natural-exit-zero'
    assert not m.validate_controlled_bootstrap_report(report, policy, gate)
