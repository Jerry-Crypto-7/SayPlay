"""Fixed Windows driver for expected missing-ACK failure and owned cleanup."""
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

FAULT = 'scripts/subscription-systemd-ingress-ack-fault.py'
SELF = 'scripts/subscription-systemd-ingress-ack-fault.measure.py'
RESOURCE = 'scripts/subscription-exec-environment-systemd.measure.py'
COMMAND = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/scripts/subscription-systemd-ingress-ack-fault.py']
LIMIT = 2 * 1024 * 1024
LOADED_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def load():
    raw = Path(FAULT).read_bytes(); spec = importlib.util.spec_from_file_location('ack_fault_measure_core', FAULT)
    module = importlib.util.module_from_spec(spec); exec(compile(raw, FAULT, 'exec'), module.__dict__)
    return module


def numeric(value):
    return type(value) in (int, float) and value >= 0 and value < float('inf')


def parse(raw):
    def unique(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('DUPLICATE_KEY')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE')))


def validate_binding(value, owner):
    """Same fixed private-peer schema, directly applied to actual binding."""
    def integer(item, minimum=0): return type(item) is int and minimum <= item <= 9007199254740991
    if type(value) is not dict or set(value) != {'driverPid', 'driverCgroup', 'managerPid', 'managerCgroup',
            'managerIdentityProfile', 'managerUid', 'managerGid', 'managerStartTimeTicks', 'managerSocket',
            'unitMainPid', 'unitMainCgroup', 'unitMainStartTimeTicks'}: return False
    if (value['managerIdentityProfile'] != 'private-socket-peer-v1' or not integer(value['managerUid'])
            or value['managerUid'] != owner['uid'] or not integer(value['managerGid'])
            or any(not integer(value[key], 2) for key in ('driverPid', 'managerPid', 'unitMainPid'))
            or value['driverPid'] != owner['driverPid'] or len({value['driverPid'], value['managerPid'], value['unitMainPid']}) != 3): return False
    for key in ('managerStartTimeTicks', 'unitMainStartTimeTicks'):
        if type(value[key]) is not str or re.fullmatch('[0-9]{1,32}', value[key]) is None: return False
    relative = owner['leaf'][len('/sys/fs/cgroup'):]
    if value['unitMainCgroup'] != relative: return False
    for key in ('driverCgroup', 'managerCgroup'):
        path = value[key]
        if type(path) is not str or not path.startswith('/') or len(path) > 4096 or path == relative or path.startswith(relative + '/'): return False
    peer = value['managerSocket']
    if (type(peer) is not dict or set(peer) != {'path', 'components'} or peer['path'] != f"/run/user/{owner['uid']}/systemd/private"
            or type(peer['components']) is not list or len(peer['components']) != 5): return False
    for index, item in enumerate(peer['components']):
        if (type(item) is not dict or set(item) != {'dev', 'ino', 'mode', 'uid', 'gid'} or any(not integer(v) for v in item.values())
                or item['mode'] & 0xf000 != (0xc000 if index == 4 else 0x4000)): return False
    return peer['components'][-1]['uid'] == owner['uid']


def evaluate(report):
    try:
        core = load(); before = report['sourceBefore']
        if (len(before) != 32 or set(before) != set(core.sources()) or not core.same(before, report['sourceAfter'])
                or any(hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest for path, digest in before.items())
                or before[SELF] != LOADED_SHA or not core.same(report['command'], COMMAND)
                or report['localWaitKnown'] is not True or type(report['localReturnCode']) is not int or report['localReturnCode'] != 0
                or report['readersClosed'] is not True or report['stdinClosed'] is not True or report['outputComplete'] is not True or report['errors'] != []
                or report['stderrHex'] != ''): return False
        raw = bytes.fromhex(report['stdoutHex'])
        if len(raw) > LIMIT or report['stdoutBytes'] != len(raw) or report['stdoutSha256'] != hashlib.sha256(raw).hexdigest(): return False
        frames = [parse(line) for line in raw.splitlines()]
        expected = ['systemd_ownership', 'systemd_ingress_ownership', 'systemd_ingress_terminal', 'systemd_failure', 'ack_fault_terminal']
        if [frame.get('type') for frame in frames] != expected: return False
        for frame in frames:
            if type(frame.get('version')) is not int or frame['version'] != 1: return False
        if any(set(frames[i]) != {'version', 'type', field} for i, field in ((0, 'ownership'), (1, 'ownership'), (2, 'result'))): return False
        resource = core.load(RESOURCE, before); owner = frames[0]['ownership']; ingress = frames[1]['ownership']; route = frames[2]['result']; failed = frames[3]; final = frames[4]
        if not resource.validate_ownership(owner, before) or not core.same(failed['ownership'], owner): return False
        if (ingress['unit'] != owner['unit'] or ingress['uuid'] != owner['unit'][19:-8] or ingress['controllerPid'] != owner['driverPid']
                or ingress['rendezvous']['path'] != f"/run/user/{owner['uid']}/rc-ingress-{ingress['uuid']}/handoff.sock"): return False
        companion = core.load(core.RENDEZVOUS, before)
        if not core.same(ingress['sourceSha256'], {name: before['scripts/' + name] for name in companion.SOURCES}): return False
        if (not core.same(failed['cleanup'], {'unitAbsent': True, 'leafAbsent': True, 'systemdRunClosed': True})
                or failed['diagnostics']['notSpawned'] is not False or 'TimeoutError:HANDOFF_DEADLINE' not in failed['error']
                or failed['stageEvidence']['capsuleFailureTerminal'] is not None): return False
        if (route['unit'] != owner['unit'] or route['nonce'] != ingress['nonce'] or route['passed'] is not False
                or route['ownedCleanupVerified'] is not True or route['threadsClosed'] is not True or route['peersClosed'] is not True
                or route['sourceStable'] is not True or route['errors'] != [] or route['broker'] is not None
                or route['remoteUnitCleanup'] != 'NOT_ATTESTED' or route['productionReady'] is not False
                or not core.same(route['pathCleanup'], {'socketRemoved': True, 'directoryRemoved': True})
                or not core.same(route['route'], {'beforeBytes': 0, 'afterBytes': 0, 'eof': False})): return False
        if (set(final) != {'version', 'type', 'profile', 'sourceBefore', 'sourceAfter', 'relayReturnCode', 'systemdRunReturnCode', 'fault', 'error',
                'productionReady', 'capsuleValidated', 'namespaceCleanupValidated', 'actualModelCalls'}
                or final['profile'] != 'stopped-owned-receiver-before-scm' or not core.same(final['sourceBefore'], before)
                or not core.same(final['sourceAfter'], before) or type(final['relayReturnCode']) is not int or final['relayReturnCode'] != 1
                or type(final['systemdRunReturnCode']) is not int or final['error'] is not None
                or any(final[key] is not False for key in ('productionReady', 'capsuleValidated', 'namespaceCleanupValidated'))
                or type(final['actualModelCalls']) is not int or final['actualModelCalls'] != 0): return False
        fault = final['fault']; binding = fault['binding']; stopped = fault['stoppedState']
        if not validate_binding(binding, owner): return False
        if (binding['driverPid'] != owner['driverPid'] or binding['unitMainCgroup'] != owner['leaf'][len('/sys/fs/cgroup'):]
                or len({binding['driverPid'], binding['managerPid'], binding['unitMainPid']}) != 3
                or binding['managerIdentityProfile'] != 'private-socket-peer-v1' or binding['managerUid'] != owner['uid']): return False
        if not core.same(fault['hello'], {'version': 1, 'type': 'receiver_hello', 'uuid': ingress['uuid'], 'nonce': ingress['nonce'],
                'pid': binding['unitMainPid'], 'startTicks': binding['unitMainStartTimeTicks']}): return False
        if (stopped['state'] not in ('T', 't') or stopped['pid'] != binding['unitMainPid'] or stopped['startTicks'] != binding['unitMainStartTimeTicks']
                or stopped['cgroup'] != binding['unitMainCgroup'] or fault['ackFramesObserved'] != 0 or type(fault['ackFramesObserved']) is not int
                or fault['fenced'] is not True or fault['secondConstructorError'] != 'PREVIOUS_HANDOFF_UNCERTAIN'
                or fault['retainedPidfdESRCH'] is not True or fault['retainedPidfdClosed'] is not True
                or not core.same(fault['transferError'], {'type': 'TimeoutError', 'message': 'HANDOFF_DEADLINE'})): return False
        calls = fault['sendCalls']
        if type(calls) is not list or len(calls) != 1 or type(calls[0]['returnCount']) is not int or calls[0]['returnCount'] != 1: return False
        times = [fault['transferStartedAt'], fault['offerWrittenAt'], fault['stopSentAt'], fault['stoppedAt'], calls[0]['startedAt'], calls[0]['returnedAt'], fault['deadline'], fault['transferEndedAt']]
        return (all(numeric(value) for value in times) and times == sorted(times) and fault['deadline'] - fault['offerWrittenAt'] <= 5
            and fault['deadline'] - fault['transferStartedAt'] >= 5)
    except (ValueError, TypeError, KeyError, AttributeError, OSError): return False


def capture_fixed():
    report = {'errors': [], 'localWaitKnown': False, 'localReturnCode': None, 'stdinClosed': False}
    data = {'stdout': bytearray(), 'stderr': bytearray()}; counts = {'stdout': 0, 'stderr': 0}
    threads = []; active = set(); process = None
    def reader(stream, kind):
        try:
            while True:
                block = stream.read(4096)
                if not block: break
                counts[kind] += len(block)
                data[kind].extend(block[:max(0, LIMIT - len(data[kind]))])
        except OSError: report['errors'].append(kind + '_READ_FAILED')
        finally: stream.close()
    try:
        # Epoll can register the relay's own pipe; /dev/null would fail EPERM.
        process = subprocess.Popen(COMMAND, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
        for kind in ('stdout', 'stderr'):
            thread = threading.Thread(target=reader, args=(getattr(process, kind), kind), daemon=True)
            thread.start(); threads.append(thread); active.add(kind)
        report['localReturnCode'] = process.wait(timeout=35); report['localWaitKnown'] = True
    except (OSError, subprocess.SubprocessError, RuntimeError) as error: report['errors'].append(type(error).__name__)
    finally:
        if process is not None:
            try: process.stdin.close(); report['stdinClosed'] = True
            except OSError: report['errors'].append('STDIN_CLOSE_FAILED')
            for kind in ('stdout', 'stderr'):
                if kind not in active:
                    try: getattr(process, kind).close()
                    except OSError: report['errors'].append(kind + '_CLOSE_FAILED')
    for thread in threads: thread.join(timeout=1)
    report['readersClosed'] = len(threads) == 2 and all(not thread.is_alive() for thread in threads)
    report['outputComplete'] = report['readersClosed'] and all(counts[kind] == len(data[kind]) for kind in counts)
    report.update(stdoutHex=bytes(data['stdout']).hex(), stderrHex=bytes(data['stderr']).hex(), stdoutBytes=counts['stdout'],
        stderrBytes=counts['stderr'], stdoutSha256=hashlib.sha256(data['stdout']).hexdigest())
    return report


def main():
    if sys.argv[1:]: raise ValueError('FIXED_FAULT_MEASURE_NO_ARGUMENTS')
    core = load(); before = core.hashes()
    if before[FAULT] != core.LOADED_SHA or before[SELF] != LOADED_SHA: raise ValueError('LOADED_SOURCE_DRIFT')
    output = Path('scratch') / ('session8-systemd-ingress-ack-fault-' + str(uuid.uuid4()) + '.json')
    report = {'version': 1, 'command': COMMAND, 'sourceBefore': before, 'passed': False,
        'expectedTransferOutcome': 'FAIL_MISSING_ACK', 'productionReady': False, 'namespaceCleanupValidated': False}
    with output.open('x', encoding='utf-8') as file: json.dump(report, file, indent=2)
    report.update(capture_fixed(), sourceAfter=core.hashes())
    report['passed'] = evaluate(report)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'path': str(output), 'passed': report['passed']}))
    return 0 if report['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
