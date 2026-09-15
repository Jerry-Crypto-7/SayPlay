"""Finite control and exclusive profile tests; no actual resource workload."""
import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock, patch
import pytest

spec = importlib.util.spec_from_file_location('stress_supervisor_tests', Path(__file__).with_name('subscription-cli-supervisor.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


@pytest.mark.parametrize('phase', ['tasks', 'memory'])
def test_exclusive_profile_closes_all_nonstdio_and_forbids_ordinary_dispatch(phase):
    mode = 'candidate-resource-stress-' + phase
    s.require_launch_profile(mode, None, stress_phase=phase)
    for other in s.MODES:
        if other != mode:
            with pytest.raises(ValueError): s.require_launch_profile(other, None, stress_phase=phase)
    with pytest.raises(ValueError): s.require_launch_profile(mode, None)
    with patch.object(s.os, 'closerange') as close, patch.object(s, 'inspect_ingress_fd') as inspect:
        assert s.prepare_reexec(None, stress_phase=phase) == ['--inside-' + mode]
        close.assert_called_once_with(3, 65536)
        inspect.assert_not_called()
    assert s.fixed_command(mode) == ['/usr/bin/python3', '-I', '-S', '/usr/bin/candidate-resource-stress-child.py', '--inside-' + phase]
    with pytest.raises(ValueError): s.fixed_command(mode, 'normal')
    with pytest.raises(ValueError): s.fixed_arguments(mode)


@pytest.mark.parametrize('kwargs', [{'stress_phase': True}, {'stress_phase': 'other'},
    {'stress_phase': 'tasks', 'cgroup_worker': True}, {'stress_phase': 'tasks', 'cli_proxy_refusal': True},
    {'stress_phase': 'tasks', 'http_ingress': True}])
def test_mixed_profile_refused_before_descriptor_changes(kwargs):
    with patch.object(s.os, 'closerange') as close:
        with pytest.raises(ValueError): s.prepare_reexec(None, **kwargs)
        close.assert_not_called()


@pytest.mark.parametrize('phase', ['tasks', 'memory'])
def test_start_requires_exact_eleven_source_hashes_and_no_override(phase):
    frame = {'type': 'start', 'mode': 'candidate-resource-stress-' + phase, 'helperSha256': dict.fromkeys(s.STRESS_FILES, 'a'*64)}
    assert len(s.STRESS_FILES) == 11
    assert s.parse_frame(json.dumps(frame).encode()) == frame
    for change in ({'helperSha256': {}}, {'argv': ['login']}, {'fd': 198}, {'nonce': 'a'*32}, {'scenario': 'normal'}):
        with pytest.raises(ValueError): s.parse_frame(json.dumps({**frame, **change}).encode())


@pytest.mark.parametrize('phase', ['tasks', 'memory'])
def test_partial_writes_block_next_action_and_ack_only_after_complete_delivery(phase):
    queue = s.StressInput(phase)
    for action in (['start', 'release'] if phase == 'tasks' else ['start', 'ramp', 'release']):
        queue.accept(action)
        raw = ('{"version":1,"action":"' + action + '"}\n').encode()
        assert bytes(queue.pending) == raw
        with patch.object(s.os, 'write', return_value=1): assert queue.drain(9) is None
        with pytest.raises(ValueError): queue.accept('cancel')
        with patch.object(s.os, 'write', side_effect=BlockingIOError): assert queue.drain(9) is None
        with patch.object(s.os, 'write', return_value=len(raw)-1): assert queue.drain(9) == action
    with pytest.raises(ValueError): queue.accept('release')
    with pytest.raises(ValueError): queue.accept('cancel')


@pytest.mark.parametrize('phase', ['tasks', 'memory'])
def test_cancel_is_finite_and_no_arbitrary_payload(phase):
    queue = s.StressInput(phase)
    for action in ('ramp', 'release', 'unknown', True):
        with pytest.raises(ValueError): queue.accept(action)
    queue.accept('cancel')
    with patch.object(s.os, 'write', side_effect=lambda fd, raw: len(raw)): assert queue.drain(9) == 'cancel'
    with pytest.raises(ValueError): queue.accept('start')
    for frame in ({'type':'stress_action','action':'unknown'}, {'type':'stress_action','action':'start','data':'x'}):
        with pytest.raises(ValueError): s.parse_frame(json.dumps(frame).encode())


@pytest.mark.parametrize('count', [0, -1, True, 1000])
def test_unknown_write_accounting_never_delivery(count):
    queue = s.StressInput('tasks'); queue.accept('start')
    with patch.object(s.os, 'write', return_value=count):
        with pytest.raises(ValueError): queue.drain(9)


def test_new_startup_keeps_own_pipe_open_old_startup_closes_it():
    process = Mock(pid=12, stdin=Mock())
    with patch.object(s, 'trusted_control_startup_packet', return_value=b'fixed\n'), patch.object(s.os, 'write', return_value=6):
        s.write_stress_startup(process, {12: 90}, {})
        process.stdin.close.assert_not_called()
        s.write_trusted_control_startup(process, {12: 90}, {})
        process.stdin.close.assert_called_once()


def test_startup_requires_owned_pin_and_partial_write_fails():
    process = Mock(pid=12, stdin=Mock())
    with patch.object(s.os, 'write') as write:
        with pytest.raises(ValueError): s.write_stress_startup(process, {}, {})
        write.assert_not_called()
    with patch.object(s, 'trusted_control_startup_packet', return_value=b'fixed\n'), patch.object(s.os, 'write', return_value=1):
        with pytest.raises(RuntimeError): s.write_stress_startup(process, {12: 90}, {})


@pytest.mark.parametrize('failure', [OSError('close unknown'), ValueError('already corrupted')])
def test_owned_input_close_uncertainty_is_sticky_and_does_not_interrupt_other_cleanup(failure):
    process = Mock(stdin=Mock(close=Mock(side_effect=failure)))
    state = s.OwnedInputClose()
    state.close(process)
    assert state.attempted and not state.known
    process.stdin.close.side_effect = None
    state.close(process)
    process.stdin.close.assert_called_once()
    assert not state.known


def test_no_input_then_owned_input_is_closed_once():
    state = s.OwnedInputClose()
    state.close(None)
    state.close(Mock(stdin=None))
    assert not state.attempted and state.known
    process = Mock(stdin=Mock())
    state.close(process); state.close(process)
    process.stdin.close.assert_called_once()
    assert state.attempted and state.known
