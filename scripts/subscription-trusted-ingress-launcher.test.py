"""Offline descriptor admission and fixed launcher tests; no sockets/processes."""
import errno
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import sys
import pytest

spec = importlib.util.spec_from_file_location('fixed_ingress_test', Path(__file__).with_name('subscription-trusted-ingress-launcher.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


@pytest.mark.parametrize('case', ['valid', 'occupied', 'race', 'identity', 'regular', 'listener', 'unconnected'])
def test_fd198_never_overwritten_and_exact_socket_only(case):
    original = SimpleNamespace(st_mode=0o140777, st_dev=1, st_ino=2)
    copied = SimpleNamespace(**vars(original))
    if case == 'identity': copied.st_ino = 3
    if case == 'regular': copied.st_mode = 0o100600
    fcntl = SimpleNamespace(F_DUPFD_CLOEXEC=1030, fcntl=Mock(return_value=199 if case == 'race' else 198))
    peer = Mock(family=1, fileno=Mock(return_value=42))
    peer.getsockopt.side_effect = [1, 1 if case == 'listener' else 0]
    if case == 'unconnected': peer.getpeername.side_effect = OSError('unconnected')
    status = [original] if case == 'occupied' else [OSError(errno.EBADF, 'unused'), original, copied]
    with patch.dict(sys.modules, {'fcntl': fcntl}), patch.object(m.os, 'fstat', side_effect=status), \
         patch.object(m.os, 'close') as close, patch.object(m.socket, 'AF_UNIX', 1, create=True):
        if case == 'valid':
            assert m.reserve_ingress_fd(peer) == {'dev': 1, 'ino': 2, 'type': 49152, 'family': 1, 'socketType': 1}
            fcntl.fcntl.assert_called_once_with(42, 1030, 198); close.assert_not_called()
        else:
            with pytest.raises((ValueError, OSError)): m.reserve_ingress_fd(peer)
            if case == 'occupied': fcntl.fcntl.assert_not_called(); close.assert_not_called()
            elif case == 'race': close.assert_called_once_with(199)
            else: close.assert_called_once_with(198)


@pytest.mark.parametrize('phase,nonce', [('OTHER', 'a'*32), ('BEFORE', 'A'*32), ('AFTER', 'a'*31)])
def test_fixed_challenges_reject_arbitrary_values(phase, nonce):
    with pytest.raises(ValueError): m.challenge(phase, nonce)


def test_exact_fragmented_challenge_and_no_raw_error_disclosure():
    expected = b'BEFORE ' + b'a'*32 + b'\n'
    peer = Mock(recv=Mock(side_effect=[expected[:9], expected[9:]]))
    assert m.recv_exact(peer, expected, m.time.monotonic()+1) == len(expected)
    peer.recv.side_effect = [b'x'*len(expected)]
    with pytest.raises(ValueError, match='FIXTURE_CHALLENGE_MISMATCH'): m.recv_exact(peer, expected, m.time.monotonic()+1)


def test_fixed_command_and_cli_reject_extra_input():
    assert m.COMMAND[:5] == ('/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '200', '/usr/bin/unshare')
    assert m.COMMAND[-1] == '--trusted-ingress-fd'
    with patch.object(m.sys, 'argv', ['launcher', '--fd', '42']), patch.object(m, 'run') as run:
        with pytest.raises(ValueError): m.main()
        run.assert_not_called()


def test_unknown_previous_launch_cannot_create_more_sockets():
    with patch.object(m, '_RUN_USED', True), patch.object(m, 'source_hashes') as hashes:
        with pytest.raises(ValueError, match='SINGLE_USE_FENCE'): m.run()
        hashes.assert_not_called()


@pytest.mark.parametrize('failure', [None, 'spawn', 'pidfd', 'ownership-emit', 'terminal-emit'])
def test_ownership_precedes_only_fixed_spawn_and_terminal_follows_wait(failure):
    import hashlib
    events = []
    endpoints = [Mock(fileno=Mock(return_value=-1)) for _ in range(6)]
    broker = SimpleNamespace(_sockets=tuple(endpoints[:3]), cleanup_known=False)
    proxy = SimpleNamespace(create_offline_session=Mock(return_value=(broker, *endpoints[3:])))
    raw = (m.ROOT / 'subscription-trusted-egress-proxy.py').read_bytes()
    before = {'subscription-trusted-egress-proxy.py': hashlib.sha256(raw).hexdigest()}
    proc = Mock(pid=123)
    proc.wait.side_effect = lambda **_kwargs: events.append('wait') or 0
    def spawn(*args, **kwargs):
        events.append('spawn')
        assert args == (m.COMMAND,)
        assert kwargs == {'env': {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, 'close_fds': True, 'pass_fds': (198,)}
        if failure == 'spawn': raise OSError('spawn failed')
        return proc
    thread = Mock(is_alive=Mock(return_value=False))
    def emit(frame):
        events.append(frame['type'])
        if (failure == 'ownership-emit' and frame['type'] == 'ingress_ownership'
                or failure == 'terminal-emit' and frame['type'] == 'ingress_terminal'):
            raise TimeoutError('bounded emit failed')
    with patch.object(m, '_RUN_USED', False), patch.object(m.sys, 'platform', 'linux'), patch.object(m, 'source_hashes', return_value=before), \
         patch.object(m.importlib.util, 'module_from_spec', return_value=proxy), patch.object(m, 'exec', Mock(), create=True), \
         patch.object(m, 'reserve_ingress_fd', return_value={'dev': 1, 'ino': 2, 'type': 49152, 'family': 1, 'socketType': 1}), \
         patch.object(m, 'emit', side_effect=emit), patch.object(m.subprocess, 'Popen', side_effect=spawn), \
         patch.object(m.os, 'close', side_effect=lambda fd: events.append('close-' + str(fd))), \
         patch.object(m.os, 'pidfd_open', return_value=99, side_effect=OSError('pin failed') if failure == 'pidfd' else None, create=True), \
         patch.object(m.threading, 'Thread', return_value=thread):
        assert m.run() == 1  # no fake relay/report earns success
    if failure == 'ownership-emit':
        assert 'spawn' not in events and 'ingress_terminal' not in events
        assert events.count('close-198') == 1
    else:
        assert events.index('ingress_ownership') < events.index('spawn')
        assert events.index('spawn') < events.index('close-198')
        if failure != 'spawn': assert events.index('wait') < events.index('ingress_terminal')
    for index, endpoint in enumerate(endpoints):
        assert endpoint.close.call_count == (2 if index == 3 and failure not in ('spawn', 'ownership-emit') else 1)


@pytest.mark.parametrize('failure', [False, True])
def test_emit_is_partial_nonblocking_bounded_and_restores_stdout_flags(failure):
    import json
    clock = [0.0]; emitted = bytearray(); calls = [0]
    def write(fd, raw):
        assert fd == 1
        calls[0] += 1
        if failure or calls[0] % 2:
            raise BlockingIOError()
        emitted.extend(raw[:3]); return min(3, len(raw))
    def ready(*args): clock[0] += 0.05; return ([], [], [])
    with patch.object(m.os, 'get_blocking', return_value=True), patch.object(m.os, 'set_blocking') as blocking, \
         patch.object(m.os, 'write', side_effect=write), patch.object(m.select, 'select', side_effect=ready), \
         patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
        if failure:
            with pytest.raises(TimeoutError, match='FRAME_WRITE_DEADLINE'): m.emit({'type': 'ingress_ownership'})
            assert not emitted and clock[0] < 2.1
        else:
            m.emit({'type': 'ingress_ownership'})
            assert json.loads(emitted) == {'type': 'ingress_ownership'}
        assert [call.args for call in blocking.call_args_list] == [(1, False), (1, True)]


def test_emit_delayed_writable_signal_never_writes_after_deadline():
    clock = [0.0]
    def ready(*args): clock[0] = 3.0; return ([], [1], [])
    with patch.object(m.os, 'get_blocking', return_value=True), patch.object(m.os, 'set_blocking'), \
         patch.object(m.os, 'write', side_effect=BlockingIOError()) as write, patch.object(m.select, 'select', side_effect=ready), \
         patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
        with pytest.raises(TimeoutError): m.emit({'type': 'ingress_terminal'})
        write.assert_called_once()
