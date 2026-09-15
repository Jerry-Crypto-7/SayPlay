"""Offline dedicated-driver admission and full independently bound replay."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import patch
import pytest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


m = load('ingress_measure_test', 'subscription-trusted-ingress.measure.py')
f = load('ingress_child_fixture', 'subscription-trusted-ingress-child.test.py')
basic = load('ingress_basic_fixture', '__tests__/subscription-cli-supervisor-measure.test.py')


def report_fixture():
    report = basic.environment_sample()
    driver = m.load_driver()
    before = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in driver.SOURCES}
    helpers = m.expected_hashes(before, m.HELPERS)
    body = f.complete_report()
    for value in (body, body['parentReport']): value.update(helperSha256Before=dict(helpers), helperSha256After=dict(helpers))
    raw = json.dumps(body).encode()
    ingress = f.ingress()
    owner = {'type': 'ingress_ownership', 'version': 1, **ingress, 'sourceSha256': m.expected_hashes(before, m.LAUNCHER_SOURCES)}
    ready = report['frames'][0]
    ready.update(binarySha256=m.CLI_SHA256, bwrapSha256=m.BWRAP_SHA256, limits=dict(m.LIMITS),
        sandbox={**m.SANDBOX, 'uid': 1000, 'gid': 1000})
    ready.update(trustedIngressBoundary={'helperSha256': helpers}, workerBoundary=f.old_fixture.ready(),
        trustedIngressFd={'fd': 198, 'socket': ingress['socket'], 'bootstrapInheritance': 'trusted-setup-only', 'preservedAcrossPivot': True})
    report['frames'][1]['mode'] = m.SCENARIO
    report['frames'][2]['data'] = base64.b64encode(raw).decode()
    report['terminal'].update(mode=m.SCENARIO, outputBytes=len(raw), observedOutputSha256=hashlib.sha256(raw).hexdigest())
    proxy = m.load_source(m.PROXY, before)
    terminal = {'type': 'ingress_terminal', 'version': 1, 'nonce': ingress['nonce'], 'socket': ingress['socket'],
        'sourceBefore': dict(owner['sourceSha256']), 'sourceAfter': dict(owner['sourceSha256']),
        'capsuleWaitKnown': True, 'capsuleReturnCode': 0, 'remoteProcessCleanup': 'NOT_ATTESTED_BY_LAUNCHER',
        'broker': {'version': 1, 'profile': 'authored-offline-connect', 'reason': 'EOF', 'connectAccepted': True,
            'observedBytes': {'ingress': len(proxy.REQUEST) + 79, 'upstream': 87},
            'deliveredBytes': {'ingress': len(proxy.RESPONSE) + 87, 'upstream': 79}, 'elapsedMs': 350,
            'brokerDescriptorsClosed': True, 'productionReady': False, 'externalNetworkCalls': 0, 'modelCalls': 0},
        'route': {'beforeBytes': 40, 'afterBytes': 39, 'eof': True}, 'threadsClosed': True, 'peersClosed': True,
        'errors': [], 'passed': True, 'productionReady': False, 'aggregateResourcesValidated': False}
    report['frames'].insert(0, owner); report['frames'].append(terminal)
    report.update(scenario=m.SCENARIO, sourceSha256Before=before, sourceSha256After=dict(before), command=list(m.COMMAND))
    return report


def test_complete_fixture_requires_full_child_broker_and_capsule_replay():
    report = report_fixture()
    assert len(report['sourceSha256Before']) == 24
    assert len(report['frames'][0]['sourceSha256']) == 14
    assert m.evaluate(report)
    assert m.start_request(report['frames'][1], report['sourceSha256Before'], report['frames'][0]) == {
        'type': 'start', 'mode': m.SCENARIO, 'helperSha256': report['frames'][1]['trustedIngressBoundary']['helperSha256'],
        'nonce': f.ingress()['nonce']}


@pytest.mark.parametrize('case', ['missing-owner', 'owner-late', 'duplicate-owner', 'ready-socket', 'ready-inheritance', 'owner-bool',
    'owner-source-extra', 'helper-missing', 'nonce', 'child-body', 'child-before-start', 'terminal-late-output', 'unknown-frame',
    'ingress-terminal-early', 'wait-unknown', 'wait-nonzero', 'wait-bool', 'thread-open', 'peer-open', 'broker-open',
    'broker-deadline', 'route-eof', 'route-before', 'route-after', 'observed-ingress', 'observed-upstream',
    'delivered-ingress', 'delivered-upstream', 'model-credit', 'network-credit', 'resource-credit', 'process-credit',
    'capsule-cleanup', 'source-drift', 'source-missing', 'launcher-source-drift', 'command'])
def test_strict_separate_identity_raw_cleanup_and_source_failures(case):
    report = report_fixture(); owner, ready = report['frames'][:2]; terminal = report['frames'][-1]
    if case == 'missing-owner': report['frames'].pop(0)
    if case == 'owner-late': report['frames'][0], report['frames'][1] = report['frames'][1], report['frames'][0]
    if case == 'duplicate-owner': report['frames'].insert(0, copy.deepcopy(owner))
    if case == 'ready-socket': ready['trustedIngressFd']['socket'] = {**owner['socket'], 'ino': 998}
    if case == 'ready-inheritance': ready['trustedIngressFd']['bootstrapInheritance'] = 'only-child-ever'
    if case == 'owner-bool': owner['version'] = True
    if case == 'owner-source-extra': owner['sourceSha256']['foreign'] = 'a' * 64
    if case == 'helper-missing': ready['trustedIngressBoundary']['helperSha256'].pop(m.HELPERS[0])
    if case == 'nonce': terminal['nonce'] = 'b' * 32
    if case == 'child-body': report['frames'][3]['data'] = 'e30='
    if case == 'child-before-start': report['frames'][2], report['frames'][3] = report['frames'][3], report['frames'][2]
    if case == 'terminal-late-output': report['frames'].insert(-1, copy.deepcopy(report['frames'][3]))
    if case == 'unknown-frame': report['frames'].insert(-1, {'type': 'unknown'})
    if case == 'ingress-terminal-early': report['frames'][-1], report['frames'][-2] = report['frames'][-2], report['frames'][-1]
    if case == 'wait-unknown': terminal['capsuleWaitKnown'] = False
    if case == 'wait-nonzero': terminal['capsuleReturnCode'] = 1
    if case == 'wait-bool': terminal['capsuleReturnCode'] = False
    if case == 'thread-open': terminal['threadsClosed'] = False
    if case == 'peer-open': terminal['peersClosed'] = False
    if case == 'broker-open': terminal['broker']['brokerDescriptorsClosed'] = False
    if case == 'broker-deadline': terminal['broker']['reason'] = 'SESSION_DEADLINE'
    if case == 'route-eof': terminal['route']['eof'] = False
    if case == 'route-before': terminal['route']['beforeBytes'] = 39
    if case == 'route-after': terminal['route']['afterBytes'] = 40
    if case == 'observed-ingress': terminal['broker']['observedBytes']['ingress'] += 1
    if case == 'observed-upstream': terminal['broker']['observedBytes']['upstream'] -= 1
    if case == 'delivered-ingress': terminal['broker']['deliveredBytes']['ingress'] -= 1
    if case == 'delivered-upstream': terminal['broker']['deliveredBytes']['upstream'] = False
    if case == 'model-credit': terminal['broker']['modelCalls'] = 1
    if case == 'network-credit': terminal['broker']['externalNetworkCalls'] = 1
    if case == 'resource-credit': terminal['aggregateResourcesValidated'] = True
    if case == 'process-credit': terminal['remoteProcessCleanup'] = 'CONFIRMED'
    if case == 'capsule-cleanup': report['terminal']['cleanup']['allObservedPidfdsESRCH'] = False
    if case == 'source-drift': report['sourceSha256After'][m.PROXY] = 'b' * 64
    if case == 'source-missing': report['sourceSha256Before'].pop(m.LAUNCHER)
    if case == 'launcher-source-drift': terminal['sourceAfter'][m.LAUNCHER_SOURCES[0]] = 'b' * 64
    if case == 'command': report['command'].append('--extra')
    assert not m.evaluate(report)


@pytest.mark.parametrize('case', ['missing-owner', 'valid', 'wrong-source', 'wrong-nonce-type'])
def test_start_requires_previously_observed_bound_ownership(case):
    report = report_fixture(); observer = m.ObservedWire(io.BytesIO())
    if case == 'wrong-source': report['frames'][0]['sourceSha256'][m.LAUNCHER_SOURCES[0]] = 'b' * 64
    if case == 'wrong-nonce-type': report['frames'][0]['nonce'] = 1
    if case != 'missing-owner': observer.loads(json.dumps(report['frames'][0]).encode())
    ready = observer.loads(json.dumps(report['frames'][1]).encode())
    if case == 'valid': assert observer.start(ready, report['sourceSha256Before'])['nonce'] == f.ingress()['nonce']
    else:
        with pytest.raises(ValueError): observer.start(ready, report['sourceSha256Before'])


def test_duplicate_wire_key_rejected_without_start():
    observer = m.ObservedWire(io.BytesIO())
    with pytest.raises(ValueError, match='DUPLICATE'):
        observer.loads(b'{"type":"ready","type":"ingress_ownership"}\n')
    assert observer.frames == []


@pytest.mark.parametrize('field,value', [
    ('binarySha256', '0' * 64), ('bwrapSha256', '0' * 64),
    ('limits.jobMs', 180001), ('limits.commandMs', 200001), ('limits.termGraceMs', 5001),
    ('limits.maxOutputBytes', 8388609), ('limits.commandBudgetEnforcedHere', 0),
    ('limits.aggregateResourcesEnforced', True), ('sandbox.uid', True), ('sandbox.gid', -1),
    ('sandbox.pidNamespaceInit', 1), ('sandbox.hostHomeMounted', True), ('sandbox.hostMntMounted', True),
    ('sandbox.networkInterfaces', ['lo', 'eth0']), ('sandbox.ttyIsNullDevice', False),
    ('sandbox.runtimeWriteDenied', False), ('sandbox.parentNondumpable', False),
])
def test_runtime_identity_rejected_before_start_and_in_replay(field, value):
    report = report_fixture(); owner, ready = report['frames'][:2]
    parts = field.split('.')
    target = ready if len(parts) == 1 else ready[parts[0]]
    target[parts[-1]] = value
    with pytest.raises(ValueError, match='RUNTIME_ADMISSION'):
        m.start_request(ready, report['sourceSha256Before'], owner)
    assert not m.evaluate(report)


def test_no_caller_arguments_before_loading_or_runtime():
    with patch.object(m.sys, 'argv', ['measure', '--caller']), patch.object(m, 'load_driver') as loader:
        with pytest.raises(ValueError): m.main()
        loader.assert_not_called()
