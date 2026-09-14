import importlib.util
from pathlib import Path
import pytest
from types import SimpleNamespace
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('fixture_child', Path(__file__).parents[1] / 'subscription-appserver-fixture-child.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)


def start(scenario):
    protocol = f.Protocol(scenario)
    frames = []
    for ident, method in [(1, 'initialize'), (None, 'initialized'), (2, 'thread/start'), (3, 'turn/start')]:
        request = {'method': method, 'params': {}}
        if ident is not None:
            request['id'] = ident
        frames.extend(protocol.receive(request))
    return protocol, frames


def test_authored_normal_has_fixed_answer_and_no_model():
    _, frames = start('normal')
    answer = next(frame for frame in frames if frame.get('method') == 'item/agentMessage/delta')
    assert answer['params']['delta'] == '{"authoredFixture":true,"actualModelCalls":0}'
    assert frames[-1]['method'] == 'turn/completed'


@pytest.mark.parametrize('scenario', ['cancel', 'output-limit'])
def test_fault_modes_never_emit_completion(scenario):
    _, frames = start(scenario)
    assert frames[-1]['method'] == 'turn/started'
    assert not any(frame.get('method') == 'turn/completed' for frame in frames)


@pytest.mark.parametrize('frame', [
    {'id': 1, 'method': 'account/login/start', 'params': {}},
    {'id': True, 'method': 'initialize', 'params': {}},
    {'id': 1, 'method': 'initialize', 'params': {}, 'argv': ['exec']},
    {'id': 1, 'method': 'initialize', 'params': {}, 'jsonrpc': '2.0'},
])
def test_rejects_unexpected_or_caller_commands(frame):
    with pytest.raises(ValueError):
        f.Protocol('normal').receive(frame)


def test_duplicate_requests_and_unknown_scenario_rejected():
    protocol, _ = start('normal')
    with pytest.raises(ValueError):
        protocol.receive({'id': 1, 'method': 'initialize', 'params': {}})
    with pytest.raises(ValueError):
        f.Protocol('login')


def forbidden_before_lockdown(monkeypatch):
    sentinels = []
    for owner, name in [(f, 'Protocol'), (f.selectors, 'DefaultSelector'),
                        (f.os, 'set_blocking'), (f.os, 'read'), (f.os, 'write')]:
        sentinel = Mock(side_effect=AssertionError('PROTOCOL_OR_IO_BEFORE_LOCKDOWN'))
        monkeypatch.setattr(owner, name, sentinel)
        sentinels.append(sentinel)
    return sentinels


@pytest.mark.parametrize('scenario', f.SCENARIOS)
def test_install_failure_prevents_protocol_and_descriptor_io(monkeypatch, scenario):
    monkeypatch.setattr(f.sys, 'argv', ['fixed-child', scenario])
    sentinels = forbidden_before_lockdown(monkeypatch)
    install = Mock(side_effect=RuntimeError('WORKER_LOCKDOWN_READBACK_FAILED'))
    monkeypatch.setattr(f, 'install_fixed_lockdown', install)
    with pytest.raises(RuntimeError, match='WORKER_LOCKDOWN_READBACK_FAILED'):
        f.main()
    install.assert_called_once_with()
    for sentinel in sentinels:
        sentinel.assert_not_called()


@pytest.mark.parametrize('argv', [['fixed-child'], ['fixed-child', 'login'],
                                 ['fixed-child', 'normal', '/tmp/override.py']])
def test_invalid_argv_does_not_load_filter_or_touch_protocol(monkeypatch, argv):
    monkeypatch.setattr(f.sys, 'argv', argv)
    sentinels = forbidden_before_lockdown(monkeypatch)
    install = Mock()
    monkeypatch.setattr(f, 'install_fixed_lockdown', install)
    with pytest.raises(ValueError, match='FIXED_SCENARIO_REQUIRED'):
        f.main()
    install.assert_not_called()
    for sentinel in sentinels:
        sentinel.assert_not_called()


@pytest.mark.parametrize('scenario', f.SCENARIOS)
def test_installs_synchronously_before_constructing_protocol(monkeypatch, scenario):
    monkeypatch.setattr(f.sys, 'argv', ['fixed-child', scenario])
    events = []
    monkeypatch.setattr(f, 'install_fixed_lockdown', lambda: events.append('installed'))
    class StopAfterAdmission(Exception):
        pass
    def protocol(value):
        assert events == ['installed']
        assert value == scenario
        raise StopAfterAdmission()
    monkeypatch.setattr(f, 'Protocol', protocol)
    with pytest.raises(StopAfterAdmission):
        f.main()


@pytest.mark.parametrize('failure', [None, 'load', 'install'])
def test_only_fixed_image_path_is_loaded_and_errors_propagate(monkeypatch, failure):
    events = []
    module = SimpleNamespace()
    def install():
        events.append('install')
        if failure == 'install':
            raise RuntimeError('FILTER_FAILED')
    def execute(value):
        assert value is module
        events.append('load')
        if failure == 'load':
            raise RuntimeError('LOAD_FAILED')
        value.install_worker_lockdown = install
    spec = SimpleNamespace(loader=SimpleNamespace(exec_module=execute))
    lookup = Mock(return_value=spec)
    monkeypatch.setattr(f.importlib.util, 'spec_from_file_location', lookup)
    monkeypatch.setattr(f.importlib.util, 'module_from_spec', lambda value: module)
    if failure:
        with pytest.raises(RuntimeError, match='FAILED'):
            f.install_fixed_lockdown()
    else:
        f.install_fixed_lockdown()
    lookup.assert_called_once_with('fixed_fixture_lockdown', '/usr/bin/worker-lockdown.py')
    assert events == (['load'] if failure == 'load' else ['load', 'install'])


@pytest.mark.parametrize('spec', [None, SimpleNamespace(loader=None)])
def test_missing_fixed_loader_has_no_fallback(monkeypatch, spec):
    monkeypatch.setattr(f.importlib.util, 'spec_from_file_location', lambda *_: spec)
    with pytest.raises(RuntimeError, match='FIXTURE_LOCKDOWN_LOADER_REQUIRED'):
        f.install_fixed_lockdown()
