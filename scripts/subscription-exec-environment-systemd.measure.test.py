"""Offline resource receipt admission and reuse tests; no systemd/CLI execution."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import Mock, patch
import pytest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).parents[1]
m = load('systemd_environment_measure_test', Path(__file__).with_name('subscription-exec-environment-systemd.measure.py'))
fixtures = load('basic_environment_outer_fixture', ROOT / 'scripts/__tests__/subscription-cli-supervisor-measure.test.py')


def report_fixture(bootstrap=False, controlled=False):
    report = fixtures.environment_sample(bootstrap=bootstrap, controlled=controlled)
    driver = m.load_driver()
    files = set(driver.SOURCES) | {m.SELF, m.RELAY, m.PROBE}
    before = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}
    report.update(sourceSha256Before=before, sourceSha256After=dict(before),
                  command=m.fixed_command(m.CONTROLLED_SCENARIO if controlled else m.BOOTSTRAP_SCENARIO if bootstrap else m.SCENARIO))
    unit = 'codex-cli-resource-' + 'a'*32 + '.service'
    leaf = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/' + unit
    owner = {'unit': unit, 'uid': 1000, 'leaf': leaf, 'driverPid': 2, 'relaySha256': before[m.RELAY], 'probeSha256': before[m.PROBE]}
    control = {'driverPid': 2, 'driverCgroup': '/user.slice/controller', 'managerPid': 3, 'managerCgroup': '/user.slice/manager',
        'managerIdentityProfile': 'private-socket-peer-v1', 'managerUid': 1000, 'managerGid': 1000, 'managerStartTimeTicks': '123',
        'managerSocket': {'path': '/run/user/1000/systemd/private', 'components': [
            {'dev': 1, 'ino': i+1, 'mode': 0xc180 if i == 4 else 0x41ed, 'uid': 1000, 'gid': 1000} for i in range(5)]},
        'unitMainPid': 4, 'unitMainCgroup': leaf[len('/sys/fs/cgroup'):], 'unitMainStartTimeTicks': '456'}
    boundary = {key: owner[key] for key in ('unit', 'uid', 'leaf', 'relaySha256', 'probeSha256')}
    boundary.update(aggregateResourceReadbackValidated=True, candidateExhaustionValidated=False,
        limits=dict(m.LIMITS), readback=dict(m.READBACK), control=control)
    ready = report['frames'][0]
    ready.update(binarySha256=m.CLI_SHA, bwrapSha256=m.BWRAP_SHA, sandbox={'uid': 1000}, systemdFixtureBoundary=boundary)
    report['terminal']['systemdFixtureBoundary'] = {**copy.deepcopy(boundary), 'preStartReadback': dict(m.READBACK),
        'cleanup': {'unitAbsent': True, 'leafAbsent': True, 'systemdRunClosed': True}, 'relayErrors': []}
    report['frames'].insert(0, {'version': 1, 'type': 'systemd_ownership', 'ownership': owner})
    return report


def test_full_synthetic_report_replays_parent_and_both_cleanup_domains_without_runtime_credit():
    assert m.evaluate(report_fixture())
    assert m.COMMAND[-1] == '--environment-metadata'
    assert m.COMMAND[4:7] == ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin']
    assert m.LIMITS == {'memoryMaxBytes': 2147483648, 'swapMaxBytes': 0, 'tasksMax': 64,
        'guardianMs': 220000, 'termGraceMs': 5000, 'innerCommandMs': 200000}


@pytest.mark.parametrize('args', [['bootstrap'], ['--bootstrap-metadata', 'extra'], ['--exec', '/bin/true']])
def test_unknown_profile_refused_before_loading_driver(args):
    with patch.object(m.sys, 'argv', ['fixed', *args]), patch.object(m, 'load_driver') as load_driver:
        with pytest.raises(ValueError, match='FIXED_SYSTEMD_METADATA_SCENARIO_REQUIRED'): m.main()
        load_driver.assert_not_called()


def test_bootstrap_command_is_distinct_fixed_literal_and_cannot_relabel_old_report():
    assert m.select_scenario([]) == m.SCENARIO
    assert m.select_scenario(['--bootstrap-metadata']) == m.BOOTSTRAP_SCENARIO
    assert m.fixed_command(m.BOOTSTRAP_SCENARIO) == [*m.COMMAND[:-1], '--environment-bootstrap-metadata']
    assert not m.evaluate(report_fixture(), m.BOOTSTRAP_SCENARIO)
    assert m.evaluate(report_fixture(bootstrap=True), m.BOOTSTRAP_SCENARIO)
    assert not m.evaluate(report_fixture(bootstrap=True))


@pytest.mark.parametrize('case', ['ownership-missing', 'ownership-duplicate', 'ownership-late', 'owner-foreign', 'owner-version-bool',
    'readback', 'prestart', 'memory-bool', 'stress-credit', 'main-generation', 'peer-generation', 'peer-uid', 'manager-inside',
    'driver-inside', 'socket-symlink', 'socket-path', 'socket-uid', 'socket-shape', 'unit-absent', 'leaf-absent',
    'run-closed', 'relay-failure', 'relay-errors', 'wrapper', 'command', 'current-source', 'source-after', 'missing-helper'])
def test_incomplete_foreign_or_tampered_resource_receipt_fails(case):
    report = report_fixture()
    owner, ready = report['frames'][:2]
    resource = ready['systemdFixtureBoundary']; terminal = report['terminal']['systemdFixtureBoundary']
    if case == 'ownership-missing': report['frames'].pop(0)
    if case == 'ownership-duplicate': report['frames'].insert(0, copy.deepcopy(owner))
    if case == 'ownership-late': report['frames'][0], report['frames'][1] = report['frames'][1], report['frames'][0]
    if case == 'owner-foreign': owner['ownership']['driverPid'] = 20
    if case == 'owner-version-bool': owner['version'] = True
    if case == 'readback': resource['readback']['pidsMax'] = '65'
    if case == 'prestart': terminal['preStartReadback']['memorySwapMax'] = '1'
    if case == 'memory-bool': resource['limits']['swapMaxBytes'] = False
    if case == 'stress-credit': resource['candidateExhaustionValidated'] = True
    if case == 'main-generation': terminal['control']['unitMainStartTimeTicks'] = '999'
    if case == 'peer-generation': terminal['control']['managerStartTimeTicks'] = '999'
    if case == 'peer-uid': resource['control']['managerUid'] = 0
    if case == 'manager-inside': resource['control']['managerCgroup'] = resource['control']['unitMainCgroup']
    if case == 'driver-inside': resource['control']['driverCgroup'] = resource['control']['unitMainCgroup'] + '/child'
    if case == 'socket-symlink': resource['control']['managerSocket']['components'][0]['mode'] = 0xa1ff
    if case == 'socket-path': resource['control']['managerSocket']['path'] = '/run/user/0/systemd/private'
    if case == 'socket-uid': resource['control']['managerSocket']['components'][4]['uid'] = 0
    if case == 'socket-shape': resource['control']['managerSocket']['components'].pop()
    if case == 'unit-absent': terminal['cleanup']['unitAbsent'] = 1
    if case == 'leaf-absent': terminal['cleanup']['leafAbsent'] = False
    if case == 'run-closed': terminal['cleanup']['systemdRunClosed'] = False
    if case == 'relay-failure': report['frames'].append({'type': 'systemd_failure'})
    if case == 'relay-errors': terminal['relayErrors'].append('ERROR')
    if case == 'wrapper': report['exitCode'] = 1
    if case == 'command': report['command'].append('arbitrary')
    if case == 'current-source': report['sourceSha256Before'][m.RELAY] = report['sourceSha256After'][m.RELAY] = '0'*64
    if case == 'source-after': report['sourceSha256After'][m.PROBE] = '0'*64
    if case == 'missing-helper': del ready['execEnvironmentMetadataBoundary']['helperSha256']['subscription-worker-lockdown.py']
    assert not m.evaluate(report)


def test_mismatched_driver_source_rejected_before_module_execution():
    with patch.object(m.importlib.util, 'module_from_spec') as create:
        with pytest.raises(ValueError, match='SOURCE_MISMATCH'): m.load_driver({m.DRIVER: '0'*64})
        create.assert_not_called()


def test_owner_and_resource_validation_precede_original_start_dispatch():
    report = report_fixture(); owner, ready = report['frames'][:2]
    archive = io.BytesIO(); wire = m.ObservedWire(archive); send = Mock(return_value={'fixed': True})
    with pytest.raises(ValueError): wire.admit_start(ready, report['sourceSha256Before'], send)
    send.assert_not_called()
    raw = (json.dumps(owner, indent=1) + '\n').encode()
    assert wire.loads(raw) == owner
    assert archive.getvalue() == raw
    assert wire.admit_start(ready, report['sourceSha256Before'], send) == {'fixed': True}
    wire.loads((json.dumps(owner) + '\n').encode())
    with pytest.raises(ValueError): wire.admit_start(ready, report['sourceSha256Before'], send)
    assert send.call_count == 1


def test_pre_ready_failure_is_archived_and_never_becomes_start_admission():
    report = report_fixture(); owner, ready = report['frames'][:2]
    archive = io.BytesIO(); wire = m.ObservedWire(archive)
    wire.loads((json.dumps(owner) + '\n').encode())
    raw = b'{"version":1,"type":"systemd_failure","error":"fixed failure"}\n'
    wire.loads(raw)
    send = Mock()
    with pytest.raises(ValueError): wire.admit_start(ready, report['sourceSha256Before'], send)
    assert raw in archive.getvalue()
    send.assert_not_called()


@pytest.mark.parametrize('ready', [None, [], ['ready']])
def test_malformed_ready_refuses_immediately_with_value_error_not_reader_thread_failure(ready):
    report = report_fixture(); owner = report['frames'][0]
    assert not m.validate_ready(ready, owner['ownership'], report['sourceSha256Before'])
    wire = m.ObservedWire(io.BytesIO())
    wire.loads((json.dumps(owner) + '\n').encode())
    send = Mock()
    with pytest.raises(ValueError, match='SYSTEMD_RESOURCE_PRESTART_ADMISSION_FAILED'):
        wire.admit_start(ready, report['sourceSha256Before'], send)
    send.assert_not_called()


def test_controlled_command_profile_and_replay_cannot_relabel_natural():
    assert m.select_scenario(['--bootstrap-controlled-cleanup']) == m.CONTROLLED_SCENARIO
    assert m.fixed_command(m.CONTROLLED_SCENARIO) == [*m.COMMAND[:-1], '--environment-bootstrap-controlled']
    assert m.evaluate(report_fixture(controlled=True), m.CONTROLLED_SCENARIO)
    assert not m.evaluate(report_fixture(controlled=True), m.BOOTSTRAP_SCENARIO)
    assert not m.evaluate(report_fixture(bootstrap=True), m.CONTROLLED_SCENARIO)
    with pytest.raises(ValueError): m.select_scenario(['--bootstrap-controlled-cleanup', 'extra'])
