"""Duplex causality, actual local pipe writes, bounded replay and failure paths."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import pytest

PATH = Path(__file__).with_name('subscription-captured-worker-transport.py')
SPEC = importlib.util.spec_from_file_location('captured_transport_test', PATH)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
ADAPTER = PATH.with_name('subscription-captured-start-adapter.py').read_bytes()
BASE = PATH.with_name('subscription-exec-server-worker-gate.py').read_bytes()
CAPTURE = PATH.with_name('subscription-captured-start.fixture.json').read_bytes()
PROCESS = '75019-eefe8e86-65cd-45ed-9ab0-b55a100b8ace'
THREAD = '01a0905c-d025-73e0-9b43-40038e02cd46'


def transport():
    return m.Transport(ADAPTER, BASE, PROCESS, THREAD)


def enc(frame):
    return json.dumps(frame, separators=(',', ':')).encode() + b'\n'


REPLY = enc({'id': 2, 'result': {'processId': 'fixed-worker'}})
EXIT = enc({'method': 'process/exited', 'params': {
    'processId': 'fixed-worker', 'seq': 1, 'exitCode': 0, 'sandboxDenied': False}})
CLOSED = enc({'method': 'process/closed', 'params': {'processId': 'fixed-worker', 'seq': 2}})


def flush(t, side):
    raw = t.pending(side)
    if raw:
        t.written(side, len(raw))
    return raw


def started():
    t = transport()
    t.feed('client', CAPTURE)
    flush(t, 'worker')
    t.feed('worker', REPLY)
    flush(t, 'client')
    return t


def read_request(t):
    frame = t.adapter.base.read_request(10)
    frame['params']['processId'] = PROCESS
    return enc(frame)


READ_REPLY = enc({'id': 3, 'result': {'chunks': [], 'nextSeq': 1, 'exited': False,
    'exitCode': None, 'closed': False, 'failure': None, 'sandboxDenied': False}})


def test_actual_pipe_partial_writes_and_replay():
    t = transport()
    # Local authored endpoints only. Read immediately to avoid pipe-capacity waits.
    def pipe_flush(side):
        reader, writer = os.pipe()
        captured = bytearray()
        expected = t.pending(side)
        try:
            while t.pending(side):
                count = os.write(writer, t.pending(side)[:11])
                t.written(side, count)
                captured.extend(os.read(reader, count))
        finally:
            os.close(writer)
            os.close(reader)
        assert bytes(captured) == expected
        return bytes(captured)

    for pos in range(0, len(CAPTURE), 17):
        t.feed('client', CAPTURE[pos:pos + 17])
    assert json.loads(pipe_flush('worker'))['params']['processId'] == 'fixed-worker'
    t.feed('worker', REPLY[:7])
    assert not t.pending('client')
    t.feed('worker', REPLY[7:])
    assert json.loads(pipe_flush('client'))['result']['processId'] == PROCESS
    t.feed('client', read_request(t))
    assert json.loads(pipe_flush('worker'))['id'] == 3
    t.eof('client')  # Half-close while read and lifecycle are still outstanding.
    t.feed('worker', EXIT + CLOSED + READ_REPLY)
    t.eof('worker')
    assert t.adapter.report()['complete'] and not t.report()['complete']
    mapped = pipe_flush('client').splitlines()
    assert json.loads(mapped[-1])['id'] == 10
    assert all(json.loads(line)['params']['processId'] == PROCESS for line in mapped[:-1])
    report = t.report()
    assert report['complete'] and report['writeAccountingComplete']
    assert report['writtenBytes'] == report['enqueuedBytes']
    assert not any(report[k] for k in ('deliveryAttested', 'executionAttested', 'productionReady'))
    assert m.validate_report(report, ADAPTER, BASE, PROCESS, THREAD)
    assert not m.validate_report(report, ADAPTER, BASE, '1-' + THREAD, THREAD)
    for field in ('writtenBytes', 'deliveryAttested', 'writeAccountingComplete'):
        changed = copy.deepcopy(report)
        changed[field] = None
        assert not m.validate_report(changed, ADAPTER, BASE, PROCESS, THREAD)
    for mutation in ('drop-write', 'early-reply', 'bad-hex', 'extra', 'bool-count'):
        changed = copy.deepcopy(report)
        calls = changed['calls']
        index = next(i for i, c in enumerate(calls) if c['op'] == 'written')
        if mutation == 'drop-write': del calls[index]
        if mutation == 'early-reply': calls.insert(0, {'op': 'feed', 'side': 'worker', 'rawHex': REPLY.hex()})
        if mutation == 'bad-hex': calls[0]['rawHex'] = 'FF'
        if mutation == 'extra': calls[0]['extra'] = 1
        if mutation == 'bool-count': calls[index]['count'] = True
        assert not m.validate_report(changed, ADAPTER, BASE, PROCESS, THREAD)


@pytest.mark.parametrize('case', ['start', 'start-partial', 'reply', 'read', 'read-partial'])
def test_response_requires_actual_write_accounting(case):
    t = transport()
    t.feed('client', CAPTURE)
    if case == 'start-partial': t.written('worker', 1)
    if case in ('start', 'start-partial'):
        with pytest.raises(ValueError, match='START_NOT_WRITTEN'): t.feed('worker', REPLY)
    else:
        flush(t, 'worker')
        t.feed('worker', REPLY)
        if case == 'reply':
            t.written('client', 1)
            with pytest.raises(ValueError, match='START_REPLY_NOT_WRITTEN'): t.feed('client', read_request(t))
        else:
            flush(t, 'client')
            t.feed('client', read_request(t))
            if case == 'read-partial': t.written('worker', 1)
            with pytest.raises(ValueError, match='READ_NOT_WRITTEN'): t.feed('worker', READ_REPLY)
    assert t.failed and not t.pending('client') and not t.pending('worker')
    assert not t.report()['complete']


def test_notifications_before_start_reply_after_full_start_write():
    t = transport()
    t.feed('client', CAPTURE)
    flush(t, 'worker')
    t.feed('worker', EXIT + CLOSED + REPLY)
    t.eof('client')
    t.eof('worker')
    flush(t, 'client')
    assert m.validate_report(t.report(), ADAPTER, BASE, PROCESS, THREAD)


@pytest.mark.parametrize('count', [0, -1, True, 1.0, 1000000])
def test_invalid_write_counts_poison_and_clear(count):
    t = transport()
    t.feed('client', CAPTURE)
    with pytest.raises(ValueError): t.written('worker', count)
    assert t.failed and not t.pending('worker')
    with pytest.raises(ValueError): t.feed('client', CAPTURE)


@pytest.mark.parametrize('case', ['worker-early', 'client-partial', 'worker-partial',
    'duplicate', 'after-eof', 'abort', 'missing-eof', 'pending-read'])
def test_eof_and_abort_fail_closed(case):
    t = started()
    if case == 'worker-early':
        with pytest.raises(ValueError): t.eof('worker')
    if case in ('client-partial', 'worker-partial'):
        side = case.split('-')[0]
        t.feed(side, b'{')
        with pytest.raises(ValueError): t.eof(side)
    if case == 'duplicate':
        t.eof('client')
        with pytest.raises(ValueError): t.eof('client')
    if case == 'after-eof':
        t.eof('client')
        with pytest.raises(ValueError): t.feed('client', read_request(t))
    if case == 'abort': t.abort()
    if case == 'missing-eof':
        t.feed('worker', EXIT + CLOSED)
        flush(t, 'client')
    if case == 'pending-read':
        t.feed('client', read_request(t))
        flush(t, 'worker')
        t.feed('worker', EXIT + CLOSED)
        with pytest.raises(ValueError): t.eof('worker')
    assert not t.report()['complete']
    assert not m.validate_report(t.report(), ADAPTER, BASE, PROCESS, THREAD)


@pytest.mark.parametrize('case', ['side', 'oversize', 'line', 'json', 'two-client-frames', 'empty'])
def test_input_shape_and_bounds(case):
    t = transport()
    side, raw = 'client', CAPTURE
    if case == 'side': side = 'unknown'
    if case == 'oversize': raw = b' ' * 131073
    if case == 'line': raw = b' ' * 131072
    if case == 'json': raw = b'{"id":9,"id":9}\n'
    if case == 'two-client-frames': raw = CAPTURE + CAPTURE
    if case == 'empty': raw = b''
    with pytest.raises(ValueError): t.feed(side, raw)
    assert t.failed and not t.pending('worker')


def test_source_pin_and_global_limits(monkeypatch):
    with pytest.raises(ValueError, match='ADAPTER_SOURCE'):
        m.Transport(ADAPTER + b'\n', BASE, PROCESS, THREAD)
    t = transport()
    monkeypatch.setattr(m, 'MAX_CALLS', 1)
    t.feed('client', CAPTURE)
    with pytest.raises(ValueError, match='CALL_LIMIT'): flush(t, 'worker')
    monkeypatch.setattr(m, 'MAX_CALLS', 4096)
    t = transport()
    monkeypatch.setattr(m, 'MAX_BYTES', 1)
    with pytest.raises(ValueError, match='INPUT_LIMIT'): t.feed('client', CAPTURE)
