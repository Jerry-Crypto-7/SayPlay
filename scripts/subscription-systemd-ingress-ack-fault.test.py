"""Offline fault injection ordering, owned identity and replay tests."""
import copy
import errno
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import pytest


def load(name):
    path = Path(__file__).with_name(name); spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


m = load('subscription-systemd-ingress-ack-fault.py')
w = load('subscription-systemd-ingress-ack-fault.measure.py')
fixtures = load('subscription-trusted-ingress-systemd.measure.test.py')


def report_fixture():
    source = fixtures.report_fixture(); before = m.hashes(); own = source['frames'][0]; ingress = source['frames'][1]
    ingress['ownership']['sourceSha256'] = {name: before['scripts/' + name] for name in m.load(m.RENDEZVOUS).SOURCES}
    binding = source['frames'][2]['handoff']['control']; unit = own['ownership']['unit']; nonce = ingress['ownership']['nonce']
    route = {'version': 1, 'unit': unit, 'nonce': nonce, 'route': {'beforeBytes': 0, 'afterBytes': 0, 'eof': False},
        'broker': None, 'threadsClosed': True, 'ownedCleanupVerified': True, 'pathCleanup': {'socketRemoved': True, 'directoryRemoved': True},
        'peersClosed': True, 'errors': [], 'remoteUnitCleanup': 'NOT_ATTESTED', 'productionReady': False, 'passed': False, 'sourceStable': True}
    fault = {'hello': {'version': 1, 'type': 'receiver_hello', 'uuid': ingress['ownership']['uuid'], 'nonce': nonce,
        'pid': binding['unitMainPid'], 'startTicks': binding['unitMainStartTimeTicks']}, 'binding': binding,
        'transferStartedAt': 10.0, 'deadline': 15.0, 'offerWrittenAt': 10.1, 'stopSentAt': 10.2, 'stoppedAt': 10.3,
        'stoppedState': {'pid': binding['unitMainPid'], 'state': 'T', 'startTicks': binding['unitMainStartTimeTicks'], 'cgroup': binding['unitMainCgroup']},
        'sendCalls': [{'startedAt': 10.4, 'returnedAt': 10.5, 'returnCount': 1}], 'ackFramesObserved': 0,
        'transferError': {'type': 'TimeoutError', 'message': 'HANDOFF_DEADLINE'}, 'transferEndedAt': 15.01,
        'fenced': True, 'secondConstructorError': 'PREVIOUS_HANDOFF_UNCERTAIN', 'retainedPidfdESRCH': True, 'retainedPidfdClosed': True}
    failed = {'version': 1, 'type': 'systemd_failure', 'ownership': own['ownership'], 'error': 'TimeoutError:HANDOFF_DEADLINE;RELAY_INCOMPLETE',
        'cleanup': {'unitAbsent': True, 'leafAbsent': True, 'systemdRunClosed': True}, 'diagnostics': {'notSpawned': False},
        'stageEvidence': {'capsuleFailureTerminal': None}}
    final = {'version': 1, 'type': 'ack_fault_terminal', 'profile': 'stopped-owned-receiver-before-scm', 'sourceBefore': before,
        'sourceAfter': dict(before), 'relayReturnCode': 1, 'systemdRunReturnCode': 1, 'fault': fault, 'error': None,
        'productionReady': False, 'capsuleValidated': False, 'namespaceCleanupValidated': False, 'actualModelCalls': 0}
    frames = [own, ingress, {'version': 1, 'type': 'systemd_ingress_terminal', 'result': route}, failed, final]
    raw = b''.join(json.dumps(frame).encode() + b'\n' for frame in frames)
    return {'sourceBefore': before, 'sourceAfter': dict(before), 'command': list(w.COMMAND), 'localWaitKnown': True, 'localReturnCode': 0,
        'readersClosed': True, 'stdinClosed': True, 'outputComplete': True, 'errors': [], 'stderrHex': '', 'stdoutHex': raw.hex(),
        'stdoutBytes': len(raw), 'stdoutSha256': hashlib.sha256(raw).hexdigest()}, frames


def reseal(report, frames):
    raw = b''.join(json.dumps(frame).encode() + b'\n' for frame in frames)
    report.update(stdoutHex=raw.hex(), stdoutBytes=len(raw), stdoutSha256=hashlib.sha256(raw).hexdigest())


def test_expected_failure_is_not_handoff_or_namespace_success():
    report, _ = report_fixture(); assert w.evaluate(report)
    assert len(report['sourceBefore']) == 32


@pytest.mark.parametrize('case', ['early', 'send-before-stop', 'no-stop', 'two-send', 'short-send', 'ack', 'wrong-generation',
    'manager-as-receiver', 'not-fenced', 'second-constructor', 'esrch', 'pin-close', 'unit', 'leaf', 'run', 'path', 'broker',
    'ready', 'source', 'known-wait', 'local-exit', 'raw-hash', 'short-deadline', 'manager-socket-missing', 'manager-ticks-missing', 'stdin-open', 'receiver-setup-timeout'])
def test_expected_failure_requires_each_independent_evidence(case):
    report, frames = report_fixture(); fault = frames[-1]['fault']
    if case == 'early': fault['transferEndedAt'] = 14.99
    if case == 'send-before-stop': fault['sendCalls'][0]['startedAt'] = 10.1
    if case == 'no-stop': fault['stoppedState']['state'] = 'R'
    if case == 'two-send': fault['sendCalls'].append(copy.deepcopy(fault['sendCalls'][0]))
    if case == 'short-send': fault['sendCalls'][0]['returnCount'] = 0
    if case == 'ack': fault['ackFramesObserved'] = 1
    if case == 'wrong-generation': fault['stoppedState']['startTicks'] = '999'
    if case == 'manager-as-receiver': fault['binding']['unitMainPid'] = fault['binding']['managerPid']
    if case == 'not-fenced': fault['fenced'] = False
    if case == 'second-constructor': fault['secondConstructorError'] = None
    if case == 'esrch': fault['retainedPidfdESRCH'] = False
    if case == 'pin-close': fault['retainedPidfdClosed'] = False
    if case in ('unit', 'leaf', 'run'): frames[3]['cleanup'][{'unit': 'unitAbsent', 'leaf': 'leafAbsent', 'run': 'systemdRunClosed'}[case]] = False
    if case == 'path': frames[2]['result']['pathCleanup']['socketRemoved'] = False
    if case == 'broker': frames[2]['result']['broker'] = {'reason': 'EOF'}
    if case == 'ready': frames.insert(2, {'version': 1, 'type': 'ready'})
    if case == 'source': report['sourceAfter'][m.RELAY] = '0' * 64
    if case == 'known-wait': report['localWaitKnown'] = False
    if case == 'local-exit': report['localReturnCode'] = 1
    if case == 'short-deadline': fault['deadline'] = 14.9
    if case == 'manager-socket-missing': fault['binding'].pop('managerSocket')
    if case == 'manager-ticks-missing': fault['binding'].pop('managerStartTimeTicks')
    if case == 'stdin-open': report['stdinClosed'] = False
    if case == 'receiver-setup-timeout':
        fault['transferError']['message'] = 'RECEIVER_SETUP_DEADLINE'
        frames[3]['error'] = 'TimeoutError:RECEIVER_SETUP_DEADLINE;RELAY_INCOMPLETE'
    reseal(report, frames)
    if case == 'raw-hash': report['stdoutSha256'] = '0' * 64
    assert not w.evaluate(report)


def fault_fixture():
    report, frames = report_fixture(); evidence = frames[-1]['fault']; binding = evidence['binding']
    receiver = SimpleNamespace(check_time=Mock())
    relay = SimpleNamespace(binding=Mock(return_value=binding))
    obj = SimpleNamespace(uuid=frames[1]['ownership']['uuid'], nonce=frames[1]['ownership']['nonce'], unit=frames[0]['ownership']['unit'],
        pin=88, modules=SimpleNamespace(receiver=receiver, relay=relay, probe=object()))
    fault = m.Fault(obj, SimpleNamespace()); fault.report['hello'] = evidence['hello']
    return fault, binding, evidence['stoppedState']


@pytest.mark.parametrize('case', ['valid', 'wrong-hello', 'foreign-manager', 'generation', 'rebind', 'stop-failed'])
def test_signal_only_duplicate_of_bound_own_pin(case):
    fault, binding, stopped = fault_fixture()
    if case == 'wrong-hello': fault.report['hello']['pid'] = 999
    if case == 'foreign-manager': binding['managerPid'] = binding['unitMainPid']
    if case == 'generation': stopped['startTicks'] = '999'
    if case == 'rebind': fault.obj.modules.relay.binding.side_effect = [binding, {**binding, 'unitMainPid': 999}]
    def sent(fd, sig):
        if case == 'stop-failed' and sig == m.signal.SIGSTOP: raise OSError(errno.ESRCH, 'gone')
    with patch.object(m.os, 'dup', return_value=89) as dup, patch.object(m.os, 'set_inheritable') as inherit, \
         patch.object(m.signal, 'SIGSTOP', 19, create=True), \
         patch.object(m.signal, 'pidfd_send_signal', side_effect=sent, create=True) as send, patch.object(m, 'own_state', return_value=stopped), \
         patch.object(m.time, 'monotonic', return_value=10):
        if case == 'valid':
            fault.stop(15, {}, 99); assert fault.report['stoppedAt'] == 10
            dup.assert_called_once_with(88); inherit.assert_called_once_with(89, False)
            assert [call.args for call in send.call_args_list if call.args[1] != 0] == [(89, m.signal.SIGSTOP)]
        else:
            with pytest.raises((ValueError, OSError)): fault.stop(15, {}, 99)
            if case != 'stop-failed': assert all(call.args[1] == 0 for call in send.call_args_list)


def test_retained_handle_esrch_and_close_separate():
    fault, _, _ = fault_fixture(); fault.pin = 89
    with patch.object(m.signal, 'pidfd_send_signal', side_effect=OSError(errno.ESRCH, 'gone'), create=True), patch.object(m.os, 'close') as close:
        fault.close_pin()
        assert fault.report['retainedPidfdESRCH'] and fault.report['retainedPidfdClosed']
        close.assert_called_once_with(89)


def test_no_caller_entry_before_sources():
    with patch.object(w.sys, 'argv', ['measure', '--fault']), patch.object(w, 'load') as loaded:
        with pytest.raises(ValueError): w.main()
        loaded.assert_not_called()


def test_failed_nonblocking_admission_never_writes():
    with patch.object(m.os, 'set_blocking', side_effect=OSError('denied')), patch.object(m.os, 'write') as write:
        with pytest.raises(OSError): m.emit_report({'version': 1})
        write.assert_not_called()


def test_private_popen_does_not_intercept_run_module_globals():
    import subprocess
    callback = Mock()
    proxy = m.private_subprocess(subprocess, callback)
    assert proxy.Popen is callback and proxy.run is subprocess.run
    assert proxy.run.__globals__['Popen'] is subprocess.Popen
    assert proxy.run.__globals__['Popen'] is not callback


def test_fixed_wrapper_real_companion_order_one_send_and_same_module_fence():
    helper = load('subscription-systemd-ingress-rendezvous.test.py'); companion = helper.m
    obj, channel, hello, _ = helper.prepared(); obj.sources = {'fixed': 'hash'}
    fault = m.Fault(obj, companion); fault.original_transfer = obj.transfer
    events = []
    obj.modules.receiver.send_frame.side_effect = lambda *args: events.append('offer-written')
    def stop(deadline, manager, manager_fd):
        assert events == ['offer-written']
        events.append('stopped'); fault.report['stoppedAt'] = m.time.monotonic()
    fault.stop = stop
    channel.sendmsg.side_effect = lambda *args: events.append('actual-send') or 1
    with patch.object(companion, '_FENCED', False), patch.object(companion.os, 'getuid', return_value=1000, create=True), \
         patch.object(companion.os, 'getgid', return_value=1000, create=True), patch.object(companion.os, 'pidfd_open', return_value=88, create=True), \
         patch.object(companion.signal, 'pidfd_send_signal', create=True), patch.object(companion.os, 'close'), \
         patch.object(companion.socket, 'SO_PEERCRED', 17, create=True), patch.object(companion.socket, 'SCM_RIGHTS', 1, create=True), \
         patch.object(companion.socket, 'MSG_DONTWAIT', 64, create=True), \
         patch.object(companion.os, 'fstat', return_value=SimpleNamespace(st_dev=1, st_ino=2, st_mode=0o140777)), \
         patch.object(companion, 'receive_plain', side_effect=[hello, TimeoutError('HANDOFF_DEADLINE')]), \
         patch.object(companion, 'load_modules') as loaded:
        with pytest.raises(TimeoutError): fault.transfer({}, 99)
        assert events == ['offer-written', 'stopped', 'actual-send']
        assert len(fault.report['sendCalls']) == 1 and fault.report['sendCalls'][0]['returnCount'] == 1
        assert fault.report['fenced'] and fault.report['secondConstructorError'] == 'PREVIOUS_HANDOFF_UNCERTAIN'
        loaded.assert_not_called()


@pytest.mark.parametrize('fail_start', [False, True])
def test_fixed_capture_pipe_and_thread_setup_failure_are_archivable(fail_start):
    process = SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(b'fixed\n'), stderr=io.BytesIO(), wait=Mock(return_value=0))
    constructed = []
    class Thread:
        def __init__(self, target, args, daemon): self.target = target; self.args = args; constructed.append(self)
        def start(self):
            if fail_start and len(constructed) == 2: raise RuntimeError('thread setup')
            self.target(*self.args)
        def join(self, timeout): pass
        def is_alive(self): return False
    with patch.object(w.subprocess, 'Popen', return_value=process) as spawn, patch.object(w.threading, 'Thread', Thread):
        result = w.capture_fixed()
        assert spawn.call_args.kwargs['stdin'] == w.subprocess.PIPE
        assert process.stdin.closed and result['stdinClosed']
        assert process.stdout.closed and process.stderr.closed
        if fail_start:
            assert result['errors'] == ['RuntimeError'] and not result['localWaitKnown'] and not result['readersClosed']
            process.wait.assert_not_called()
        else: assert result['errors'] == [] and result['localWaitKnown'] and result['readersClosed']
