"""Final gate wire integration; local pipe accounting is not worker execution."""
import copy
import importlib.util
import json
import os
from pathlib import Path

import pytest


PATH = Path(__file__).with_name('subscription-captured-worker-transport.py')
SPEC = importlib.util.spec_from_file_location('captured_wire_test', PATH)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
ADAPTER = PATH.with_name('subscription-captured-start-adapter.py').read_bytes()
BASE = PATH.with_name('subscription-exec-server-worker-gate.py').read_bytes()
CAPTURE = PATH.with_name('subscription-captured-start.fixture.json').read_bytes()
PROCESS = '75019-eefe8e86-65cd-45ed-9ab0-b55a100b8ace'
THREAD = '01a0905c-d025-73e0-9b43-40038e02cd46'
PID = 'pid:[101]'
MOUNT = 'mnt:[202]'


def enc(frame):
    return json.dumps(frame, separators=(',', ':')).encode() + b'\n'


INIT = enc({'id': 1, 'result': {'sessionId': 'fixture'}})
START = enc({'id': 2, 'result': {'processId': 'fixed-worker'}})
READ = enc({'id': 3, 'result': {'chunks': [], 'nextSeq': 1, 'exited': False,
    'exitCode': None, 'closed': False, 'failure': None, 'sandboxDenied': False}})


def note(method, seq, **fields):
    return enc({'method': 'process/' + method,
                'params': {'processId': 'fixed-worker', 'seq': seq, **fields}})


def transport():
    return m.WireTransport(ADAPTER, BASE, PROCESS, THREAD, PID, MOUNT)


def flush(t, side):
    raw = t.pending(side)
    if raw:
        t.written(side, len(raw))
    return raw


def boot():
    t = transport()
    assert json.loads(flush(t, 'worker')) == t.adapter.base.initialize_request()
    t.feed('worker', INIT)
    assert not t.pending('client')
    assert json.loads(flush(t, 'worker')) == {'method': 'initialized', 'params': {}}
    return t


def started():
    t = boot()
    t.feed('client', CAPTURE)
    flush(t, 'worker')
    t.feed('worker', START)
    flush(t, 'client')
    return t


def request(t):
    frame = t.adapter.base.read_request(10)
    frame['params']['processId'] = PROCESS
    return enc(frame)


def finish(t):
    t.feed('worker', note('exited', 1, exitCode=0, sandboxDenied=False) + note('closed', 2))
    t.eof('client')
    t.eof('worker')
    flush(t, 'client')
    return t.report()


def validate(report, **identities):
    return m.validate_wire_report(report, ADAPTER, BASE,
        identities.get('process', PROCESS), identities.get('thread', THREAD),
        identities.get('pid', PID), identities.get('mount', MOUNT))


def assert_failed(t):
    assert t.failed and not t.report()['complete']
    assert not t.pending('client') and not t.pending('worker')
    assert not validate(t.report())


def test_real_pipe_final_wire_partial_writes_full_lifecycle():
    t = transport()
    wire = []

    def pipe_flush(side):
        reader, writer = os.pipe()
        expected = t.pending(side)
        observed = bytearray()
        try:
            while t.pending(side):
                count = os.write(writer, t.pending(side)[:13])
                observed.extend(os.read(reader, count))
                t.written(side, count)
        finally:
            os.close(writer)
            os.close(reader)
        assert bytes(observed) == expected
        if side == 'worker':
            wire.extend(expected.splitlines(keepends=True))
        return expected

    assert json.loads(pipe_flush('worker')) == t.adapter.base.initialize_request()
    for byte in INIT:
        t.feed('worker', bytes([byte]))
    assert json.loads(pipe_flush('worker')) == {'method': 'initialized', 'params': {}}
    for pos in range(0, len(CAPTURE), 19):
        t.feed('client', CAPTURE[pos:pos + 19])
    final_start = json.loads(pipe_flush('worker'))
    assert final_start['id'] == 2
    params = final_start['params']
    assert params['argv'] == list(t.adapter.base.TRUSTED_CLI_TRAMPOLINE_ARGV)
    assert params['env'] == {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
        'HOME': '/work/exec-worker', 'TMPDIR': '/work/exec-worker/tmp',
        'RC_EXEC_OUTER_PID_NS': PID, 'RC_EXEC_OUTER_MOUNT_NS': MOUNT}
    assert params['envPolicy'] is None and params['processId'] == 'fixed-worker'
    assert params['sandbox'] == t.adapter.base.trusted_cli_start_request()['params']['sandbox']
    t.feed('worker', START[:5])
    assert not t.pending('client')
    t.feed('worker', START[5:])
    assert json.loads(pipe_flush('client')) == {'id': 9, 'result': {'processId': PROCESS}}
    t.feed('client', request(t))
    assert json.loads(pipe_flush('worker')) == t.adapter.base.read_request(3)
    t.eof('client')
    frames = (note('output', 1, stream='stdout', chunk='AP8K') +
        note('exited', 2, exitCode=0, sandboxDenied=False) + note('closed', 3) + READ)
    for pos in range(0, len(frames), 7):
        t.feed('worker', frames[pos:pos + 7])
    t.eof('worker')
    assert not t.report()['complete']
    mapped = [json.loads(line) for line in pipe_flush('client').splitlines()]
    assert [x['method'] for x in mapped[:-1]] == ['process/output', 'process/exited', 'process/closed']
    assert all(x['params']['processId'] == PROCESS for x in mapped[:-1])
    assert mapped[0]['params']['chunk'] == 'AP8K'
    assert mapped[-1] == dict(json.loads(READ), id=10)
    report = t.report()
    assert report['profile'] == 'captured-worker-final-wire-accounting'
    assert report['complete'] and report['writeAccountingComplete']
    assert report['writtenBytes'] == report['enqueuedBytes']
    assert not any(report[key] for key in ('deliveryAttested', 'executionAttested', 'productionReady'))
    assert validate(report)
    assert report['wireFrames'] == [raw.hex() for raw in wire]


@pytest.mark.parametrize('stage', ['before-init', 'partial-init', 'await-init', 'initialized-pending', 'initialized-partial'])
def test_client_start_requires_fully_completed_bootstrap(stage):
    t = transport()
    if stage == 'partial-init': t.written('worker', 1)
    if stage in ('await-init', 'initialized-pending', 'initialized-partial'): flush(t, 'worker')
    if stage in ('initialized-pending', 'initialized-partial'): t.feed('worker', INIT)
    if stage == 'initialized-partial': t.written('worker', 1)
    with pytest.raises(ValueError): t.feed('client', CAPTURE)
    assert_failed(t)


@pytest.mark.parametrize('stage', ['init', 'init-partial', 'start', 'start-partial', 'read', 'read-partial'])
def test_worker_reply_requires_full_corresponding_request_write(stage):
    if stage.startswith('init'):
        t, response = transport(), INIT
    elif stage.startswith('start'):
        t, response = boot(), START
        t.feed('client', CAPTURE)
    else:
        t, response = started(), READ
        t.feed('client', request(t))
    if stage.endswith('partial'): t.written('worker', 1)
    with pytest.raises(ValueError): t.feed('worker', response)
    assert_failed(t)


@pytest.mark.parametrize('case', ['session', 'init-id', 'init-error', 'start-id', 'start-identity',
    'output-identity', 'closed-first', 'read-id', 'read-shape'])
def test_hostile_worker_frames_fail_closed(case):
    if case.startswith('init') or case == 'session':
        t = transport()
        flush(t, 'worker')
        frame = json.loads(INIT)
        if case == 'session': frame['result']['sessionId'] = '../invalid'
        if case == 'init-id': frame['id'] = True
        if case == 'init-error': frame = {'id': 1, 'error': {'code': -1, 'message': 'no'}}
    elif case.startswith('start'):
        t = boot()
        t.feed('client', CAPTURE)
        flush(t, 'worker')
        frame = json.loads(START)
        if case == 'start-id': frame['id'] = 9
        else: frame['result']['processId'] = PROCESS
    else:
        t = started()
        if case == 'output-identity':
            frame = json.loads(note('output', 1, stream='stdout', chunk='YQ=='))
            frame['params']['processId'] = PROCESS
        elif case == 'closed-first': frame = json.loads(note('closed', 1))
        else:
            t.feed('client', request(t))
            flush(t, 'worker')
            frame = json.loads(READ)
            if case == 'read-id': frame['id'] = 10
            else: frame['result']['sandboxDenied'] = None
    with pytest.raises(ValueError): t.feed('worker', enc(frame))
    assert_failed(t)


@pytest.mark.parametrize('case', ['missing-eof', 'partial-client', 'partial-worker', 'awaiting-read', 'abort'])
def test_incomplete_and_aborted_lifecycles_never_validate(case):
    t = started()
    if case == 'missing-eof':
        t.feed('worker', note('exited', 1, exitCode=0, sandboxDenied=False) + note('closed', 2))
        flush(t, 'client')
    elif case.startswith('partial'):
        side = case.split('-')[1]
        t.feed(side, b'{')
        with pytest.raises(ValueError): t.eof(side)
        assert_failed(t)
    elif case == 'awaiting-read':
        t.feed('client', request(t))
        flush(t, 'worker')
        t.feed('worker', note('exited', 1, exitCode=0, sandboxDenied=False) + note('closed', 2))
        with pytest.raises(ValueError): t.eof('worker')
        assert_failed(t)
    else:
        t.feed('client', request(t))
        t.abort()
        assert_failed(t)
    assert not t.report()['complete'] and not validate(t.report())


def test_report_replay_binds_sources_identities_namespaces_and_final_wire():
    report = finish(started())
    assert validate(report)
    for replacement in ({'pid': 'pid:[102]'}, {'mount': 'mnt:[203]'},
                        {'process': '1-' + THREAD}, {'thread': '01a0905c-d025-73e0-9b43-40038e02cd47'}):
        assert not validate(report, **replacement)
    assert not m.validate_wire_report(report, ADAPTER + b'\n', BASE, PROCESS, THREAD, PID, MOUNT)
    assert not m.validate_wire_report(report, ADAPTER, BASE + b'\n', PROCESS, THREAD, PID, MOUNT)
    for key in ('wireFrames', 'gate', 'writtenBytes', 'complete', 'executionAttested'):
        changed = copy.deepcopy(report)
        changed[key] = None
        assert not validate(changed)
    changed = copy.deepcopy(report)
    changed['calls'] = changed['calls'][1:]
    assert not validate(changed)
    changed = copy.deepcopy(report)
    write = next(call for call in changed['calls'] if call['op'] == 'written')
    write['count'] = True
    assert not validate(changed)


@pytest.mark.parametrize('pid,mount', [('pid:1', MOUNT), (PID, 'mnt:2'), ('pid:[-1]', MOUNT)])
def test_constructor_refuses_invalid_namespace_identity(pid, mount):
    with pytest.raises(ValueError): m.WireTransport(ADAPTER, BASE, PROCESS, THREAD, pid, mount)
