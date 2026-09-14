"""Offline orchestration checks; kernel scenarios run only under explicit handoff."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
import pytest

spec = importlib.util.spec_from_file_location('receiver_primitive_measure', Path(__file__).with_name('subscription-systemd-ingress-receiver.measure.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def test_import_pinned_source_without_runtime():
    before = m.hashes()
    receiver = m.load_receiver(before)
    assert receiver.SETUP_SECONDS == 5
    assert callable(receiver.receive_fd) and callable(receiver.reserve_fd)
    assert set(before) == {m.SELF, m.RECEIVER}


def test_source_drift_rejected_before_exec():
    before = m.hashes(); before[m.RECEIVER] = '0' * 64
    with pytest.raises(ValueError, match='PINNED'): m.load_receiver(before)


@pytest.mark.parametrize('case', ['unknown-cleanup', 'failed-known-cleanup'])
def test_stop_fence_before_next_scenario(case):
    value = {'passed': False, 'cleanup': {'verified': case == 'failed-known-cleanup'}}
    with patch.object(m, 'scenario', return_value=value) as call:
        assert m.execute(object()) == [value]
        assert call.call_count == 1


def test_all_fixed_scenarios_only_after_verified_cleanup():
    value = {'passed': True, 'cleanup': {'verified': True}}
    with patch.object(m, 'scenario', return_value=value) as call:
        assert len(m.execute(object())) == 5
        assert [args.args[1] for args in call.call_args_list] == list(m.SCENARIOS)


def test_existing_198_never_touched():
    with patch.object(m, 'inventory', return_value={'198': {}}), patch.object(m, 'absent', return_value=False), patch.object(m.socket, 'socketpair') as opened:
        with pytest.raises(ValueError, match='PREEXISTING'): m.scenario(object(), 'one-fd')
        opened.assert_not_called()


def test_unknown_scenario_no_fd_inspection():
    with patch.object(m, 'inventory') as inspect:
        with pytest.raises(ValueError, match='FIXED_SCENARIO'): m.scenario(object(), 'caller')
        inspect.assert_not_called()


def test_no_arguments_before_source_or_runtime():
    with patch.object(m.sys, 'argv', ['measure', '--extra']), patch.object(m, 'hashes') as hashed:
        with pytest.raises(ValueError, match='NO_CALLER'): m.main()
        hashed.assert_not_called()


def test_nonlinux_before_source_or_runtime():
    with patch.object(m.sys, 'argv', ['measure']), patch.object(m.sys, 'platform', 'win32'), patch.object(m, 'hashes') as hashed:
        with pytest.raises(ValueError, match='LINUX'): m.main()
        hashed.assert_not_called()
