"""Fixed local Linux SCM_RIGHTS primitives; never calls receiver.run or exec."""
import array
import errno
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import sys
import time
import types
import uuid

ROOT = Path(__file__).resolve().parents[1]
SELF = 'scripts/subscription-systemd-ingress-receiver.measure.py'
RECEIVER = 'scripts/subscription-systemd-ingress-receiver.py'
PIN = '2d32b1508794f43cf5a6266f7ec666a42b2eacaabed60be4e20b471aa00e1f32'
SCENARIOS = ('one-fd', 'occupied-198', 'excess-rights', 'malformed-payload', 'truncated-rights')
LOADED_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in (SELF, RECEIVER)}


def load_receiver(before):
    raw = (ROOT / RECEIVER).read_bytes()
    if before.get(RECEIVER) != PIN or hashlib.sha256(raw).hexdigest() != PIN:
        raise ValueError('PINNED_RECEIVER_REQUIRED')
    module = types.ModuleType('fixed_receiver_primitive')
    module.__file__ = str(ROOT / RECEIVER)
    exec(compile(raw, module.__file__, 'exec'), module.__dict__)
    return module


def identity(fd):
    value = os.fstat(fd)
    return {'dev': value.st_dev, 'ino': value.st_ino, 'type': stat.S_IFMT(value.st_mode)}


def inventory():
    result = {}
    for name in os.listdir('/proc/self/fd'):
        if not name.isdecimal(): continue
        try: result[name] = identity(int(name))
        except OSError as error:
            if error.errno != errno.EBADF: raise
    return result


def absent(fd):
    try: os.fstat(fd)
    except OSError as error:
        if error.errno == errno.EBADF: return True
        raise
    return False


def scenario(receiver, name):
    if name not in SCENARIOS: raise ValueError('FIXED_SCENARIO_REQUIRED')
    before = inventory()
    if not absent(198): raise ValueError('PREEXISTING_FD198_NO_OVERWRITE')
    channels = []; owned = set(); failure = None; observations = {}
    started = time.monotonic()
    try:
        tx, rx = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM); channels.extend((tx, rx))
        source, peer = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM); channels.extend((source, peer))
        rx.setblocking(False)
        count = 32 if name == 'truncated-rights' else 2 if name == 'excess-rights' else 1
        payload = b'X' if name == 'malformed-payload' else b'F'
        sent = tx.sendmsg([payload], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [source.fileno()] * count))])
        if sent != 1: raise ValueError('EXACT_SEND_REQUIRED')
        observations.update(sentPayloadHex=payload.hex(), sentRights=count, sourceSocket=identity(source.fileno()))
        deadline = started + receiver.SETUP_SECONDS
        class ObservedChannel:
            def fileno(self): return rx.fileno()
            def recvmsg(self, *args):
                result = rx.recvmsg(*args)
                observations['receiveFlags'] = result[2]
                observations['ancillaryLengths'] = [len(body) for _, _, body in result[1]]
                return result
        try:
            received = receiver.receive_fd(ObservedChannel(), deadline); owned.add(received)
        except ValueError as error:
            observations['receiveError'] = str(error)
            if name not in ('excess-rights', 'malformed-payload', 'truncated-rights') or str(error) != 'EXACT_ONE_FD_REQUIRED': raise
            if name == 'truncated-rights' and not observations.get('receiveFlags', 0) & socket.MSG_CTRUNC:
                raise ValueError('ACTUAL_CTRUNC_REQUIRED')
        else:
            if name not in ('one-fd', 'occupied-198'): raise ValueError('REJECTED_RIGHTS_ACCEPTED')
            observations.update(receivedCloexec=not os.get_inheritable(received), receivedSocket=identity(received))
            if not observations['receivedCloexec'] or observations['receivedSocket'] != observations['sourceSocket']:
                raise ValueError('RECEIVED_IDENTITY_OR_CLOEXEC')
            if name == 'occupied-198':
                import fcntl
                fixed = fcntl.fcntl(peer.fileno(), fcntl.F_DUPFD_CLOEXEC, 198); owned.add(fixed)
                if fixed != 198: raise ValueError('FD198_RESERVATION_RACE')
                occupied = identity(198)
                try: receiver.reserve_fd(received, observations['sourceSocket'])
                except ValueError as error:
                    if str(error) != 'FD198_OCCUPIED': raise
                    observations['reserveError'] = str(error)
                else: raise ValueError('OCCUPIED_FD_OVERWRITTEN')
                observations['occupiedUnchanged'] = identity(198) == occupied
                if not observations['occupiedUnchanged']: raise ValueError('OCCUPIED_FD_CHANGED')
            else:
                fixed = receiver.reserve_fd(received, observations['sourceSocket']); owned.add(fixed)
                observations.update(fixedFd=fixed, fixedCloexec=not os.get_inheritable(fixed), fixedSocket=identity(fixed))
                if fixed != 198 or not observations['fixedCloexec'] or observations['fixedSocket'] != observations['sourceSocket']:
                    raise ValueError('FIXED_FD_INVALID')
        receiver.check_time(deadline)
    except Exception as error:
        failure = {'type': type(error).__name__, 'message': str(error)[:256]}
    finally:
        cleanup_errors = []
        for fd in owned:
            try: os.close(fd)
            except OSError as error: cleanup_errors.append(error.errno)
        for channel in channels:
            try: channel.close()
            except OSError as error: cleanup_errors.append(error.errno)
    after = inventory()
    cleanup = {'inventoryBefore': before, 'inventoryAfter': after, 'fd198Absent': absent(198), 'errors': cleanup_errors}
    cleanup['verified'] = before == after and cleanup['fd198Absent'] and not cleanup_errors
    return {'scenario': name, 'observations': observations, 'error': failure, 'elapsedMs': (time.monotonic() - started) * 1000,
        'cleanup': cleanup, 'passed': failure is None and cleanup['verified']}


def execute(receiver):
    results = []
    for name in SCENARIOS:
        result = scenario(receiver, name); results.append(result)
        if result['cleanup']['verified'] is not True or result['passed'] is not True: break
    return results


def main():
    if sys.argv[1:]: raise ValueError('NO_CALLER_ARGUMENTS')
    if sys.platform != 'linux': raise ValueError('LINUX_ONLY')
    before = hashes()
    if before[SELF] != LOADED_SHA: raise ValueError('LOADED_SOURCE_DRIFT')
    receiver = load_receiver(before)
    output = ROOT / 'scratch' / ('session8-systemd-ingress-receiver-primitives-' + str(uuid.uuid4()) + '.json')
    report = {'version': 1, 'kind': 'ACTUAL_LOCAL_KERNEL_PRIMITIVES', 'sourceBefore': before,
        'scenarios': [], 'passed': False, 'fullReceiverValidated': False, 'systemdValidated': False,
        'productionReady': False, 'actualModelCalls': 0, 'setupSeconds': 5}
    with output.open('x', encoding='utf-8') as file: json.dump(report, file, indent=2)
    try: report['scenarios'] = execute(receiver)
    except Exception as error: report['error'] = {'type': type(error).__name__, 'message': str(error)[:256]}
    report['sourceAfter'] = hashes()
    report['passed'] = (before == report['sourceAfter'] and len(report['scenarios']) == len(SCENARIOS)
        and all(value['passed'] is True for value in report['scenarios']) and 'error' not in report)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'path': str(output), 'passed': report['passed']}))
    return 0 if report['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
