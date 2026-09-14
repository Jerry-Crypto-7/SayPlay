import importlib.util
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch
import pytest
from contextlib import contextmanager
from contextlib import ExitStack

spec = importlib.util.spec_from_file_location('systemd_fixture_relay', Path(__file__).parents[1] / 'subscription-systemd-fixture-transport.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

UNIT = 'codex-cli-resource-' + 'a' * 32 + '.service'
LEAF = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/' + UNIT


def start_profile(profile):
    if profile in ('environment-metadata', 'environment-bootstrap-metadata', 'environment-bootstrap-controlled'):
        names = ('subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
                 'subscription-exec-worker-probe.py', 'subscription-worker-lockdown.py',
                 'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json',
                 'subscription-exec-environment-metadata-parent.py')
        helpers = {name: 'a' * 64 for name in names}
        return {'type': 'start', 'mode': 'exec-' + profile, 'helperSha256': helpers}, \
            {'execEnvironmentMetadataBoundary': {'helperSha256': dict(helpers)}}
    if profile == 'fixture':
        helpers = {'subscription-appserver-fixture-child.py': 'a' * 64, 'subscription-worker-lockdown.py': 'b' * 64}
        return {'type': 'start', 'mode': 'appserver-fixture', 'scenario': 'normal', 'helperSha256': helpers}, \
            {'appServerFixtureBoundary': {'helperSha256': dict(helpers)}}
    helpers = {'subscription-appserver-metadata-pipe-child.py': 'a' * 64, 'subscription-appserver-noenv.py': 'b' * 64,
               'subscription-worker-lockdown.py': 'c' * 64, 'subscription-text-model-catalog.json': 'd' * 64}
    return {'type': 'start', 'mode': 'appserver-metadata-pipe', 'helperSha256': helpers}, \
        {'appServerMetadataPipeBoundary': {'helperSha256': dict(helpers)}}


@pytest.mark.parametrize('arguments,profile', [([], 'fixture'), (['--metadata-pipe'], 'metadata'),
                                            (['--environment-metadata'], 'environment-metadata'),
                                            (['--environment-bootstrap-metadata'], 'environment-bootstrap-metadata'), (['--environment-bootstrap-controlled'], 'environment-bootstrap-controlled')])
def test_only_fixed_argv_selects_profile(arguments, profile):
    assert r.select_profile(arguments) == profile


@pytest.mark.parametrize('profile', ['environment-metadata', 'environment-bootstrap-metadata', 'environment-bootstrap-controlled', 'unknown'])
def test_noninteractive_profile_never_accepts_input_frames(profile):
    with pytest.raises(ValueError, match='RELAY_NONINTERACTIVE_PROFILE'):
        r.require_interactive_profile(profile)


@pytest.mark.parametrize('profile', ['fixture', 'metadata'])
def test_existing_interactive_profiles_keep_input(profile):
    r.require_interactive_profile(profile)


@pytest.mark.parametrize('arguments', [['metadata'], ['--metadata-pipe', 'normal'], ['--fixture'], ['--exec', '/bin/true'], ['--metadata-pipe=1'],
                                     ['--environment-metadata', 'normal'], ['--environment-metadata=1'],
                                     ['--environment-metadata', '--metadata-pipe'], ['--environment-bootstrap-metadata', 'normal']])
def test_unknown_profile_argv_cannot_query_or_spawn(arguments):
    with patch.object(r.sys, 'platform', 'linux'), patch.object(r.sys, 'argv', ['fixed', *arguments]), \
         patch.object(r, 'load_probe') as load, patch.object(r.subprocess, 'Popen') as spawn, pytest.raises(ValueError):
        r.main()
    load.assert_not_called()
    spawn.assert_not_called()


@pytest.mark.parametrize('profile', ['fixture', 'metadata', 'environment-metadata', 'environment-bootstrap-metadata', 'environment-bootstrap-controlled'])
def test_fixed_profiles_share_actual_resource_admission_before_start_write(profile):
    frame, ready = start_profile(profile)
    order = []
    identity = {'unitMainPid': 123}
    with patch.object(r, 'exact_readback', side_effect=lambda *_: order.append('readback') or {'pidsMax': '64'}), \
         patch.object(r, 'binding', side_effect=lambda *_: order.append('binding') or identity), \
         patch.object(r.os, 'write', side_effect=lambda _fd, raw: order.append('write') or len(raw)) as write:
        r.admit_profile_start(profile, probe(), UNIT, {'control': identity}, ready, frame, 42, {}, 43)
    assert order == ['readback', 'binding', 'write']
    assert r.json.loads(write.call_args.args[1]) == frame


@pytest.mark.parametrize('profile', ['fixture', 'metadata', 'environment-metadata', 'environment-bootstrap-metadata', 'environment-bootstrap-controlled'])
@pytest.mark.parametrize('change', ['foreign-mode', 'foreign-ready-field', 'foreign-helper-map', 'missing-helper',
                                    'extra-helper', 'wrong-hash', 'malformed-ready-hash', 'extra-field', 'wrong-scenario-shape'])
def test_profile_or_helper_confusion_never_reaches_resource_admission_or_pipe_write(profile, change):
    frame, ready = start_profile(profile)
    field = next(iter(ready))
    foreign_frame, foreign_ready = start_profile('metadata' if profile == 'fixture' else 'fixture')
    if change == 'foreign-mode': frame['mode'] = foreign_frame['mode']
    if change == 'foreign-ready-field': ready = foreign_ready
    if change == 'foreign-helper-map': frame['helperSha256'] = foreign_frame['helperSha256']
    if change == 'missing-helper': frame['helperSha256'].pop('subscription-worker-lockdown.py')
    if change == 'extra-helper': frame['helperSha256']['other.py'] = 'e' * 64
    if change == 'wrong-hash': frame['helperSha256']['subscription-worker-lockdown.py'] = 'f' * 64
    if change == 'malformed-ready-hash':
        frame['helperSha256']['subscription-worker-lockdown.py'] = 'not-a-sha256'
        ready[field]['helperSha256']['subscription-worker-lockdown.py'] = 'not-a-sha256'
    if change == 'extra-field': frame['argv'] = ['/bin/true']
    if change == 'wrong-scenario-shape':
        if profile == 'fixture': del frame['scenario']
        else: frame['scenario'] = 'normal'
    with patch.object(r, 'admit_start') as admit, patch.object(r.os, 'write') as write, pytest.raises(ValueError):
        r.admit_profile_start(profile, probe(), UNIT, {}, ready, frame, 42, {}, 43)
    admit.assert_not_called()
    write.assert_not_called()


@contextmanager
def private_peer_fixture(raw=None):
    peer = MagicMock()
    peer.__enter__.return_value = peer
    peer.getsockopt.return_value = r.struct.pack('3i', 406, 1000, 1000) if raw is None else raw
    metadata = {'path': '/run/user/1000/systemd/private', 'components': [{'dev': 1, 'ino': 2}] * 5}
    with patch.object(r.socket, 'socket', return_value=peer), \
         patch.object(r.socket, 'AF_UNIX', 1, create=True), patch.object(r.socket, 'SO_PEERCRED', 17, create=True), \
         patch.object(r, 'manager_socket_metadata', return_value=metadata) as paths, \
         patch.object(r, 'process_start_ticks', return_value='88') as ticks, \
         patch.object(r, 'cgroup', return_value='/manager') as groups, \
         patch.object(r.os, 'getuid', return_value=1000, create=True), \
         patch.object(r.os, 'pidfd_open', return_value=42, create=True) as pin, \
         patch.object(r.signal, 'pidfd_send_signal', create=True) as live, patch.object(r.os, 'close') as close:
        yield peer, paths, ticks, groups, pin, live, close


def test_private_peer_is_metadata_only_and_pins_generation_without_exe_access():
    with private_peer_fixture() as (peer, paths, ticks, groups, pin, live, close):
        value = r.manager_connection(probe())
    assert value['managerIdentityProfile'] == 'private-socket-peer-v1'
    assert value['managerPid'] == 406 and value['managerUid'] == 1000
    assert value['managerStartTimeTicks'] == '88'
    peer.connect.assert_called_once_with('/run/user/1000/systemd/private')
    peer.settimeout.assert_called_once_with(1)
    peer.send.assert_not_called()
    peer.recv.assert_not_called()
    pin.assert_called_once_with(406)
    assert live.call_count == 2 and paths.call_count == 2
    close.assert_called_once_with(42)


@pytest.mark.parametrize('case', ['short-peer', 'wrong-uid', 'pid-one', 'path-drift', 'generation-drift', 'cgroup-drift', 'timeout', 'dead-peer'])
def test_private_peer_rejects_every_observed_identity_or_lifetime_failure(case):
    with private_peer_fixture() as (peer, paths, ticks, groups, pin, live, close):
        if case == 'short-peer': peer.getsockopt.return_value = b'x'
        if case == 'wrong-uid': peer.getsockopt.return_value = r.struct.pack('3i', 406, 0, 0)
        if case == 'pid-one': peer.getsockopt.return_value = r.struct.pack('3i', 1, 1000, 1000)
        if case == 'path-drift': paths.side_effect = [paths.return_value, {'path': '/other'}]
        if case == 'generation-drift': ticks.side_effect = ['88', '89']
        if case == 'cgroup-drift': groups.side_effect = ['/manager', '/other']
        if case == 'timeout': peer.connect.side_effect = TimeoutError()
        if case == 'dead-peer': live.side_effect = ProcessLookupError(3, 'gone')
        with pytest.raises((ValueError, OSError)):
            r.manager_connection(probe())
        peer.send.assert_not_called()
        peer.recv.assert_not_called()


@pytest.mark.parametrize('mode,uid', [(0o140600, 1000), (0o120777, 1000), (0o100600, 1000), (0o140600, 0)])
def test_private_socket_walk_rejects_symlink_or_wrong_owner_and_uses_nofollow(mode, uid):
    item = Mock(st_dev=1, st_ino=2, st_mode=0o40755, st_uid=0, st_gid=0)
    final = Mock(st_dev=1, st_ino=9, st_mode=mode, st_uid=uid, st_gid=1000)
    with patch.object(r.os, 'getuid', return_value=1000, create=True), \
         patch.object(r.os, 'O_DIRECTORY', 65536, create=True), patch.object(r.os, 'O_NOFOLLOW', 131072, create=True), \
         patch.object(r.os, 'O_CLOEXEC', 262144, create=True), patch.object(r.os, 'open', side_effect=[10, 11, 12, 13, 14]) as opened, \
         patch.object(r.os, 'close'), patch.object(r.os, 'fstat', return_value=item), patch.object(r.os, 'stat', return_value=final) as final_stat:
        if mode != 0o140600 or uid != 1000:
            with pytest.raises(ValueError): r.manager_socket_metadata()
        else:
            assert len(r.manager_socket_metadata()['components']) == 5
    assert [call.args[0] for call in opened.call_args_list] == ['/', 'run', 'user', '1000', 'systemd']
    assert all(call.args[1] & 131072 for call in opened.call_args_list)
    final_stat.assert_called_once_with('private', dir_fd=14, follow_symlinks=False)


def test_pre_spawn_failure_explicitly_reports_no_spawn_without_cleanup_credit():
    with patch.object(r, 'unit_absent', return_value=True), patch.object(r.Path, 'exists', return_value=False):
        frame = r.failure_evidence(probe(), {'unit': UNIT, 'leaf': LEAF}, 'PRIVATE_MANAGER_PEER_USER')
    assert frame['diagnostics']['notSpawned'] is True
    assert frame['cleanup']['systemdRunClosed'] is False


def probe():
    return Mock(CAPSULE=('/fixed-test-capsule',), leaf_path=Mock(return_value=LEAF), readback=Mock(return_value={
        'leaf': LEAF, 'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '64'}))


@pytest.mark.parametrize('key,value', [('leaf', '/other'), ('memory.max', 'max'), ('memory.swap.max', '1'), ('pids.max', '65')])
def test_wrong_resource_readback_never_writes_start(key, value):
    p = probe()
    p.readback.return_value[key] = value
    with patch.object(r.os, 'write') as write, pytest.raises(ValueError):
        r.admit_start(p, UNIT, {'control': {}}, {'type': 'start'}, 42)
    write.assert_not_called()


def test_start_requires_readback_then_current_identity_then_actual_write():
    order = []
    with patch.object(r, 'exact_readback', side_effect=lambda *_: order.append('readback') or {'pidsMax': '64'}), \
         patch.object(r, 'binding', side_effect=lambda *_: order.append('binding') or {'unitMainPid': 123}), \
         patch.object(r.os, 'write', side_effect=lambda _fd, raw: order.append('write') or len(raw)):
        assert r.admit_start(probe(), UNIT, {'control': {'unitMainPid': 123}}, {'type': 'start'}, 42) == {'pidsMax': '64'}
    assert order == ['readback', 'binding', 'write']


def test_changed_identity_never_writes_start():
    with patch.object(r, 'binding', return_value={'unitMainPid': 456}), patch.object(r.os, 'write') as write, pytest.raises(ValueError):
        r.admit_start(probe(), UNIT, {'control': {'unitMainPid': 123}}, {'type': 'start'}, 42)
    write.assert_not_called()


@pytest.mark.parametrize('outcome', [0, BlockingIOError()])
def test_start_backpressure_never_defers_admitted_frame(outcome):
    with patch.object(r, 'binding', return_value={}), patch.object(r.os, 'write', **({'side_effect': outcome} if isinstance(outcome, Exception) else {'return_value': outcome})), \
         pytest.raises((ValueError, BlockingIOError)):
        r.admit_start(probe(), UNIT, {'control': {}}, {'type': 'start'}, 42)


def test_bounded_queue_and_partial_nonblocking_drain():
    b = r.Buffer(4)
    b.append(b'abcd')
    with pytest.raises(ValueError):
        b.append(b'e')
    with patch.object(r.os, 'write', side_effect=[BlockingIOError(), 2, 2]):
        b.drain(42)
        assert b.data == b'abcd'
        b.drain(42)
        assert b.data == b'cd'
        b.drain(42)
        assert b.data == b''


@pytest.mark.parametrize('code,text,wanted', [(0, b'LoadState=not-found\n', True), (4, b'LoadState=not-found\n', True),
    (0, b'LoadState=loaded\n', False), (1, b'', False), (9, b'LoadState=not-found\n', False)])
def test_unit_absence_requires_exact_successful_query(code, text, wanted):
    with patch.object(r.subprocess, 'run', return_value=Mock(returncode=code, stdout=text)) as run:
        assert r.unit_absent(probe(), UNIT) is wanted
    assert run.call_args.args[0][-2:] == [UNIT, '--property=LoadState']


def test_binding_rejects_wrong_manager_unit_before_process_metadata():
    output = b'MainPID=123\nControlGroup=/wrong\n'
    with patch.object(r.subprocess, 'run', return_value=Mock(stdout=output)), patch.object(r.os, 'pidfd_open', create=True) as pin, pytest.raises(ValueError):
        r.binding(probe(), UNIT)
    pin.assert_not_called()


def test_ownership_backpressure_prevents_any_unit_spawn():
    with patch.object(r.sys, 'platform', 'linux'), patch.object(r.sys, 'argv', ['fixed']), \
         patch.object(r, 'load_probe', return_value=probe()), patch.object(r.os, 'getuid', return_value=1000, create=True), \
         patch.object(r.Path, 'read_bytes', return_value=b'fixed source'), patch.object(r.os, 'set_blocking'), \
         patch.object(r.os, 'write', side_effect=BlockingIOError()), patch.object(r.time, 'monotonic', side_effect=[0, 0, 3]), \
         patch.object(r.time, 'sleep'), patch.object(r.subprocess, 'Popen') as spawn, pytest.raises(ValueError, match='OWNERSHIP_OUTPUT_BACKPRESSURE'):
        r.main()
    spawn.assert_not_called()


def test_failure_evidence_distinguishes_missing_query_from_false_absence():
    ownership = {'unit': UNIT, 'leaf': LEAF}
    with patch.object(r, 'unit_absent', side_effect=OSError()), patch.object(r.Path, 'exists', return_value=False):
        evidence = r.failure_evidence(probe(), ownership, 'x' * 2000, Mock(poll=Mock(return_value=1)), b'fixed stderr', 12)
    assert evidence['cleanup'] == {'unitAbsent': None, 'leafAbsent': True, 'systemdRunClosed': True}
    assert len(evidence['error']) == 1024
    assert evidence['ownership'] == ownership
    assert evidence['diagnostics']['stderrPrefix'] == 'fixed stderr'


def test_main_parent_must_equal_private_peer_pid_without_exe_access():
    output = ('MainPID=123\nControlGroup=' + LEAF.removeprefix('/sys/fs/cgroup') + '\n').encode()
    with patch.object(r.subprocess, 'run', return_value=Mock(stdout=output)), \
         patch.object(r.os, 'pidfd_open', return_value=42, create=True), patch.object(r.os, 'close'), \
         patch.object(r.signal, 'pidfd_send_signal', create=True), \
         patch.object(r, 'cgroup', return_value=LEAF.removeprefix('/sys/fs/cgroup')), \
         patch.object(r.Path, 'read_text', return_value='123 (timeout) S 406 ' + '0 ' * 17 + '99'), \
         patch.object(r, 'manager_connection', return_value={'managerPid': 407}), \
         patch.object(r.os, 'readlink') as readlink, pytest.raises(ValueError, match='PRIVATE_MANAGER_PARENT_MISMATCH'):
        r.binding(probe(), UNIT)
    readlink.assert_not_called()


def test_full_manager_discovery_and_pin_happen_before_unit_spawn():
    order = []
    connection = {'managerPid': 406, 'managerUid': 1000, 'managerStartTimeTicks': '88', 'managerCgroup': '/manager'}
    def spawn(*_, **__):
        order.append('spawn')
        raise OSError('deliberate no-runtime test')
    with patch.object(r.sys, 'platform', 'linux'), patch.object(r.sys, 'argv', ['fixed']), \
         patch.object(r, 'load_probe', return_value=probe()), patch.object(r.os, 'getuid', return_value=1000, create=True), \
         patch.object(r.Path, 'read_bytes', return_value=b'fixed'), patch.object(r.Path, 'exists', return_value=False), \
         patch.object(r, 'unit_absent', return_value=True), patch.object(r, 'emit_before_spawn'), \
         patch.object(r, 'manager_connection', side_effect=lambda _: order.append('discovery') or connection), \
         patch.object(r, 'process_start_ticks', return_value='88'), patch.object(r, 'cgroup', return_value='/manager'), \
         patch.object(r.os, 'pidfd_open', side_effect=lambda _: order.append('pin') or 42, create=True), \
         patch.object(r.signal, 'pidfd_send_signal', create=True), patch.object(r.os, 'close'), \
         patch.object(r.subprocess, 'Popen', side_effect=spawn):
        assert r.main() == 1
    assert order == ['discovery', 'pin', 'spawn']


@pytest.mark.parametrize('drift', ['ticks', 'cgroup'])
def test_retained_preflight_pin_generation_drift_prevents_unit_spawn(drift):
    connection = {'managerPid': 406, 'managerUid': 1000, 'managerStartTimeTicks': '88', 'managerCgroup': '/manager'}
    with patch.object(r.sys, 'platform', 'linux'), patch.object(r.sys, 'argv', ['fixed']), \
         patch.object(r, 'load_probe', return_value=probe()), patch.object(r.os, 'getuid', return_value=1000, create=True), \
         patch.object(r.Path, 'read_bytes', return_value=b'fixed'), patch.object(r.Path, 'exists', return_value=False), \
         patch.object(r, 'unit_absent', return_value=True), patch.object(r, 'emit_before_spawn') as emitted, \
         patch.object(r, 'manager_connection', return_value=connection), \
         patch.object(r, 'process_start_ticks', return_value='89' if drift == 'ticks' else '88'), \
         patch.object(r, 'cgroup', return_value='/other' if drift == 'cgroup' else '/manager'), \
         patch.object(r.os, 'pidfd_open', return_value=42, create=True), \
         patch.object(r.signal, 'pidfd_send_signal', create=True), patch.object(r.os, 'close'), \
         patch.object(r.subprocess, 'Popen') as spawn:
        assert r.main() == 1
    spawn.assert_not_called()
    failure = emitted.call_args.args[0]
    assert 'PRIVATE_MANAGER_GENERATION_CHANGED' in failure['error']
    assert failure['diagnostics']['notSpawned'] is True


def test_fresh_prestart_peer_mismatch_never_writes_first_start_bytes():
    connection = {'managerPid': 406, 'managerUid': 1000, 'managerStartTimeTicks': '88', 'managerCgroup': '/manager'}
    group = LEAF.removeprefix('/sys/fs/cgroup')
    output = ('MainPID=123\nControlGroup=' + group + '\n').encode()
    with patch.object(r.subprocess, 'run', return_value=Mock(stdout=output)), \
         patch.object(r.os, 'pidfd_open', return_value=42, create=True), patch.object(r.os, 'close'), \
         patch.object(r.signal, 'pidfd_send_signal', create=True), patch.object(r, 'cgroup', return_value=group), \
         patch.object(r.Path, 'read_text', return_value='123 (timeout) S 406 ' + '0 ' * 17 + '99'), \
         patch.object(r, 'manager_connection', return_value={**connection, 'managerPid': 407}), \
         patch.object(r.os, 'write') as write, pytest.raises(ValueError, match='PRIVATE_MANAGER_IDENTITY_CHANGED'):
        r.admit_start(probe(), UNIT, {'control': {}}, {'type': 'start'}, 44, connection, 43)
    write.assert_not_called()


def test_ready_binding_rechecks_entire_private_peer_identity_against_retained_pin():
    connection = {'managerPid': 406, 'managerUid': 1000, 'managerStartTimeTicks': '88', 'managerCgroup': '/manager'}
    group = LEAF.removeprefix('/sys/fs/cgroup')
    output = ('MainPID=123\nControlGroup=' + group + '\n').encode()
    with patch.object(r.subprocess, 'run', return_value=Mock(stdout=output)), \
         patch.object(r.os, 'pidfd_open', return_value=42, create=True), patch.object(r.os, 'close'), \
         patch.object(r.signal, 'pidfd_send_signal', create=True), \
         patch.object(r, 'cgroup', side_effect=[group, '/driver', '/manager']), \
         patch.object(r.Path, 'read_text', return_value='123 (timeout) S 406 ' + '0 ' * 17 + '99'), \
         patch.object(r, 'manager_connection', return_value=connection) as discovery:
        result = r.binding(probe(), UNIT, connection, 43)
    discovery.assert_called_once()
    assert result['unitMainStartTimeTicks'] == '99'
    assert result['managerPid'] == 406


def test_stage_trace_keeps_original_exception_and_bounds_event_history():
    trace = r.StageTrace()
    with pytest.raises(ProcessLookupError):
        trace.run('main_pidfd_live_after', lambda: (_ for _ in ()).throw(ProcessLookupError(3, 'gone')))
    assert trace.events[0]['stage'] == 'main_pidfd_live_after'
    assert trace.events[0]['errno'] == 3
    assert trace.events[0]['outcome'] == 'error'
    for _ in range(100):
        trace.run('bounded', lambda: None)
    assert len(trace.events) == 64
    assert trace.events_dropped == 37


def test_failed_capsule_terminal_is_retained_as_diagnostic_with_actual_line_hash():
    raw = b'{ "version":1, "type":"terminal", "reason":"START_TIMEOUT" }'
    trace = r.StageTrace()
    trace.capture_terminal(raw)
    assert trace.capsule_terminal['rawSha256'] == r.hashlib.sha256(raw).hexdigest()
    assert trace.capsule_terminal['frame']['reason'] == 'START_TIMEOUT'
    for rejected in [b'not json', b'[]', b'{"type":"ready","version":1}', b'x' * 65537]:
        trace.capture_terminal(rejected)
    assert trace.capsule_terminal['rawSha256'] == r.hashlib.sha256(raw).hexdigest()


@pytest.mark.parametrize('body', ['x' * 64000, '\u00e9' * 10000, '\u00e9' * 1000],
                         ids=['near_raw_cap', 'unicode_oversize', 'envelope_omission'])
def test_complete_failure_envelope_is_bounded_with_large_unicode_terminal_and_max_events(body):
    raw = r.json.dumps({'version': 1, 'type': 'terminal', 'reason': 'START_TIMEOUT', 'text': body}, ensure_ascii=False).encode()
    assert len(raw) <= 65536
    trace = r.StageTrace()
    trace.capture_terminal(raw)
    for _ in range(64):
        trace.run('\uffff' * 64, lambda: None)
    ownership = {'unit': UNIT, 'uid': 1000, 'leaf': LEAF, 'driverPid': 123, 'relaySha256': 'a' * 64, 'probeSha256': 'b' * 64}
    reason = '\uffff' * 1024
    with patch.object(r, 'TRACE', trace), patch.object(r, 'unit_absent', return_value=True), patch.object(r.Path, 'exists', return_value=False):
        frame = r.failure_evidence(probe(), ownership, reason, Mock(poll=Mock(return_value=1)), b'\xff' * 4096, 65536)
    wire = r.Buffer()
    wire.frame(frame)
    assert len(wire.data) <= r.FAILURE_FRAME_LIMIT < r.QUEUE_LIMIT
    assert frame['error'] == reason
    assert frame['ownership'] == ownership
    inner = frame['stageEvidence']['capsuleFailureTerminal']
    assert inner['frame'] is None
    assert inner['omittedReason'] in ('CANONICAL_TERMINAL_LIMIT', 'FAILURE_ENVELOPE_LIMIT')
    assert inner['rawSha256'] == r.hashlib.sha256(raw).hexdigest()
    assert inner['rawBytes'] == len(raw)
    assert inner['canonicalBytes'] > 0
    assert frame['stageEvidence']['eventsDropped'] > 0
    assert frame['diagnostics']['stderrPrefixTruncated'] is True


def test_trusted_control_profile_is_fixed_eight_helper_noninteractive():
    assert r.select_profile(['--trusted-control-boundary']) == 'trusted-control-boundary'
    mode, field, names = r.profile_contract('trusted-control-boundary')
    assert (mode, field) == ('trusted-control-boundary', 'trustedControlBoundary')
    assert set(names) == {'subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
        'subscription-exec-worker-probe.py', 'subscription-trusted-control-boundary-probe.py',
        'subscription-worker-lockdown.py', 'subscription-appserver-noenv.py',
        'subscription-text-model-catalog.json', 'subscription-trusted-control-boundary-parent.py'}
    hashes = dict.fromkeys(names, 'a' * 64)
    ready = {field: {'helperSha256': hashes}}
    start = {'type': 'start', 'mode': mode, 'helperSha256': dict(hashes)}
    r.validate_profile_start(mode, start, ready)
    with pytest.raises(ValueError, match='NONINTERACTIVE'):
        r.require_interactive_profile(mode)


@pytest.mark.parametrize('case', ['scenario', 'wrong-mode', 'missing-helper', 'extra-helper', 'changed-helper', 'ready-wrong-field'])
def test_trusted_profile_malformed_start_never_reaches_resource_or_pipe_dispatch(case):
    mode, field, names = r.profile_contract('trusted-control-boundary')
    hashes = dict.fromkeys(names, 'a' * 64)
    ready = {field: {'helperSha256': dict(hashes)}}
    start = {'type': 'start', 'mode': mode, 'helperSha256': dict(hashes)}
    if case == 'scenario': start['scenario'] = 'normal'
    if case == 'wrong-mode': start['mode'] = 'exec-environment-bootstrap-controlled'
    if case == 'missing-helper': start['helperSha256'].pop(names[0])
    if case == 'extra-helper': start['helperSha256']['caller.py'] = 'a' * 64
    if case == 'changed-helper': start['helperSha256'][names[0]] = 'b' * 64
    if case == 'ready-wrong-field': ready = {'execEnvironmentMetadataBoundary': ready[field]}
    with patch.object(r, 'admit_start') as dispatch, pytest.raises(ValueError):
        r.admit_profile_start(mode, None, UNIT, {}, ready, start, 1, {}, 2)
    dispatch.assert_not_called()


def ingress_start(profile='trusted-ingress-boundary'):
    mode, field, names = r.profile_contract(profile)
    hashes = dict.fromkeys(names, 'a' * 64)
    return ({'type': 'start', 'mode': mode, 'helperSha256': hashes, 'nonce': 'b' * 32},
            {field: {'helperSha256': dict(hashes)}, 'systemdIngressBoundary': {'nonce': 'b' * 32}})


def test_cli_proxy_refusal_is_fixed_ten_helper_noninteractive_and_has_no_nonce():
    profile = 'cli-proxy-refusal'
    assert r.select_profile(['--cli-proxy-refusal']) == profile
    mode, field, names = r.profile_contract(profile)
    assert len(names) == 10
    frame = {'type':'start','mode':mode,'helperSha256':dict.fromkeys(names,'a'*64)}
    ready = {field:{'helperSha256':dict(frame['helperSha256'])}}
    r.validate_profile_start(profile, frame, ready)
    for delta in ({'nonce':'a'*32},{'mode':'trusted-http-ingress-boundary'},{'scenario':'normal'}, {'helperSha256':{}}):
        with patch.object(r, 'admit_start') as dispatch, pytest.raises(ValueError):
            r.admit_profile_start(profile,None,UNIT,{},ready,{**frame,**delta},1,{},2)
        dispatch.assert_not_called()
    with pytest.raises(ValueError, match='NONINTERACTIVE'): r.require_interactive_profile(profile)


def test_cli_proxy_capsule_adds_only_fixed_selector_and_never_uses_ingress():
    capsule = ['/usr/bin/timeout','--signal=TERM','--kill-after=5','200','/usr/bin/unshare','--user','--net','/bin/sh','/fixed/supervisor.sh']
    probe = Mock(CAPSULE=capsule)
    assert r.fixed_capsule_argv(probe,'cli-proxy-refusal',None) == [*capsule,'--cli-proxy-refusal']
    assert r.fixed_capsule_argv(probe,'fixture',None) is capsule
    receiver = Mock(); receiver.receiver_argv.return_value = ['fixed-owned-receiver']
    assert r.fixed_capsule_argv(probe,'trusted-ingress-boundary',receiver) == ['fixed-owned-receiver']
    for profile, ingress in (('cli-proxy-refusal',receiver),('trusted-ingress-boundary',None),('trusted-http-ingress-boundary',None)):
        with pytest.raises(ValueError, match='INGRESS_TRANSPORT_MISMATCH'):
            r.fixed_capsule_argv(probe,profile,ingress)
    with pytest.raises(ValueError): r.fixed_capsule_argv(probe,'arbitrary',None)


def test_cgroup_fixed_ten_helpers_and_shared_resource_admission():
    profile='trusted-cgroup-worker-boundary'
    assert r.select_profile(['--'+profile])==profile
    mode,field,names=r.profile_contract(profile)
    assert (mode,field)==(profile,'trustedCgroupWorkerBoundary')
    assert set(names)==set(r.profile_contract('trusted-control-boundary')[2])|{
        'subscription-trusted-cgroup-worker-probe.py','subscription-trusted-cgroup-worker-child.py'}
    assert len(names)==10
    start={'type':'start','mode':mode,'helperSha256':dict.fromkeys(names,'a'*64)}
    ready={field:{'helperSha256':dict(start['helperSha256'])}}
    with patch.object(r,'admit_start',return_value={'prestart':'actual-resource-seam'}) as dispatch:
        assert r.admit_profile_start(profile,'probe',UNIT,'receipt',ready,start,1,'manager',2)=={'prestart':'actual-resource-seam'}
        dispatch.assert_called_once_with('probe',UNIT,'receipt',start,1,'manager',2)
    with pytest.raises(ValueError,match='NONINTERACTIVE'):r.require_interactive_profile(profile)


@pytest.mark.parametrize('case',['nonce','scenario','oldmode','oldfield','missinghash','extrahash','wronghash','unknownselector'])
def test_cgroup_refuses_foreign_profile_before_resource_start(case):
    profile='trusted-cgroup-worker-boundary';mode,field,names=r.profile_contract(profile)
    start={'type':'start','mode':mode,'helperSha256':dict.fromkeys(names,'a'*64)}
    ready={field:{'helperSha256':dict(start['helperSha256'])}}
    if case=='nonce':start['nonce']='a'*32
    elif case=='scenario':start['scenario']='normal'
    elif case=='oldmode':start['mode']='trusted-control-boundary'
    elif case=='oldfield':ready={'trustedControlBoundary':ready[field]}
    elif case=='missinghash':start['helperSha256'].pop(names[-1])
    elif case=='extrahash':start['helperSha256']['foreign.py']='a'*64
    elif case=='wronghash':start['helperSha256'][names[-1]]='b'*64
    elif case=='unknownselector':
        with pytest.raises(ValueError):r.select_profile(['--'+profile,'--metadata-pipe'])
        return
    with patch.object(r,'admit_start') as dispatch,pytest.raises(ValueError):
        r.admit_profile_start(profile,None,UNIT,{},ready,start,1,{},2)
    dispatch.assert_not_called()


def test_cgroup_capsule_selector_has_no_ingress_or_limit_change():
    capsule=['/usr/bin/timeout','--signal=TERM','--kill-after=5','200','/usr/bin/unshare','--user','--net','/bin/sh','/fixed/supervisor.sh']
    probe=Mock(CAPSULE=capsule)
    assert r.fixed_capsule_argv(probe,'trusted-cgroup-worker-boundary',None)==[*capsule,'--trusted-cgroup-worker-boundary']
    assert r.LIMITS=={'memoryMaxBytes':2147483648,'swapMaxBytes':0,'tasksMax':64,'guardianMs':220000,'termGraceMs':5000,'innerCommandMs':200000}
    with pytest.raises(ValueError,match='INGRESS_TRANSPORT_MISMATCH'):
        r.fixed_capsule_argv(probe,'trusted-cgroup-worker-boundary',Mock())
    with patch.object(r,'importlib') as loader,pytest.raises(ValueError,match='FIXED_INGRESS_PROFILE_REQUIRED'):
        r.create_ingress('trusted-cgroup-worker-boundary')
    loader.util.spec_from_file_location.assert_not_called()


def test_ingress_start_is_fixed_ten_helper_nonce_bound_noninteractive():
    assert r.select_profile(['--trusted-ingress-boundary']) == 'trusted-ingress-boundary'
    start, ready = ingress_start()
    assert len(start['helperSha256']) == 10
    r.validate_profile_start('trusted-ingress-boundary', start, ready)
    with pytest.raises(ValueError, match='NONINTERACTIVE'):
        r.require_interactive_profile('trusted-ingress-boundary')


@pytest.mark.parametrize('profile', ['trusted-ingress-boundary', 'trusted-http-ingress-boundary'])
@pytest.mark.parametrize('case', ['missing-nonce', 'wrong-nonce', 'bool-nonce', 'extra-fd', 'missing-helper', 'missing-binding'])
def test_ingress_start_rejects_before_resource_or_dispatch(case, profile):
    start, ready = ingress_start(profile)
    if case == 'missing-nonce': del start['nonce']
    if case == 'wrong-nonce': start['nonce'] = 'c' * 32
    if case == 'bool-nonce': start['nonce'] = True
    if case == 'extra-fd': start['fd'] = 198
    if case == 'missing-helper': start['helperSha256'].pop('subscription-trusted-ingress-child.py')
    if case == 'missing-binding': ready.pop('systemdIngressBoundary')
    with patch.object(r, 'admit_start') as dispatch, pytest.raises(ValueError):
        r.admit_profile_start(profile, None, UNIT, {}, ready, start, 1, {}, 2)
    dispatch.assert_not_called()


def test_http_ingress_exact_fourteen_helper_profile_refuses_old_start():
    profile = 'trusted-http-ingress-boundary'
    assert r.select_profile(['--' + profile]) == profile
    start, ready = ingress_start(profile)
    assert len(start['helperSha256']) == 14
    r.validate_profile_start(profile, start, ready)
    with pytest.raises(ValueError, match='NONINTERACTIVE'): r.require_interactive_profile(profile)
    old_start, old_ready = ingress_start()
    for chosen, frame, evidence in ((profile, old_start, ready), ('trusted-ingress-boundary', start, old_ready),
                                    (profile, start, old_ready)):
        with patch.object(r, 'admit_start') as dispatch, pytest.raises(ValueError):
            r.admit_profile_start(chosen, None, UNIT, {}, evidence, frame, 1, {}, 2)
        dispatch.assert_not_called()


def test_http_ingress_rejects_extra_helper_even_when_ready_matches():
    start, ready = ingress_start('trusted-http-ingress-boundary')
    start['helperSha256']['unexpected.py'] = 'c' * 64
    ready['trustedHttpIngressBoundary']['helperSha256'] = dict(start['helperSha256'])
    with pytest.raises(ValueError, match='HELPER_IDENTITY'):
        r.validate_profile_start('trusted-http-ingress-boundary', start, ready)


def test_ingress_factory_selects_only_fixed_source_bound_constructor(tmp_path):
    path = tmp_path / 'subscription-systemd-ingress-rendezvous.py'
    path.write_text("SOURCES=('subscription-systemd-ingress-rendezvous.py',)\n"
                    "def create_rendezvous(hashes): return ('legacy', hashes)\n"
                    "def create_http_rendezvous(hashes): return ('http', hashes)\n")
    with patch.object(r, 'ROOT', tmp_path):
        assert r.create_ingress()[0] == 'legacy'
        actual = r.create_ingress('trusted-http-ingress-boundary')
        assert actual == ('http', {path.name: r.hashlib.sha256(path.read_bytes()).hexdigest()})
        with pytest.raises(ValueError, match='FIXED_INGRESS_PROFILE'):
            r.create_ingress('arbitrary')


def ingress_binding():
    socket = {'dev': 9, 'ino': 100, 'type': 49152, 'family': 1, 'socketType': 1}
    owner = {'unit': UNIT, 'nonce': 'b' * 32}
    handoff = {**owner, 'socket': socket, 'control': {'unitMainPid': 123}, 'transferObserved': True, 'productionReady': False}
    frame = {'trustedIngressFd': {'fd': 198, 'socket': dict(socket), 'bootstrapInheritance': 'trusted-setup-only', 'preservedAcrossPivot': True}}
    return frame, owner, handoff, {'control': {'unitMainPid': 123}}


def test_post_pivot_socket_and_same_unit_generation_binding():
    frame, owner, handoff, receipt = ingress_binding()
    assert r.bind_ingress_ready(frame, owner, handoff, receipt) == {'nonce': owner['nonce'], 'ownership': owner, 'handoff': handoff}


@pytest.mark.parametrize('case', ['socket', 'fd', 'boolean-family', 'generation', 'unit', 'nonce', 'unobserved', 'production'])
def test_post_pivot_binding_rejects_drift(case):
    frame, owner, handoff, receipt = ingress_binding()
    if case == 'socket': frame['trustedIngressFd']['socket']['ino'] += 1
    if case == 'fd': frame['trustedIngressFd']['fd'] = 199
    if case == 'boolean-family': frame['trustedIngressFd']['socket']['family'] = True
    if case == 'generation': receipt['control']['unitMainPid'] += 1
    if case == 'unit': handoff['unit'] += 'x'
    if case == 'nonce': handoff['nonce'] = 'c' * 32
    if case == 'unobserved': handoff['transferObserved'] = False
    if case == 'production': handoff['productionReady'] = True
    with pytest.raises(ValueError, match='POST_PIVOT'):
        r.bind_ingress_ready(frame, owner, handoff, receipt)


def test_ingress_cleanup_failure_remains_unknown_and_does_not_skip_unit_cleanup_caller():
    ingress = Mock()
    ingress.finish_route.side_effect = OSError('owned descriptor close failed')
    result = r.finish_ingress_route(ingress, UNIT)
    assert result['passed'] is False and result['ownedCleanupVerified'] is False
    assert result['remoteUnitCleanup'] == 'NOT_ATTESTED'


def test_one_handle_close_failure_does_not_skip_remaining_owned_handles():
    selector, process = Mock(), Mock()
    selector.close.side_effect = OSError('selector close failed')
    for name in ('stdin', 'stdout', 'stderr'):
        getattr(process, name).closed = False
    process.stdout.close.side_effect = OSError('stdout close failed')
    with patch.object(r.os, 'close') as close, pytest.raises(OSError, match='selector close failed'):
        r.close_relay_handles(selector, 42, process)
    close.assert_called_once_with(42)
    for name in ('stdin', 'stdout', 'stderr'):
        getattr(process, name).close.assert_called_once()


@pytest.mark.parametrize('stage', ['leaf', 'hash', 'ownership', 'argv'])
def test_ingress_prespawn_failure_closes_owned_rendezvous_without_spawning(stage):
    ingress = Mock(unit=UNIT)
    resource = Mock()
    resource.leaf_path.return_value = LEAF
    with ExitStack() as stack:
        stack.enter_context(patch.object(r.sys, 'platform', 'linux'))
        stack.enter_context(patch.object(r.sys, 'argv', ['relay', '--trusted-ingress-boundary']))
        stack.enter_context(patch.object(r, 'load_probe', return_value=resource))
        stack.enter_context(patch.object(r, 'create_ingress', return_value=ingress))
        stack.enter_context(patch.object(r.os, 'getuid', return_value=1000, create=True))
        data = stack.enter_context(patch.object(r.Path, 'read_bytes', return_value=b'fixed source'))
        output = stack.enter_context(patch.object(r, 'emit_before_spawn'))
        spawn = stack.enter_context(patch.object(r.subprocess, 'Popen'))
        if stage == 'leaf': resource.leaf_path.side_effect = OSError('leaf failed')
        if stage == 'hash': data.side_effect = OSError('source failed')
        if stage == 'ownership': output.side_effect = ValueError('backpressure')
        if stage == 'argv': ingress.receiver_argv.side_effect = ValueError('argv failed')
        with pytest.raises((ValueError, OSError)):
            r.main()
        ingress.finish_route.assert_called_once()
        spawn.assert_not_called()


@pytest.mark.parametrize('stage', ['selector', 'register', 'nonblocking', 'failure-output', 'preflight-close'])
def test_postspawn_setup_failure_stops_only_owned_unit_and_closes_all_domains(stage):
    ingress = Mock(unit=UNIT)
    ingress.receiver_argv.return_value = ('/usr/bin/python3', 'fixed-receiver')
    ingress.ownership.return_value = {'unit': UNIT}
    ingress.finish_route.return_value = {'passed': False, 'ownedCleanupVerified': True}
    resource = Mock()
    resource.leaf_path.return_value = LEAF
    resource.environment.return_value = {'PATH': '/usr/bin:/bin'}
    process = Mock()
    process.poll.return_value = 0
    for number, name in enumerate(('stdin', 'stdout', 'stderr'), 10):
        pipe = getattr(process, name)
        pipe.fileno.return_value = number
        pipe.closed = False
        pipe.close.side_effect = lambda pipe=pipe: setattr(pipe, 'closed', True)
    manager = {'managerPid': 123, 'managerStartTimeTicks': '9', 'managerCgroup': '/outside'}
    with ExitStack() as stack:
        stack.enter_context(patch.object(r.sys, 'platform', 'linux'))
        stack.enter_context(patch.object(r.sys, 'argv', ['relay', '--trusted-ingress-boundary']))
        stack.enter_context(patch.object(r, 'load_probe', return_value=resource))
        stack.enter_context(patch.object(r, 'create_ingress', return_value=ingress))
        stack.enter_context(patch.object(r.os, 'getuid', return_value=1000, create=True))
        stack.enter_context(patch.object(r.Path, 'read_bytes', return_value=b'fixed source'))
        stack.enter_context(patch.object(r.Path, 'exists', return_value=False))
        stack.enter_context(patch.object(r, 'emit_before_spawn'))
        stack.enter_context(patch.object(r, 'unit_absent', return_value=True))
        stack.enter_context(patch.object(r, 'manager_connection', return_value=manager))
        ticks = stack.enter_context(patch.object(r, 'process_start_ticks', return_value='9'))
        stack.enter_context(patch.object(r, 'cgroup', return_value='/outside'))
        stack.enter_context(patch.object(r.os, 'pidfd_open', return_value=42, create=True))
        stack.enter_context(patch.object(r.signal, 'pidfd_send_signal', create=True))
        spawn = stack.enter_context(patch.object(r.subprocess, 'Popen', return_value=process))
        stop = stack.enter_context(patch.object(r.subprocess, 'run', return_value=Mock(returncode=0)))
        selector = stack.enter_context(patch.object(r.selectors, 'DefaultSelector'))
        blocking = stack.enter_context(patch.object(r.os, 'set_blocking'))
        read = stack.enter_context(patch.object(r.os, 'read', return_value=b''))
        write = stack.enter_context(patch.object(r.os, 'write', side_effect=lambda fd, raw: len(raw)))
        close = stack.enter_context(patch.object(r.os, 'close'))
        stack.enter_context(patch.object(r.time, 'sleep'))
        stack.enter_context(patch.object(r, 'failure_evidence', return_value={'type': 'systemd_failure'}))
        if stage == 'selector': selector.side_effect = OSError('selector failed')
        if stage == 'register': selector.return_value.register.side_effect = OSError('register failed')
        if stage == 'nonblocking':
            def reject_stdout(fd, value):
                if fd == 11: raise OSError('cannot make stdout nonblocking')
            blocking.side_effect = reject_stdout
        if stage == 'failure-output':
            selector.side_effect = OSError('selector failed')
            blocking.side_effect = OSError('nonblocking mode unknown; no diagnostic write allowed')
        if stage == 'preflight-close':
            ticks.return_value = '10'
            close.side_effect = OSError('manager handle close failed')
        assert r.main() == 1
        if stage == 'preflight-close':
            ingress.finish_route.assert_called_once()
            spawn.assert_not_called()
            stop.assert_not_called()
            return
        assert stop.call_args.args[0] == ['/usr/bin/systemctl', '--user', '--no-ask-password', '--no-block', 'stop', UNIT]
        ingress.finish_route.assert_called_once()
        ingress.transfer.assert_not_called()
        close.assert_any_call(42)
        assert all(getattr(process, name).closed for name in ('stdin', 'stdout', 'stderr'))
        if stage == 'nonblocking': assert all(call.args[0] != 11 for call in read.call_args_list)
        if stage == 'failure-output': write.assert_not_called()


def stress_start(phase):
    profile='candidate-resource-stress-'+phase
    mode,field,names=r.profile_contract(profile);helpers={name:'a'*64 for name in names}
    return profile,{'type':'start','mode':mode,'helperSha256':helpers},{field:{'phase':phase,'helperSha256':dict(helpers)}}


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_stress_profile_exact11_phase_and_fixed_argv(phase):
    profile,frame,ready=stress_start(phase)
    assert r.select_profile(['--'+profile])==profile and len(frame['helperSha256'])==11
    r.validate_profile_start(profile,frame,ready)
    p=Mock();p.CAPSULE=['fixed-capsule'];p.leaf_path.return_value=LEAF
    capsule=r.fixed_capsule_argv(p,profile,None)
    assert capsule==['fixed-capsule','--'+profile]
    argv=r._unit_argv(p,profile,UNIT,capsule)
    assert '--property=OOMPolicy=continue' in argv
    assert all(x in argv for x in ('--property=MemoryMax=2G','--property=MemorySwapMax=0','--property=TasksMax=64','--property=RuntimeMaxSec=220','--property=TimeoutStopSec=5'))
    assert '--property=OOMPolicy=continue' not in r._unit_argv(p,'fixture',UNIT,p.CAPSULE)


@pytest.mark.parametrize('case',['phase','hash','extra','mode','missing'])
def test_stress_start_rejects_crossprofile_or_helper_drift(case):
    profile,frame,ready=stress_start('tasks');boundary=ready['candidateResourceStressBoundary']
    if case=='phase':boundary['phase']='memory'
    elif case=='hash':frame['helperSha256'][next(iter(frame['helperSha256']))]='b'*64
    elif case=='extra':boundary['extra']=True
    elif case=='mode':frame['mode']='candidate-resource-stress-memory'
    else:del boundary['helperSha256'][next(iter(boundary['helperSha256']))]
    with pytest.raises(ValueError):r.validate_profile_start(profile,frame,ready)


def delivery(action):return {'version':1,'type':'stress_action_delivered','action':action,'workerAcknowledged':False,'observerAdmissionAttestedHere':False}


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_finite_stress_actions_wait_for_actual_supervisor_delivery(phase):
    channel=r.StressActions('candidate-resource-stress-'+phase)
    actions=['start','release'] if phase=='tasks' else ['start','ramp','release']
    for action in actions:
        channel.accept({'type':'stress_action','action':action})
        with pytest.raises(ValueError):channel.accept({'type':'stress_action','action':action})
        channel.delivered(delivery(action))
    with pytest.raises(ValueError):channel.accept({'type':'stress_action','action':'start'})


@pytest.mark.parametrize('case',['duplicate','wrong','workercredit','observercredit','boolversion','extra'])
def test_stress_delivery_rejects_forged_or_duplicate_credit(case):
    channel=r.StressActions('candidate-resource-stress-tasks');channel.accept({'type':'stress_action','action':'start'});frame=delivery('start')
    if case=='duplicate':channel.delivered(frame)
    elif case=='wrong':frame['action']='release'
    elif case=='workercredit':frame['workerAcknowledged']=True
    elif case=='observercredit':frame['observerAdmissionAttestedHere']=True
    elif case=='boolversion':frame['version']=True
    else:frame['seq']=1
    with pytest.raises(ValueError):channel.delivered(frame)


def test_stress_prestart_extra_readback_must_match_before_write():
    profile,frame,ready=stress_start('tasks');facts={'memoryMax':'2147483648','memorySwapMax':'0','pidsMax':'64','memoryOomGroup':'0','oomPolicy':'continue'}
    with patch.object(r,'stress_readback',return_value=facts),patch.object(r,'admit_start',return_value={'base':'readback'}) as write:
        assert r.admit_profile_start(profile,None,UNIT,{'readback':facts},ready,frame,42,{},43)['oomPolicy']=='continue'
        write.assert_called_once()
    with patch.object(r,'stress_readback',return_value={**facts,'oomPolicy':'stop'}),patch.object(r,'admit_start') as write:
        with pytest.raises(ValueError):r.admit_profile_start(profile,None,UNIT,{'readback':facts},ready,frame,42,{},43)
        write.assert_not_called()


def test_stress_cli_requires_source_prelude_before_any_probe_or_spawn():
    with patch.object(r.sys,'platform','linux'),patch.object(r.sys,'argv',['relay','--candidate-resource-stress-tasks']),patch.object(r,'read_stress_composition',side_effect=ValueError('bad prelude')),patch.object(r,'load_probe') as load,patch.object(r.subprocess,'Popen') as spawn:
        with pytest.raises(ValueError,match='bad prelude'):r.main()
        load.assert_not_called();spawn.assert_not_called()


def test_token_bound_composition_is_failclosed_and_owns_only_observer_identity():
    with pytest.raises(ValueError):r.StressComposition('tasks',Mock(),{},None)
    observer=Mock();observer.unit=UNIT;observer.close.return_value=True
    owner=r.StressComposition('tasks',observer,{},r._STRESS_TOKEN)
    assert owner.unit==UNIT
    with patch.object(r,'_run_profile',return_value=0) as run:
        assert owner.run()==0;run.assert_called_once_with(owner.profile,owner)
    assert owner.close() and owner.close();observer.close.assert_called_once()



@pytest.mark.parametrize('tamper',[False,True])
def test_real_fixed_source_composition_has_observer_generated_unit_and_no_spawn(monkeypatch,tamper):
    import hashlib
    root=Path(__file__).parents[1]
    hashes={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in r.STRESS_OBSERVER_FILES}
    if tamper:hashes[r.STRESS_OBSERVER_FILES[0]]='0'*64
    monkeypatch.setattr(r,'ROOT',root);monkeypatch.setattr(r,'_STRESS_UNKNOWN',False)
    # Native Windows source reads only; no Linux descriptor/namespace claims.
    monkeypatch.setattr(r.os,'O_CLOEXEC',0,raising=False);monkeypatch.setattr(r.os,'O_NOFOLLOW',0,raising=False);monkeypatch.setattr(r.os,'O_NONBLOCK',0,raising=False)
    monkeypatch.setattr(r.os,'getuid',lambda:1000,raising=False)
    monkeypatch.setattr(r.os,'O_RDONLY',r.os.O_RDONLY | getattr(r.os,'O_BINARY',0))
    with patch.object(r.subprocess,'Popen') as spawn:
        if tamper:
            with pytest.raises(ValueError,match='SOURCE_HASH'):r.create_stress_composition('tasks',r.time.monotonic()+10,hashes)
        else:
            owner=r.create_stress_composition('tasks',r.time.monotonic()+10,hashes)
            assert r.re.fullmatch('codex-cli-resource-[a-f0-9]{32}\\.service',owner.unit)
            assert callable(owner._capacity.check_capacity)
            with patch.object(r,'_run_profile',return_value=0) as run:
                assert owner.run()==0;run.assert_called_once_with(owner.profile,owner)
            assert owner.close()
        spawn.assert_not_called()



def owner_fixture(phase='tasks'):
    import time
    from types import SimpleNamespace
    baseline={'values':{'pids.events':{'max':0},'pids.current':8,'memory.events':{'oom_kill':0}}}
    current={'values':{'pids.events':{'max':1},'pids.current':64,'memory.events':{'oom_kill':1}}}
    outcomes={'outcomes':[{'identity':{'pid':3},'pidfdExitObserved':False},{'identity':{'pid':4},'pidfdExitObserved':phase=='memory'}]}
    observer=Mock();observer.unit=UNIT;observer.deadline=time.monotonic()+30;observer.close.return_value=True
    observer.open.return_value={'baseline':baseline};observer.sample.return_value=current;observer.observe_outcomes.return_value=outcomes
    observer.admit_workers.return_value={'releaseAdmitted':True,'releaseWritten':False}
    owner=r.StressComposition(phase,observer,{},r._STRESS_TOKEN,Mock())
    return owner,observer,current,outcomes


def progress_frame(record):
    import base64,json
    raw=(json.dumps(record,separators=(',',':'))+'\n').encode()
    wrapper={'version':1,'type':'candidate_stress_progress','phase':record['phase'],'record':record,'rawHex':raw.hex()}
    data=(json.dumps(wrapper,separators=(',',':'))+'\n').encode()
    return {'version':1,'type':'child_output','stream':'stdout','encoding':'base64','data':base64.b64encode(data).decode()}


def held_record(phase):
    return {'type':'held','phase':phase,'workerIdentity':{'pid':3,'startTicks':'10','pidNamespace':'pid:[5]','procInitPidNamespace':'pid:[5]'},'childIdentities':[{'pid':4,'startTicks':'11'}]}


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_owner_actual_progress_calls_observer_before_release(phase):
    owner,observer,current,outcomes=owner_fixture(phase)
    assert owner.ready()['stage']=='baseline'
    owner._fresh_capacity=Mock(return_value={'admitted':True})
    assert owner.before_action('start')['stage']=='before-work-capacity'
    with pytest.raises(ValueError,match='PERMISSION'):owner.before_action('release')
    actual=held_record(phase)
    result=owner.output(progress_frame(actual));assert result[0]['stage']=='workers-held'
    observer.admit_workers.assert_called_once_with({key:actual[key] for key in ('phase','workerIdentity','childIdentities')})
    if phase=='memory':
        assert owner.tick() is None
        owner.before_action('ramp')
        owner.output(progress_frame({'type':'ramp-complete','phase':'memory','allocationCapPerChild':1207959552}))
    assert owner.tick()['evidence']['releaseAdmitted'] is True
    assert owner.before_action('release')['evidence']['releaseAdmitted'] is True
    assert owner.close()


@pytest.mark.parametrize('case',['worker-exited','foreign-exited','no-oom','tasks-below64','no-pids-event'])
def test_owner_never_uses_worker_or_foreign_exit_as_allocator_proof(case):
    phase='tasks' if case.startswith('tasks') or case=='no-pids-event' else 'memory'
    owner,observer,current,outcomes=owner_fixture(phase);owner.ready();owner.output(progress_frame(held_record(phase)));owner._ramped=True
    if case=='worker-exited':outcomes['outcomes'][0]['pidfdExitObserved']=True
    elif case=='foreign-exited':outcomes['outcomes'][1]['identity']['pid']=999
    elif case=='no-oom':current['values']['memory.events']['oom_kill']=0
    elif case=='tasks-below64':current['values']['pids.current']=63
    else:current['values']['pids.events']['max']=0
    if case=='worker-exited':
        with pytest.raises(ValueError,match='WORKER_NOT_ALIVE'):owner.tick()
    else:assert owner.tick()['evidence']['releaseAdmitted'] is False
    assert not owner._grant;owner.close()


def test_owner_rechecks_release_and_unknown_close_changes_run_exit():
    owner,observer,current,outcomes=owner_fixture();owner.ready();owner.output(progress_frame(held_record('tasks')))
    assert owner.tick()['evidence']['releaseAdmitted']
    current['values']['pids.current']=63
    with pytest.raises(ValueError,match='PERMISSION'):owner.before_action('release')
    observer.close.return_value=False
    with patch.object(r,'_run_profile',return_value=0):assert owner.run()==1
    assert owner.close() is False


def test_stress_prelude_does_not_consume_following_control_frame(monkeypatch):
    import json
    first={'type':'stress_composition','sourceSha256':{name:'a'*64 for name in r.STRESS_OBSERVER_FILES}}
    raw=bytearray((json.dumps(first)+'\n{"type":"heartbeat"}\n').encode())
    selector=Mock();selector.select.return_value=[(Mock(),1)]
    def read(fd,count):
        assert fd==0 and count==1
        result=bytes(raw[:1]);del raw[:1];return result
    with patch.object(r.selectors,'DefaultSelector',return_value=selector),patch.object(r.os,'set_blocking'),patch.object(r.os,'read',side_effect=read):
        deadline,hashes=r.read_stress_composition()
    assert hashes==first['sourceSha256'] and bytes(raw)==b'{"type":"heartbeat"}\n';selector.close.assert_called_once()


def test_owner_loop_uses_generated_unit_and_capacity_refusal_prevents_popen():
    owner,observer,*_=owner_fixture();resource=Mock();resource.leaf_path.return_value=LEAF;resource.CAPSULE=['fixed-capsule'];observer.probe=resource
    owner.before_spawn=Mock(side_effect=ValueError('capacity refused'))
    manager={'managerPid':123,'managerStartTimeTicks':'9','managerCgroup':'/outside'}
    with ExitStack() as stack:
        stack.enter_context(patch.object(r.sys,'platform','linux'))
        stack.enter_context(patch.object(r.os,'getuid',return_value=1000,create=True))
        stack.enter_context(patch.object(r.Path,'read_bytes',return_value=b'fixed source'))
        stack.enter_context(patch.object(r.Path,'exists',return_value=False))
        emit=stack.enter_context(patch.object(r,'emit_before_spawn'))
        stack.enter_context(patch.object(r,'unit_absent',return_value=True))
        stack.enter_context(patch.object(r,'manager_connection',return_value=manager))
        stack.enter_context(patch.object(r,'process_start_ticks',return_value='9'))
        stack.enter_context(patch.object(r,'cgroup',return_value='/outside'))
        stack.enter_context(patch.object(r.os,'pidfd_open',return_value=42,create=True))
        stack.enter_context(patch.object(r.signal,'pidfd_send_signal',create=True))
        stack.enter_context(patch.object(r.os,'close'))
        stack.enter_context(patch.object(r,'failure_evidence',return_value={'type':'systemd_failure'}))
        spawn=stack.enter_context(patch.object(r.subprocess,'Popen'))
        assert owner.run()==1
        spawn.assert_not_called();owner.before_spawn.assert_called_once_with(manager,42)
        assert emit.call_args_list[0].args[0]['ownership']['unit']==observer.unit
    observer.close.assert_called_once()


@pytest.mark.parametrize('case',['ok','backlog','eagain','partial','boolean'])
def test_stress_action_admission_is_at_actual_single_write_without_queue_retry(case):
    owner=Mock();order=[];owner.before_action.side_effect=lambda action:order.append('admitted') or None
    actions=r.StressActions('candidate-resource-stress-tasks');inbound=r.Buffer()
    if case=='backlog':inbound.data.extend(b'queued')
    frame={'type':'stress_action','action':'start'}
    def write(fd,raw):
        order.append('write')
        if case=='eagain':raise BlockingIOError()
        return len(raw)-1 if case=='partial' else True if case=='boolean' else len(raw)
    with patch.object(r.os,'write',side_effect=write) as called:
        if case=='ok':assert r.admit_stress_action(owner,actions,frame,inbound,42) is None
        else:
            with pytest.raises((ValueError,BlockingIOError)):r.admit_stress_action(owner,actions,frame,inbound,42)
        assert order==([] if case=='backlog' else ['admitted','write'])
        assert called.call_count==(0 if case=='backlog' else 1)
    assert bytes(inbound.data)==(b'queued' if case=='backlog' else b'')


def test_delayed_observer_preserves_actual_heartbeat_and_stdout_pumping():
    import threading
    owner,observer,*_=owner_fixture();entered=threading.Event();release=threading.Event()
    def delayed():
        entered.set()
        if not release.wait(.8):raise ValueError('test release missing')
        return {'version':1,'type':'test-observation'}
    owner.ready=delayed;runner=r.StressObserverRunner(owner);runner.enqueue('baseline')
    outbound=r.Buffer();inbound=r.Buffer();proc=Mock();proc.stdin.closed=False;proc.stdin.fileno.return_value=42
    writes=[]
    with patch.object(r.os,'write',side_effect=lambda fd,data:writes.append((fd,bytes(data))) or len(data)):
        r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
        assert entered.wait(.5)
        inbound.frame({'type':'heartbeat'});outbound.frame({'version':1,'type':'child_output','data':'authored'})
        r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
        assert any(fd==42 and b'heartbeat' in data for fd,data in writes)
        assert any(fd==1 and b'child_output' in data for fd,data in writes)
        assert runner.thread.is_alive()
        release.set();runner.thread.join(.5)
        r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
        assert b'test-observation' in outbound.data
    assert owner.close()


def test_unknown_observer_thread_never_closes_in_use_fds_or_allows_next_factory(monkeypatch):
    owner,observer,*_=owner_fixture();owner._manager_fd=99;runner=r.StressObserverRunner(owner)
    runner.thread=Mock();runner.thread.is_alive.return_value=True
    monkeypatch.setattr(r,'_STRESS_UNKNOWN',False)
    with patch.object(r.os,'close') as close:
        assert owner.close() is False
        close.assert_not_called();observer.close.assert_not_called()
    assert r._STRESS_UNKNOWN
    with pytest.raises(ValueError,match='PRIOR_STRESS'):r.create_stress_composition('tasks',10,{})


@pytest.mark.parametrize('case',['fresh','stale','eagain','backlog'])
def test_async_action_completion_writes_once_without_permission_queue(case):
    owner=Mock();owner._common=None;runner=Mock();runner.owner=owner;runner.cancelled=False;runner.pending_completion=None
    frame={'type':'stress_action','action':'start'}
    runner.advance.return_value=('action',frame,None,9.8 if case=='stale' else 10)
    proc=Mock();proc.stdin.closed=False;proc.stdin.fileno.return_value=42
    outbound=r.Buffer();inbound=r.Buffer()
    if case=='backlog':inbound.data.extend(b'heartbeat')
    calls=[]
    def write(fd,raw):
        calls.append(bytes(raw))
        if case in ('eagain','backlog'):raise BlockingIOError()
        return len(raw)
    with patch.object(r.time,'monotonic',return_value=10),patch.object(r.os,'write',side_effect=write):
        if case=='fresh':r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
        else:
            with pytest.raises((ValueError,BlockingIOError)):r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert sum(b'stress_action' in raw for raw in calls)==(1 if case in ('fresh','eagain') else 0)


def test_capacity_failure_closes_only_own_manager_duplicate():
    owner,observer,*_=owner_fixture();owner._fresh_capacity=Mock(side_effect=ValueError('capacity failure'))
    with patch.object(r.os,'dup',return_value=77),patch.object(r.os,'set_inheritable'),patch.object(r.os,'close') as close:
        with pytest.raises(ValueError,match='capacity failure'):owner.before_spawn({'managerPid':5},42)
        assert owner.close()
        close.assert_called_once_with(77)


def test_observer_thread_start_failure_leaves_no_active_thread_or_fd_close_race():
    owner,observer,*_=owner_fixture();runner=r.StressObserverRunner(owner);runner.enqueue('baseline')
    with patch.object(r.threading,'Thread') as thread:
        thread.return_value.start.side_effect=RuntimeError('start failed')
        with pytest.raises(RuntimeError):runner.advance()
    assert runner.thread is None and owner.close();observer.close.assert_called_once()


@pytest.mark.parametrize('kind,error,expected',[
    ('tick',ValueError('PIDFD_EVENT_UNKNOWN'),'tick:ValueError:PIDFD_EVENT_UNKNOWN'),
    ('output',ValueError('STRESS_PROGRESS_ORDER'),'output:ValueError:STRESS_PROGRESS_ORDER'),
    ('action',ValueError('private arbitrary body'),'action:ValueError'),
    ('preopen',OSError('private path'),'preopen:OSError'),
    ('bad-stage-with-data',ValueError('FIXED_REASON'),'unknown:ValueError:FIXED_REASON'),
    ('tick',ValueError('X'*129),'tick:ValueError')],ids=['pidfd','progress','value-redaction','os-redaction','stage-redaction','bound'])
def test_observer_thread_failure_has_fixed_bounded_diagnostic_only(kind,error,expected):
    owner,*_=owner_fixture();runner=r.StressObserverRunner(owner)
    runner.thread=Mock();runner.thread.is_alive.return_value=False
    runner.current=(kind,None);runner.error=error
    with pytest.raises(ValueError) as raised:runner.advance()
    assert str(raised.value)=='STRESS_OBSERVER_JOB_FAILED:'+expected
    assert runner.thread is None and runner.current is None


@pytest.mark.parametrize('count',[50,64])
def test_actual_authored_many_child_report_stream_keeps_full_serialization(count):
    import base64
    path=Path(__file__).parents[1]/'subscription-candidate-resource-stress-child.test.py'
    spec=importlib.util.spec_from_file_location('stress_child_envelope_fixture',path)
    fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
    report=fixture.complete_report('tasks',count)
    assert fixture.m.validate_report(report,fixture.deps(),fixture.ready())
    stream=b''.join(fixture.m.encode(item)+b'\n' for item in report['progress'])+fixture.m.encode(report)+b'\n'
    assert 131072<len(stream)<r.STRESS_CHILD_OUTPUT_LIMIT
    owner,observer,*_=owner_fixture();observations=[]
    for offset in range(0,len(stream),4096):
        observations.extend(owner.output({'version':1,'type':'child_output','stream':'stdout','encoding':'base64','data':base64.b64encode(stream[offset:offset+4096]).decode()}))
    assert owner._raw_bytes==len(stream) and not owner._partial
    assert len(observations)==1 and len(owner._child_pids)==count
    assert owner.close()


def test_child_serialization_crossing_three_mib_refused_without_retaining_crossing_bytes():
    import base64
    owner,observer,*_=owner_fixture()
    frame={'version':1,'type':'child_output','stream':'stdout','encoding':'base64','data':base64.b64encode(b' '*4096).decode()}
    for _ in range(r.STRESS_CHILD_OUTPUT_LIMIT//4096):owner.output(frame)
    assert owner._raw_bytes==r.STRESS_CHILD_OUTPUT_LIMIT
    with pytest.raises(ValueError,match='OUTPUT_LIMIT'):owner.output({**frame,'data':'eA=='})
    assert owner._raw_bytes==r.STRESS_CHILD_OUTPUT_LIMIT+1 and len(owner._partial)==r.STRESS_CHILD_OUTPUT_LIMIT
    owner.close()


@pytest.mark.parametrize('failure',['finish','join','is-alive'])
def test_observer_finish_exception_stays_unknown_without_closing_in_use_handles(monkeypatch,failure):
    owner,observer,*_=owner_fixture();owner._manager_fd=99;runner=r.StressObserverRunner(owner)
    monkeypatch.setattr(r,'_STRESS_UNKNOWN',False)
    if failure=='finish':runner.finish=Mock(side_effect=RuntimeError('finish failed'))
    else:
        runner.thread=Mock()
        if failure=='join':runner.thread.join.side_effect=RuntimeError('join failed')
        else:runner.thread.is_alive.side_effect=RuntimeError('liveness unknown')
    with patch.object(r.os,'close') as close:
        assert owner.close() is False and owner.close() is False
        observer.close.assert_not_called();close.assert_not_called()
    assert owner._known is False and r._STRESS_UNKNOWN
    with pytest.raises(ValueError,match='PRIOR_STRESS'):r.create_stress_composition('tasks',10,{})


def test_actual_cancel_admission_discards_completed_action_before_next_pump():
    owner,observer,*_=owner_fixture();runner=r.StressObserverRunner(owner)
    runner.enqueue('action',{'type':'stress_action','action':'release'})
    # An earlier already-completed admission is waiting for main-thread pickup.
    runner.thread=Mock();runner.thread.is_alive.return_value=False
    runner.current=('action',{'type':'stress_action','action':'start'})
    runner.result=None;runner.completed_at=10
    inbound=r.Buffer();outbound=r.Buffer();proc=Mock();proc.stdin.closed=False;proc.stdin.fileno.return_value=42
    r.accept_relay_cancel(inbound,runner)
    assert runner.cancelled and runner.stopping and not runner.queue and runner.queued_bytes==0
    writes=[]
    with patch.object(r.os,'write',side_effect=lambda fd,data:writes.append((fd,bytes(data))) or len(data)),patch.object(r.time,'monotonic',return_value=10):
        r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
        r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert writes==[(42,b'{"type":"cancel"}\n')]
    runner.enqueue('output',{'actual':'raw still forwarded by main'})
    assert not runner.queue
    assert owner.close()



@pytest.mark.parametrize('phase',['tasks','memory'])
def test_common_profile_uses_original_finite_capsule_mode_with_distinct_selector(phase):
    new='candidate-common-view-stress-'+phase;old='candidate-resource-stress-'+phase
    assert r.select_profile(['--'+new])==new
    assert r.profile_contract(new)==r.profile_contract(old)
    assert r.fixed_capsule_argv(Mock(CAPSULE=['fixed']),new,None)==['fixed','--'+old]
    assert '--property=OOMPolicy=continue' in r._unit_argv(Mock(leaf_path=Mock(return_value=LEAF)),new,UNIT,['fixed'])
    _,frame,ready=stress_start(phase)
    assert r.validate_profile_start(new,frame,ready) is None
    frame['mode']=new
    with pytest.raises(ValueError):r.validate_profile_start(new,frame,ready)


def test_real_common_source_factory_reuses_exact_annotated_eventreader(monkeypatch):
    import hashlib
    root=Path(__file__).parents[1];hashes={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in r.COMMON_FILES}
    monkeypatch.setattr(r,'ROOT',root);monkeypatch.setattr(r,'_STRESS_UNKNOWN',False)
    monkeypatch.setattr(r.os,'O_CLOEXEC',0,raising=False);monkeypatch.setattr(r.os,'O_NOFOLLOW',0,raising=False);monkeypatch.setattr(r.os,'O_NONBLOCK',0,raising=False)
    monkeypatch.setattr(r.os,'getuid',lambda:1000,raising=False)
    monkeypatch.setattr(r.os,'O_RDONLY',r.os.O_RDONLY|getattr(r.os,'O_BINARY',0))
    with patch.object(r.subprocess,'Popen') as spawn:
        owner=r.create_common_composition('tasks',r.time.monotonic()+30,hashes)
        assert len(owner._hashes)==12 and owner.profile=='candidate-common-view-stress-tasks'
        assert type(owner._observer.reader) is owner._observer.events.EventReader
        assert owner._observer.events.__source_sha256__==hashes['subscription-candidate-resource-events.py']
        assert owner._common.sampler.__source_sha256__==hashes['subscription-cgroup-common-view.py']
        assert owner.close()
        with pytest.raises(ValueError,match='TWELVE'):r.create_common_composition('tasks',r.time.monotonic()+30,{n:hashes[n] for n in r.STRESS_OBSERVER_FILES})
        spawn.assert_not_called()


def test_common_close_exception_keeps_unknown_fence_and_inuse_handles(monkeypatch):
    owner,observer,*_=owner_fixture();owner._common=Mock();owner._common.close.side_effect=RuntimeError('join')
    monkeypatch.setattr(r,'_STRESS_UNKNOWN',False)
    with patch.object(r.os,'close') as close:
        assert owner.close() is False and owner.close() is False and r._STRESS_UNKNOWN
        observer.close.assert_not_called();close.assert_not_called()
    with pytest.raises(ValueError,match='PRIOR'):r.create_stress_composition('tasks',r.time.monotonic()+5,{})


def test_common_counter_tracks_actual_partial_stdout_across_distinct_buffers(monkeypatch):
    counter=r.WireCounter();monkeypatch.setattr(r,'_WIRE_COUNTER',counter)
    a=r.Buffer();b=r.Buffer();a.append(b'abc');b.append(b'def')
    with patch.object(r.os,'write',side_effect=[1,2,3]):
        a.drain(1);assert counter.written==1 and a.data==b'bc'
        a.drain(1);b.drain(1)
    assert counter.written==6
    counter.written=r.WIRE_LIMIT-r.QUEUE_LIMIT-1
    a.append(b'xx')
    with patch.object(r.os,'write') as write:
        with pytest.raises(ValueError,match='STDOUT_LIMIT'):a.drain(1)
        write.assert_not_called()
    a.data.clear();counter.finalizing=True;a.append(b'failure')
    with patch.object(r.os,'write',return_value=7):a.drain(1)
    assert counter.written<=r.WIRE_LIMIT


def test_common_document_completion_waits_for_actual_last_frame_drain(monkeypatch):
    import importlib.util
    p=Path(__file__).parents[1]/'subscription-cgroup-evidence-stream.py'
    spec=importlib.util.spec_from_file_location('common_test_codec',p);codec=importlib.util.module_from_spec(spec);spec.loader.exec_module(codec)
    common=object.__new__(r.CommonEvidence);common.owner=Mock(unit=UNIT);common.codec=codec
    common.documents={'service':b'{}'};common.completed={};common.pending=r.deque(['service']);common.iterator=None;common.label=None;common.cancelled=False
    outbound=r.Buffer();seen=[]
    assert common.pump_documents(outbound) and not common.completed
    with patch.object(r.os,'write',side_effect=BlockingIOError):outbound.drain(1)
    assert common.pump_documents(outbound) and not common.completed
    with patch.object(r.os,'write',side_effect=lambda fd,data:(seen.append(bytes(data)) or len(data))):
        for _ in range(5):outbound.drain(1);common.pump_documents(outbound)
    assert common.completed['service']=={'label':'service','bytes':2,'sha256':r.hashlib.sha256(b'{}').hexdigest()}
    decoder=codec.Decoder(UNIT);assert [v for v in (decoder.feed(f) for f in seen) if v][0]['raw']==b'{}'


@pytest.mark.parametrize('stale',[False,True])
def test_common_docs_do_not_reset_completed_action_write_deadline(monkeypatch,stale):
    import importlib.util
    spec=importlib.util.spec_from_file_location('codec_action_test',Path(__file__).parents[1]/'subscription-cgroup-evidence-stream.py')
    codec=importlib.util.module_from_spec(spec);spec.loader.exec_module(codec)
    owner,_,*_=owner_fixture();common=object.__new__(r.CommonEvidence);owner._common=common
    common.owner=owner;common.codec=codec;common.documents={'service':b'{}'};common.completed={};common.pending=r.deque(['service'])
    common.iterator=None;common.label=None;common.cancelled=False
    runner=Mock(owner=owner,cancelled=False,pending_completion=None)
    runner.advance.return_value=('action',{'type':'stress_action','action':'start'},None,10)
    outbound,inbound=r.Buffer(),r.Buffer();proc=Mock();proc.stdin.closed=False;proc.stdin.fileno.return_value=42
    calls=[];clock=[10]
    monkeypatch.setattr(r.time,'monotonic',lambda:clock[0]);monkeypatch.setattr(r.os,'write',lambda fd,raw:(calls.append((fd,bytes(raw))) or len(raw)))
    r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert not any(fd==42 for fd,_ in calls)
    if stale:clock[0]=10.2
    if stale:
        with pytest.raises(ValueError,match='STALE'):r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    else:r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert sum(fd==42 for fd,_ in calls)==(0 if stale else 1)


def test_actual_byte_counter_covers_full_bounded_common_stream(monkeypatch):
    import importlib.util,base64
    spec=importlib.util.spec_from_file_location('codec_bound_test',Path(__file__).parents[1]/'subscription-cgroup-evidence-stream.py')
    codec=importlib.util.module_from_spec(spec);spec.loader.exec_module(codec)
    counter=r.WireCounter();monkeypatch.setattr(r,'_WIRE_COUNTER',counter);output=r.Buffer();actual=[0]
    def write(fd,raw):assert fd==1;actual[0]+=len(raw);return len(raw)
    monkeypatch.setattr(r.os,'write',write)
    output.frame({'version':1,'type':'systemd_ownership','fixturePadding':'x'*2000});output.drain(1)
    for label in codec.LABELS:
        for frame in codec.encode_document(UNIT,label,b'x'*codec.LIMITS[label]):output.append(frame);output.drain(1)
    for _ in range(40):output.frame({'type':'candidate_stress_observation','fixturePadding':'x'*44900});output.drain(1)
    for _ in range(r.STRESS_CHILD_OUTPUT_LIMIT//4096):
        output.frame({'version':1,'type':'child_output','stream':'stdout','encoding':'base64','data':base64.b64encode(b'x'*4096).decode()});output.drain(1)
    counter.finalizing=True;output.frame({'version':1,'type':'terminal','fixturePadding':'x'*20000});output.drain(1)
    assert counter.written==actual[0]==14505057 and actual[0]<r.WIRE_LIMIT


@pytest.mark.parametrize('reply',['admit','wrong','cancel','eof','duplicate','partial'])
def test_common_pretarget_real_pump_requires_drained_ready_before_capacity(monkeypatch,reply):
    from types import SimpleNamespace
    owner,_,*_=owner_fixture();owner._hashes={'service':'a'*64}
    owner._observer.deadline=100;owner._check=Mock()
    controller=Mock(deadline=90);controller.finished.return_value=True
    controller.poll.return_value=None;controller.result.return_value={'actual':'service'}
    controller.close.return_value=True;controller.terminal.return_value={'type':'common_view_preflight'}
    common=Mock();owner._common=common;common.service.FILES=('service',)
    common.controller_module.create_preflight.return_value=controller
    common.completed={'service':{'sha256':'b'*64,'bytes':2}}
    common.pending=[];common.iterator=None;common.codec.LABELS=('service','before','after')
    common.pump_documents.return_value=False
    output=[];reads=[];ticks=[0];ready_seen=[False];sent=[False]
    def write(fd,raw):
        assert fd==1;output.append(bytes(raw))
        if b'common_view_ready' in raw:ready_seen[0]=True
        return len(raw)
    def select(_):
        ticks[0]+=1
        assert ticks[0]<30
        # One full loop after actual ready write lets the owner seal ready_written.
        if ready_seen[0] and not sent[0] and ticks[0]>=3:
            sent[0]=True
            value=({'type':'cancel'} if reply=='cancel' else
                   {'type':'common_view_admission','unit':UNIT,'sha256':('b' if reply in ('admit','duplicate') else 'c')*64})
            raw=r.json.dumps(value).encode()+b'\n'
            if reply=='eof':raw=b''
            elif reply=='duplicate':raw+=raw
            elif reply=='partial':raw=b'x'*4097
            reads.append(raw)
            return [(SimpleNamespace(fd=0),1)]
        return []
    selector=Mock();selector.select.side_effect=select
    runner=Mock(cancelled=False,pending_completion=None);runner.idle.return_value=True
    advanced=[False]
    def advance(**kwargs):
        if advanced[0]:return None
        advanced[0]=True
        assert ready_seen[0] and sent[0]
        common.completed.update({'before':{},'after':{}})
        return ('preopen',None,{'type':'candidate_stress_observation'},1)
    runner.owner=owner;runner.advance.side_effect=advance
    monkeypatch.setattr(r.time,'monotonic',lambda:1)
    monkeypatch.setattr(r.os,'set_blocking',lambda *a:None)
    monkeypatch.setattr(r.os,'write',write);monkeypatch.setattr(r.os,'read',lambda *a:reads.pop(0))
    monkeypatch.setattr(r.selectors,'DefaultSelector',lambda:selector)
    monkeypatch.setattr(r,'StressObserverRunner',lambda o:runner)
    with patch.object(r.subprocess,'Popen') as spawn:
        if reply=='admit':r.common_pretarget(owner);runner.enqueue.assert_called_once_with('preopen')
        else:
            with pytest.raises(ValueError,match='ADMISSION_REQUIRED|CANCELLED|CONTROL_EOF|FRAME_BOUND'):r.common_pretarget(owner)
            if reply=='duplicate':runner.enqueue.assert_called_once_with('preopen');runner.cancel.assert_called_once()
            else:runner.enqueue.assert_not_called()
            common.cancel.assert_called_once()
        spawn.assert_not_called()
    selector.close.assert_called_once()
    assert b'common_view_preflight' in b''.join(output) and ready_seen[0]


def burst_fixture(raw):
    import importlib.util
    spec=importlib.util.spec_from_file_location('burst_codec',Path(__file__).parents[1]/'subscription-cgroup-evidence-stream.py')
    codec=importlib.util.module_from_spec(spec);spec.loader.exec_module(codec)
    owner,_,*_=owner_fixture();common=object.__new__(r.CommonEvidence);owner._common=common
    common.owner=owner;common.codec=codec;common.documents={'service':raw};common.completed={};common.pending=r.deque(['service'])
    common.iterator=None;common.label=None;common.cancelled=False
    runner=Mock(owner=owner,cancelled=False,pending_completion=None);runner.advance.return_value=None
    proc=Mock();proc.stdin.closed=False;proc.stdin.fileno.return_value=42
    return common,runner,proc,r.Buffer(),r.Buffer()


def test_common_real_pump_burst_four_frames_then_returns_control(monkeypatch):
    raw=b'x'*200000;common,runner,proc,outbound,inbound=burst_fixture(raw)
    seen=[];monkeypatch.setattr(r.time,'monotonic',lambda:10)
    monkeypatch.setattr(r.os,'write',lambda fd,data:(seen.append((fd,bytes(data))) or len(data)))
    r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert len(seen)==4 and not outbound.data and not common.completed
    runner.advance.assert_not_called()
    for _ in range(4):r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    decoder=common.codec.Decoder(UNIT);complete=[value for fd,frame in seen if (value:=decoder.feed(frame))]
    assert complete[0]['raw']==raw and common.completed['service']['bytes']==len(raw)
    assert all(fd==1 for fd,_ in seen)


def test_common_real_pump_burst_shared_two_ms_budget(monkeypatch):
    common,runner,proc,outbound,inbound=burst_fixture(b'x'*200000)
    clock=[10.0];writes=[]
    monkeypatch.setattr(r.time,'monotonic',lambda:clock[0])
    def write(fd,data):writes.append(bytes(data));clock[0]+=.0011;return len(data)
    monkeypatch.setattr(r.os,'write',write)
    r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert len(writes)==2 and not common.completed
    runner.advance.assert_not_called()


@pytest.mark.parametrize('partial',[False,True])
def test_common_burst_eagain_partial_never_declares_document_delivery(monkeypatch,partial):
    common,runner,proc,outbound,inbound=burst_fixture(b'{}')
    monkeypatch.setattr(r.time,'monotonic',lambda:10)
    writes=[]
    def write(fd,data):
        writes.append(bytes(data))
        if partial and len(writes)==1:return 1
        raise BlockingIOError()
    monkeypatch.setattr(r.os,'write',write)
    r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert len(writes)==1 and outbound.data and not common.completed
    r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert len(writes)==2 and not common.completed
    runner.advance.assert_not_called()


def test_common_burst_codec_work_consumes_budget_before_write(monkeypatch):
    common,runner,proc,outbound,inbound=burst_fixture(b'{}');clock=[10.0]
    original=common.pump_documents
    def slow(output):result=original(output);clock[0]+=.003;return result
    common.pump_documents=slow
    monkeypatch.setattr(r.time,'monotonic',lambda:clock[0]);write=Mock();monkeypatch.setattr(r.os,'write',write)
    r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    write.assert_not_called();assert outbound.data and not common.completed


def test_common_burst_four_steps_shared_across_observer_completion(monkeypatch):
    common,runner,proc,outbound,inbound=burst_fixture(b'x'*200000)
    common.pending.clear();original=common.pump_documents;calls=[]
    def count(output):calls.append(1);return original(output)
    common.pump_documents=count
    def advance(**kwargs):common.pending.append('service');return ('preopen',None,None,10)
    runner.advance.side_effect=advance
    monkeypatch.setattr(r.time,'monotonic',lambda:10);writes=[]
    monkeypatch.setattr(r.os,'write',lambda fd,data:(writes.append(bytes(data)) or len(data)))
    r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
    assert len(calls)==4 and len(writes)==3 and runner.pending_completion==('preopen',None,None,10)


@pytest.mark.parametrize('poll_delay,stale',[(.01,False),(.06,True)])
def test_large_evidence_delivery_preserves_original_action_admission(monkeypatch,poll_delay,stale):
    raw=b'x'*200000
    common,runner,proc,outbound,inbound=burst_fixture(raw)
    clock=[10.0];writes=[]
    runner.advance.return_value=('action',{'type':'stress_action','action':'start'},None,10.0)
    monkeypatch.setattr(r.time,'monotonic',lambda:clock[0])
    monkeypatch.setattr(r.os,'write',lambda fd,data:(writes.append((fd,bytes(data))) or len(data)))
    rejected=False
    for _ in range(10):
        try:r.pump_relay_buffers(outbound,inbound,proc,runner,None,None)
        except ValueError as error:
            assert str(error)=='STRESS_ACTION_ADMISSION_STALE'
            rejected=True;break
        if any(fd==42 for fd,_ in writes):break
        clock[0]+=poll_delay
    assert rejected is stale
    assert sum(fd==42 for fd,_ in writes)==(0 if stale else 1)
    decoder=common.codec.Decoder(UNIT)
    documents=[value for fd,frame in writes if fd==1 and (value:=decoder.feed(frame))]
    assert len(documents)==1 and documents[0]['raw']==raw
    assert common.completed['service']['bytes']==len(raw)
    if not stale:
        assert clock[0]-10.0<.1 and writes[-1][0]==42
