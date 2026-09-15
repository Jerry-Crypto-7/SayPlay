"""Fixed driver source binding and unit isolation checks; no systemd launch."""
import copy
import importlib.util
from pathlib import Path
from unittest.mock import Mock

import pytest

path = Path(__file__).with_name('subscription-tool-capture.measure.py')
spec = importlib.util.spec_from_file_location('capture_measure_test', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def terminal():
    hashes = {name: 'a' * 64 for name in m.SOURCES}
    value = {'passed': True, 'error': None,
        'sourceSha256': {key: hashes[name] for key, name in m.RUNTIME_SOURCES.items()},
        'binarySha256': {'codex': 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
                        'bwrap': '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'},
        'controller': {'turnCompleted': True, 'failed': False},
        'peer': {'complete': True, 'failed': False}, 'capture': {'report': {'captureComplete': True}},
        'streamEOF': {'stdout': True, 'stderr': True},
        'cleanup': {'namespaceEmpty': True, 'allObservedPidfdsESRCH': True, 'errors': []}}
    return value, hashes


@pytest.mark.parametrize('case', ['source', 'binary', 'capture', 'cleanup', 'eof', 'controller', 'peer'])
def test_driver_rejects_inconsistent_self_reported_success(case):
    value, hashes = terminal()
    assert m.valid_terminal(value, hashes)
    value = copy.deepcopy(value)
    if case == 'source': value['sourceSha256']['runner'] = 'b' * 64
    if case == 'binary': value['binarySha256']['codex'] = 'b' * 64
    if case == 'capture': value['capture'] = None
    if case == 'cleanup': value['cleanup']['namespaceEmpty'] = False
    if case == 'eof': value['streamEOF']['stderr'] = False
    if case == 'controller': value['controller']['failed'] = True
    if case == 'peer': value['peer']['complete'] = False
    assert not m.valid_terminal(value, hashes)


def test_fixed_unit_command_has_limits_namespaces_and_no_caller_payload():
    command = m.command('codex-tool-capture-' + 'a' * 32 + '.service')
    for flag in ['--property=MemoryMax=2G', '--property=TasksMax=64',
                 '--property=RuntimeMaxSec=180', '--property=KillMode=control-group',
                 '--user', '--map-current-user', '--mount', '--net', '--pid', '--uts']:
        assert flag in command
    assert command[-1] == str(m.ROOT / 'scripts/subscription-tool-capture-capsule.sh')
    assert '--collect' in command and '--pipe' in command


@pytest.mark.parametrize('case', ['kill-fails', 'wait-fails', 'close-fails'])
def test_process_cleanup_failure_still_attempts_both_pipe_closes(monkeypatch, case):
    monkeypatch.setattr(m.signal, 'SIGKILL', 9, raising=False)
    process = Mock(pid=123)
    timeout = m.subprocess.TimeoutExpired('owned-process', 3)
    process.wait.side_effect = [timeout, timeout]
    kill = Mock(side_effect=OSError('authored kill failure') if case == 'kill-fails' else None)
    monkeypatch.setattr(m.os, 'killpg', kill, raising=False)
    if case == 'close-fails': process.stdout.close.side_effect = OSError('authored close failure')
    assert m.close_process(process) is not None
    process.stdout.close.assert_called_once()
    process.stderr.close.assert_called_once()
    kill.assert_called_once_with(123, 9)
