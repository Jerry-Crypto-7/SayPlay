"""Offline HTTP fragmentation/framing tests; real ResponsesPeer, no sockets."""
import importlib.util
from pathlib import Path

import pytest


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'),
        Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


h = load('subscription-tool-capture-harness')
m = load('subscription-tool-capture-http')


def request(second=False):
    return h.encode({'model': h.MODEL, 'stream': True,
        'input': [{'type': 'function_call_output', 'call_id': h.CALL_ID,
                   'output': 'capture refused'}] if second else [],
        'tools': [{'type': 'function', 'name': 'exec_command'}]})


def wire(body=None, extra=b''):
    body = request() if body is None else body
    return (b'POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:31317\r\n'
        b'Content-Type: application/json\r\nContent-Length: '
        + str(len(body)).encode() + b'\r\n' + extra + b'\r\n' + body)


@pytest.mark.parametrize('size', [1, 3, 37, 65536])
def test_fragmented_request_and_partial_response_accounting(size):
    peer = h.ResponsesPeer()
    c = m.Connection(peer)
    raw = wire()
    for offset in range(0, len(raw), size):
        c.feed(raw[offset:offset + size])
    header, body = bytes(c.pending).split(b'\r\n\r\n', 1)
    assert b'Content-Length: ' + str(len(body)).encode() in header
    assert b'Connection: close' in header and body == peer.pending
    c.eof()  # HTTP request half-close does not prevent sending response.
    c.written(len(c.pending) - 1)
    assert not c.complete and peer.step == 0
    c.written(1)
    assert c.complete and peer.step == 1
    second = m.Connection(peer)
    second.feed(wire(request(True)))
    second.written(len(second.pending))
    assert second.complete and peer.report()['complete']


@pytest.mark.parametrize('mutation', [
    lambda b: b.replace(b'POST ', b'GET ', 1),
    lambda b: b.replace(b'HTTP/1.1', b'HTTP/1.0', 1),
    lambda b: b.replace(b'Host: 127.0.0.1:31317\r\n', b''),
    lambda b: b.replace(b'Content-Length:', b'Content-Length :'),
    lambda b: b.replace(b'Content-Type:', b' Content-Type:'),
    lambda b: b.replace(b'Host:', b'Ho\nst:'),
    lambda b: b.replace(b'application/json', b'application/json\x00'),
    lambda b: b.replace(b'Content-Length: ', b'Content-Length: +'),
    lambda b: b.replace(b'Content-Length: ', b'Content-Length: 0'),
    lambda b: b + b'POST /v1/responses HTTP/1.1\r\n',
])
def test_malformed_input_sticky_failure(mutation):
    peer = h.ResponsesPeer()
    c = m.Connection(peer)
    with pytest.raises(ValueError):
        c.feed(mutation(wire()))
    assert c.failed and peer.failed and not c.pending and not peer.events
    with pytest.raises(ValueError):
        c.feed(wire())


@pytest.mark.parametrize('header', [b'Transfer-Encoding: chunked\r\n',
    b'Upgrade: websocket\r\n', b'Content-Encoding: gzip\r\n',
    b'Authorization: authored-placeholder\r\n', b'HOST: other\r\n'])
def test_transport_auth_and_duplicate_header_rejection(header):
    peer = h.ResponsesPeer()
    c = m.Connection(peer)
    with pytest.raises(ValueError):
        c.feed(wire(extra=header))
    assert c.failed and not peer.events


@pytest.mark.parametrize('raw', [b'', b'POST /v1/responses HTTP/1.1\r\n', wire()[:-1]])
def test_truncated_eof_cannot_complete(raw):
    c = m.Connection(h.ResponsesPeer())
    if raw:
        c.feed(raw)
    with pytest.raises(ValueError):
        c.eof()
    assert c.failed and not c.complete


@pytest.mark.parametrize('count', [0, -1, True, 999999])
def test_invalid_actual_write_count_fails_closed(count):
    peer = h.ResponsesPeer()
    c = m.Connection(peer)
    c.feed(wire())
    with pytest.raises(ValueError):
        c.written(count)
    assert c.failed and not c.pending and peer.step == 0


def test_separate_pipelined_data_clears_queued_reply():
    peer = h.ResponsesPeer()
    c = m.Connection(peer)
    c.feed(wire())
    with pytest.raises(ValueError):
        c.feed(b'x')
    assert c.failed and not c.pending and peer.step == 0


@pytest.mark.parametrize('raw', [b'x' * m.MAX_HEADERS,
    wire(extra=b'X-Padding: ' + b'x' * m.MAX_HEADERS + b'\r\n'),
    b'POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2097153\r\n\r\n',
    b'x' * (m.MAX_HEADERS + m.MAX_BODY + 1)],
    ids=['unterminated-header', 'oversize-header', 'oversize-body', 'total-input'])
def test_header_and_body_bounds(raw):
    peer = h.ResponsesPeer()
    c = m.Connection(peer)
    with pytest.raises(ValueError):
        c.feed(raw)
    assert c.failed and not peer.events


def test_peer_delivery_error_poisoned_connection():
    peer = h.ResponsesPeer()
    c = m.Connection(peer)
    c.feed(wire())
    peer.failed = True
    with pytest.raises(ValueError):
        c.written(len(c.pending))
    assert c.failed and not c.complete
