import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import pytest


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


m = load('subscription-trusted-ingress-child')
probe_fixture = load('subscription-trusted-ingress-worker-probe.test')
old_fixture = load('subscription-trusted-control-boundary-parent.test')


def ingress():
    return {'fd': 198, 'nonce': 'a' * 32, 'socket': {'dev': 99, 'ino': 999, 'type': 0o140000, 'family': 1, 'socketType': 1}}


def dependencies():
    return (load('subscription-trusted-control-boundary-parent'), load('subscription-exec-server-worker-gate'),
        load('subscription-appserver-noenv'), load('subscription-trusted-ingress-worker-probe'),
        lambda: load('subscription-trusted-control-boundary-probe'))


class Channel:
    def __init__(self, incoming): self.incoming, self.sent, self.closed, self.shutdowns = bytearray(incoming), bytearray(), False, []
    def settimeout(self, value): assert 0 < value <= 5
    def send(self, raw): self.sent.extend(raw[:3]); return min(3, len(raw))
    def recv(self, count):
        raw = bytes(self.incoming[:min(count, 4)]); del self.incoming[:len(raw)]; return raw
    def shutdown(self, how): self.shutdowns.append(how)
    def close(self): self.closed = True


def incoming():
    return m.RESPONSE + b'ACK BEFORE ' + b'a' * 32 + b'\nACK AFTER ' + b'a' * 32 + b'\n'


def test_bounded_partial_io_route_and_eof_are_actual_accounted(monkeypatch):
    monkeypatch.setattr(m, 'inspect_socket', lambda channel: ingress()['socket'])
    monkeypatch.setattr(m.time, 'monotonic', lambda: 1.0)
    channel = Channel(incoming())
    route = m.Route(channel, ingress(), SimpleNamespace(began=0, require_remaining=lambda: 29))
    route.observe('BEFORE'); route.observe('AFTER')
    assert m.validate_route(route.report(), ingress())
    assert channel.sent == m.REQUEST + b'BEFORE ' + b'a' * 32 + b'\nAFTER ' + b'a' * 32 + b'\n'
    assert channel.closed and route.eof and channel.shutdowns == [m.socket.SHUT_WR]


@pytest.mark.parametrize('case', ['wrong-ack', 'early-eof', 'trailing', 'deadline', 'identity'])
def test_route_failure_retains_known_partial_bytes_and_no_success(case, monkeypatch):
    clock = [1.0]
    monkeypatch.setattr(m.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(m, 'inspect_socket', lambda channel: ingress()['socket'])
    data = incoming()
    if case == 'wrong-ack': data = m.RESPONSE + b'BAD!'
    if case == 'early-eof': data = m.RESPONSE[:5]
    if case == 'trailing': data += b'x'
    channel = Channel(data)
    route = m.Route(channel, ingress(), SimpleNamespace(began=0, require_remaining=lambda: 29))
    with pytest.raises(ValueError):
        route.observe('BEFORE')
        if case == 'deadline': clock[0] = 6.0
        if case == 'identity': monkeypatch.setattr(m, 'inspect_socket', lambda channel: {**ingress()['socket'], 'ino': 1000})
        route.observe('AFTER')
    route.close()
    assert route.error and not m.validate_route(route.report(), ingress())
    assert route.steps and sum(step['bytes'] for step in route.steps) > 0


def complete_report():
    parent, gate, policy, ingress_probe, base_loader = dependencies()
    gate_view, proxy = m.adapt(parent, gate, policy, ingress_probe, base_loader, ingress())
    body = old_fixture.complete_report()
    marker = probe_fixture.marker(); raw_marker = json.dumps(marker).encode()
    body['marker'].update(path=m.MARKER_PATH, value=marker, bytes=len(raw_marker), rawHex=raw_marker.hex(), sha256=hashlib.sha256(raw_marker).hexdigest())
    body['startupPacket']['value']['ingress'] = ingress()
    raw_packet = json.dumps(body['startupPacket']['value']).encode() + b'\n'
    body['startupPacket'].update(bytes=len(raw_packet), rawHex=raw_packet.hex(), sha256=hashlib.sha256(raw_packet).hexdigest())
    for field in ('beforeWorker', 'afterWorker'):
        body[field]['marker'] = {'file': body['marker']['file'], 'sha256': body['marker']['sha256']}
    worker = parent.WorkerProtocol(gate_view, proxy, marker)
    old_fixture.drain(worker)
    worker.receive({'id': 1, 'result': {'sessionId': 'ingress-session'}})
    old_fixture.drain(worker)
    worker.receive({'id': 2, 'result': {'processId': 'fixed-worker'}})
    old_fixture.drain(worker)
    raw_probe = json.dumps(probe_fixture.report()).encode() + b'\n'
    worker.receive(old_fixture.read_reply(3, [old_fixture.chunk(1, raw_probe)], 2, closed=True))
    body['sessions']['executor'] = old_fixture.session_report(worker, 8, m.GATE_ARGV)
    hashes = dict.fromkeys(m.HELPERS, 'a' * 64); hashes['subscription-text-model-catalog.json'] = parent.CATALOG_SHA256
    body.update(helperSha256Before=dict(hashes), helperSha256After=dict(hashes))
    steps = []
    for phase, sent, received in [('CONNECT', m.REQUEST, m.RESPONSE),
        ('BEFORE', b'BEFORE ' + b'a' * 32 + b'\n', b'ACK BEFORE ' + b'a' * 32 + b'\n'),
        ('AFTER', b'AFTER ' + b'a' * 32 + b'\n', b'ACK AFTER ' + b'a' * 32 + b'\n')]:
        for direction, raw in [('sent', sent), ('received', received)]:
            steps.append({'phase': phase, 'direction': direction, 'bytes': len(raw), 'rawHex': raw.hex(), 'sha256': hashlib.sha256(raw).hexdigest()})
    steps.append({'phase': 'EOF', 'direction': 'received', 'bytes': 0, 'rawHex': '', 'sha256': hashlib.sha256(b'').hexdigest()})
    route = {'fd': 198, 'expected': ingress(), 'steps': steps, 'observations': [
        {'phase': 'BEFORE', 'socket': ingress()['socket'], 'cloexec': True, 'elapsedMs': 110},
        {'phase': 'AFTER', 'socket': ingress()['socket'], 'cloexec': True, 'elapsedMs': 410}],
        'eofObserved': True, 'closed': True, 'error': None, 'brokerElapsedMs': 350}
    return {'version': 1, 'profile': 'fixed-trusted-ingress-child', 'success': True, 'error': None,
        'parentReport': body, 'route': route, 'helperSha256Before': hashes, 'helperSha256After': dict(hashes)}


def test_full_replay_binds_actual_five_field_packet_and_external_socket_nonce():
    report = complete_report()
    assert m.validate_report(report, dependencies(), old_fixture.ready(), ingress())
    foreign = ingress(); foreign['nonce'] = 'b' * 32
    assert not m.validate_report(report, dependencies(), old_fixture.ready(), foreign)
    assert len(report['parentReport']['startupPacket']['value']) == 5
    assert not old_fixture.m.validate_report(report['parentReport'], old_fixture.policy, old_fixture.gate, old_fixture.probe, old_fixture.ready())


@pytest.mark.parametrize('case', ['nonce', 'socket', 'cloexec', 'missing-eof', 'route-time', 'after-cleanup', 'helper', 'raw-packet'])
def test_full_replay_rejects_route_or_source_tampering(case):
    report = complete_report()
    if case == 'nonce': report['route']['expected']['nonce'] = 'b' * 32
    if case == 'socket': report['route']['observations'][1]['socket']['ino'] += 1
    if case == 'cloexec': report['route']['observations'][0]['cloexec'] = False
    if case == 'missing-eof': report['route']['eofObserved'] = False
    if case == 'route-time': report['route']['brokerElapsedMs'] = 5000
    if case == 'after-cleanup': report['route']['observations'][1]['elapsedMs'] = 501
    if case == 'helper': report['helperSha256After'][next(iter(m.HELPERS))] = 'b' * 64
    if case == 'raw-packet': report['parentReport']['startupPacket']['rawHex'] = '7b7d'
    assert not m.validate_report(report, dependencies(), old_fixture.ready(), ingress())


def test_after_callback_checks_fresh_work_deadline_without_rewriting_prior_observation(monkeypatch):
    parent, gate, policy, probe, base_loader = dependencies()
    clock = [21.9]
    original = {'elapsedMs': 21900, 'identity': 'actual-before-exchange'}
    monkeypatch.setattr(parent, 'trusted_observation', lambda *_args: original)
    monkeypatch.setattr(m.time, 'monotonic', lambda: clock[0])
    def delayed(_phase): clock[0] = 22.001
    route = SimpleNamespace(observations=[{}], observe=delayed)
    m.adapt(parent, gate, policy, probe, base_loader, ingress(), route)
    with pytest.raises(ValueError, match='POST_ROUTE_WORK_DEADLINE'):
        parent.trusted_observation(SimpleNamespace(poll=lambda: None), {}, SimpleNamespace(began=0))
    assert original['elapsedMs'] == 21900


@pytest.mark.parametrize('delay', ['hash', 'validation'])
def test_main_seals_true_final_elapsed_and_fails_after_shared_deadline(delay, monkeypatch, capsys):
    fixture = complete_report()
    parent, gate, policy, probe, base_loader = dependencies()
    clock = [0.0]; calls = []
    monkeypatch.setattr(m.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(m.sys, 'platform', 'linux')
    monkeypatch.setattr(m.sys, 'argv', ['fixed'])
    monkeypatch.setattr(m.os, 'set_inheritable', lambda fd, value: calls.append(('cloexec', fd, value)))
    monkeypatch.setattr(m, 'inspect_socket', lambda channel: ingress()['socket'])
    monkeypatch.setattr(m.socket, 'socket', lambda **_kwargs: Channel(b''))
    monkeypatch.setattr(m.os, 'ST_RDONLY', 1, raising=False)
    monkeypatch.setattr(m.os, 'statvfs', lambda path: SimpleNamespace(f_flag=1), raising=False)
    hashes_count = [0]
    def hashes():
        calls.append(('hash',))
        hashes_count[0] += 1
        if delay == 'hash' and hashes_count[0] == 2: clock[0] = 30.001
        return dict(fixture['helperSha256Before'])
    monkeypatch.setattr(m, 'hashes', hashes)
    monkeypatch.setattr(parent, 'read_startup_packet', lambda *_args: copy.deepcopy(fixture['parentReport']['startupPacket']))
    monkeypatch.setattr(parent, 'run_parent', lambda *_args: copy.deepcopy(fixture['parentReport']))
    modules = {'subscription-trusted-control-boundary-parent.py': parent, 'subscription-exec-server-worker-gate.py': gate,
        'subscription-appserver-noenv.py': policy, 'subscription-trusted-ingress-worker-probe.py': probe,
        'subscription-trusted-control-boundary-probe.py': base_loader()}
    monkeypatch.setattr(m, 'load_fixed', lambda name: modules[name])
    def validate(*_args):
        if delay == 'validation': clock[0] = 30.001
        return True
    monkeypatch.setattr(m, 'validate_report', validate)
    assert m.main() == 1
    report = json.loads(capsys.readouterr().out)
    assert report['error'] == 'INGRESS_FINAL_SHARED_DEADLINE'
    assert report['parentReport']['elapsedMs'] == 30.001 * 1000
    assert calls[0] == ('cloexec', 198, False)


@pytest.mark.parametrize('case', ['valid', 'regular', 'wrong-fd', 'listener', 'not-connected', 'inheritable', 'wrong-family'])
def test_socket_admission_is_metadata_only_before_payload(case, monkeypatch):
    monkeypatch.setattr(m.socket, 'AF_UNIX', 1, raising=False)
    monkeypatch.setattr(m.socket, 'SO_ACCEPTCONN', 30, raising=False)
    monkeypatch.setattr(m.os, 'get_inheritable', lambda fd: case == 'inheritable')
    monkeypatch.setattr(m.os, 'fstat', lambda fd: SimpleNamespace(st_dev=99, st_ino=999, st_mode=0o100000 if case == 'regular' else 0o140000))
    class MetadataSocket:
        family = 2 if case == 'wrong-family' else 1
        def fileno(self): return 197 if case == 'wrong-fd' else 198
        def getsockopt(self, level, option):
            return (1 if case == 'listener' else 0) if option == m.socket.SO_ACCEPTCONN else m.socket.SOCK_STREAM
        def getpeername(self):
            if case == 'not-connected': raise OSError('not connected')
            return ''
        def send(self, _raw): pytest.fail('no payload during admission')
    if case == 'valid': assert m.inspect_socket(MetadataSocket()) == ingress()['socket']
    else:
        with pytest.raises((ValueError, OSError)): m.inspect_socket(MetadataSocket())


def test_repeated_pure_validation_with_same_private_dependencies_stays_deterministic():
    deps = dependencies(); report = complete_report()
    assert m.validate_report(report, deps, old_fixture.ready(), ingress())
    assert m.validate_report(report, deps, old_fixture.ready(), ingress())


@pytest.mark.parametrize('now,total,expected', [(21.9, 8.1, 0.1), (18.0, 0.05, 0.05), (18.0, 12, 4.0)])
def test_socket_timeout_cannot_consume_work_or_shared_cleanup_reserve(now, total, expected, monkeypatch):
    route = object.__new__(m.Route)
    captured = []
    route.channel = SimpleNamespace(settimeout=captured.append)
    route.budget = SimpleNamespace(began=0, require_remaining=lambda: total)
    route.began = 17.0
    monkeypatch.setattr(m.time, 'monotonic', lambda: now)
    route.timeout()
    assert captured == [pytest.approx(expected)]
