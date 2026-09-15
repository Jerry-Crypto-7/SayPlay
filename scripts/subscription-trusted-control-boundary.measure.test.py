"""Independent authored report fixtures; no subprocess/runtime execution."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import pytest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


ROOT = Path(__file__).parent
m = load('trusted_measure_test', ROOT / 'subscription-trusted-control-boundary.measure.py')
f = load('trusted_parent_fixture', ROOT / 'subscription-trusted-control-boundary-parent.test.py')
basic = load('trusted_basic_fixture', ROOT / '__tests__/subscription-cli-supervisor-measure.test.py')


def report_fixture():
    driver = m.load_driver()
    report = basic.environment_sample()
    sources = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in driver.SOURCES}
    hashes = {name: sources['scripts/' + name] for name in m.HELPERS}
    body = f.complete_report(); body['helperSha256Before'] = dict(hashes); body['helperSha256After'] = dict(hashes)
    raw = json.dumps(body).encode()
    ready = report['frames'][0]
    ready['trustedControlBoundary'] = {'helperSha256': hashes}
    ready['workerBoundary'] = f.ready()
    report['frames'][1]['mode'] = m.SCENARIO
    report['frames'][2]['data'] = base64.b64encode(raw).decode()
    report['terminal'].update(mode=m.SCENARIO, outputBytes=len(raw), observedOutputSha256=hashlib.sha256(raw).hexdigest())
    report.update(scenario=m.SCENARIO, sourceSha256Before=sources, sourceSha256After=dict(sources), command=list(driver.COMMAND))
    return report


def test_full_independent_parent_replay_and_fixed_start():
    report = report_fixture()
    assert m.evaluate(report)
    assert m.start_request(report['frames'][0], report['sourceSha256Before']) == {
        'type': 'start', 'mode': m.SCENARIO, 'helperSha256': report['frames'][0]['trustedControlBoundary']['helperSha256']}
    assert m.SCENARIO not in basic.measure.SCENARIOS


@pytest.mark.parametrize('case', ['source', 'extra-source', 'command', 'helper', 'extra-helper', 'outer', 'missing-outer', 'duplicate-ready', 'stderr', 'cleanup', 'terminal-mode', 'output-sha', 'partial', 'false-bytecount'])
def test_rejects_source_identity_raw_and_cleanup_drift(case):
    report = report_fixture()
    ready = report['frames'][0]
    if case == 'source': report['sourceSha256Before'][m.DRIVER] = '0'*64
    if case == 'extra-source': report['sourceSha256Before']['foreign'] = '0'*64
    if case == 'command': report['command'].append('--foreign')
    if case == 'helper': ready['trustedControlBoundary']['helperSha256'][m.HELPERS[0]] = '0'*64
    if case == 'extra-helper': ready['trustedControlBoundary']['helperSha256']['foreign'] = '0'*64
    if case == 'outer': ready['workerBoundary']['namespace'] = 'pid:[999]'
    if case == 'missing-outer': del ready['workerBoundary']
    if case == 'duplicate-ready': report['frames'].insert(0, copy.deepcopy(ready))
    if case == 'stderr': report['frames'][2]['stream'] = 'stderr'
    if case == 'cleanup': report['terminal']['cleanup']['allObservedPidfdsESRCH'] = False
    if case == 'terminal-mode': report['terminal']['mode'] = 'exec-environment-metadata'
    if case == 'output-sha': report['terminal']['observedOutputSha256'] = '0'*64
    if case == 'partial': report['terminal']['streamEOF']['stdout'] = False
    if case == 'false-bytecount': report['terminal']['outputBytes'] += 1
    assert not m.evaluate(report)


@pytest.mark.parametrize('ready', [None, [], {}, {'trustedControlBoundary': {}}])
def test_missing_ready_refuses_before_dispatch(ready):
    with pytest.raises(ValueError): m.start_request(ready, {})


def test_source_spoof_rejected_before_module_execution():
    with patch.object(m, 'load_bytes') as load_module:
        with pytest.raises(ValueError): m.load_driver({m.DRIVER: '0'*64})
        load_module.assert_not_called()


def test_no_arbitrary_runtime_cli():
    with patch.object(m.sys, 'argv', ['measure', '--arbitrary']), patch.object(m, 'load_driver') as driver:
        with pytest.raises(ValueError): m.main()
        driver.assert_not_called()


@pytest.mark.parametrize('case', ['zero-pid', 'leading-pid', 'zero-mount', 'leading-mount', 'zero-ino', 'aliased-pipes'])
def test_strict_outer_identity_refuses_before_dispatch(case):
    report = report_fixture(); ready = report['frames'][0]; worker = ready['workerBoundary']
    if case == 'zero-pid': worker['namespace'] = 'pid:[0]'
    if case == 'leading-pid': worker['namespace'] = 'pid:[01]'
    if case == 'zero-mount': worker['mountNamespace'] = 'mnt:[0]'
    if case == 'leading-mount': worker['mountNamespace'] = 'mnt:[01]'
    if case == 'zero-ino': worker['control']['ino'] = 0
    if case == 'aliased-pipes': worker['output'] = dict(worker['control'])
    with pytest.raises(ValueError): m.start_request(ready, report['sourceSha256Before'])
