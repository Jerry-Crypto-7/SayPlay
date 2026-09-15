"""Host evaluator rejects forged success; no systemd or runtime launch."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

PATH = Path(__file__).with_name('subscription-captured-session.measure.py')
SPEC = importlib.util.spec_from_file_location('session_measure_test', PATH)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def event(method, **params):
    raw = json.dumps({'method': 'process/' + method, 'params': params}).encode()
    return {'kind': 'notification', 'inputHex': raw.hex()}


def terminal(monkeypatch):
    hashes = {name: 'a' * 64 for name in m.SOURCES}
    worker = {'authored': 'probe-fixture'}
    events = [event('output', stream='stdout', chunk=base64.b64encode(json.dumps(worker).encode()).decode()),
              event('exited', exitCode=0, sandboxDenied=False)]
    protocol = {'protocol': {'events': events}, 'writtenBytes': {'client': 4, 'worker': 5}, 'inputBytes': 7}
    value = {'kind': 'authored-client-real-worker-session', 'passed': True, 'error': None,
        'sourceSha256': {key: hashes[name] for key, name in m.RUNTIME_SOURCES.items()},
        'binarySha256': {'codex': 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
                        'bwrap': '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'},
        'realWorkerValidated': True, 'stockClientAttested': False, 'inferenceAttested': False,
        'productionReady': False, 'workerReturncode': 0, 'stderrEof': True, 'peerJoined': True,
        'peerErrors': [], 'cleanup': {'namespaceEmpty': True, 'allObservedPidfdsESRCH': True,
                                   'observedPidfds': 2, 'errors': []},
        'threadId': 'fixed-thread', 'outerPidNamespace': 'pid:[101]', 'outerMountNamespace': 'mnt:[202]',
        'workerReport': worker, 'marker': {'namespaces': {'trustedPid': 'pid:[101]', 'trustedMount': 'mnt:[202]'}},
        'pump': {'protocol': protocol, 'complete': True, 'error': None, 'localSocketsClosed': True,
                 'socketIo': {'inputEof': {'client': True, 'worker': True},
                              'sentBytes': {'client': 4, 'worker': 5}, 'receivedBytes': {'client': 3, 'worker': 4}},
                 'executionAttested': False, 'remoteCleanupAttested': False, 'productionReady': False}}
    replay, validate_probe = Mock(return_value=True), Mock(return_value=True)
    modules = {'session': SimpleNamespace(validate_report=replay),
               'runner': SimpleNamespace(THREAD='fixed-thread'),
               'boundary': SimpleNamespace(strict_json=json.loads),
               'cli_probe': SimpleNamespace(adapt=lambda _: validate_probe)}
    monkeypatch.setattr(m, 'load_source', lambda key, _: (modules.get(key), key.encode()))
    return value, hashes, replay, validate_probe


def test_success_requires_both_independent_replays_and_bound_output(monkeypatch):
    value, hashes, replay, validate = terminal(monkeypatch)
    assert m.valid_terminal(value, hashes)
    replay.assert_called_once_with(value['pump']['protocol'], b'transport', b'adapter', b'gate',
                                   'fixed-thread', 'pid:[101]', 'mnt:[202]')
    validate.assert_called_once_with(value['workerReport'], value['marker'])


@pytest.mark.parametrize('case', ['source', 'binary', 'cleanup', 'zero-pidfds', 'stderr-eof', 'peer',
    'claimed-stock', 'exit-bool', 'pump-bytes', 'pump-eof', 'worker-body', 'marker-ns', 'thread',
    'transcript-exit', 'transcript-stderr', 'protocol-replay', 'probe-replay'])
def test_terminal_tampering_cannot_turn_into_success(monkeypatch, case):
    value, hashes, replay, validate = terminal(monkeypatch)
    value = copy.deepcopy(value)
    if case == 'source': value['sourceSha256']['runner'] = 'b' * 64
    elif case == 'binary': value['binarySha256']['codex'] = 'b' * 64
    elif case == 'cleanup': value['cleanup']['namespaceEmpty'] = False
    elif case == 'zero-pidfds': value['cleanup']['observedPidfds'] = 0
    elif case == 'stderr-eof': value['stderrEof'] = False
    elif case == 'peer': value['peerJoined'] = False
    elif case == 'claimed-stock': value['stockClientAttested'] = True
    elif case == 'exit-bool': value['workerReturncode'] = False
    elif case == 'pump-bytes': value['pump']['socketIo']['sentBytes']['client'] += 1
    elif case == 'pump-eof': value['pump']['socketIo']['inputEof']['worker'] = False
    elif case == 'worker-body': value['workerReport']['authored'] = 'unbound'
    elif case == 'marker-ns': value['marker']['namespaces']['trustedPid'] = 'pid:[999]'
    elif case == 'thread': value['threadId'] = 'untrusted-thread'
    elif case == 'transcript-exit': value['pump']['protocol']['protocol']['events'][-1] = event('exited', exitCode=1, sandboxDenied=False)
    elif case == 'transcript-stderr': value['pump']['protocol']['protocol']['events'][0] = event('output', stream='stderr', chunk='YQ==')
    elif case == 'protocol-replay': replay.return_value = False
    elif case == 'probe-replay': validate.return_value = False
    assert not m.valid_terminal(value, hashes)


def test_source_drift_rejected_before_execution(monkeypatch):
    monkeypatch.setattr(m, 'ROOT', PATH.parent.parent)
    with pytest.raises(ValueError, match='REPLAY_SOURCE_DRIFT'):
        m.load_source('session', {'subscription-captured-session.py': '0' * 64})


def test_fixed_capsule_inventory_covers_every_runtime_source():
    capsule = PATH.with_name('subscription-captured-session-capsule.sh').read_text(encoding='utf-8')
    runner_spec = importlib.util.spec_from_file_location('session_inventory_runner',
        PATH.with_name('subscription-captured-session-runner.py'))
    runner = importlib.util.module_from_spec(runner_spec)
    runner_spec.loader.exec_module(runner)
    assert set(runner.FILES) == set(m.RUNTIME_SOURCES)
    for key, source in m.RUNTIME_SOURCES.items():
        assert '/scripts/' + source + ' "$root' + runner.FILES[key] + '"' in capsule
    assert len(m.SOURCES) == len(set(m.SOURCES)) == 22
    assert '"$root/usr/bin/captured-session-runner.py" "$root"' in capsule


def test_fixed_command_retains_owned_unit_limits_and_namespaces():
    unit = 'codex-captured-session-worker-' + 'a' * 32 + '.service'
    command = m.command(unit)
    for flag in ('--unit=' + unit, '--property=MemoryMax=2G', '--property=MemorySwapMax=0',
                 '--property=TasksMax=64', '--property=RuntimeMaxSec=180', '--property=KillMode=control-group',
                 '--map-current-user', '--mount', '--net', '--pid', '--uts', '--collect'):
        assert flag in command
    assert command[-1] == str(m.ROOT / 'scripts/subscription-captured-session-capsule.sh')


@pytest.mark.parametrize('case', ['kill-fails', 'wait-fails', 'close-fails'])
def test_cleanup_failure_still_attempts_both_pipe_closes(monkeypatch, case):
    monkeypatch.setattr(m.signal, 'SIGKILL', 9, raising=False)
    process = Mock(pid=123)
    process.wait.side_effect = [m.subprocess.TimeoutExpired('owned-process', 3)] * 2
    kill = Mock(side_effect=OSError('authored failure') if case == 'kill-fails' else None)
    monkeypatch.setattr(m.os, 'killpg', kill, raising=False)
    if case == 'close-fails': process.stdout.close.side_effect = OSError('authored failure')
    assert m.close_process(process) is not None
    process.stdout.close.assert_called_once()
    process.stderr.close.assert_called_once()
    kill.assert_called_once_with(123, 9)
