"""Offline measurement validator/fence tests; no socket creation."""
import copy
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import pytest

spec = importlib.util.spec_from_file_location('fixed_egress_measure_test', Path(__file__).with_name('subscription-trusted-egress-proxy.measure.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def fixture(name):
    reasons = {'normal': 'EOF', 'cancel': 'CANCELLED', 'bad-control': 'CONTROL_REFUSED',
        'control-eof': 'CANCELLED', 'negotiation-deadline': 'NEGOTIATION_DEADLINE', 'backpressure-cancel': 'CANCELLED'}
    return {'scenario': name, 'error': None, 'threadClosed': True, 'peersClosed': True,
        'broker': {'reason': reasons[name], 'brokerDescriptorsClosed': True, 'productionReady': False,
            'externalNetworkCalls': 0, 'modelCalls': 0, 'elapsedMs': 2001 if name == 'negotiation-deadline' else 12,
            'connectAccepted': name in ('normal', 'backpressure-cancel')},
        'payloadChecks': {'forward': hashlib.sha256(m.PAYLOAD).hexdigest(), 'reverse': hashlib.sha256(m.PAYLOAD[::-1]).hexdigest(), 'halfCloseEOF': True},
        'sendWouldBlock': True, 'acceptedPayloadBytes': 4096}


@pytest.mark.parametrize('name', m.SCENARIOS)
def test_fixed_scenario_validation(name):
    assert m.validate_case(fixture(name))


@pytest.mark.parametrize('case', ['cancel-not-eof', 'thread', 'fd', 'peer', 'hash', 'deadline-short', 'deadline-bool', 'pressure', 'error'])
def test_does_not_grant_credit_to_unknown_or_wrong_outcome(case):
    record = fixture('normal')
    if case == 'cancel-not-eof': record['broker']['reason'] = 'CANCELLED'
    if case == 'thread': record['threadClosed'] = False
    if case == 'fd': record['broker']['brokerDescriptorsClosed'] = False
    if case == 'peer': record['peersClosed'] = False
    if case == 'hash': record['payloadChecks']['forward'] = '0'*64
    if case == 'deadline-short': record = fixture('negotiation-deadline'); record['broker']['elapsedMs'] = 1999
    if case == 'deadline-bool': record['broker']['elapsedMs'] = True
    if case == 'pressure': record = fixture('backpressure-cancel'); record['sendWouldBlock'] = False
    if case == 'error': record['error'] = 'TimeoutError'
    assert not m.validate_case(record)


def test_failure_fences_all_later_cases_and_preserves_source_receipt():
    source = {m.MODULE.name: 'a'*64, m.SELF.name: 'b'*64}
    first = fixture('normal'); first.update(passed=False, threadClosed=False)
    with patch.object(m, 'hashes', return_value=source), patch.object(m, 'frozen_module', return_value=(object(), 'a'*64)), \
         patch.object(m, 'run_case', return_value=first) as run_case:
        report = m.run()
    assert not report['passed'] and len(report['cases']) == 1
    run_case.assert_called_once()
    assert report['sourceBefore'] == report['sourceAfter'] == source


def test_source_drift_and_nonliteral_cli_refused_without_dispatch():
    with patch.object(m, 'hashes', return_value={m.MODULE.name: 'a'*64}), patch.object(m, 'frozen_module', return_value=(object(), 'b'*64)), patch.object(m, 'run_case') as case:
        with pytest.raises(ValueError, match='SOURCE_CHANGED'): m.run()
        case.assert_not_called()
    with patch.object(m.sys, 'argv', ['measure', '--target']), patch.object(m, 'run') as run:
        with pytest.raises(ValueError): m.main()
        run.assert_not_called()


@pytest.mark.parametrize('failure', ['timeout', 'sockopt', 'thread-constructor', 'thread-start', 'unknown-close'])
def test_setup_failure_closes_every_owned_endpoint_without_starting_next_session(failure):
    endpoints = []
    for _ in range(6):
        endpoint = Mock()
        endpoint.closed = False
        endpoint.close.side_effect = lambda e=endpoint: setattr(e, 'closed', True)
        endpoint.fileno.side_effect = lambda e=endpoint: -1 if e.closed else 42
        endpoints.append(endpoint)
    broker = SimpleNamespace(_sockets=tuple(endpoints[:3]), cleanup_known=False)
    module = SimpleNamespace(create_offline_session=Mock(return_value=(broker, *endpoints[3:])), SESSION_SECONDS=5, _UNCERTAIN_CLEANUP=False)
    thread = Mock(is_alive=Mock(return_value=False))
    if failure == 'timeout': endpoints[3].settimeout.side_effect = OSError('timeout setup')
    if failure == 'sockopt': endpoints[1].setsockopt.side_effect = OSError('buffer setup')
    if failure in ('thread-start', 'unknown-close'): thread.start.side_effect = RuntimeError('thread start')
    if failure == 'unknown-close': endpoints[0].close.side_effect = OSError('close failed')
    constructor = RuntimeError('thread constructor') if failure == 'thread-constructor' else None
    with patch.object(m.threading, 'Thread', return_value=thread, side_effect=constructor):
        result = m.run_case(module, 'backpressure-cancel', m.time.monotonic() + 20)
    assert result['passed'] is False and result['error'] is not None
    assert result['threadStarted'] is False and result['threadClosed'] is True
    assert result['setupBrokerDescriptorsClosed'] is (failure != 'unknown-close')
    assert module._UNCERTAIN_CLEANUP is (failure == 'unknown-close')
    for endpoint in endpoints: endpoint.close.assert_called_once()
    thread.join.assert_not_called()
