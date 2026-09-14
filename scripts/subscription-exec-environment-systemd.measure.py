"""One fixed systemd environment metadata measurement; no caller runtime inputs."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import types
import uuid

SCENARIO = 'exec-environment-metadata'
BOOTSTRAP_SCENARIO = 'exec-environment-bootstrap-metadata'
CONTROLLED_SCENARIO = 'exec-environment-bootstrap-controlled'
DRIVER = 'scripts/subscription-cli-supervisor.measure.py'
SELF = 'scripts/subscription-exec-environment-systemd.measure.py'
RELAY = 'scripts/subscription-systemd-fixture-transport.py'
PROBE = 'scripts/subscription-systemd-cli-probe.py'
COMMAND = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/scripts/subscription-systemd-fixture-transport.py', '--environment-metadata']
READBACK = {'memoryMax': '2147483648', 'memorySwapMax': '0', 'pidsMax': '64'}
LIMITS = {'memoryMaxBytes': 2147483648, 'swapMaxBytes': 0, 'tasksMax': 64,
    'guardianMs': 220000, 'termGraceMs': 5000, 'innerCommandMs': 200000}
CLI_SHA = 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'
BWRAP_SHA = '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'


def select_scenario(arguments):
    if arguments == []: return SCENARIO
    if arguments == ['--bootstrap-metadata']: return BOOTSTRAP_SCENARIO
    if arguments == ['--bootstrap-controlled-cleanup']: return CONTROLLED_SCENARIO
    raise ValueError('FIXED_SYSTEMD_METADATA_SCENARIO_REQUIRED')


def fixed_command(scenario):
    if scenario == SCENARIO: return list(COMMAND)
    if scenario == BOOTSTRAP_SCENARIO: return [*COMMAND[:-1], '--environment-bootstrap-metadata']
    if scenario == CONTROLLED_SCENARIO: return [*COMMAND[:-1], '--environment-bootstrap-controlled']
    raise ValueError('FIXED_SYSTEMD_METADATA_SCENARIO_REQUIRED')


def same(a, b):
    return json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False)


def number(value, low=0):
    return type(value) is int and low <= value <= 9007199254740991


def load_driver(expected=None):
    raw = Path(DRIVER).read_bytes()
    if expected is not None and hashlib.sha256(raw).hexdigest() != expected.get(DRIVER):
        raise ValueError('SYSTEMD_MEASURE_DRIVER_SOURCE_MISMATCH')
    spec = importlib.util.spec_from_file_location('fixed_systemd_environment_driver', DRIVER)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, DRIVER, 'exec'), module.__dict__)
    module.loadedSourceSha256 = hashlib.sha256(raw).hexdigest()
    return module


def validate_ownership(value, before):
    if (type(value) is not dict or set(value) != {'unit', 'uid', 'leaf', 'driverPid', 'relaySha256', 'probeSha256'}
            or type(value['unit']) is not str or re.fullmatch('codex-cli-resource-[a-f0-9]{32}\\.service', value['unit']) is None
            or not number(value['uid']) or not number(value['driverPid'], 2)
            or value['relaySha256'] != before.get(RELAY) or value['probeSha256'] != before.get(PROBE)):
        return False
    for key in ('relaySha256', 'probeSha256'):
        if type(value[key]) is not str or re.fullmatch('[a-f0-9]{64}', value[key]) is None: return False
    return value['leaf'] == f"/sys/fs/cgroup/user.slice/user-{value['uid']}.slice/user@{value['uid']}.service/app.slice/{value['unit']}"


def validate_ready(ready, ownership, before):
    try:
        if type(ready) is not dict: return False
        if not validate_ownership(ownership, before): return False
        if ready.get('binarySha256') != CLI_SHA or ready.get('bwrapSha256') != BWRAP_SHA: return False
        value = ready['systemdFixtureBoundary']
        keys = {'unit', 'uid', 'leaf', 'relaySha256', 'probeSha256', 'aggregateResourceReadbackValidated',
            'candidateExhaustionValidated', 'limits', 'control', 'readback'}
        if type(value) is not dict or set(value) != keys: return False
        if not same({key: value[key] for key in ('unit', 'uid', 'leaf', 'relaySha256', 'probeSha256')},
                    {key: ownership[key] for key in ('unit', 'uid', 'leaf', 'relaySha256', 'probeSha256')}): return False
        if (value['aggregateResourceReadbackValidated'] is not True or value['candidateExhaustionValidated'] is not False
                or not same(value['limits'], LIMITS) or not same(value['readback'], READBACK)
                or not number(ready['sandbox']['uid']) or ready['sandbox']['uid'] != value['uid']): return False
        c = value['control']
        if type(c) is not dict or set(c) != {'driverPid', 'driverCgroup', 'managerPid', 'managerCgroup',
                'managerIdentityProfile', 'managerUid', 'managerGid', 'managerStartTimeTicks', 'managerSocket',
                'unitMainPid', 'unitMainCgroup', 'unitMainStartTimeTicks'}: return False
        if (c['managerIdentityProfile'] != 'private-socket-peer-v1' or c['driverPid'] != ownership['driverPid']
                or not number(c['managerUid']) or c['managerUid'] != value['uid'] or not number(c['managerGid'])
                or any(not number(c[key], 2) for key in ('driverPid', 'managerPid', 'unitMainPid'))
                or len({c['driverPid'], c['managerPid'], c['unitMainPid']}) != 3): return False
        for key in ('managerStartTimeTicks', 'unitMainStartTimeTicks'):
            if type(c[key]) is not str or re.fullmatch('[0-9]{1,32}', c[key]) is None: return False
        relative = value['leaf'][len('/sys/fs/cgroup'):]
        if c['unitMainCgroup'] != relative: return False
        for key in ('driverCgroup', 'managerCgroup'):
            path = c[key]
            if type(path) is not str or not path.startswith('/') or len(path) > 4096 or path == relative or path.startswith(relative + '/'): return False
        socket = c['managerSocket']
        if (type(socket) is not dict or set(socket) != {'path', 'components'}
                or socket['path'] != f"/run/user/{value['uid']}/systemd/private"
                or type(socket['components']) is not list or len(socket['components']) != 5): return False
        for i, component in enumerate(socket['components']):
            if (type(component) is not dict or set(component) != {'dev', 'ino', 'mode', 'uid', 'gid'}
                    or any(not number(v) for v in component.values())
                    or component['mode'] & 0xf000 != (0xc000 if i == 4 else 0x4000)): return False
        return socket['components'][-1]['uid'] == value['uid']
    except (KeyError, TypeError, ValueError): return False


def evaluate(report, scenario=SCENARIO):
    try:
        before = report['sourceSha256Before']
        driver = load_driver(before)
        required = set(driver.SOURCES) | {SELF, RELAY, PROBE}
        if (report.get('scenario') != scenario or set(before) != required
                or not same(before, report['sourceSha256After']) or not same(report['command'], fixed_command(scenario))): return False
        # Validate current measurement dependencies as well as the parent's own
        # seven helper bytes, before interpreting this as a current replay.
        if any(hashlib.sha256(Path(path).read_bytes()).hexdigest() != before[path] for path in required): return False
        frames = report['frames']
        if type(frames) is not list or any(type(frame) is not dict for frame in frames): return False
        owners = [frame for frame in frames if frame.get('type') == 'systemd_ownership']
        readies = [frame for frame in frames if frame.get('type') == 'ready']
        if len(owners) != 1 or len(readies) != 1 or frames.index(owners[0]) >= frames.index(readies[0]): return False
        if set(owners[0]) != {'version', 'type', 'ownership'} or type(owners[0]['version']) is not int or owners[0]['version'] != 1: return False
        if any(frame.get('type') == 'systemd_failure' for frame in frames): return False
        if not validate_ready(readies[0], owners[0]['ownership'], before): return False
        terminal = report['terminal']['systemdFixtureBoundary']
        if set(terminal) != set(readies[0]['systemdFixtureBoundary']) | {'preStartReadback', 'cleanup', 'relayErrors'}: return False
        if not same({k: v for k, v in terminal.items() if k not in ('preStartReadback', 'cleanup', 'relayErrors')}, readies[0]['systemdFixtureBoundary']): return False
        if (not same(terminal['preStartReadback'], READBACK) or terminal['relayErrors'] != []
                or not same(terminal['cleanup'], {'unitAbsent': True, 'leafAbsent': True, 'systemdRunClosed': True})): return False
        return driver.evaluate(scenario, report) is True
    except (ValueError, KeyError, TypeError, AttributeError, OSError): return False


class ObservedWire:
    """Observe the existing reader's bounded candidate JSONL; no second pipe."""
    def __init__(self, file):
        self.file = file
        self.owners = []
        self.invalid = False
        self.bytes = 0
        self.digest = hashlib.sha256()

    def loads(self, raw):
        if type(raw) is not bytes: raise ValueError('FIXED_DRIVER_RAW_BYTES_REQUIRED')
        self.bytes += len(raw)
        if self.bytes > 16 * 1024 * 1024: raise ValueError('SYSTEMD_WIRE_ARCHIVE_LIMIT')
        self.file.write(raw); self.file.flush(); self.digest.update(raw)
        value = json.loads(raw)
        if type(value) is dict and value.get('type') == 'systemd_ownership': self.owners.append(value)
        if type(value) is dict and value.get('type') == 'systemd_failure': self.invalid = True
        return value

    dumps = staticmethod(json.dumps)

    def admit_start(self, ready, before, original):
        if (self.invalid or len(self.owners) != 1 or set(self.owners[0]) != {'version', 'type', 'ownership'}
                or type(self.owners[0]['version']) is not int or self.owners[0]['version'] != 1
                or not validate_ready(ready, self.owners[0]['ownership'], before)):
            raise ValueError('SYSTEMD_RESOURCE_PRESTART_ADMISSION_FAILED')
        return original(ready, before)


def main():
    scenario = select_scenario(sys.argv[1:])
    command = fixed_command(scenario)
    identifier = uuid.uuid4()
    directory = Path('scratch') / ('session8-systemd-exec-environment-metadata-' + str(identifier))
    directory.mkdir(exist_ok=False)
    driver = load_driver()
    driver.COMMAND = command
    driver.SOURCES = tuple(dict.fromkeys((*driver.SOURCES, SELF, RELAY, PROBE)))
    original_hashes = driver.source_hashes
    def fixed_hashes():
        hashes = original_hashes()
        if hashes.get(DRIVER) != driver.loadedSourceSha256:
            raise ValueError('SYSTEMD_MEASURE_DRIVER_SOURCE_DRIFT')
        return hashes
    driver.source_hashes = fixed_hashes
    driver.uuid = types.SimpleNamespace(uuid4=lambda: identifier)
    artifact = Path('scratch') / ('session8-cli-' + scenario + '-measure-' + str(identifier) + '.json')
    record = {'version': 1, 'scenario': scenario, 'command': command, 'driverArtifact': str(artifact),
        'state': 'PREPARED', 'scenarioPassed': False, 'productionReady': False,
        'aggregateResourceReadbackValidated': False, 'candidateExhaustionValidated': False}
    receipt = directory / 'receipt.json'
    receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
    with (directory / 'candidate-frames.jsonl').open('xb') as file:
        observed = ObservedWire(file)
        driver.json = observed
        original = driver.environment_start
        def start(ready, before, requested=SCENARIO):
            if requested != scenario: raise ValueError('SYSTEMD_PROFILE_CONFUSION')
            return observed.admit_start(ready, before, lambda r, b: original(r, b, scenario))
        driver.environment_start = start
        driver.evaluate = lambda requested, report: requested == scenario and evaluate(report, scenario)
        try:
            passed = driver.measure(scenario)
            record.update(state='FINISHED', scenarioPassed=passed, aggregateResourceReadbackValidated=passed)
        except Exception as error:
            record.update(state='FAILED', errorType=type(error).__name__)
        record.update(candidateFrameBytes=observed.bytes, candidateFrameSha256=observed.digest.hexdigest(),
            rawScope='Existing reader candidate lines only; rejected overlong/overbudget unread lines are not a complete transcript.')
    if artifact.exists(): record['driverArtifactSha256'] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(json.dumps({'receipt': str(receipt), 'scenarioPassed': record['scenarioPassed']}))
    return 0 if record['scenarioPassed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
