"""Offline full independent child/resource replay; no runtime launch."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import pytest


def load(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


m = load('subscription-trusted-ingress-systemd.measure.py')
b = load('subscription-trusted-ingress.measure.test.py')
r = load('subscription-exec-environment-systemd.measure.test.py')


def report_fixture():
    report = b.report_fixture(); resources = r.report_fixture()
    basic, resource, driver = m.stack()
    before = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in driver.SOURCES}
    report.update(sourceSha256Before=before, sourceSha256After=dict(before), command=list(m.COMMAND))
    oldowner, ready = report['frames'][:2]
    own, resource_ready = copy.deepcopy(resources['frames'][:2])
    ready['systemdFixtureBoundary'] = resource_ready['systemdFixtureBoundary']
    ready['sandbox']['uid'] = own['ownership']['uid']
    unit = own['ownership']['unit']; uid = own['ownership']['uid']; identifier = unit[19:-8]
    owner = {'unit': unit, 'uuid': identifier, 'nonce': oldowner['nonce'], 'controllerPid': own['ownership']['driverPid'],
        'controllerStartTicks': '1234', 'rendezvous': {'path': f'/run/user/{uid}/rc-ingress-{identifier}/handoff.sock', 'dev': 3, 'ino': 999},
        'sourceSha256': basic.expected_hashes(before, m.load(m.RENDEZVOUS).SOURCES)}
    handoff = {'version': 1, 'unit': unit, 'nonce': owner['nonce'], 'socket': oldowner['socket'], 'readback': dict(resource.READBACK),
        'control': copy.deepcopy(ready['systemdFixtureBoundary']['control']), 'transferObserved': True, 'remoteCleanup': 'NOT_ATTESTED', 'productionReady': False,
        'receiverAck': {'version': 1, 'type': 'fd_received', 'uuid': identifier, 'nonce': owner['nonce'], 'fd': 198, 'socket': oldowner['socket']}}
    ready['systemdIngressBoundary'] = {'nonce': owner['nonce'], 'ownership': copy.deepcopy(owner), 'handoff': copy.deepcopy(handoff)}
    oldterminal = report['frames'].pop()
    report['terminal']['systemdFixtureBoundary'] = copy.deepcopy(resources['terminal']['systemdFixtureBoundary'])
    result = {'version': 1, 'unit': unit, 'nonce': owner['nonce'], 'route': oldterminal['route'], 'broker': oldterminal['broker'],
        'threadsClosed': True, 'ownedCleanupVerified': True, 'pathCleanup': {'socketRemoved': True, 'directoryRemoved': True},
        'peersClosed': True, 'errors': [], 'remoteUnitCleanup': 'NOT_ATTESTED', 'productionReady': False, 'passed': True, 'sourceStable': True}
    report['frames'][:1] = [own, {'version': 1, 'type': 'systemd_ingress_ownership', 'ownership': owner},
        {'version': 1, 'type': 'systemd_ingress_handoff', 'handoff': handoff}]
    report['frames'].append({'version': 1, 'type': 'systemd_ingress_terminal', 'result': result})
    return report


def test_full_actual_shape_replay_without_synthetic_basic_frames():
    report = report_fixture()
    assert len(report['sourceSha256Before']) == 30
    assert all(frame['type'] not in ('ingress_ownership', 'ingress_terminal') for frame in report['frames'])
    assert m.evaluate(report)


@pytest.mark.parametrize('case', ['valid', 'missing', 'reordered', 'ack', 'resource', 'null-owner', 'null-handoff',
    'worker-missing', 'worker-zero', 'worker-bool', 'worker-alias', 'worker-namespace'])
def test_admission_before_any_start_write(case):
    report = report_fixture(); frames = report['frames'][:4]; ready = frames[-1]
    if case == 'missing': frames.pop(1)
    if case == 'reordered': frames[1], frames[2] = frames[2], frames[1]
    if case == 'ack': frames[2]['handoff']['receiverAck']['fd'] = True
    if case == 'resource': ready['systemdFixtureBoundary']['readback']['pidsMax'] = '65'
    if case == 'null-owner': frames[1]['ownership'] = None
    if case == 'null-handoff': frames[2]['handoff'] = None
    if case == 'worker-missing': ready.pop('workerBoundary')
    if case == 'worker-zero': ready['workerBoundary']['control']['ino'] = 0
    if case == 'worker-bool': ready['workerBoundary']['control']['dev'] = True
    if case == 'worker-alias': ready['workerBoundary']['output'] = copy.deepcopy(ready['workerBoundary']['control'])
    if case == 'worker-namespace': ready['workerBoundary']['mountNamespace'] = 'mnt:[0]'
    if case == 'valid':
        value = m.start_request(frames, ready, report['sourceSha256Before'])
        assert set(value) == {'type', 'mode', 'helperSha256', 'nonce'} and len(value['helperSha256']) == 10
    else:
        with pytest.raises(ValueError): m.start_request(frames, ready, report['sourceSha256Before'])


@pytest.mark.parametrize('case', ['nonce', 'ack', 'source', 'path', 'pid', 'readback', 'control', 'fd', 'order', 'duplicate', 'raw',
    'prestart', 'unit-cleanup', 'namespace-cleanup', 'socket-cleanup', 'path-cleanup', 'threads', 'source-stable', 'counter', 'remote-credit', 'drift'])
def test_each_independent_boundary_failure(case):
    report = report_fixture(); frames = report['frames']; owner = frames[1]['ownership']; handoff = frames[2]['handoff']; ready = frames[3]; end = frames[-1]['result']
    if case == 'nonce': owner['nonce'] = 'b' * 32
    if case == 'ack': handoff['receiverAck']['fd'] = 197
    if case == 'source': owner['sourceSha256']['extra'] = 'a' * 64
    if case == 'path': owner['rendezvous']['path'] += 'x'
    if case == 'pid': owner['controllerPid'] += 1
    if case == 'readback': handoff['readback']['pidsMax'] = '65'
    if case == 'control': handoff['control']['unitMainStartTimeTicks'] = '999'
    if case == 'fd': ready['trustedIngressFd']['fd'] = 197
    if case == 'order': frames[1], frames[2] = frames[2], frames[1]
    if case == 'duplicate': frames.insert(1, copy.deepcopy(frames[1]))
    if case == 'raw': frames[5]['data'] = 'e30='
    if case == 'prestart': report['terminal']['systemdFixtureBoundary']['preStartReadback']['memoryMax'] = '1'
    if case == 'unit-cleanup': report['terminal']['systemdFixtureBoundary']['cleanup']['unitAbsent'] = False
    if case == 'namespace-cleanup': report['terminal']['cleanup']['namespaceEmpty'] = False
    if case == 'socket-cleanup': end['peersClosed'] = False
    if case == 'path-cleanup': end['pathCleanup']['directoryRemoved'] = False
    if case == 'threads': end['threadsClosed'] = False
    if case == 'source-stable': end['sourceStable'] = False
    if case == 'counter': end['broker']['observedBytes']['ingress'] += 1
    if case == 'remote-credit': end['remoteUnitCleanup'] = 'CONFIRMED'
    if case == 'drift': report['sourceSha256After'][m.RECEIVER] = 'a' * 64
    assert not m.evaluate(report)
