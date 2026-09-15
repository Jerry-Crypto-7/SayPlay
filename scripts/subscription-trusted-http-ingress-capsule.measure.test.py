"""Offline HTTP outer admission; actual child replay remains independently required."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import pytest


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


m = load('http_capsule_measure', 'subscription-trusted-http-ingress-capsule.measure.py')
old = load('http_capsule_outer_fixture', 'subscription-trusted-ingress.measure.test.py')
child_fixture = load('http_capsule_child_fixture', 'subscription-trusted-http-ingress-child.test.py')


def outer_fixture():
    report = old.report_fixture()
    before = m.load_driver().source_hashes(); base = m.load_base(before)
    owner, ready = report['frames'][:2]
    owner['sourceSha256'] = base.expected_hashes(before, base.LAUNCHER_SOURCES)
    ready['trustedIngressBoundary'] = {'helperSha256': base.expected_hashes(before, base.HELPERS)}
    ready['trustedHttpIngressBoundary'] = {'helperSha256': base.expected_hashes(before, (*base.HELPERS, *m.HTTP_HELPERS))}
    ready['trustedHttpLoopback'] = {'interface': 'lo', 'namespace': 'net:[123]', 'ownerUserNamespace': 'user:[789]', 'beforeFlags': 8, 'afterFlags': 73}
    report['frames'][2]['mode'] = m.SCENARIO; report['terminal']['mode'] = m.SCENARIO
    report['frames'][-1].update(sourceBefore=dict(owner['sourceSha256']), sourceAfter=dict(owner['sourceSha256']))
    report.update(sourceSha256Before=before, sourceSha256After=dict(before), scenario=m.SCENARIO, command=list(m.COMMAND))
    return report


def complete_report():
    report = outer_fixture(); owner, ready = report['frames'][:2]
    ingress = child_fixture.ingress(); owner.update(ingress)
    ready['trustedIngressFd']['socket'] = copy.deepcopy(ingress['socket'])
    ready['workerBoundary'] = child_fixture.ready()
    report['frames'][-1].update(nonce=ingress['nonce'], socket=copy.deepcopy(ingress['socket']))
    body = child_fixture.complete_report()
    ready['trustedHttpLoopback']['namespace'] = body['parentReport']['marker']['value']['trustedHttpIngress']['networkNamespace']
    hashes = ready['trustedHttpIngressBoundary']['helperSha256']
    for item in (body, body['parentReport']): item.update(helperSha256Before=dict(hashes), helperSha256After=dict(hashes))
    raw = json.dumps(body).encode()
    report['frames'][3]['data'] = base64.b64encode(raw).decode()
    report['terminal'].update(outputBytes=len(raw), observedOutputSha256=hashlib.sha256(raw).hexdigest())
    return report


def test_complete_http_raw_replays_actual_parent_probe_gate_and_separate_outer_domains():
    report = complete_report()
    assert m.child_evaluation(report)
    assert m.evaluate(report)


@pytest.mark.parametrize('case', ['listener', 'normalization', 'old-profile', 'worker-raw', 'parent-cleanup', 'original-fd', 'packet-nonce'])
def test_full_child_negative_replay(case):
    report = complete_report(); body = json.loads(base64.b64decode(report['frames'][3]['data']))
    if case == 'listener': body['httpRoute']['observations'][1]['listening'] = False
    if case == 'normalization': body['httpRoute']['adapter']['normalizedHeaderBytes'] = 0
    if case == 'old-profile': body['profile'] = 'fixed-trusted-ingress-child'
    if case == 'worker-raw': body['parentReport']['sessions']['executor']['stdoutBase64'] = 'e30='
    if case == 'parent-cleanup': body['parentReport']['sessions']['executor']['reaped'] = False
    if case == 'original-fd': body['httpRoute']['originalFdClosed'] = False
    if case == 'packet-nonce': body['parentReport']['startupPacket']['value']['ingress']['nonce'] = 'b' * 32
    raw = json.dumps(body).encode(); report['frames'][3]['data'] = base64.b64encode(raw).decode()
    report['terminal'].update(outputBytes=len(raw), observedOutputSha256=hashlib.sha256(raw).hexdigest())
    assert not m.child_evaluation(report) and not m.evaluate(report)


def test_thirty_sources_nineteen_launcher_fourteen_start_and_real_old_boundary():
    report = outer_fixture(); owner, ready = report['frames'][:2]
    assert len(report['sourceSha256Before']) == 30 and len(owner['sourceSha256']) == 19
    request = m.start_request(ready, report['sourceSha256Before'], owner)
    assert request == {'type': 'start', 'mode': m.SCENARIO, 'nonce': owner['nonce'],
        'helperSha256': ready['trustedHttpIngressBoundary']['helperSha256']}
    assert len(request['helperSha256']) == 14 and len(ready['trustedIngressBoundary']['helperSha256']) == 10
    # An old valid raw child body is NOT a successful HTTP child.
    assert not m.child_evaluation(report) and not m.evaluate(report)


@pytest.mark.parametrize('case', ['new-missing', 'new-extra', 'new-drift', 'old-missing', 'binary', 'bwrap',
    'limit', 'network', 'fifo-alias', 'fifo-bool', 'namespace', 'socket', 'ownership-null', 'ownership-map'])
def test_admission_rejects_before_start(case):
    report = outer_fixture(); owner, ready = report['frames'][:2]
    if case == 'new-missing': ready.pop('trustedHttpIngressBoundary')
    if case == 'new-extra': ready['trustedHttpIngressBoundary']['extra'] = True
    if case == 'new-drift': ready['trustedHttpIngressBoundary']['helperSha256'][m.HTTP_HELPERS[0]] = '0' * 64
    if case == 'old-missing': ready.pop('trustedIngressBoundary')
    if case == 'binary': ready['binarySha256'] = '0' * 64
    if case == 'bwrap': ready['bwrapSha256'] = '0' * 64
    if case == 'limit': ready['limits']['maxOutputBytes'] += 1
    if case == 'network': ready['sandbox']['networkInterfaces'] = ['lo', 'eth0']
    if case == 'fifo-alias': ready['workerBoundary']['output'] = copy.deepcopy(ready['workerBoundary']['control'])
    if case == 'fifo-bool': ready['workerBoundary']['control']['ino'] = True
    if case == 'namespace': ready['workerBoundary']['namespace'] = 'pid:[0]'
    if case == 'socket': ready['trustedIngressFd']['socket'] = {**owner['socket'], 'ino': 900}
    if case == 'ownership-null': owner = None
    if case == 'ownership-map': owner['sourceSha256'].pop(m.HTTP_HELPERS[0])
    with pytest.raises(ValueError): m.start_request(ready, report['sourceSha256Before'], owner)


@pytest.mark.parametrize('case', ['owner-order', 'duplicate-owner', 'child-late', 'outer-early', 'unknown-frame',
    'nonce', 'broker-counter', 'wait', 'peers', 'thread', 'route', 'capsule', 'source', 'command'])
def test_outer_validation_independent_of_child_validator(case):
    report = outer_fixture(); outer = report['frames'][-1]
    if case == 'owner-order': report['frames'][0], report['frames'][1] = report['frames'][1], report['frames'][0]
    if case == 'duplicate-owner': report['frames'].insert(0, copy.deepcopy(report['frames'][0]))
    if case == 'child-late': report['frames'].insert(-1, copy.deepcopy(report['frames'][3]))
    if case == 'outer-early': report['frames'][-1], report['frames'][-2] = report['frames'][-2], report['frames'][-1]
    if case == 'unknown-frame': report['frames'].insert(-1, {'type': 'caller'})
    if case == 'nonce': outer['nonce'] = 'b' * 32
    if case == 'broker-counter': outer['broker']['observedBytes']['ingress'] += 30
    if case == 'wait': outer['capsuleWaitKnown'] = False
    if case == 'peers': outer['peersClosed'] = False
    if case == 'thread': outer['threadsClosed'] = False
    if case == 'route': outer['route']['beforeBytes'] = 39
    if case == 'capsule': report['terminal']['cleanup']['allObservedPidfdsESRCH'] = False
    if case == 'source': report['sourceSha256After'][m.LAUNCHER] = '0' * 64
    if case == 'command': report['command'].append('--caller')
    with patch.object(m, 'child_evaluation', return_value=True): assert not m.evaluate(report)


def test_no_arguments_before_loading():
    with patch.object(m.sys, 'argv', ['measure', '--caller']), patch.object(m, 'load_base') as loaded:
        with pytest.raises(ValueError): m.main()
        loaded.assert_not_called()


def test_base_source_drift_is_pre_import():
    with patch.object(m.importlib.util, 'module_from_spec') as loaded:
        with pytest.raises(ValueError): m.load_base({m.BASE: '0' * 64})
        loaded.assert_not_called()


@pytest.mark.parametrize('field,value', [('interface', 'eth0'), ('namespace', 'net:[0]'), ('namespace', 'user:[123]'),
    ('ownerUserNamespace', 'user:[0]'), ('ownerUserNamespace', 123), ('beforeFlags', True), ('beforeFlags', -1),
    ('beforeFlags', 65536), ('beforeFlags', 1), ('afterFlags', False), ('afterFlags', 65536), ('afterFlags', 8), ('afterFlags', 1)])
def test_loopback_receipt_strict_before_start(field, value):
    report = outer_fixture(); owner, ready = report['frames'][:2]
    ready['trustedHttpLoopback'][field] = value
    with pytest.raises(ValueError, match='LOOPBACK_ADMISSION'):
        m.start_request(ready, report['sourceSha256Before'], owner)


@pytest.mark.parametrize('value', [None, {}, {'extra': True}])
def test_loopback_missing_shape_rejected(value):
    report = outer_fixture(); owner, ready = report['frames'][:2]
    ready['trustedHttpLoopback'] = value
    with pytest.raises(ValueError, match='LOOPBACK_ADMISSION'):
        m.start_request(ready, report['sourceSha256Before'], owner)


def test_loopback_running_bit_is_not_required_or_forbidden():
    report = outer_fixture(); owner, ready = report['frames'][:2]
    for before, after in ((8, 9), (8, 73), (73, 73)):
        ready['trustedHttpLoopback'].update(beforeFlags=before, afterFlags=after)
        assert m.start_request(ready, report['sourceSha256Before'], owner)['mode'] == m.SCENARIO


def test_child_network_namespace_must_equal_actual_ready_loopback_namespace():
    report = complete_report(); report['frames'][1]['trustedHttpLoopback']['namespace'] = 'net:[999999]'
    assert not m.child_evaluation(report) and not m.evaluate(report)
