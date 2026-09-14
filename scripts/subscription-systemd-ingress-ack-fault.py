"""Fixed stopped owned receiver experiment. No shared source mutations."""
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import time
import types

ROOT = Path(__file__).resolve().parents[1]
SELF = 'scripts/subscription-systemd-ingress-ack-fault.py'
MEASURE = 'scripts/subscription-systemd-ingress-ack-fault.measure.py'
SUCCESS = 'scripts/subscription-trusted-ingress-systemd.measure.py'
RELAY = 'scripts/subscription-systemd-fixture-transport.py'
RENDEZVOUS = 'scripts/subscription-systemd-ingress-rendezvous.py'
LOADED_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def same(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def load(path, before=None):
    raw = (ROOT / path).read_bytes()
    if before is not None and hashlib.sha256(raw).hexdigest() != before.get(path): raise ValueError('FAULT_SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('ack_fault_' + Path(path).name, ROOT / path)
    module = importlib.util.module_from_spec(spec); exec(compile(raw, str(ROOT / path), 'exec'), module.__dict__)
    module.loadedSha = hashlib.sha256(raw).hexdigest()
    return module


def sources():
    success = load(SUCCESS)
    _, _, driver = success.stack()
    result = tuple(dict.fromkeys((*driver.SOURCES, SELF, MEASURE)))
    if len(result) != 32: raise ValueError('FIXED_32_SOURCES_REQUIRED')
    return result


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources()}


def own_state(pid):
    # Only called after same-unit peer/HELLO/pidfd admission, never caller PID.
    with open(f'/proc/{pid}/stat', 'rb') as file: raw = file.read(4097)
    if len(raw) > 4096: raise ValueError('OWN_STAT_LIMIT')
    head, tail = raw.decode('ascii').rsplit(') ', 1); fields = tail.split()
    if int(head.split(' (', 1)[0]) != pid or len(fields) < 20: raise ValueError('OWN_STAT_IDENTITY')
    with open(f'/proc/{pid}/cgroup', 'rb') as file: group = file.read(4097)
    if len(group) > 4096 or not group.startswith(b'0::/') or group.count(b'\n') != 1: raise ValueError('OWN_CGROUP_SHAPE')
    return {'pid': pid, 'state': fields[0], 'startTicks': fields[19], 'cgroup': group.decode('ascii')[3:].rstrip('\n')}


class Fault:
    def __init__(self, rendezvous, companion):
        self.obj = rendezvous; self.companion = companion; self.pin = None
        self.report = {'hello': None, 'binding': None, 'deadline': None, 'offerWrittenAt': None,
            'transferStartedAt': None,
            'stopSentAt': None, 'stoppedAt': None, 'stoppedState': None, 'sendCalls': [], 'ackFramesObserved': 0,
            'transferError': None, 'transferEndedAt': None, 'fenced': False, 'secondConstructorError': None,
            'retainedPidfdESRCH': False, 'retainedPidfdClosed': False}

    def stop(self, deadline, manager, manager_fd):
        obj = self.obj; receiver = obj.modules.receiver; relay = obj.modules.relay
        receiver.check_time(deadline)
        current = relay.binding(obj.modules.probe, obj.unit, manager, manager_fd)
        hello = self.report['hello']
        expected = {'version': 1, 'type': 'receiver_hello', 'uuid': obj.uuid, 'nonce': obj.nonce,
            'pid': current['unitMainPid'], 'startTicks': current['unitMainStartTimeTicks']}
        if not same(hello, expected) or current['unitMainPid'] in (current['driverPid'], current['managerPid']):
            raise ValueError('FAULT_RECEIVER_IDENTITY_REQUIRED')
        if obj.pin is None or self.pin is not None: raise ValueError('FAULT_ORIGINAL_PIN_REQUIRED')
        signal.pidfd_send_signal(obj.pin, 0)
        self.pin = os.dup(obj.pin); os.set_inheritable(self.pin, False)
        signal.pidfd_send_signal(self.pin, 0)
        value = own_state(current['unitMainPid'])
        if value['startTicks'] != current['unitMainStartTimeTicks'] or value['cgroup'] != current['unitMainCgroup']:
            raise ValueError('FAULT_RECEIVER_GENERATION_CHANGED')
        if not same(relay.binding(obj.modules.probe, obj.unit, manager, manager_fd), current):
            raise ValueError('FAULT_REBIND_CHANGED')
        receiver.check_time(deadline); signal.pidfd_send_signal(self.pin, 0)
        self.report['binding'] = current
        signal.pidfd_send_signal(self.pin, signal.SIGSTOP)
        self.report['stopSentAt'] = time.monotonic()
        while True:
            receiver.check_time(deadline); signal.pidfd_send_signal(self.pin, 0)
            value = own_state(current['unitMainPid'])
            if value['startTicks'] != current['unitMainStartTimeTicks'] or value['cgroup'] != current['unitMainCgroup']:
                raise ValueError('FAULT_STOP_GENERATION_CHANGED')
            signal.pidfd_send_signal(self.pin, 0); receiver.check_time(deadline)
            if value['state'] in ('T', 't'):
                self.report.update(stoppedAt=time.monotonic(), stoppedState=value)
                break
            time.sleep(min(0.005, max(0, deadline - time.monotonic())))

    def transfer(self, manager, manager_fd):
        obj = self.obj; receiver = obj.modules.receiver
        original_send = receiver.send_frame; original_receive = self.companion.receive_plain
        original_transfer = self.original_transfer
        fault = self
        class Channel:
            def __init__(self, actual): self.actual = actual
            def __getattr__(self, name): return getattr(self.actual, name)
            def sendmsg(self, *args):
                if fault.report['stoppedAt'] is None or fault.report['sendCalls']: raise ValueError('FAULT_ONE_SEND_AFTER_STOP')
                receiver.check_time(fault.report['deadline'])
                # Original transfer constructs the exact SCM_RIGHTS operation.
                record = {'startedAt': time.monotonic(), 'returnedAt': None, 'returnCount': None}
                fault.report['sendCalls'].append(record)
                count = self.actual.sendmsg(*args)
                record.update(returnedAt=time.monotonic(), returnCount=count)
                return count
        def receive(channel, deadline):
            value = original_receive(channel, deadline)
            if type(value) is dict and value.get('type') == 'receiver_hello':
                if fault.report['hello'] is not None: raise ValueError('FAULT_DUPLICATE_HELLO')
                fault.report['hello'] = value
            elif type(value) is dict and value.get('type') == 'fd_received': fault.report['ackFramesObserved'] += 1
            return value
        def send(channel, frame, deadline):
            if frame.get('type') != 'fd_offer' or fault.report['offerWrittenAt'] is not None or channel is not obj.channel:
                raise ValueError('FAULT_FIXED_OFFER_ONLY')
            original_send(channel, frame, deadline)
            fault.report.update(offerWrittenAt=time.monotonic(), deadline=deadline)
            fault.stop(deadline, manager, manager_fd)
            obj.channel = Channel(channel)
        receiver.send_frame = send; self.companion.receive_plain = receive
        try:
            self.report['transferStartedAt'] = time.monotonic()
            result = original_transfer(manager, manager_fd)
            raise ValueError('FAULT_UNEXPECTED_HANDOFF_SUCCESS')
        except BaseException as error:
            self.report.update(transferError={'type': type(error).__name__, 'message': str(error)[:160]}, transferEndedAt=time.monotonic())
            raise
        finally:
            receiver.send_frame = original_send; self.companion.receive_plain = original_receive
            self.report['fenced'] = self.companion._FENCED is True
            if self.report['fenced']:
                try: self.companion.create_rendezvous(obj.sources)
                except ValueError as error: self.report['secondConstructorError'] = str(error)
                else: self.report['secondConstructorError'] = 'UNEXPECTED_SECOND_CONSTRUCTOR'

    def close_pin(self):
        if self.pin is None: return
        try:
            try: signal.pidfd_send_signal(self.pin, 0)
            except OSError as error:
                if error.errno != errno.ESRCH: raise
                self.report['retainedPidfdESRCH'] = True
        finally:
            os.close(self.pin); self.pin = None; self.report['retainedPidfdClosed'] = True


def private_subprocess(module, popen):
    result = types.SimpleNamespace(**vars(module)); result.Popen = popen
    return result


def emit_report(result):
    raw = (json.dumps(result, separators=(',', ':'), allow_nan=False) + '\n').encode()
    if len(raw) > 32768: raise ValueError('FAULT_REPORT_LIMIT')
    os.set_blocking(1, False)
    deadline = time.monotonic() + 2; offset = 0
    while offset < len(raw):
        if time.monotonic() >= deadline: raise TimeoutError('FAULT_REPORT_DEADLINE')
        try: count = os.write(1, raw[offset:])
        except BlockingIOError: time.sleep(0.005); continue
        if count <= 0: raise OSError('FAULT_REPORT_CLOSED')
        offset += count


def main():
    if sys.argv[1:] or sys.platform != 'linux': raise ValueError('FIXED_LINUX_FAULT_NO_ARGUMENTS')
    os.chdir(ROOT)
    before = hashes()
    if before[SELF] != LOADED_SHA: raise ValueError('LOADED_FAULT_SOURCE_DRIFT')
    relay = load(RELAY, before); companion = load(RENDEZVOUS, before)
    state = {'fault': None, 'process': None}; original_popen = relay.subprocess.Popen
    def create():
        if state['fault'] is not None: raise ValueError('FAULT_SINGLE_RENDEZVOUS')
        expected = {name: before['scripts/' + name] for name in companion.SOURCES}
        obj = companion.create_rendezvous(expected); fault = Fault(obj, companion)
        fault.original_transfer = obj.transfer; obj.transfer = fault.transfer; state['fault'] = fault
        return obj
    def popen(argv, **kwargs):
        if state['process'] is not None or state['fault'] is None or argv[0] != '/usr/bin/systemd-run' or '--unit=' + state['fault'].obj.unit not in argv:
            raise ValueError('FAULT_FIXED_OWN_UNIT_SPAWN')
        process = original_popen(argv, **kwargs); state['process'] = process; return process
    relay.create_ingress = create
    relay.subprocess = private_subprocess(relay.subprocess, popen)
    relay.sys = types.SimpleNamespace(**vars(sys)); relay.sys.argv = [str(ROOT / RELAY), '--trusted-ingress-boundary']
    result = {'version': 1, 'type': 'ack_fault_terminal', 'profile': 'stopped-owned-receiver-before-scm', 'sourceBefore': before,
        'relayReturnCode': None, 'systemdRunReturnCode': None, 'fault': None, 'error': None,
        'productionReady': False, 'capsuleValidated': False, 'namespaceCleanupValidated': False, 'actualModelCalls': 0}
    try: result['relayReturnCode'] = relay.main()
    except BaseException as error: result['error'] = {'type': type(error).__name__, 'message': str(error)[:160]}
    finally:
        fault = state['fault']
        if fault is not None:
            try: fault.close_pin()
            except OSError as error: result['error'] = {'type': type(error).__name__, 'message': 'RETAINED_PIN_CLEANUP_FAILED'}
            result['fault'] = fault.report
        process = state['process']
        if process is not None: result['systemdRunReturnCode'] = process.poll()
        result['sourceAfter'] = hashes()
    emit_report(result)
    return 0 if result['error'] is None else 1


if __name__ == '__main__': raise SystemExit(main())
