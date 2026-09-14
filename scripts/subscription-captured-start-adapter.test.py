"""Captured wire admission, fixed gate compatibility and hostile drift checks."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import pytest

PATH = Path(__file__).with_name('subscription-captured-start-adapter.py')
SPEC = importlib.util.spec_from_file_location('captured_start_test', PATH)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
BASE = PATH.with_name('subscription-exec-server-worker-gate.py').read_bytes()
PROCESS = '75019-eefe8e86-65cd-45ed-9ab0-b55a100b8ace'
THREAD = '01a0905c-d025-73e0-9b43-40038e02cd46'
CAPTURE = PATH.with_name('subscription-captured-start.fixture.json')


def adapter():
    return m.StartAdapter(BASE, PROCESS, THREAD)


def test_actual_capture_enters_unchanged_fixed_gate_and_replays():
    raw = CAPTURE.read_bytes()
    assert len(raw) == 1047 and hashlib.sha256(raw).hexdigest() == m.CAPTURE_SHA
    a = adapter()
    mapped = a.start(raw)
    gate = a.base.Gate('pid:[1]', 'mnt:[2]', 'trusted-cli-worker-boundary')
    gate.initialized = True
    gate.init_ok = True
    gate.identifier = 1
    gate.admit(json.loads(mapped))
    wire = json.loads(bytes(gate.pending))
    assert wire['params']['argv'] == a.base.TRUSTED_CLI_TRAMPOLINE_ARGV
    assert wire['params']['env'] == gate.worker_env
    assert 'CODEX_THREAD_ID' not in wire['params']['env']
    assert wire['params']['envPolicy'] is None
    assert wire['params']['sandbox'] == a.base.control_start_request()['params']['sandbox']
    assert wire['params']['processId'] == 'fixed-worker'
    gate.written(len(gate.pending))
    reply = {'id': 2, 'result': {'processId': 'fixed-worker'}}
    gate.receive(reply)
    assert json.loads(a.reply(m.encode(reply))) == {'id': 9, 'result': {'processId': PROCESS}}
    report = a.report()
    assert report['complete'] and not report['executionAttested']
    assert m.validate_report(report, BASE, PROCESS, THREAD)
    assert not m.validate_report(report, BASE, '1-' + PROCESS.split('-', 1)[1], THREAD)
    for field in ('inputHex', 'outputHex', 'kind'):
        changed = copy.deepcopy(report)
        changed['events'][0][field] = '00'
        assert not m.validate_report(changed, BASE, PROCESS, THREAD)
    report['productionReady'] = True
    assert not m.validate_report(report, BASE, PROCESS, THREAD)


@pytest.mark.parametrize('case', ['id', 'method', 'extra', 'argv', 'env', 'thread', 'process',
    'policy', 'sandbox', 'cwd', 'tty', 'stdin', 'network', 'arg0', 'numeric-bool'])
def test_drift_is_sticky_before_output(case):
    a = adapter()
    frame = m.client_request(PROCESS, THREAD)
    p = frame['params']
    if case == 'id': frame['id'] = 10
    if case == 'method': frame['method'] = 'process/read'
    if case == 'extra': frame['trace'] = {}
    if case == 'argv': p['argv'][2] += '; caller'
    if case == 'env': p['env']['CALLER'] = 'fixture'
    if case == 'thread': p['env']['CODEX_THREAD_ID'] = '0' * 36
    if case == 'process': p['processId'] = 'fixed-worker'
    if case == 'policy': p['envPolicy']['set']['PATH'] = '/caller'
    if case == 'sandbox': p['sandbox']['permissions']['network'] = 'enabled'
    if case == 'cwd': p['cwd'] = 'file:///work'
    if case == 'tty': p['tty'] = True
    if case == 'stdin': p['pipeStdin'] = True
    if case == 'network': p['managedNetwork'] = {}
    if case == 'arg0': p['arg0'] = 'caller'
    if case == 'numeric-bool': p['tty'] = 0
    with pytest.raises(ValueError): a.start(m.encode(frame))
    assert a.failed and not a.events
    with pytest.raises(ValueError): a.start(m.encode(m.client_request(PROCESS, THREAD)))


@pytest.mark.parametrize('raw', [b'{}', b'{}\n{}\n', b'[]\n', b'{"id":9,"id":9}\n',
    b'{"id":NaN}\n', b'\xff\n', b' ' * 131072 + b'\n'],
    ids=['no-newline', 'two-frames', 'array', 'duplicate', 'nan', 'utf8', 'oversize'])
def test_invalid_raw(raw):
    a = adapter()
    with pytest.raises(ValueError): a.start(raw)
    assert a.failed and not a.events


@pytest.mark.parametrize('reply', [{'id': 9, 'result': {'processId': 'fixed-worker'}},
    {'id': 2, 'result': {'processId': PROCESS}}, {'id': 2, 'error': {'code': -1}},
    {'id': 2, 'result': {'processId': 'fixed-worker', 'extra': True}}])
def test_reply_rejects_drift(reply):
    a = adapter()
    a.start(m.encode(m.client_request(PROCESS, THREAD)))
    with pytest.raises(ValueError): a.reply(m.encode(reply))
    assert a.failed and not a.report()['complete']


def test_order_and_source():
    with pytest.raises(ValueError, match='BASE_SOURCE'): m.StartAdapter(BASE + b'\n', PROCESS, THREAD)
    a = adapter()
    with pytest.raises(ValueError): a.reply(b'{}\n')
    b = adapter()
    raw = m.encode(m.client_request(PROCESS, THREAD))
    b.start(raw)
    with pytest.raises(ValueError): b.start(raw)
    assert b.failed


@pytest.mark.parametrize('process', ['0-' + THREAD, '2147483648-' + THREAD,
    '01-' + THREAD, '-1-' + THREAD, '1-' + THREAD.upper(), 'fixed-worker'])
def test_identity_bound(process):
    with pytest.raises(ValueError, match='PROCESS_ID'): m.StartAdapter(BASE, process, THREAD)


def lifecycle(reply=True):
    a = m.LifecycleAdapter(BASE, PROCESS, THREAD)
    a.start(CAPTURE.read_bytes())
    if reply:
        a.reply(m.encode({'id': 2, 'result': {'processId': 'fixed-worker'}}))
    return a


def note(method, seq, **fields):
    return {'method': 'process/' + method,
            'params': {'processId': 'fixed-worker', 'seq': seq, **fields}}


@pytest.mark.parametrize('early', [False, True])
@pytest.mark.parametrize('denied', [False, True])
def test_lifecycle_preserves_output_exit_and_late_reply(early, denied):
    a = lifecycle(reply=not early)
    frames = [note('output', 1, stream='stdout', chunk='AP8K'),
              note('exited', 2, exitCode=-9, sandboxDenied=denied),
              note('output', 3, stream='stderr', chunk='ZXJy'), note('closed', 4)]
    for frame in frames:
        mapped = json.loads(a.notification(m.encode(frame)))
        expected = copy.deepcopy(frame)
        expected['params']['processId'] = PROCESS
        assert mapped == expected
    if early:
        assert not a.report()['complete']
        a.reply(m.encode({'id': 2, 'result': {'processId': 'fixed-worker'}}))
    report = a.report()
    assert report['complete']
    assert not any(report[k] for k in ('deliveryAttested', 'executionAttested', 'productionReady'))
    assert m.validate_lifecycle_report(report, BASE, PROCESS, THREAD)
    for field in ('inputHex', 'outputHex', 'kind'):
        changed = copy.deepcopy(report)
        changed['events'][-1][field] = '00'
        assert not m.validate_lifecycle_report(changed, BASE, PROCESS, THREAD)
    assert not m.validate_lifecycle_report(report, BASE, '1-' + THREAD, THREAD)
    with pytest.raises(ValueError): a.notification(m.encode(note('closed', 5)))
    assert a.failed and not a.report()['complete']


@pytest.mark.parametrize('case', ['identity', 'gap', 'bool', 'extra', 'base64', 'pty',
    'method', 'closed', 'exit-bool', 'exit-range', 'denial-missing', 'denial-null', 'rpc'])
def test_lifecycle_refuses_hostile_notifications(case):
    a = lifecycle()
    frame = note('output', 1, stream='stdout', chunk='YQ==')
    if case == 'identity': frame['params']['processId'] = PROCESS
    if case == 'gap': frame['params']['seq'] = 2
    if case == 'bool': frame['params']['seq'] = True
    if case == 'extra': frame['params']['extra'] = 1
    if case == 'base64': frame['params']['chunk'] = 'YR=='
    if case == 'pty': frame['params']['stream'] = 'pty'
    if case == 'method': frame['method'] = 'process/read'
    if case == 'closed': frame = note('closed', 1)
    if case == 'exit-bool': frame = note('exited', 1, exitCode=False, sandboxDenied=False)
    if case == 'exit-range': frame = note('exited', 1, exitCode=2147483648, sandboxDenied=False)
    if case == 'denial-missing': frame = note('exited', 1, exitCode=0)
    if case == 'denial-null': frame = note('exited', 1, exitCode=0, sandboxDenied=None)
    if case == 'rpc': frame['id'] = 2
    before = copy.deepcopy(a.events)
    with pytest.raises(ValueError): a.notification(m.encode(frame))
    assert a.failed and a.events == before
    with pytest.raises(ValueError): a.notification(m.encode(note('exited', 1, exitCode=0, sandboxDenied=False)))


def test_lifecycle_order_and_incomplete_replay():
    a = m.LifecycleAdapter(BASE, PROCESS, THREAD)
    with pytest.raises(ValueError): a.notification(m.encode(note('closed', 1)))
    a = lifecycle()
    a.notification(m.encode(note('exited', 1, exitCode=0, sandboxDenied=False)))
    assert not a.report()['complete']
    assert not m.validate_lifecycle_report(a.report(), BASE, PROCESS, THREAD)
    with pytest.raises(ValueError):
        a.notification(m.encode(note('exited', 2, exitCode=0, sandboxDenied=False)))


@pytest.mark.parametrize('early', [False, True])
def test_lifecycle_event_limit_reserves_reply(early):
    a = lifecycle(reply=not early)
    for seq in range(1, 63):
        a.notification(m.encode(note('output', seq, stream='stdout', chunk='')))
    before = len(a.events)
    with pytest.raises(ValueError, match='EVENT_LIMIT'):
        a.notification(m.encode(note('output', 63, stream='stdout', chunk='')))
    assert len(a.events) == before and a.failed


def test_lifecycle_total_byte_limit():
    import base64
    a = lifecycle()
    chunk = base64.b64encode(b'x' * 65536).decode()
    for seq in range(1, 6):
        a.notification(m.encode(note('output', seq, stream='stdout', chunk=chunk)))
    with pytest.raises(ValueError, match='BYTE_LIMIT'):
        a.notification(m.encode(note('output', 6, stream='stdout', chunk=chunk)))
    assert a.seq == 5 and a.failed


def reader():
    a = m.ReadAdapter(BASE, PROCESS, THREAD)
    a.start(CAPTURE.read_bytes())
    a.reply(m.encode({'id': 2, 'result': {'processId': 'fixed-worker'}}))
    return a


def read_frame(a, after=None):
    frame = a.base.read_request(10 + a.read_count, after)
    frame['params']['processId'] = PROCESS
    return frame


def read_result(identifier=3, **fields):
    return {'id': identifier, 'result': {'chunks': [], 'nextSeq': 1, 'exited': False,
            'exitCode': None, 'closed': False, 'failure': None, 'sandboxDenied': False, **fields}}


def test_read_mapping_gate_compatibility_interleaving_and_replay():
    a = reader()
    gate = a.base.Gate('pid:[1]', 'mnt:[2]', 'trusted-cli-worker-boundary')
    gate.initialized = gate.init_ok = True
    gate.identifier = 1
    gate.admit(a.base.trusted_cli_start_request())
    gate.written(len(gate.pending))
    gate.receive({'id': 2, 'result': {'processId': 'fixed-worker'}})
    mapped = a.read(m.encode(read_frame(a)))
    gate.admit(json.loads(mapped))
    assert json.loads(bytes(gate.pending)) == a.base.read_request(3, None)
    gate.written(len(gate.pending))
    out = note('output', 1, stream='stdout', chunk='AP8K')
    a.notification(m.encode(out))
    snapshot = read_result(chunks=[{k: v for k, v in out['params'].items() if k != 'processId'}], nextSeq=2)
    gate.receive(snapshot)
    expected = copy.deepcopy(snapshot)
    expected['id'] = 10
    assert json.loads(a.read_reply(m.encode(snapshot))) == expected
    assert a.seq == 1  # Read snapshots never advance streaming state.
    a.read(m.encode(read_frame(a, after=1)))
    a.notification(m.encode(note('exited', 2, exitCode=0, sandboxDenied=False)))
    a.notification(m.encode(note('closed', 3)))
    assert not a.report()['complete']
    # This running snapshot was prepared before the notifications above.
    assert json.loads(a.read_reply(m.encode(read_result(4, nextSeq=2))))['id'] == 11
    report = a.report()
    assert report['complete'] and report['readCount'] == 2
    assert m.validate_read_report(report, BASE, PROCESS, THREAD)
    assert not m.validate_lifecycle_report(report, BASE, PROCESS, THREAD)
    for field in ('inputHex', 'outputHex', 'kind'):
        changed = copy.deepcopy(report)
        changed['events'][2][field] = '00'
        assert not m.validate_read_report(changed, BASE, PROCESS, THREAD)
    assert not m.validate_read_report(report, BASE, '1-' + THREAD, THREAD)
    with pytest.raises(ValueError): a.read(m.encode(read_frame(a)))


@pytest.mark.parametrize('case', ['id', 'process', 'method', 'extra', 'cursor-bool',
    'cursor-negative', 'cursor-overflow', 'max', 'wait', 'missing', 'parallel'])
def test_read_request_refusal(case):
    a = reader()
    frame = read_frame(a)
    if case == 'id': frame['id'] = 11
    if case == 'process': frame['params']['processId'] = 'fixed-worker'
    if case == 'method': frame['method'] = 'process/terminate'
    if case == 'extra': frame['extra'] = True
    if case == 'cursor-bool': frame['params']['afterSeq'] = False
    if case == 'cursor-negative': frame['params']['afterSeq'] = -1
    if case == 'cursor-overflow': frame['params']['afterSeq'] = 2**64
    if case == 'max': frame['params']['maxBytes'] = 65537
    if case == 'wait': frame['params']['waitMs'] = 0
    if case == 'missing': del frame['params']['afterSeq']
    if case == 'parallel': a.read(m.encode(frame))
    before = copy.deepcopy(a.events)
    with pytest.raises(ValueError): a.read(m.encode(frame))
    assert a.failed and a.events == before


@pytest.mark.parametrize('case', ['id', 'error', 'extra', 'bool', 'failure', 'closed',
    'exit-missing', 'exit-bool', 'denied', 'cursor', 'duplicate', 'backward',
    'next', 'base64', 'bytes', 'chunk-count'])
def test_read_reply_refusal(case):
    import base64
    a = reader()
    a.read(m.encode(read_frame(a, 2)))
    frame = read_result()
    value = frame['result']
    chunk = {'seq': 3, 'stream': 'stderr', 'chunk': 'YQ=='}
    if case == 'id': frame['id'] = 10
    if case == 'error': frame = {'id': 3, 'error': {'code': -32000, 'message': 'fixture'}}
    if case == 'extra': value['extra'] = None
    if case == 'bool': value['exited'] = 0
    if case == 'failure': value['failure'] = 'fixture'
    if case == 'closed': value['closed'] = True
    if case == 'exit-missing': value['exited'] = True
    if case == 'exit-bool': value.update(exited=True, exitCode=False)
    if case == 'denied': value['sandboxDenied'] = True
    if case == 'cursor': value['nextSeq'] = 2**64
    if case == 'duplicate': value.update(chunks=[chunk, chunk], nextSeq=4)
    if case == 'backward': value.update(chunks=[{**chunk, 'seq': 2}], nextSeq=3)
    if case == 'next': value.update(chunks=[chunk], nextSeq=5)
    if case == 'base64': value.update(chunks=[{**chunk, 'chunk': 'YR=='}], nextSeq=4)
    if case == 'bytes':
        value.update(chunks=[{**chunk, 'chunk': base64.b64encode(b'a' * 65536).decode()},
                             {**chunk, 'seq': 4}], nextSeq=5)
    if case == 'chunk-count':
        value.update(chunks=[{**chunk, 'seq': seq} for seq in range(3, 68)], nextSeq=68)
    before = copy.deepcopy(a.events)
    with pytest.raises(ValueError): a.read_reply(m.encode(frame))
    assert a.failed and a.events == before and a.pending_read is not None
    with pytest.raises(ValueError): a.read_reply(m.encode(read_result()))


def test_read_snapshot_is_not_lifecycle_completion_and_empty_future_cursor():
    a = reader()
    a.read(m.encode(read_frame(a, 100)))
    result = read_result(exited=True, closed=True, exitCode=1, sandboxDenied=True)
    assert json.loads(a.read_reply(m.encode(result)))['result'] == result['result']
    assert not a.report()['complete'] and not a.closed and not a.exited
    assert not m.validate_read_report(a.report(), BASE, PROCESS, THREAD)
    with pytest.raises(ValueError): a.read_reply(m.encode(result))


@pytest.mark.parametrize('operation', ['read', 'read_reply'])
@pytest.mark.parametrize('limit', ['MAX_EVENTS', 'MAX_BYTES'])
def test_read_limits_apply_before_recording(operation, limit):
    a = reader()
    raw = m.encode(read_frame(a))
    if operation == 'read_reply':
        a.read(raw)
        raw = m.encode(read_result())
    setattr(a, limit, 1)
    before = copy.deepcopy(a.events)
    with pytest.raises(ValueError, match='READ_LIMIT'): getattr(a, operation)(raw)
    assert a.failed and a.events == before


def test_read_requires_start_reply():
    a = m.ReadAdapter(BASE, PROCESS, THREAD)
    a.start(CAPTURE.read_bytes())
    with pytest.raises(ValueError, match='READ_ORDER'): a.read(m.encode(read_frame(a)))
