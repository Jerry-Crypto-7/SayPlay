"""Fixed own-unit synthetic guardian fault. Never production/auth evidence."""
import errno
import base64
import math
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path('/mnt/d/claude/Hackaton')
PROPERTIES = ('LoadState', 'ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus',
              'RuntimeMaxUSec', 'TimeoutStopUSec', 'KillMode', 'SendSIGKILL', 'ControlGroup',
              'MainPID', 'ExecMainStartTimestampMonotonic', 'ExecMainExitTimestampMonotonic')
MODES = ('guardian-runtime', 'command-deadline', 'command-deadline-diagnostic')
SOURCE_NAMES = frozenset(('subscription-systemd-cli-probe.py', 'subscription-cli-supervisor.py',
                         'subscription-cli-supervisor.sh', 'subscription-cli-supervisor-child.py',
                         'subscription-cli-supervisor.measure.py', 'subscription-runtime-probe.py',
                         'subscription-runtime-child-probe.py', 'subscription-systemd-guardian-fault.py'))
SOURCE_NAMES_V2 = SOURCE_NAMES | {'subscription-worker-lockdown.py', 'subscription-worker-boundary-child.py',
                                 'subscription-worker-boundary.py', 'subscription-appserver-noenv.py'}
SOURCE_NAMES_V3 = SOURCE_NAMES_V2 | {'subscription-text-model-catalog.json'}
SOURCE_NAMES_V4 = SOURCE_NAMES_V3 | {'subscription-appserver-fixture-child.py'}
GROUP_PATTERN = (r'0::/user\.slice/user-([0-9]+)\.slice/user@([0-9]+)\.service/app\.slice/'
                 r'(codex-cli-resource-[a-f0-9]{32}\.service)')


def load_candidate():
    spec = importlib.util.spec_from_file_location('candidate', ROOT / 'scripts/subscription-systemd-cli-probe.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def own_identity(pid, leaf):
    if type(pid) is not int or pid < 2 or not re.fullmatch(r'/sys/fs/cgroup/user\.slice/user-[0-9]+\.slice/user@[0-9]+\.service/app\.slice/codex-cli-resource-[a-f0-9]{32}\.service', leaf):
        raise ValueError('OWN_PROCESS_SCOPE_REQUIRED')
    def read(name):
        fd = os.open('/proc/' + str(pid) + '/' + name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            data = os.read(fd, 65537)
            if len(data) > 65536:
                raise ValueError('OWN_PROCESS_METADATA_LIMIT')
            return data.decode('ascii')
        finally:
            os.close(fd)
    fields = dict(line.split(':', 1) for line in read('status').splitlines() if ':' in line)
    own_group = read('cgroup').strip()
    raw_stat = read('stat')
    # stat comm can contain spaces/parentheses; fields after its final ')' start
    # with state (field3), so starttime (field22) is index19 of that suffix.
    suffix = raw_stat[raw_stat.rfind(')') + 2:].split()
    return {'pid': pid, 'nspid': [int(value) for value in fields.get('NSpid', '').split()],
            'state': fields['State'].strip().split()[0], 'startTicks': int(suffix[19]),
            'cgroup': own_group, 'expectedCgroup': '0::' + leaf.removeprefix('/sys/fs/cgroup'),
            'executable': os.readlink('/proc/' + str(pid) + '/exe')}


def valid_target(facts):
    if type(facts) is not dict or not isinstance(facts.get('expectedCgroup'), str):
        return False
    group = re.fullmatch(GROUP_PATTERN, facts['expectedCgroup'])
    return (group is not None and group[1] == group[2] and facts.get('cgroup') == facts['expectedCgroup']
            and type(facts.get('pid')) is int and facts['pid'] >= 2
            and isinstance(facts.get('nspid'), list) and len(facts['nspid']) >= 2
            and all(type(pid) is int and pid > 0 for pid in facts['nspid'])
            and facts['nspid'][0] == facts.get('pid') and facts['nspid'][-1] == 1
            and facts.get('executable') == '/usr/bin/python3'
            and type(facts.get('startTicks')) is int and facts['startTicks'] > 0)


def valid_source_identity(value, version=1):
    if type(version) is not int:
        return False
    expected = {1: SOURCE_NAMES, 2: SOURCE_NAMES_V2, 3: SOURCE_NAMES_V3, 4: SOURCE_NAMES_V4}.get(version)
    return (type(version) is int and expected is not None and type(value) is dict and set(value) == expected and
            all(type(digest) is str and re.fullmatch('[a-f0-9]{64}', digest) for digest in value.values()))


def matching_stopped_target(report):
    trigger = report.get('trigger')
    if type(trigger) is not dict or trigger.get('triggered') is not True or trigger.get('stateT') is not True:
        return False
    before, after = trigger.get('targetBefore'), trigger.get('targetAfter')
    if not valid_target(before) or not valid_target(after) or after.get('state') != 'T':
        return False
    unit = report.get('unit')
    leaf = trigger.get('sample', {}).get('leaf') if type(trigger.get('sample')) is dict else None
    if not isinstance(unit, str) or not re.fullmatch(r'codex-cli-resource-[a-f0-9]{32}\.service', unit) or not isinstance(leaf, str):
        return False
    expected = '0::' + leaf.removeprefix('/sys/fs/cgroup')
    group = re.fullmatch(GROUP_PATTERN, expected)
    if not leaf.startswith('/sys/fs/cgroup/') or not group or group[1] != group[2] or group[3] != unit:
        return False
    return before['expectedCgroup'] == expected and after['expectedCgroup'] == expected and all(
        before[key] == after[key] for key in ('pid', 'startTicks', 'nspid', 'cgroup', 'executable'))


def select_and_stop(candidate, unit, pre_stop=None):
    leaf = candidate.leaf_path(unit)
    sample = candidate.readback(unit)
    pids = [int(value) for value in sample['cgroup.procs'].splitlines()]
    if not pids or len(pids) > 64 or any(pid < 2 for pid in pids):
        raise ValueError('BOUNDED_OWN_PIDS_REQUIRED')
    handles, identities, errors = [], [], []
    try:
        for pid in set(pids):
            fd = os.pidfd_open(pid, 0)
            handles.append((pid, fd))
            try:
                identity = own_identity(pid, leaf)
                identities.append(identity)
            except (OSError, ValueError) as error:
                errors.append({'pid': pid, 'error': type(error).__name__, 'errno': getattr(error, 'errno', None)})
        matches = [item for item in identities if valid_target(item)]
        if len(matches) != 1:
            kept = handles
            handles = []
            return {'triggered': False, 'error': 'UNIQUE_PINNED_CAPSULE_PID1_NOT_VERIFIED',
                    'identities': identities, 'identityErrors': errors, 'sample': sample}, kept
        target = matches[0]
        again = own_identity(target['pid'], leaf)
        if not valid_target(again) or any(again[key] != target[key] for key in ('pid', 'startTicks', 'nspid', 'cgroup', 'executable')):
            raise ValueError('PINNED_IDENTITY_CHANGED')
        if pre_stop is not None and pre_stop(identities, target, sample) is not True:
            kept = handles
            handles = []
            return {'triggered': False, 'error': 'COMMAND_MAIN_NOT_VERIFIED_BEFORE_STOP',
                    'identities': identities, 'identityErrors': errors, 'sample': sample}, kept
        if pre_stop is not None:
            current_target = own_identity(target['pid'], leaf)
            if not valid_target(current_target) or any(current_target[key] != target[key] for key in ('pid', 'startTicks', 'nspid', 'cgroup', 'executable')):
                raise ValueError('TARGET_CHANGED_DURING_MAIN_PRECONDITION')
        pinned = next(fd for pid, fd in handles if pid == target['pid'])
        signal.pidfd_send_signal(pinned, signal.SIGSTOP)
        stopped = own_identity(target['pid'], leaf)
        # State can take a scheduler turn to reflect SIGSTOP; short bounded poll.
        until = time.monotonic() + 1
        while stopped['state'] != 'T' and time.monotonic() < until:
            time.sleep(0.01)
            stopped = own_identity(target['pid'], leaf)
        kept = handles
        handles = []
        return {'triggered': True, 'targetBefore': target, 'targetAfter': stopped,
                'stateT': stopped['state'] == 'T', 'signal': 'SIGSTOP', 'sample': sample,
                'identities': identities, 'identityErrors': errors}, kept
    finally:
        for _, fd in handles:
            os.close(fd)


def parse_properties(value):
    if len(value) > 65536:
        raise ValueError('PROPERTY_LIMIT')
    result = {}
    for line in value.splitlines():
        key, sep, content = line.partition('=')
        if not sep or key not in PROPERTIES or key in result:
            raise ValueError('PROPERTY_FORMAT')
        result[key] = content
    return result


def fixed_budgets(mode):
    if mode == 'guardian-runtime':
        return {'guardianSeconds': 15, 'stopSeconds': 2, 'driverSeconds': 45}
    if mode in ('command-deadline', 'command-deadline-diagnostic'):
        return {'guardianSeconds': 220, 'stopSeconds': 5, 'driverSeconds': 235}
    raise ValueError('FIXED_PROBE_MODE_REQUIRED')


def command_elapsed_ms(manager):
    values = [manager.get(key) for key in ('ExecMainStartTimestampMonotonic', 'ExecMainExitTimestampMonotonic')]
    if any(type(value) is not str or not re.fullmatch('[0-9]{1,18}', value) for value in values):
        return None
    start, end = map(int, values)
    return (end - start) / 1000 if start > 0 and end >= start else None


def command_main_matches(facts, manager_pid, expected_group):
    if type(facts) is not dict or not isinstance(expected_group, str) or not re.fullmatch(GROUP_PATTERN, expected_group):
        return False
    return (type(manager_pid) is int and type(facts.get('pid')) is int and facts['pid'] >= 2
            and facts['pid'] == manager_pid
            and facts.get('executable') == '/usr/bin/timeout' and facts.get('nspid') == [facts.get('pid')]
            and type(facts.get('startTicks')) is int and facts['startTicks'] > 0
            and facts.get('expectedCgroup') == expected_group and facts.get('cgroup') == expected_group)


def valid_command_main(report):
    return matching_stopped_target(report) and command_main_matches(
        report.get('commandMainIdentity'), report.get('managerMainPidBefore'), report['trigger']['targetBefore']['expectedCgroup'])


def timeout_markers(chunks):
    """Bounded diagnostics from fixed outer stderr, never child output frames."""
    if type(chunks) is not list or len(chunks) > 128:
        raise ValueError('STDERR_CHUNKS_REQUIRED')
    pending = b''
    markers = []
    total = 0
    previous = 0
    for chunk in chunks:
        if type(chunk) is not dict or set(chunk) != {'receivedAtMs', 'base64', 'byteLength'}:
            raise ValueError('STDERR_CHUNK_FORMAT')
        at = chunk['receivedAtMs']
        if type(at) not in (float, int) or not math.isfinite(at) or at < previous:
            raise ValueError('STDERR_CHUNK_TIME')
        block = base64.b64decode(chunk['base64'], validate=True)
        if type(chunk['byteLength']) is not int or len(block) != chunk['byteLength']:
            raise ValueError('STDERR_CHUNK_BYTES')
        total += len(block)
        if total > 65536:
            raise ValueError('STDERR_LIMIT')
        pending += block
        previous = at
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            text = line.decode('utf-8', errors='strict')
            match = re.fullmatch(r"/usr/bin/timeout: sending signal (TERM|KILL) to command ['‘]/usr/bin/unshare['’]", text)
            if match:
                markers.append({'signal': match[1], 'receivedAtMs': at, 'diagnostic': text})
    return markers


def diagnostic_checks(report, manager, elapsed):
    original_main = report.get('commandMainIdentity')
    revalidated_main = report.get('commandMainRevalidatedBeforeStop')
    same_main = (type(original_main) is dict and type(revalidated_main) is dict
                 and all(original_main.get(key) == revalidated_main.get(key)
                         for key in ('pid', 'startTicks', 'nspid', 'cgroup', 'executable')))
    try:
        markers = timeout_markers(report.get('stderrChunks'))
    except (ValueError, TypeError, UnicodeError):
        markers = []
    graceful = manager.get('Result') == 'exit-code' and manager.get('ExecMainCode') == '1' and manager.get('ExecMainStatus') == '124' and report.get('exitCode') == 124
    killed = manager.get('Result') == 'signal' and manager.get('ExecMainCode') == '2' and manager.get('ExecMainStatus') == '9' and report.get('exitCode') == 255
    term = bool(markers) and markers[0]['signal'] == 'TERM' and markers[0]['receivedAtMs'] >= 200000
    kill = (len(markers) == 2 and [item['signal'] for item in markers] == ['TERM', 'KILL']
            and markers[1]['receivedAtMs'] >= 205000
            and 4500 <= markers[1]['receivedAtMs'] - markers[0]['receivedAtMs'] <= 6500)
    branch = 'graceful-exit124' if graceful else 'kill-after-main-SIGKILL-wrapper255' if killed else 'UNEXPECTED'
    return {'diagnosticTerminationBranch': branch, 'timeoutDiagnostics': markers,
            'diagnosticChecks': {'TERMAtOrAfter200s': term,
                'predeclaredTerminationBranch': graceful and len(markers) == 1 or killed and kill,
                'mainDurationMatchesBranch': elapsed is not None and elapsed >= (205000 if killed else 200000),
                'outerGuardianDidNotTimeout': manager.get('Result') in ('exit-code', 'signal'),
              'mainIdentityValidatedBeforeStop': report.get('managerMainPidQueryPhase') == 'before-pidfd-SIGSTOP'
                     and same_main
                   and command_main_matches(report.get('commandMainRevalidatedBeforeStop'), report.get('managerMainPidBefore'),
                                            report.get('trigger', {}).get('targetBefore', {}).get('expectedCgroup'))}}


def evaluate(report):
    mode = report.get('mode', 'guardian-runtime')
    manager = report.get('manager', {})
    checks = {'pinnedOwnPid1Stopped': matching_stopped_target(report),
              'fixedMode': mode in MODES,
              'noDriverProcessCleanup': report.get('externalHarnessCleanup') is False,
              'allPinnedPidsGone': report.get('allPinnedPidsESRCH') is True,
              'leafRemovedBeforeMetadataCleanup': report.get('leafAbsentBeforeReset') is True,
              'ownUnitMetadataCollected': report.get('unitAbsentAfterReset') is True,
              'noDriverErrors': report.get('errors') == [],
              'sourceStable': valid_source_identity(report.get('sourceSha256Before'), report.get('version', 1))
                 and valid_source_identity(report.get('sourceSha256After'), report.get('version', 1))
                 and report['sourceSha256Before'] == report['sourceSha256After']}
    diagnostic = None
    if mode in ('command-deadline', 'command-deadline-diagnostic'):
        elapsed = command_elapsed_ms(manager)
        checks.update(commandMainIdentity=valid_command_main(report),
                      actualCommandAtLeast200s=elapsed is not None and elapsed >= 200000,
                      unchangedOuterGuardian=manager.get('RuntimeMaxUSec') == '3min 40s'
                        and manager.get('TimeoutStopUSec') == '5s' and manager.get('KillMode') == 'control-group')
        if mode == 'command-deadline-diagnostic':
            diagnostic = diagnostic_checks(report, manager, elapsed)
            checks.update(diagnostic['diagnosticChecks'])
        else:
            checks['timeoutExit124'] = manager.get('Result') == 'exit-code' and manager.get('ExecMainCode') == '1' and manager.get('ExecMainStatus') == '124' and report.get('exitCode') == 124
    else:
        checks.update(managerTimeoutObserved=manager.get('Result') == 'timeout',
                      exactSyntheticGuardian=manager.get('RuntimeMaxUSec') == '15s'
                        and manager.get('TimeoutStopUSec') == '2s' and manager.get('KillMode') == 'control-group')
    passed = all(checks.values())
    return {'status': 'PASS' if passed else 'FAIL', 'checks': checks,
            'scope': 'fixed-200s-command-timeout-verbose-diagnostic' if mode == 'command-deadline-diagnostic' else 'fixed-200s-command-timeout-only' if mode == 'command-deadline' else 'manager-runtime-trigger-and-owned-cleanup-only',
            'commandTimeoutMeasured': passed and mode in ('command-deadline', 'command-deadline-diagnostic'),
            **(diagnostic or {}),
            'guardianKillEscalation': 'NOT_OBSERVED', 'sustainedUnresponsiveKill': 'NOT_VALIDATED'}


def run(mode='guardian-runtime'):
    budgets = fixed_budgets(mode)
    candidate = load_candidate()
    unit = 'codex-cli-resource-' + uuid.uuid4().hex + '.service'
    env = candidate.environment()
    capsule_command = list(candidate.CAPSULE)
    if mode == 'command-deadline-diagnostic':
        if capsule_command[3] != '/usr/bin/timeout':
            raise ValueError('FIXED_TIMEOUT_ARGV_REQUIRED')
        capsule_command.insert(4, '--verbose')
    argv = ['/usr/bin/systemd-run', '--user', '--no-ask-password', '--quiet', '--wait', '--pipe',
            '--unit=' + unit, '--property=MemoryMax=2G', '--property=MemorySwapMax=0', '--property=TasksMax=64',
            '--property=RuntimeMaxSec=' + str(budgets['guardianSeconds']),
            '--property=TimeoutStopSec=' + str(budgets['stopSeconds']), '--property=KillMode=control-group',
            '--property=WorkingDirectory=/', *capsule_command]
    def hashes():
        return {**candidate.hashes(), 'subscription-systemd-guardian-fault.py': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    report = {'kind': 'subscription-systemd-guardian-fault', 'version': 4, 'mode': mode, 'unit': unit, 'argv': argv,
              'sourceSha256Before': hashes(), 'state': 'PRE_DISPATCH', 'productionReady': False,
              'productionAuth': 'NOT_RUN', 'productionNetwork': 'NOT_RUN', 'productionCleanup': 'NOT_RUN',
              'capsuleCleanup': 'UNKNOWN', 'modelCalls': 0,
              'guardianScope': 'candidate220s-runtime5s-stop-not-expected-to-trigger' if mode != 'guardian-runtime' else 'synthetic15s-runtime2s-stop-only',
              'fixedBudgets': budgets,
              'externalHarnessCleanup': False, 'trigger': {'triggered': False}, 'frames': [], 'errors': []}
    if mode == 'command-deadline-diagnostic':
        report['diagnosticDifference'] = 'Only GNUtimeout --verbose added; all200/5 and candidate220/5 limits unchanged'
        report['predeclaredDiagnostic'] = {'TERMReceiptMinMs': 200000, 'KILLReceiptMinMs': 205000,
            'TERMToKILLReceiptRangeMs': [4500, 6500], 'branches': ['mainExit124+wrapper124', 'mainSIGKILL+wrapper255'],
            'outerManagerTimeout': 'FAIL', 'diagnosticsMean': 'Sending markers, not target handler acknowledgements'}
    artifact = ROOT / 'scratch' / ('session8-systemd-' + (mode + '-' if mode != 'guardian-runtime' else 'guardian-') + unit + '.json')
    with artifact.open('x', encoding='utf-8') as handle:
        json.dump(report, handle, indent=2)
    proc = subprocess.Popen(argv, env=env, cwd='/', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    for pipe in (proc.stdin, proc.stdout, proc.stderr):
        os.set_blocking(pipe.fileno(), False)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
    pending, tail, stderr = bytearray(), bytearray(), bytearray()
    report['stderrChunks'] = []
    started = False
    handles = []
    began = heartbeat = time.monotonic()
    fixture_seen = False

    def command_pre_stop(identities, target, sample):
        main = subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'show', unit, '--property=MainPID'],
                              env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
        value = parse_properties(main.stdout.decode('utf-8')).get('MainPID', '')
        report['managerMainPidBefore'] = int(value) if re.fullmatch('[0-9]{1,10}', value) else None
        report['managerMainPidQueryPhase'] = 'before-pidfd-SIGSTOP'
        matches = [identity for identity in identities if identity['pid'] == report['managerMainPidBefore']]
        report['commandMainIdentity'] = matches[0] if len(matches) == 1 else None
        if main.returncode != 0 or not command_main_matches(report['commandMainIdentity'], report['managerMainPidBefore'], target['expectedCgroup']):
            return False
        current = own_identity(report['managerMainPidBefore'], sample['leaf'])
        report['commandMainRevalidatedBeforeStop'] = current
        return command_main_matches(current, report['managerMainPidBefore'], target['expectedCgroup']) and all(
            current[key] == report['commandMainIdentity'][key] for key in ('pid', 'startTicks', 'nspid', 'cgroup', 'executable'))

    try:
        while proc.poll() is None or selector.get_map():
            now = time.monotonic()
            if now - began > budgets['driverSeconds']:
                report['externalHarnessCleanup'] = True
                report['errors'].append('FIXED_DRIVER_TIMEOUT')
                subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'stop', unit], env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False)
                break
            if started and now - heartbeat >= 0.5:
                pending.extend(b'{"type":"heartbeat"}\n')
                heartbeat = now
            if pending:
                try:
                    count = os.write(proc.stdin.fileno(), pending)
                    del pending[:count]
                except BlockingIOError:
                    pass
                except BrokenPipeError:
                    pending.clear()
            for key, _ in selector.select(0.05):
                block = os.read(key.fileobj.fileno(), 65536)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == 'stderr':
                    if len(stderr) + len(block) > 65536 or len(report['stderrChunks']) >= 128:
                        raise ValueError('STDERR_LIMIT')
                    stderr.extend(block)
                    report['stderrChunks'].append({'receivedAtMs': (time.monotonic() - began) * 1000,
                        'base64': base64.b64encode(block).decode('ascii'), 'byteLength': len(block)})
                    continue
                tail.extend(block)
                if len(tail) > 65536:
                    raise ValueError('FRAME_LIMIT')
                while b'\n' in tail:
                    line, _, remaining = tail.partition(b'\n')
                    tail = bytearray(remaining)
                    frame = json.loads(line)
                    report['frames'].append(frame)
                    if len(report['frames']) > 256:
                        raise ValueError('FRAME_COUNT_LIMIT')
                    if frame.get('type') == 'ready':
                        facts = candidate.readback(unit)
                        candidate.dispatch_after_readback(unit, facts, 'stopped-cli',
                          lambda start: pending.extend((json.dumps(start) + '\n').encode()))
                        started = True
                    if frame.get('type') == 'fixture_ready' and not fixture_seen:
                        fixture_seen = True
                        report['trigger'], handles = select_and_stop(candidate, unit, command_pre_stop if mode != 'guardian-runtime' else None)
                        artifact.write_text(json.dumps(report, indent=2), encoding='utf-8')
                        if not report['trigger'].get('triggered'):
                            raise ValueError('FIXTURE_PRECONDITION_FAILED')
        proc.wait(timeout=8)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        report['errors'].append(type(error).__name__)
        report['externalHarnessCleanup'] = True
        subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'stop', unit], env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False)
        proc.wait(timeout=8)
    finally:
        selector.close()
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            pipe.close()
    state = subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'show', unit,
                            *['--property=' + key for key in PROPERTIES]], env=env, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    report['manager'] = parse_properties(state.stdout.decode('utf-8'))
    report['commandElapsedMs'] = command_elapsed_ms(report['manager'])
    report['leafAbsentBeforeReset'] = not Path(candidate.leaf_path(unit)).exists()
    disappeared = []
    for pid, fd in handles:
        try:
            signal.pidfd_send_signal(fd, 0)
            disappeared.append({'pid': pid, 'esrch': False})
        except ProcessLookupError:
            disappeared.append({'pid': pid, 'esrch': True})
        finally:
            os.close(fd)
    report['pinnedPids'] = disappeared
    report['allPinnedPidsESRCH'] = bool(disappeared) and all(item['esrch'] for item in disappeared)
    if report['leafAbsentBeforeReset']:
        reset = subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'reset-failed', unit],
                               env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        report['metadataResetExitCode'] = reset.returncode
    after = subprocess.run(['/usr/bin/systemctl', '--user', '--no-ask-password', 'show', unit, '--property=LoadState'],
                           env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    report.update(unitAbsentAfterReset=after.stdout.strip() == b'LoadState=not-found', sourceSha256After=hashes(),
                  state='FINISHED', stderr=stderr.decode('utf-8', errors='replace'), elapsedMs=round((time.monotonic() - began) * 1000),
                  exitCode=proc.returncode)
    report['observedCapsuleTerminals'] = [frame for frame in report['frames'] if frame.get('type') == 'terminal']
    report['capsuleResumptionObserved'] = report['trigger'].get('triggered') is True and bool(report['observedCapsuleTerminals'])
    report['capsuleResumedAfterStop'] = True if report['capsuleResumptionObserved'] else None
    report['guardianKillEscalation'] = 'NOT_OBSERVED'
    report['sustainedUnresponsiveKill'] = 'NOT_VALIDATED'
    report['evaluation'] = evaluate(report)
    artifact.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'artifact': str(artifact), 'evaluation': report['evaluation'], 'trigger': report['trigger'],
                      'manager': report['manager'], 'externalHarnessCleanup': report['externalHarnessCleanup']}))
    return report['evaluation']['status'] == 'PASS'


if __name__ == '__main__':
    if sys.platform != 'linux' or sys.argv[1:] not in (['--run'], ['--command-deadline'], ['--command-deadline-diagnostic']):
        raise SystemExit('Explicit fixed Linux --run, --command-deadline or --command-deadline-diagnostic required')
    raise SystemExit(0 if run('guardian-runtime' if sys.argv[1] == '--run' else sys.argv[1][2:]) else 1)
