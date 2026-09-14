import importlib.util
from pathlib import Path
import socket
import threading
from unittest.mock import patch
import pytest

spec = importlib.util.spec_from_file_location('offline_proxy_test', Path(__file__).with_name('subscription-trusted-egress-proxy.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


@pytest.mark.parametrize('split', range(1, len(m.REQUEST)))
def test_connect_every_partial_boundary(split):
    p = m.ConnectParser()
    assert not p.feed(m.REQUEST[:split])
    assert p.feed(m.REQUEST[split:])
    assert not p.pending
    with pytest.raises(ValueError): p.feed(b'extra')


@pytest.mark.parametrize('wire', [b'GET / HTTP/1.1\r\n\r\n', m.REQUEST + b'tunnel',
    m.REQUEST.replace(b'fixture.invalid:443', b'example.com:443'),
    m.REQUEST.replace(b'fixture.invalid:443', b'user@fixture.invalid:443'),
    m.REQUEST.replace(b'fixture.invalid:443', b'https://fixture.invalid:443/'),
    m.REQUEST.replace(b'\r\n\r\n', b'\r\nProxy-Authorization: secret\r\n\r\n'),
    m.REQUEST.replace(b'\r\n\r\n', b'\r\nAuthorization: secret\r\n\r\n'),
    m.REQUEST.replace(b'\r\n', b'\n'), b'x' * (m.HEADER_LIMIT + 1)])
def test_strict_fixed_authority_headers_no_payload_disclosure(wire):
    p = m.ConnectParser()
    with pytest.raises(ValueError) as result: p.feed(wire)
    assert 'secret' not in str(result.value)
    assert not p.pending and p.failed


def make_session():
    try: broker, ingress, upstream, control = m.create_offline_session()
    except (AttributeError, OSError) as error: pytest.skip('AF_UNIX socketpair unavailable: ' + type(error).__name__)
    for peer in (ingress, upstream, control): peer.settimeout(1)
    return broker, ingress, upstream, control


def recv_exact(peer, size):
    result = b''
    while len(result) < size:
        part = peer.recv(size - len(result))
        assert part
        result += part
    return result


def run_owned(action):
    broker, ingress, upstream, control = make_session()
    reports = []
    thread = threading.Thread(target=lambda: reports.append(broker.run()), daemon=True)
    thread.start()
    try: action(ingress, upstream, control)
    finally:
        for peer in (ingress, upstream, control): peer.close()
        thread.join(2)
    assert not thread.is_alive()
    assert len(reports) == 1 and reports[0]['brokerDescriptorsClosed'] and broker.cleanup_known
    with pytest.raises(ValueError): broker.run()
    return reports[0]


def test_real_owned_socketpair_opaque_both_directions_halfclose():
    def action(client, upstream, control):
        client.sendall(m.REQUEST[:9]); client.sendall(m.REQUEST[9:])
        assert recv_exact(client, len(m.RESPONSE)) == m.RESPONSE
        payload = bytes(range(256)) * 4
        client.sendall(payload); assert recv_exact(upstream, len(payload)) == payload
        upstream.sendall(payload[::-1]); assert recv_exact(client, len(payload)) == payload[::-1]
        client.shutdown(socket.SHUT_WR); assert upstream.recv(1) == b''
        upstream.shutdown(socket.SHUT_WR); assert client.recv(1) == b''
    report = run_owned(action)
    assert report['connectAccepted']
    assert report['observedBytes'] == {'ingress': len(m.REQUEST) + 1024, 'upstream': 1024}
    assert report['deliveredBytes'] == {'ingress': len(m.RESPONSE) + 1024, 'upstream': 1024}


@pytest.mark.parametrize('command', [b'C', b'bad', None])
def test_cancel_control_refusal_or_eof_while_negotiating(command):
    def action(client, upstream, control):
        client.sendall(b'CON')
        if command is None: control.shutdown(socket.SHUT_WR)
        else: control.sendall(command)
        assert client.recv(1) == b''
    report = run_owned(action)
    assert report['reason'] == ('CONTROL_REFUSED' if command == b'bad' else 'CANCELLED')
    assert not report['connectAccepted']


def test_no_production_connector_or_arbitrary_endpoint_adoption():
    with patch.object(m.socket, 'socket') as create:
        with pytest.raises(ValueError, match='PRODUCTION_UPSTREAM_NOT_IMPLEMENTED'): m.production_upstream()
        create.assert_not_called()
    with pytest.raises(ValueError, match='FIXED_OWNED_SOCKETPAIR_REQUIRED'): m.OfflineSession(None, None, None)


def test_partial_factory_failure_closes_only_created_endpoints():
    from unittest.mock import Mock
    endpoints = [Mock(fileno=Mock(return_value=-1)), Mock(fileno=Mock(return_value=-1))]
    with patch.object(m.socket, 'AF_UNIX', 1, create=True), patch.object(m.socket, 'socketpair', side_effect=[tuple(endpoints), OSError('unavailable')]):
        with pytest.raises(OSError): m.create_offline_session()
    for endpoint in endpoints: endpoint.close.assert_called_once()


@pytest.mark.parametrize('case', ['normal', 'partial-eof', 'backpressure-cancel', 'deadline', 'byte-limit'])
def test_nonblocking_loop_partial_writes_opaque_accounting_and_owned_cleanup(case):
    from types import SimpleNamespace
    tick = [0]
    class Endpoint:
        def __init__(self, chunks, identity):
            self.chunks = list(chunks); self.identity = identity; self.sent = bytearray(); self.calls = 0
            self.shutdowns = []; self.inheritable = True
        def set_inheritable(self, value): self.inheritable = value
        def setblocking(self, value): assert value is False
        def fileno(self): return self.identity
        def close(self): self.identity = -1
        def shutdown(self, how): self.shutdowns.append(how)
        def recv(self, size):
            if self is control:
                if case == 'backpressure-cancel' and tick[0] > 12: return b'C'
                raise BlockingIOError()
            if not self.chunks: raise BlockingIOError()
            raw = self.chunks[0][:size]; self.chunks[0] = self.chunks[0][size:]
            if not self.chunks[0]: self.chunks.pop(0)
            return raw
        def send(self, raw):
            assert len(raw) <= m.QUEUE_LIMIT
            self.calls += 1
            if case == 'backpressure-cancel' and self is upstream: raise BlockingIOError()
            if self.calls % 3 == 1: raise BlockingIOError()
            size = min(7, len(raw)); self.sent.extend(raw[:size]); return size
    ingress_chunks = [m.REQUEST[:5], m.REQUEST[5:], b'opaque-client', b'']
    if case == 'partial-eof': ingress_chunks = [b'CON', b'']
    if case == 'deadline': ingress_chunks = []
    if case == 'byte-limit': ingress_chunks = [m.REQUEST] + [b'x' * 4096] * 260
    ingress = Endpoint(ingress_chunks, 1)
    upstream = Endpoint([b'opaque-upstream', b''] if case == 'normal' else [], 2)
    control = Endpoint([], 3)
    class Selector:
        def __init__(self): self.keys = {}
        def get_map(self): return self.keys
        def register(self, obj, events): self.keys[obj] = SimpleNamespace(fileobj=obj, events=events)
        def unregister(self, obj): del self.keys[obj]
        def select(self, timeout):
            tick[0] += 1
            return [(key, key.events) for key in list(self.keys.values())]
        def close(self): pass
    clock = lambda: tick[0] * (0.1 if case == 'deadline' else 0.00001)
    with patch.object(m.selectors, 'DefaultSelector', Selector), patch.object(m.time, 'monotonic', side_effect=clock):
        broker = m.OfflineSession(ingress, upstream, control, m._SESSION_TOKEN)
        report = broker.run()
    assert report['brokerDescriptorsClosed'] and broker.cleanup_known
    assert all(endpoint.fileno() == -1 and not endpoint.inheritable for endpoint in (ingress, upstream, control))
    if case == 'normal':
        assert report['reason'] == 'EOF'
        assert ingress.sent == m.RESPONSE + b'opaque-upstream'
        assert upstream.sent == b'opaque-client'
        assert ingress.shutdowns == upstream.shutdowns == [socket.SHUT_WR]
    if case == 'partial-eof': assert report['reason'] == 'CONNECT_EOF'
    if case == 'backpressure-cancel': assert report['reason'] == 'CANCELLED'
    if case == 'deadline': assert report['reason'] == 'NEGOTIATION_DEADLINE'
    if case == 'byte-limit': assert report['reason'] == 'BYTE_LIMIT'


def test_unknown_cleanup_fence_prevents_next_socket_creation():
    with patch.object(m, '_UNCERTAIN_CLEANUP', True), patch.object(m.socket, 'socketpair') as factory:
        with pytest.raises(ValueError, match='PREVIOUS_BROKER_CLEANUP_UNKNOWN'): m.create_offline_session()
        factory.assert_not_called()


@pytest.mark.parametrize('close_fails', [False, True])
def test_selector_constructor_failure_closes_all_owned_fds_and_fences_unknown(close_fails):
    from unittest.mock import Mock
    endpoints = [Mock(fileno=Mock(return_value=-1)) for _ in range(3)]
    if close_fails:
        endpoints[0].close.side_effect = OSError('close failed')
        endpoints[0].fileno.return_value = 42
    with patch.object(m, '_UNCERTAIN_CLEANUP', False), patch.object(m.selectors, 'DefaultSelector', side_effect=OSError('selector unavailable')):
        broker = m.OfflineSession(*endpoints, m._SESSION_TOKEN)
        report = broker.run()
        assert report['reason'] == 'IO_OR_PROTOCOL_REFUSED'
        assert report['brokerDescriptorsClosed'] is (not close_fails)
        assert m._UNCERTAIN_CLEANUP is close_fails
        for endpoint in endpoints: endpoint.close.assert_called_once()
        if close_fails:
            with patch.object(m.socket, 'socketpair') as create:
                with pytest.raises(ValueError, match='PREVIOUS_BROKER_CLEANUP_UNKNOWN'): m.create_offline_session()
                create.assert_not_called()


@pytest.mark.parametrize('delay,reason', [(2.0, 'NEGOTIATION_DEADLINE'), (5.0, 'SESSION_DEADLINE')])
def test_delayed_selector_cannot_receive_or_forward_after_fixed_deadline(delay, reason):
    from unittest.mock import Mock
    from types import SimpleNamespace
    clock = [0.0]
    endpoints = [Mock(fileno=Mock(return_value=-1)) for _ in range(3)]
    class Selector:
        def __init__(self): self.keys = {}
        def get_map(self): return self.keys
        def register(self, obj, events): self.keys[obj] = SimpleNamespace(fileobj=obj, events=events)
        def unregister(self, obj): del self.keys[obj]
        def select(self, _timeout):
            clock[0] = delay
            return [(self.keys[endpoints[0]], m.selectors.EVENT_READ)]
        def close(self): pass
    with patch.object(m.selectors, 'DefaultSelector', Selector), patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
        report = m.OfflineSession(*endpoints, m._SESSION_TOKEN).run()
    assert report['reason'] == reason and not report['connectAccepted']
    assert report['brokerDescriptorsClosed']
    for endpoint in endpoints:
        endpoint.recv.assert_not_called(); endpoint.send.assert_not_called()
