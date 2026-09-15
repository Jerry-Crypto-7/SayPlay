"""Deterministic mocks only. No socket/network/CLI runtime credit."""
import importlib.util
import pathlib
from types import SimpleNamespace
import pytest

PATH = pathlib.Path(__file__).with_name('subscription-cli-proxy-refusal.py')


def module():
    spec = importlib.util.spec_from_file_location('refusal', PATH)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class Endpoint:
    def __init__(self, chunks=()):
        self.chunks = list(chunks); self.sent = bytearray(); self.closed = False
        self.close_fail = False; self.write_limit = None
    def setblocking(self, value): pass
    def set_inheritable(self, value): pass
    def getsockname(self): return ('127.0.0.1', 1234)
    def accept(self): return self.client, ('127.0.0.1', 5678)
    def recv(self, count):
        if not self.chunks: raise BlockingIOError()
        value = self.chunks.pop(0)
        if isinstance(value, Exception): raise value
        assert len(value) <= count
        return value
    def send(self, value):
        if self.write_limit == 0: raise BlockingIOError()
        count = min(len(value), self.write_limit or len(value))
        self.sent.extend(value[:count]); return count
    def close(self):
        if self.close_fail: raise OSError('failure')
        self.closed = True


class Selector:
    def __init__(self, batches, clock=None):
        self.batches = list(batches); self.closed = False; self.clock = clock
    def register(self, *args): pass
    def unregister(self, *args): pass
    def modify(self, *args): pass
    def select(self, timeout):
        if self.clock: self.clock()
        if not self.batches: raise ValueError('TEST_EXHAUSTED')
        return [(SimpleNamespace(fileobj=e), mask) for e, mask in self.batches.pop(0)]
    def close(self): self.closed = True


def setup(monkeypatch, chunks=None):
    m = module(); now = [0.0]
    monkeypatch.setattr(m.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(m, 'identity', lambda e: {'dev': 1, 'ino': 2, 'type': 49152})
    listener = Endpoint(); client = Endpoint([m.REQUEST] if chunks is None else chunks)
    listener.client = client
    session = m.RefusalSession(listener, {'address': ['127.0.0.1', 1234]}, 0, 2, m._TOKEN)
    return m, now, listener, client, session


def drive(monkeypatch, ctx, batches, clock=None, cancel=None, observer=None):
    m, now, listener, client, session = ctx
    selector = Selector(batches, clock)
    monkeypatch.setattr(m.selectors, 'DefaultSelector', lambda: selector)
    report = session.run(cancel, observer)
    assert listener.closed and selector.closed
    return report


def test_exact_stock_request_and_refusal():
    m = module()
    assert b'api.openai.com:443' in m.REQUEST
    assert b'fixture.invalid' not in m.REQUEST
    assert m.REFUSAL.startswith(b'HTTP/1.1 403 ') and b'200' not in m.REFUSAL
    assert m.fixed_prefix(m.REQUEST[:17], m.REQUEST[17:]) == m.REQUEST


@pytest.mark.parametrize('change', [
    lambda b: b.replace(b'api.openai.com', b'chatgpt.com'),
    lambda b: b.replace(b'Keep-Alive', b'keep-alive'),
    lambda b: b.replace(b'Host:', b'host:'),
    lambda b: b.replace(b'CONNECT', b'GET'),
    lambda b: b.replace(b':443', b':80'),
    lambda b: b.replace(b'\r\n\r\n', b'\r\nAuthorization: secret\r\n\r\n'),
    lambda b: b + b'\x16\x03',
])
def test_strict_variants(change):
    m = module()
    with pytest.raises(ValueError, match='CONNECT_REFUSED'):
        m.fixed_prefix(b'', change(m.REQUEST))


def test_fragmentation_partial_refusal_and_real_counts(monkeypatch):
    m = module(); ctx = setup(monkeypatch, [m.REQUEST[:20], m.REQUEST[20:]])
    _, _, l, c, s = ctx; c.write_limit = 11
    r = drive(monkeypatch, ctx, [[(l, 1)], [(c, 1)], [(c, 1)]] + [[(c, 2)]] * 6)
    assert r['success'] and bytes(c.sent) == m.REFUSAL and c.closed
    assert r['requestBytes'] == len(m.REQUEST) and r['requestRawComplete']
    assert r['refusalBytesWritten'] == len(m.REFUSAL)
    assert r['cliProvenanceValidated'] is False and r['tlsStarted'] is False


def test_early_data_no_refusal_and_no_raw_credential_retention(monkeypatch):
    ctx = setup(monkeypatch, [b'Authorization: secret'])
    _, _, l, c, _ = ctx
    r = drive(monkeypatch, ctx, [[(l, 1)], [(c, 1)]])
    assert r['reason'] == 'CONNECT_REFUSED' and not c.sent
    assert r['requestRawBase64'] is None and not r['requestRawComplete']
    assert r['requestBytes'] == len(b'Authorization: secret')


def test_early_tls_after_header_before_refusal(monkeypatch):
    m = module(); ctx = setup(monkeypatch, [m.REQUEST, b'x'])
    _, _, l, c, _ = ctx
    r = drive(monkeypatch, ctx, [[(l, 1)], [(c, 1)], [(c, 2)]])
    assert r['reason'] == 'CONNECT_REFUSED' and not c.sent


def test_constructor_failure_closes_and_fences(monkeypatch):
    m, _, l, _, s = setup(monkeypatch)
    l.close_fail = True
    monkeypatch.setattr(m.selectors, 'DefaultSelector', lambda: (_ for _ in ()).throw(OSError()))
    r = s.run()
    assert not r['cleanupKnown'] and m._cleanup_unknown
    with pytest.raises(ValueError, match='PRIOR_CLEANUP_UNKNOWN'):
        m.create_refusal_session(10)


def test_delayed_select_before_accept(monkeypatch):
    ctx = setup(monkeypatch); _, now, l, c, _ = ctx
    r = drive(monkeypatch, ctx, [[(l, 1)]], lambda: now.__setitem__(0, 2))
    assert r['reason'] == 'NEGOTIATION_DEADLINE' and r['accepted'] is None
    assert not c.closed  # Never adopted by the session.


def test_deadline_after_actual_write_not_success(monkeypatch):
    ctx = setup(monkeypatch); _, now, l, c, _ = ctx
    send = c.send
    def delayed(value):
        count = send(value); now[0] = 2; return count
    c.send = delayed
    r = drive(monkeypatch, ctx, [[(l, 1)], [(c, 1)], [(c, 2)]])
    assert r['reason'] == 'NEGOTIATION_DEADLINE' and not r['success']
    assert r['refusalBytesWritten'] == len(ctx[0].REFUSAL)


@pytest.mark.parametrize('chunks,reason', [([b''], 'CLIENT_EOF'), ([OSError()], 'LOCAL_IO_FAILURE')])
def test_read_failures(monkeypatch, chunks, reason):
    ctx = setup(monkeypatch, chunks); _, _, l, c, _ = ctx
    r = drive(monkeypatch, ctx, [[(l, 1)], [(c, 1)]])
    assert r['reason'] == reason and c.closed


def test_backpressure_cancel_and_idempotent_close(monkeypatch):
    ctx = setup(monkeypatch); _, _, l, c, s = ctx; c.write_limit = 0
    calls = [0]
    cancel = SimpleNamespace(is_set=lambda: calls[0] >= 4)
    def tick(): calls[0] += 1
    r = drive(monkeypatch, ctx, [[(l, 1)], [(c, 1)], [(c, 2)], []], tick, cancel)
    assert r['reason'] == 'CANCELLED' and not c.sent and c.closed
    assert s.close() is True
    with pytest.raises(ValueError, match='SESSION_UNAVAILABLE'): s.run()


@pytest.mark.parametrize('deadline', [True, None, float('nan'), float('inf'), -1])
def test_bad_parent_deadline_no_socket(monkeypatch, deadline):
    m = module()
    monkeypatch.setattr(m.socket, 'socket', lambda *a: pytest.fail('must not create socket'))
    with pytest.raises(ValueError, match='PARENT_DEADLINE'): m.create_refusal_session(deadline)


def test_factory_setup_failure_closes_owned_partial_socket(monkeypatch):
    m = module(); endpoint = Endpoint()
    endpoint.bind = lambda address: (_ for _ in ()).throw(OSError())
    monkeypatch.setattr(m.socket, 'socket', lambda *a: endpoint)
    with pytest.raises(OSError): m.create_refusal_session(m.time.monotonic() + 1)
    assert endpoint.closed


def test_observer_order_copy_and_no_provenance_credit(monkeypatch):
    ctx = setup(monkeypatch); _, _, l, c, _ = ctx
    calls = []
    def observer(phase, observation):
        calls.append((phase, len(c.sent), len(c.chunks)))
        observation['peer'][1] = 999
        return {'ownPinnedPid': 42, 'scope': 'mock-only'}
    r = drive(monkeypatch, ctx, [[(l, 1)], [(c, 1)], [(c, 2)]], observer=observer)
    assert r['success'] and r['cliProvenanceValidated'] is False
    assert calls == [('accepted-before-read', 0, 1), ('header-complete-before-refusal', 0, 0)]
    assert r['accepted']['peer'][1] == 5678 and len(r['provenanceObservations']) == 2


@pytest.mark.parametrize('record', [True, None, [], {'padding': 'x' * 16384}])
def test_bad_observer_record_refuses_before_read(monkeypatch, record):
    ctx = setup(monkeypatch); _, _, l, c, _ = ctx
    r = drive(monkeypatch, ctx, [[(l, 1)]], observer=lambda *a: record)
    assert r['reason'] == 'OBSERVER_RECORD' and not c.sent and c.chunks
    assert r['cleanupKnown'] and not r['success']


def test_observer_time_exhaustion_refuses_before_read(monkeypatch):
    ctx = setup(monkeypatch); _, now, l, c, _ = ctx
    def observer(*args): now[0] = 2; return {'sample': 1}
    r = drive(monkeypatch, ctx, [[(l, 1)]], observer=observer)
    assert r['reason'] == 'NEGOTIATION_DEADLINE' and c.chunks and not c.sent


def test_first_listener_close_failure_stays_unknown_after_noop_retry(monkeypatch):
    ctx = setup(monkeypatch); m, _, l, c, s = ctx
    calls = []
    def close():
        calls.append(1)
        l.closed = True
        if len(calls) == 1:
            raise OSError('first close lost certainty')
    l.close = close
    r = drive(monkeypatch, ctx, [[(l, 1)]])
    assert len(calls) == 2 and c.closed
    assert r['reason'] == 'LOCAL_IO_FAILURE' and not r['cleanupKnown']
    assert s.close() is False and m._cleanup_unknown
    with pytest.raises(ValueError, match='PRIOR_CLEANUP_UNKNOWN'):
        m.create_refusal_session(10)
