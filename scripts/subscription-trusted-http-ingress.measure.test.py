"""Offline authored replay and lifecycle checks; no local/external sockets."""
import copy
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import pytest

spec = importlib.util.spec_from_file_location('http_measure_tests', Path(__file__).with_name('subscription-trusted-http-ingress.measure.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
core = m.load_core(m.hashes())


def fixture(name='fragmented-halfclose'):
    ownership = {'address': ['127.0.0.1', 42000], 'expectedClient': ['127.0.0.1', 42001], 'networkNamespace': 'net:[123]',
        'listener': {'dev': 1, 'ino': 1, 'type': 49152}, 'ingress': {'dev': 1, 'ino': 2, 'type': 49152}, 'accepted': {'dev': 1, 'ino': 3, 'type': 49152}}
    data = {'clientSent': core.REQUEST + m.CLIENT_OPAQUE, 'ingressReceived': core.REQUEST + m.CLIENT_OPAQUE,
        'ingressSent': core.RESPONSE + m.PEER_OPAQUE, 'clientReceived': core.RESPONSE + m.PEER_OPAQUE, 'controlSent': b''}
    report = {'reason': 'EOF', 'state': 'RELAY', 'success': True, 'productionReady': False, 'modelCalls': 0, 'credentialFilesRead': 0,
        'profile': 'authored-connect', 'normalizedHeaderBytes': 0,
        'ownership': ownership, 'elapsedMs': 100, 'cleanup': {'closed': [True] * 5, 'known': True, 'processCleanup': 'NOT_ATTESTED'},
        'retainedBytes': {'client': 0, 'ingress': 0}, 'handshakeRetainedBytes': {'request': 0, 'response': 0}}
    if name == 'normalization-halfclose':
        data['clientSent'] = core.PINNED_WSS_REQUEST + m.CLIENT_OPAQUE
        report.update(profile='pinned-wss-shaped-fixture', normalizedHeaderBytes=30)
    if name not in ('fragmented-halfclose', 'normalization-halfclose'): report['success'] = False
    if name == 'wrong-request':
        data = {key: b'' for key in data}; data['clientSent'] = core.REQUEST.replace(b'fixture.invalid:443', b'wrong.invalid:443')
        report['reason'] = 'HANDSHAKE_REFUSED'
    if name == 'malformed-response':
        data.update(clientSent=core.REQUEST, ingressReceived=core.REQUEST, ingressSent=b'HTTP/1.1 403 Forbidden\r\n\r\n', clientReceived=b'')
        report['reason'] = 'HANDSHAKE_REFUSED'
    if name == 'cancel-backpressure':
        data.update(clientSent=core.REQUEST + m.BURST, ingressReceived=core.REQUEST, ingressSent=core.RESPONSE, clientReceived=core.RESPONSE, controlSent=b'C')
        report.update(reason='CANCELLED', retainedBytes={'client': 0, 'ingress': 65536})
    if name == 'negotiation-deadline':
        data = {key: b'' for key in data}; report.update(reason='NEGOTIATION_DEADLINE', elapsedMs=2001)
    report['observedBytes'] = {'client': len(data['clientSent']), 'ingress': len(data['ingressSent'])}
    report['deliveredBytes'] = {'client': len(data['clientReceived']), 'ingress': len(data['ingressReceived'])}
    return {'scenario': name, 'adapter': report, 'captured': {'ownership': copy.deepcopy(ownership), 'clientEOF': True, 'ingressEOF': True},
        'raw': {key: {'hex': raw.hex(), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} for key, raw in data.items()},
        'errors': [], 'cleanup': {'before': {}, 'after': {}, 'threadClosed': True, 'peersClosed': True, 'verified': True}}


@pytest.mark.parametrize('name', m.SCENARIOS)
def test_fixed_scenario_replay(name): assert m.validate_scenario(fixture(name), core)


@pytest.mark.parametrize('case', ['unknown-cleanup', 'thread', 'leak', 'identity', 'alias', 'uid-bool', 'raw-hash', 'false-eof',
    'fake200', 'wrong-forward', 'no-pressure', 'early-timeout', 'model', 'process-credit', 'counter-bool', 'partial-cleanup', 'missing-handshake-count'])
def test_incomplete_or_fabricated_evidence_rejected(case):
    name = {'fake200': 'malformed-response', 'wrong-forward': 'wrong-request', 'no-pressure': 'cancel-backpressure', 'early-timeout': 'negotiation-deadline'}.get(case, m.SCENARIOS[0])
    value = fixture(name); report = value['adapter']
    if case == 'unknown-cleanup': report['cleanup']['known'] = False
    if case == 'thread': value['cleanup']['threadClosed'] = False
    if case == 'leak': value['cleanup']['after']['42'] = [1, 2, 3]
    if case == 'identity': report['ownership']['address'][0] = '0.0.0.0'
    if case == 'alias': report['ownership']['accepted'] = report['ownership']['ingress']
    if case == 'uid-bool': report['ownership']['expectedClient'][1] = True
    if case == 'raw-hash': value['raw']['clientReceived']['sha256'] = '0' * 64
    if case == 'false-eof': value['captured']['ingressEOF'] = False
    if case == 'fake200': report['deliveredBytes']['client'] = 39
    if case == 'wrong-forward': report['deliveredBytes']['ingress'] = 1
    if case == 'no-pressure': report['retainedBytes']['ingress'] = 0
    if case == 'early-timeout': report['elapsedMs'] = 1999
    if case == 'model': report['modelCalls'] = 1
    if case == 'process-credit': report['cleanup']['processCleanup'] = 'CONFIRMED'
    if case == 'counter-bool': report['observedBytes']['client'] = True
    if case == 'partial-cleanup': report['cleanup']['closed'] = []
    if case == 'missing-handshake-count': report.pop('handshakeRetainedBytes')
    assert not m.validate_scenario(value, core)


def test_failure_stops_next_factory_attempt():
    failure = {'passed': False, 'cleanup': {'verified': False}}
    with patch.object(m, 'run_scenario', return_value=failure) as run:
        assert m.execute(core) == [failure]; run.assert_called_once()


def test_thread_start_failure_closes_session_and_caller_peers():
    peers = [Mock(fileno=Mock(return_value=-1)) for _ in range(3)]
    session = SimpleNamespace(began=0, ownership={}, close=Mock())
    fake = SimpleNamespace(create_offline_session=Mock(return_value=(session, *peers)), SESSION_SECONDS=5, REQUEST=core.REQUEST)
    thread = Mock(start=Mock(side_effect=RuntimeError('setup')), is_alive=Mock(return_value=False))
    with patch.object(m, 'fd_inventory', return_value={}), patch.object(m.threading, 'Thread', return_value=thread):
        result = m.run_scenario(fake, 'negotiation-deadline')
    assert not result['passed'] and result['errors']
    session.close.assert_called_once()
    for peer in peers: peer.close.assert_called_once()


def test_source_drift_rejected_before_import():
    before = m.hashes(); before[m.CORE] = '0' * 64
    with patch.object(m.importlib.util, 'module_from_spec') as imported:
        with pytest.raises(ValueError): m.load_core(before)
        imported.assert_not_called()


def test_no_runtime_for_caller_arguments():
    with patch.object(m.sys, 'argv', ['measure', '--caller']), patch.object(m, 'hashes') as hashes:
        with pytest.raises(ValueError): m.main()
        hashes.assert_not_called()


@pytest.mark.parametrize('case', ['profile', 'missing-count', 'bool-count', 'wrong-count', 'conservation', 'raw67', 'broker97'])
def test_normalization_is_explicit_and_preserves_actual_separate_bytes(case):
    value = fixture('normalization-halfclose'); report = value['adapter']
    if case == 'profile': report['profile'] = 'authored-connect'
    if case == 'missing-count': report.pop('normalizedHeaderBytes')
    if case == 'bool-count': report['normalizedHeaderBytes'] = True
    if case == 'wrong-count': report['normalizedHeaderBytes'] = 29
    if case == 'conservation': report['deliveredBytes']['ingress'] = report['observedBytes']['client']
    if case in ('raw67', 'broker97'):
        key = 'clientSent' if case == 'raw67' else 'ingressReceived'
        raw = (core.REQUEST if case == 'raw67' else core.PINNED_WSS_REQUEST) + m.CLIENT_OPAQUE
        value['raw'][key] = {'hex': raw.hex(), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    assert not m.validate_scenario(value, core)
