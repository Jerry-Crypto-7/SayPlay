import copy
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load('subscription-trusted-control-boundary-parent')
probe = load('subscription-trusted-control-boundary-probe')
policy = load('subscription-appserver-noenv')
gate = load('subscription-exec-server-worker-gate')
probe_fixtures = load('subscription-trusted-control-boundary-probe.test')


def packet():
    return {'version': 1, 'sourceOfOuter': 'supervisor-fixed-startup-pipe',
        'namespaces': {'trustedPid': 'pid:[10]', 'trustedMount': 'mnt:[11]'},
        'protectedDescriptors': {'outerSupervisorControl': {'dev': 15, 'ino': 100, 'type': 0o010000},
                                 'outerSupervisorOutput': {'dev': 15, 'ino': 101, 'type': 0o010000}}}


def ready():
    value = packet()
    return {'namespace': 'pid:[10]', 'mountNamespace': 'mnt:[11]',
            'control': value['protectedDescriptors']['outerSupervisorControl'],
            'output': value['protectedDescriptors']['outerSupervisorOutput']}


def test_packet_requires_external_ready_identity_not_just_source_label():
    assert m.validate_outer_packet(packet())
    assert m.packet_matches_ready(packet(), ready())
    external = ready()
    external['control']['ino'] += 1
    assert not m.packet_matches_ready(packet(), external)
    assert not m.packet_matches_ready(packet(), None)


@pytest.mark.parametrize('case', ['bool-version', 'extra', 'regular', 'alias', 'unsafe', 'bool-inode', 'namespace', 'source'])
def test_packet_rejects_ambiguous_or_unbound_shapes(case):
    value = packet()
    if case == 'bool-version': value['version'] = True
    if case == 'extra': value['caller'] = 'ignored?'
    if case == 'regular': value['protectedDescriptors']['outerSupervisorControl']['type'] = 0o100000
    if case == 'alias': value['protectedDescriptors']['outerSupervisorControl'] = copy.deepcopy(value['protectedDescriptors']['outerSupervisorOutput'])
    if case == 'unsafe': value['protectedDescriptors']['outerSupervisorControl']['ino'] = 2 ** 53
    if case == 'bool-inode': value['protectedDescriptors']['outerSupervisorControl']['ino'] = True
    if case == 'namespace': value['namespaces']['trustedPid'] = '/proc/1/ns/pid'
    if case == 'source': value['sourceOfOuter'] = 'caller'
    assert not m.validate_outer_packet(value)


def test_initialize_only_never_serializes_thread_or_turn():
    protocol = m.make_initialize_protocol(policy)
    assert json.loads(protocol.pending)['method'] == 'initialize'
    protocol.written(len(protocol.pending))
    protocol.receive({'id': 1, 'result': {'userAgent': 'test', 'codexHome': m.HOME,
                                         'platformFamily': 'unix', 'platformOs': 'linux'}})
    assert json.loads(protocol.pending)['method'] == 'initialized'
    assert protocol.initialized_complete is False
    protocol.written(len(protocol.pending))
    assert protocol.initialized_complete is True
    assert [item['frame']['method'] for item in protocol.history if item['event'] == 'queued'] == ['initialize', 'initialized']


def test_missing_worker_entry_fails_closed_without_substitution():
    with pytest.raises(ValueError, match='NOT_INTEGRATED'):
        m.require_fixed_worker_entry(SimpleNamespace())
    wrong = SimpleNamespace(control_start_request=lambda: {'method': 'process/start', 'params': {'argv': ['/usr/bin/python3']}})
    with pytest.raises(ValueError, match='FIXED_TRUSTED_CONTROL'):
        m.require_fixed_worker_entry(wrong)


def test_marker_combines_distinct_actual_pipe_roles_and_authored_objects():
    pipes = {'appServerControl': {'dev': 15, 'ino': 102, 'type': 0o010000},
             'appServerOutput': {'dev': 15, 'ino': 103, 'type': 0o010000}}
    objects = {'appServerHome': {'dev': 20, 'ino': 200, 'type': 0o040000},
               'appServerSentinel': {'dev': 20, 'ino': 201, 'type': 0o100000}}
    marker = m.make_marker(packet(), pipes, objects, probe)
    assert probe.validate_marker(marker)
    pipes['appServerControl']['ino'] = 100
    with pytest.raises(ValueError, match='MARKER_INVALID'):
        m.make_marker(packet(), pipes, objects, probe)


@pytest.mark.parametrize('case', ['valid', 'oversize', 'namespace', 'no-eof'])
def test_startup_pipe_is_bounded_and_requires_eof_and_own_namespace(case, monkeypatch):
    raw = json.dumps(packet()).encode() + b'\n'
    blocks = iter([b'x' * 4097] if case == 'oversize' else [raw, b''])
    clock = [0.0]
    class Selector:
        def register(self, fd, _mask): assert fd == 0
        def select(self, _timeout):
            if case == 'no-eof':
                clock[0] += 0.5
                return []
            return [(None, None)]
        def close(self): pass
    monkeypatch.setattr(m.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(m.os, 'set_blocking', lambda fd, blocking: None)
    monkeypatch.setattr(m.os, 'read', lambda fd, count: next(blocks))
    monkeypatch.setattr(m.selectors, 'DefaultSelector', Selector)
    def namespace(path):
        assert path in ('/proc/self/ns/pid', '/proc/self/ns/mnt')
        return ('pid:[99]' if case == 'namespace' else 'pid:[10]') if path.endswith('/pid') else 'mnt:[11]'
    monkeypatch.setattr(m.os, 'readlink', namespace)
    if case == 'valid':
        result = m.read_startup_packet(m.Budget(), probe)
        assert result['value'] == packet() and result['eofObserved'] is True
        assert result['bytes'] == len(raw) and bytes.fromhex(result['rawHex']) == raw
    else:
        with pytest.raises(ValueError):
            m.read_startup_packet(m.Budget(), probe)


def session_report(protocol, pid, argv):
    raw = b''.join((json.dumps(item['frame']) + '\n').encode() for item in protocol.history if item['event'] == 'received')
    return {'argv': list(argv), 'environment': {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': m.HOME,
        'CODEX_HOME': m.HOME, 'TMPDIR': m.HOME + '/tmp'}, 'pid': pid, 'pinned': True, 'reaped': True,
        'exitCode': 0, 'error': None, 'history': copy.deepcopy(protocol.history),
        'controlBytesQueued': protocol.control_queued, 'controlBytesWritten': protocol.control_written,
        'cleanupHistory': [{'event': 'stdin-eof', 'elapsedMs': 500}], 'signalDeliveries': [],
        'stdoutBase64': base64.b64encode(raw).decode(), 'stderrBase64': '', 'observedBytes': len(raw),
        'streamEOF': {'stdout': True, 'stderr': True}, 'partialBytes': 0}


def drain(protocol):
    while protocol.frames:
        protocol.written(protocol.frames[0][0])


def complete_report():
    # Authored responses are fixture evidence, never runtime output.
    marker = probe_fixtures.marker()
    marker_raw = json.dumps(marker).encode()
    marker_record = {'path': m.MARKER_PATH, 'bytes': len(marker_raw), 'sha256': hashlib.sha256(marker_raw).hexdigest(),
        'rawHex': marker_raw.hex(), 'file': {'dev': 21, 'ino': 300, 'type': 0o100000}, 'value': marker,
        'readonlyMountClaimedHere': False}
    value = packet()
    value['protectedDescriptors'] = {key: marker['protectedDescriptors'][key] for key in value['protectedDescriptors']}
    packet_raw = json.dumps(value).encode() + b'\n'
    startup = {'value': value, 'bytes': len(packet_raw), 'sha256': hashlib.sha256(packet_raw).hexdigest(),
        'rawHex': packet_raw.hex(), 'eofObserved': True, 'sourceOfOuter': 'supervisor-fixed-startup-pipe'}
    app = m.make_initialize_protocol(policy)
    drain(app)
    app.receive({'id': 1, 'result': {'userAgent': 'fixed-test', 'codexHome': m.HOME,
        'platformFamily': 'unix', 'platformOs': 'linux'}})
    drain(app)
    worker = m.WorkerProtocol(gate, probe, marker)
    drain(worker)
    worker.receive({'id': 1, 'result': {'sessionId': 'fixed-session'}})
    drain(worker)
    worker.receive({'id': 2, 'result': {'processId': 'fixed-worker'}})
    drain(worker)
    probe_report = probe_fixtures.report()
    probe_report['marker'].update(rawHex=marker_raw.hex(), bytes=len(marker_raw), sha256=hashlib.sha256(marker_raw).hexdigest())
    probe_raw = json.dumps(probe_report).encode() + b'\n'
    worker.receive({'id': 3, 'result': {'chunks': [{'seq': 1, 'stream': 'stdout', 'chunk': base64.b64encode(probe_raw).decode()}],
        'nextSeq': 2, 'exited': True, 'exitCode': 0, 'closed': True, 'failure': None, 'sandboxDenied': False}})
    observation = {'pid': 7, 'alive': True, 'pipes': {key: marker['protectedDescriptors'][key] for key in ('appServerControl', 'appServerOutput')},
        'objects': marker['authoredProtectedObjects'], 'marker': {'file': marker_record['file'], 'sha256': marker_record['sha256']},
        'elapsedMs': 100}
    hashes = {name: 'a' * 64 for name in m.HELPER_FILES}
    hashes['subscription-text-model-catalog.json'] = m.CATALOG_SHA256
    return {'version': 1, 'profile': 'fixed-trusted-control-boundary-parent', 'success': True, 'error': None,
        'startupPacket': startup, 'marker': marker_record, 'beforeWorker': observation,
        'afterWorker': {**copy.deepcopy(observation), 'elapsedMs': 400},
        'sessions': {'appserver': session_report(app, 7, m.appserver_argv(policy)),
                     'executor': session_report(worker, 8, m.GATE_ARGV)},
        'completedMs': 400, 'elapsedMs': 1000, 'actualModelCalls': 0, 'credentialFilesRead': False,
        'productionReady': False, 'appServerToolInvocation': False, 'descendantCleanupVerifiedHere': False,
        'helperSha256Before': hashes, 'helperSha256After': copy.deepcopy(hashes)}


def test_full_offline_replay_requires_independent_outer_ready_and_actual_probe_body():
    report = complete_report()
    assert m.validate_report(report, policy, gate, probe, ready())
    assert not m.validate_report(report, policy, gate, probe, None)


@pytest.mark.parametrize('case', ['dead-before', 'dead-after', 'pipe-drift', 'object-drift', 'marker-drift', 'namespace-drift',
    'cleanup-before-probe', 'deadline', 'work-deadline', 'source-drift', 'output-incomplete', 'raw-mismatch', 'helper-extra',
    'unknown-cleanup', 'unpinned', 'foreign-pid', 'production', 'tool-credit', 'startup-no-eof'])
def test_full_replay_rejects_identity_lifecycle_raw_or_credit_drift(case):
    report = complete_report()
    if case == 'dead-before': report['beforeWorker']['alive'] = False
    if case == 'dead-after': report['afterWorker']['alive'] = False
    if case == 'pipe-drift': report['afterWorker']['pipes']['appServerControl']['ino'] += 1
    if case == 'object-drift': report['afterWorker']['objects']['appServerHome']['ino'] += 1
    if case == 'marker-drift': report['afterWorker']['marker']['sha256'] = 'b' * 64
    if case == 'namespace-drift': report['startupPacket']['value']['namespaces']['trustedPid'] = 'pid:[99]'
    if case == 'cleanup-before-probe': report['sessions']['appserver']['cleanupHistory'][0]['elapsedMs'] = 399
    if case == 'deadline': report['elapsedMs'] = 30000
    if case == 'work-deadline': report['completedMs'] = 22000
    if case == 'source-drift': report['helperSha256After'][next(iter(m.HELPER_FILES))] = 'b' * 64
    if case == 'output-incomplete': report['sessions']['executor']['streamEOF']['stdout'] = False
    if case == 'raw-mismatch': report['sessions']['executor']['stdoutBase64'] = base64.b64encode(b'{}\n').decode()
    if case == 'helper-extra': report['helperSha256Before']['caller.py'] = 'a' * 64
    if case == 'unknown-cleanup': report['sessions']['appserver']['exitCode'] = None
    if case == 'unpinned': report['sessions']['appserver']['pinned'] = False
    if case == 'foreign-pid': report['afterWorker']['pid'] += 1
    if case == 'production': report['productionReady'] = True
    if case == 'tool-credit': report['appServerToolInvocation'] = True
    if case == 'startup-no-eof': report['startupPacket']['eofObserved'] = False
    assert not m.validate_report(report, policy, gate, probe, ready())


@pytest.mark.parametrize('case', ['valid', 'esrch', 'early', 'foreign', 'kill', 'unreaped'])
def test_bounded_direct_term_is_send_evidence_not_arbitrary_negative_exit(case):
    report = complete_report()
    session = report['sessions']['appserver']
    session['exitCode'] = -15
    session['cleanupHistory'].append({'event': 'term-sent', 'elapsedMs': 2500})
    session['signalDeliveries'] = [{'pid': 7, 'signal': 15, 'pidfdPinned': True, 'elapsedMs': 2500}]
    report['elapsedMs'] = 2600
    if case == 'esrch': session['cleanupHistory'][-1]['event'] = 'term-esrch'
    if case == 'early': session['cleanupHistory'][-1]['elapsedMs'] = session['signalDeliveries'][0]['elapsedMs'] = 2499.9
    if case == 'foreign': session['signalDeliveries'][0]['pid'] = 9
    if case == 'kill': session['exitCode'] = -9
    if case == 'unreaped': session['reaped'] = False
    assert m.validate_report(report, policy, gate, probe, ready()) is (case == 'valid')


@pytest.mark.parametrize('failure', [None, 'marker', 'worker-spawn', 'app-death'])
def test_driver_keeps_app_alive_until_probe_and_cleans_ownership_on_failure(failure, monkeypatch):
    fixture = complete_report()
    events = []
    created = []
    clock = [0.0]
    class Selector:
        def select(self, _timeout): clock[0] += 0.01; return []
        def close(self): pass
        def get_key(self, handle): raise KeyError()
        def register(self, *_args): pass
    class FakeSession:
        def __init__(self, name, argv, environment, protocol, _policy, selector, budget):
            if name == 'executor':
                assert 'before' in events and 'cleanup-appserver' not in events
                if failure == 'worker-spawn': raise OSError('fixed spawn failed')
            events.append('spawn-' + name)
            self.name, self.error, self.cleanup = name, None, None
            self.protocol = SimpleNamespace(pending=b'', initialized_complete=True, done=name == 'executor')
            self.capture = SimpleNamespace(eof={'stdout': True, 'stderr': True})
            self.process = SimpleNamespace(stdin=SimpleNamespace(closed=False), pid=7 if name == 'appserver' else 8)
            self.process.poll = lambda: 0 if self.cleanup is not None or name == 'appserver' and failure == 'app-death' and len(created) == 2 else None
            created.append(self)
        def begin_cleanup(self, *_args):
            if self.cleanup is None: events.append('cleanup-' + self.name)
            self.cleanup = True
            self.process.stdin.closed = True
        def advance_cleanup(self, _budget): pass
        def report(self): return fixture['sessions'][self.name]
        def close(self): events.append('close-' + self.name)
    def publish(*_args):
        if failure == 'marker': raise ValueError('marker exists')
        return fixture['marker']
    def observe(process, marker, budget):
        assert process.poll() is None
        field = 'beforeWorker' if 'before' not in events else 'afterWorker'
        events.append('before' if field == 'beforeWorker' else 'after')
        return fixture[field]
    monkeypatch.setattr(m, 'Session', FakeSession)
    monkeypatch.setattr(m.selectors, 'DefaultSelector', Selector)
    monkeypatch.setattr(m.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(m, 'prepare_home', lambda: ({}, fixture['marker']['value']['authoredProtectedObjects']))
    monkeypatch.setattr(m, 'capture_appserver_pipes', lambda _: fixture['beforeWorker']['pipes'])
    monkeypatch.setattr(m, 'publish_marker', publish)
    monkeypatch.setattr(m, 'trusted_observation', observe)
    report = m.run_parent(policy, gate, probe, m.Budget(), fixture['startupPacket'])
    assert len(created) == (1 if failure in ('marker', 'worker-spawn') else 2)
    assert all('cleanup-' + item.name in events and 'close-' + item.name in events for item in created)
    if failure is None:
        assert report['error'] is None
        assert events.index('before') < events.index('spawn-executor') < events.index('after') < events.index('cleanup-appserver')
    else:
        assert report['error'] is not None and report['completedMs'] is None


def test_spawn_after_work_budget_is_refused_before_popen(monkeypatch):
    monkeypatch.setattr(m.time, 'monotonic', lambda: 22.0)
    monkeypatch.setattr(m.subprocess, 'Popen', lambda *_args, **_kwargs: pytest.fail('must not spawn'))
    budget = SimpleNamespace(began=0, require_remaining=lambda: 8)
    with pytest.raises(ValueError, match='BEFORE_SPAWN'):
        m.Session('executor', m.GATE_ARGV, {}, None, policy, None, budget)


@pytest.mark.parametrize('esrch', [False, True])
def test_session_term_records_only_successful_own_pidfd_send(esrch, monkeypatch):
    session = object.__new__(m.Session)
    session.pin, session.error = 19, None
    session.process = SimpleNamespace(pid=77, poll=lambda: None)
    session.cleanup = policy.Cleanup(1.0)
    session.cleanup_history = [{'event': 'stdin-eof', 'elapsedMs': 1000}]
    session.signal_deliveries = []
    monkeypatch.setattr(m.time, 'monotonic', lambda: 3.001)
    def send(pin, number):
        assert pin == 19 and number == m.signal.SIGTERM
        if esrch: raise ProcessLookupError()
    monkeypatch.setattr(m.signal, 'pidfd_send_signal', send, raising=False)
    session.advance_cleanup(SimpleNamespace(began=0))
    assert session.cleanup_history[-1]['event'] == ('term-esrch' if esrch else 'term-sent')
    if esrch: assert session.signal_deliveries == []
    else: assert session.signal_deliveries == [{'pid': 77, 'signal': 15, 'pidfdPinned': True, 'elapsedMs': 3001.0}]


def test_shared_output_cross_child_limit_counts_rejected_tail_and_still_observes_eof(monkeypatch):
    monkeypatch.setattr(policy, 'MAX_OUTPUT', 10)
    sessions = [SimpleNamespace(capture=policy.Capture(None)) for _ in range(2)]
    m.feed_output(sessions[0], sessions, 'stderr', b'123456', policy, False)
    with pytest.raises(ValueError, match='SHARED_OUTPUT_LIMIT'):
        m.feed_output(sessions[1], sessions, 'stdout', b'abcdef', policy, False)
    assert sessions[1].capture.stdout == b'abcd'
    assert sum(item.capture.observed_bytes for item in sessions) == 12
    assert sum(len(item.capture.stdout) + len(item.capture.stderr) for item in sessions) == 10
    with pytest.raises(ValueError, match='SHARED_OUTPUT_LIMIT'):
        m.feed_output(sessions[0], sessions, 'stderr', b'late', policy, False)
    assert sum(item.capture.observed_bytes for item in sessions) == 16
    m.feed_output(sessions[0], sessions, 'stderr', b'', policy, False)
    assert sessions[0].capture.eof['stderr'] is True


def test_worker_actual_marker_mount_must_match_parent_published_inode():
    report = complete_report()
    report['marker']['file']['ino'] += 1
    report['beforeWorker']['marker']['file'] = copy.deepcopy(report['marker']['file'])
    report['afterWorker']['marker']['file'] = copy.deepcopy(report['marker']['file'])
    assert not m.validate_report(report, policy, gate, probe, ready())


def test_queued_fixed_boolean_cannot_be_replaced_by_equal_python_integer():
    report = complete_report()
    queued = next(item for item in report['sessions']['executor']['history']
                  if item['event'] == 'queued' and item['frame']['method'] == 'process/start')
    assert queued['frame']['params']['tty'] is False
    queued['frame']['params']['tty'] = 0
    assert not m.validate_report(report, policy, gate, probe, ready())


def worker_waiting_read():
    worker = m.WorkerProtocol(gate, probe, probe_fixtures.marker())
    drain(worker)
    worker.receive({'id': 1, 'result': {'sessionId': 'cursor-session'}})
    drain(worker)
    worker.receive({'id': 2, 'result': {'processId': 'fixed-worker'}})
    drain(worker)
    return worker


def read_reply(identifier, chunks, next_seq, closed=False):
    return {'id': identifier, 'result': {'chunks': chunks, 'nextSeq': next_seq,
        'exited': closed, 'exitCode': 0 if closed else None, 'closed': closed, 'failure': None, 'sandboxDenied': False}}


def chunk(sequence, raw=b'fixture'):
    return {'seq': sequence, 'stream': 'stdout', 'chunk': base64.b64encode(raw).decode()}


def test_subsequent_reads_use_completed_response_cursor_not_notification_max():
    worker = worker_waiting_read()
    worker.receive({'method': 'process/output', 'params': {'processId': 'fixed-worker', **chunk(7)}})
    worker.receive(read_reply(3, [chunk(1)], 2))
    assert json.loads(worker.pending)['params']['afterSeq'] == 1
    drain(worker)
    worker.receive(read_reply(4, [chunk(3)], 4))
    assert json.loads(worker.pending)['params']['afterSeq'] == 3
    assert set(worker.chunks) == {1, 3, 7}
    # Output events share sequence space with exited/closed; no output-only
    # contiguous sequence requirement is invented here.


def test_empty_read_uses_server_cursor_and_zero_is_valid():
    worker = worker_waiting_read()
    worker.receive(read_reply(3, [], 1))
    assert json.loads(worker.pending)['params']['afterSeq'] == 0
    drain(worker)
    worker.receive(read_reply(4, [], 3))
    assert json.loads(worker.pending)['params']['afterSeq'] == 2


@pytest.mark.parametrize('case', ['replayed', 'unordered', 'skip', 'regress', 'bool', 'unsafe'])
def test_invalid_read_cursor_cannot_queue_another_request(case):
    worker = worker_waiting_read()
    worker.receive(read_reply(3, [chunk(1)], 2))
    drain(worker)
    frame = read_reply(4, [chunk(2)], 3)
    if case == 'replayed': frame = read_reply(4, [chunk(1)], 2)
    if case == 'unordered': frame = read_reply(4, [chunk(3), chunk(2)], 4)
    if case == 'skip': frame['result']['nextSeq'] = 8
    if case == 'regress': frame = read_reply(4, [], 1)
    if case == 'bool': frame['result']['nextSeq'] = True
    if case == 'unsafe': frame['result']['nextSeq'] = 2 ** 53
    with pytest.raises(ValueError): worker.receive(frame)
    assert worker.pending == b''
    assert worker.next_id == 5


def test_notification_and_first_read_may_duplicate_but_later_read_cannot():
    worker = worker_waiting_read()
    value = chunk(1)
    worker.receive({'method': 'process/output', 'params': {'processId': 'fixed-worker', **value}})
    worker.receive(read_reply(3, [value], 2))
    assert worker.output_bytes == len(b'fixture')
    drain(worker)
    with pytest.raises(ValueError, match='REPLAY_OR_ORDER'):
        worker.receive(read_reply(4, [value], 2))


def test_pinned_retained_output_fixture_no_longer_repeats_actual_failure_amplification():
    worker = worker_waiting_read()
    retained = chunk(1, b'x' * 3379)
    response_bytes = 0
    returned_chunks = 0
    # Pinned server semantics: only chunks strictly after requested cursor.
    # The historical 26 replies all carried this same retained 3379-byte chunk.
    for identifier in range(3, 29):
        sent = next(item['frame'] for item in reversed(worker.history)
                    if item['event'] == 'queued' and item['frame'].get('id') == identifier)
        after = sent['params']['afterSeq']
        values = [retained] if after is None or after < 1 else []
        frame = read_reply(identifier, values, 2)
        response_bytes += len((json.dumps(frame) + '\n').encode())
        returned_chunks += len(values)
        worker.receive(frame)
        drain(worker)
    assert returned_chunks == 1
    assert response_bytes < policy.MAX_OUTPUT
    assert worker.output_bytes == 3379
