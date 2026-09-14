"""Offline composition tests; actual systemd/app-server/worker are not started."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import patch
import pytest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load('trusted_systemd_measure', 'subscription-trusted-control-systemd.measure.py')
trusted_fixtures = load('trusted_systemd_basic_fixtures', 'subscription-trusted-control-boundary.measure.test.py')
resource_fixtures = load('trusted_systemd_resource_fixtures', 'subscription-exec-environment-systemd.measure.test.py')


def report_fixture():
    report = trusted_fixtures.report_fixture()
    resources = resource_fixtures.report_fixture()
    driver, _ = m.load_stack()
    before = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in driver.SOURCES}
    report.update(sourceSha256Before=before, sourceSha256After=dict(before), command=list(m.COMMAND))
    owner, resource_ready = resources['frames'][:2]
    ready = report['frames'][0]
    for key in ('binarySha256', 'bwrapSha256', 'sandbox', 'systemdFixtureBoundary'):
        ready[key] = copy.deepcopy(resource_ready[key])
    report['frames'].insert(0, copy.deepcopy(owner))
    report['terminal']['systemdFixtureBoundary'] = copy.deepcopy(resources['terminal']['systemdFixtureBoundary'])
    return report


def test_full_composition_replays_trusted_body_and_both_cleanup_domains():
    report = report_fixture()
    assert m.evaluate(report)
    driver, resource = m.load_stack(report['sourceSha256Before'])
    assert driver.environment_evaluation.__name__ == 'parent_evaluation'
    assert driver.COMMAND == m.COMMAND
    assert m.COMMAND[-1] == '--trusted-control-boundary'
    assert resource.LIMITS == {'memoryMaxBytes': 2147483648, 'swapMaxBytes': 0, 'tasksMax': 64,
        'guardianMs': 220000, 'termGraceMs': 5000, 'innerCommandMs': 200000}


@pytest.mark.parametrize('case', ['ownership-missing', 'ownership-late', 'ownership-bool', 'prestart-memory', 'ready-tasks',
    'manager-generation', 'unit-generation', 'manager-uid', 'socket-type', 'leaf-cleanup', 'unit-cleanup', 'run-cleanup',
    'relay-failure', 'relay-errors', 'outer-pipe', 'parent-body', 'namespace-cleanup', 'exhaustion-credit',
    'wrapper-source', 'command-selector', 'scenario', 'missing-resource-source'])
def test_composition_rejects_each_independent_resource_or_boundary_failure(case):
    report = report_fixture()
    ready = report['frames'][1]
    boundary = ready['systemdFixtureBoundary']
    terminal = report['terminal']['systemdFixtureBoundary']
    if case == 'ownership-missing': report['frames'].pop(0)
    if case == 'ownership-late': report['frames'][0], report['frames'][1] = report['frames'][1], report['frames'][0]
    if case == 'ownership-bool': report['frames'][0]['version'] = True
    if case == 'prestart-memory': terminal['preStartReadback']['memoryMax'] = '1'
    if case == 'ready-tasks': boundary['readback']['pidsMax'] = '65'
    if case == 'manager-generation': terminal['control']['managerStartTimeTicks'] = '999'
    if case == 'unit-generation': terminal['control']['unitMainStartTimeTicks'] = '999'
    if case == 'manager-uid': boundary['control']['managerUid'] = 0
    if case == 'socket-type': boundary['control']['managerSocket']['components'][-1]['mode'] = 0o100600
    if case == 'leaf-cleanup': terminal['cleanup']['leafAbsent'] = False
    if case == 'unit-cleanup': terminal['cleanup']['unitAbsent'] = False
    if case == 'run-cleanup': terminal['cleanup']['systemdRunClosed'] = False
    if case == 'relay-failure': report['frames'].insert(1, {'type': 'systemd_failure'})
    if case == 'relay-errors': terminal['relayErrors'].append('failure')
    if case == 'outer-pipe': ready['workerBoundary']['control']['ino'] += 1
    if case == 'parent-body': report['frames'][3]['data'] = 'e30='
    if case == 'namespace-cleanup': report['terminal']['cleanup']['namespaceEmpty'] = False
    if case == 'exhaustion-credit': boundary['candidateExhaustionValidated'] = True
    if case == 'wrapper-source': report['sourceSha256Before'][m.TRUSTED] = 'a' * 64
    if case == 'command-selector': report['command'][-1] = '--environment-metadata'
    if case == 'scenario': report['scenario'] = 'exec-environment-metadata'
    if case == 'missing-resource-source': report['sourceSha256Before'].pop(m.RESOURCE)
    assert not m.evaluate(report)


@pytest.mark.parametrize('case', ['missing-owner', 'bad-readback', 'valid'])
def test_resource_admission_precedes_fixed_start_write(case):
    report = report_fixture()
    driver, resource = m.load_stack(report['sourceSha256Before'])
    observer = resource.ObservedWire(io.BytesIO())
    if case != 'missing-owner': observer.loads(json.dumps(report['frames'][0]).encode())
    ready = report['frames'][1]
    if case == 'bad-readback': ready['systemdFixtureBoundary']['readback']['pidsMax'] = '63'
    with patch.object(driver, 'environment_start', wraps=driver.environment_start) as start:
        if case == 'valid':
            frame = observer.admit_start(ready, report['sourceSha256Before'], start)
            assert frame['mode'] == m.SCENARIO and 'scenario' not in frame and len(frame['helperSha256']) == 8
            start.assert_called_once()
        else:
            with pytest.raises(ValueError): observer.admit_start(ready, report['sourceSha256Before'], start)
            start.assert_not_called()


def test_no_caller_arguments_before_source_loading():
    with patch.object(m.sys, 'argv', ['measure', '--arbitrary']), patch.object(m, 'load_stack') as loader:
        with pytest.raises(ValueError): m.main()
        loader.assert_not_called()
