"""Fixed Windows-to-WSL ingress capability measurement; no caller inputs."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import types
import uuid

SCENARIO = 'trusted-ingress-boundary'
SELF = 'scripts/subscription-trusted-ingress.measure.py'
DRIVER = 'scripts/subscription-cli-supervisor.measure.py'
LAUNCHER = 'scripts/subscription-trusted-ingress-launcher.py'
PROXY = 'scripts/subscription-trusted-egress-proxy.py'
HELPERS = ('subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-trusted-control-boundary-probe.py',
    'subscription-worker-lockdown.py', 'subscription-appserver-noenv.py', 'subscription-text-model-catalog.json',
    'subscription-trusted-control-boundary-parent.py', 'subscription-trusted-ingress-child.py',
    'subscription-trusted-ingress-worker-probe.py')
LAUNCHER_SOURCES = ('subscription-trusted-ingress-launcher.py', 'subscription-trusted-egress-proxy.py',
    'subscription-cli-supervisor.sh', 'subscription-cli-supervisor.py', *HELPERS)
COMMAND = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/scripts/subscription-trusted-ingress-launcher.py']
LOADED_SELF_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
CLI_SHA256 = 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'
BWRAP_SHA256 = '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'
LIMITS = {'jobMs': 180000, 'commandMs': 200000, 'termGraceMs': 5000, 'maxOutputBytes': 8388608,
    'commandBudgetEnforcedHere': False, 'aggregateResourcesEnforced': False}
SANDBOX = {'pidNamespaceInit': True, 'hostHomeMounted': False, 'hostMntMounted': False,
    'networkInterfaces': ['lo'], 'ttyIsNullDevice': True, 'runtimeWriteDenied': True, 'parentNondumpable': True}


def same(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 9007199254740991


def valid_socket(value):
    return (type(value) is dict and set(value) == {'dev', 'ino', 'type', 'family', 'socketType'}
        and all(integer(item) for item in value.values()) and value['ino'] > 0
        and value['type'] == 49152 and value['family'] == 1 and value['socketType'] == 1)


def expected_hashes(before, names):
    values = {name: before.get('scripts/' + name) for name in names}
    if any(type(value) is not str or re.fullmatch('[a-f0-9]{64}', value) is None for value in values.values()):
        raise ValueError('INGRESS_SOURCE_HASH_REQUIRED')
    return values


def validate_ownership(frame, before):
    try:
        return (type(frame) is dict and set(frame) == {'type', 'version', 'nonce', 'fd', 'socket', 'sourceSha256'}
            and frame['type'] == 'ingress_ownership' and type(frame['version']) is int and frame['version'] == 1
            and type(frame['fd']) is int and frame['fd'] == 198 and valid_socket(frame['socket'])
            and type(frame['nonce']) is str and re.fullmatch('[a-f0-9]{32}', frame['nonce']) is not None
            and same(frame['sourceSha256'], expected_hashes(before, LAUNCHER_SOURCES)))
    except (ValueError, TypeError, KeyError): return False


def start_request(ready, before, ownership):
    if not validate_ownership(ownership, before) or type(ready) is not dict:
        raise ValueError('INGRESS_OWNERSHIP_REQUIRED_BEFORE_START')
    hashes = expected_hashes(before, HELPERS)
    sandbox = ready.get('sandbox')
    if (ready.get('binarySha256') != CLI_SHA256 or ready.get('bwrapSha256') != BWRAP_SHA256
            or not same(ready.get('limits'), LIMITS) or type(sandbox) is not dict
            or set(sandbox) != set(SANDBOX) | {'uid', 'gid'}
            or not integer(sandbox.get('uid')) or not integer(sandbox.get('gid'))
            or not same({key: sandbox[key] for key in SANDBOX}, SANDBOX)):
        raise ValueError('INGRESS_RUNTIME_ADMISSION_FAILED')
    if (not same(ready.get('trustedIngressBoundary'), {'helperSha256': hashes})
            or not same(ready.get('trustedIngressFd'), {'fd': 198, 'socket': ownership['socket'],
                'bootstrapInheritance': 'trusted-setup-only', 'preservedAcrossPivot': True})):
        raise ValueError('INGRESS_READY_IDENTITY_MISMATCH')
    worker = ready.get('workerBoundary')
    if type(worker) is not dict: raise ValueError('INGRESS_OUTER_WORKER_REQUIRED')
    for key, prefix in (('namespace', 'pid'), ('mountNamespace', 'mnt')):
        if type(worker.get(key)) is not str or re.fullmatch(prefix + r':\[[1-9][0-9]*\]', worker[key]) is None:
            raise ValueError('INGRESS_OUTER_NAMESPACE_INVALID')
    for key in ('control', 'output'):
        value = worker.get(key)
        if (type(value) is not dict or set(value) != {'dev', 'ino', 'type'} or not all(integer(item) for item in value.values())
                or value['ino'] == 0 or value['type'] != 4096): raise ValueError('INGRESS_OUTER_PIPE_INVALID')
    if worker['control'] == worker['output']: raise ValueError('INGRESS_OUTER_PIPE_ALIAS')
    return {'type': 'start', 'mode': SCENARIO, 'helperSha256': hashes, 'nonce': ownership['nonce']}


def load_source(path, before):
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != before.get(path): raise ValueError('INGRESS_LOADED_SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('ingress_measure_' + Path(path).name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, path, 'exec'), module.__dict__)
    return module


def child_evaluation(report):
    try:
        before = report['sourceSha256Before']
        owners = [frame for frame in report['frames'] if frame.get('type') == 'ingress_ownership']
        readies = [frame for frame in report['frames'] if frame.get('type') == 'ready']
        if len(owners) != 1 or len(readies) != 1: return False
        expected = start_request(readies[0], before, owners[0])['helperSha256']
        raw = bytearray()
        for frame in report['frames']:
            if frame.get('type') != 'child_output': continue
            if frame.get('stream') != 'stdout' or frame.get('encoding') != 'base64': return False
            chunk = base64.b64decode(frame['data'], validate=True)
            if len(raw) + len(chunk) > 2 * 1024 * 1024: return False
            raw.extend(chunk)
        modules = {name: load_source('scripts/' + name, before) for name in HELPERS if name.endswith('.py')}
        child = modules['subscription-trusted-ingress-child.py']
        policy = modules['subscription-appserver-noenv.py']
        body = policy.strict_json(bytes(raw))
        if body.get('helperSha256Before') != expected or body.get('helperSha256After') != expected: return False
        deps = (modules['subscription-trusted-control-boundary-parent.py'], modules['subscription-exec-server-worker-gate.py'],
            policy, modules['subscription-trusted-ingress-worker-probe.py'],
            lambda: load_source('scripts/subscription-trusted-control-boundary-probe.py', before))
        ingress = {key: owners[0][key] for key in ('fd', 'nonce', 'socket')}
        return child.validate_report(body, deps, readies[0]['workerBoundary'], ingress) is True
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError): return False


def load_driver(before=None):
    digest = hashlib.sha256(Path(DRIVER).read_bytes()).hexdigest()
    expected = before if before is not None else {DRIVER: digest}
    driver = load_source(DRIVER, expected)
    driver.loadedSourceSha256 = digest
    driver.SOURCES = tuple(dict.fromkeys((*driver.SOURCES, SELF, LAUNCHER, PROXY)))
    driver.SCENARIOS = (*driver.SCENARIOS, SCENARIO)
    driver.ENVIRONMENT_MODES = (*driver.ENVIRONMENT_MODES, SCENARIO)
    driver.COMMAND = list(COMMAND)
    driver.environment_evaluation = child_evaluation
    return driver


def validate_terminal(value, owner, before):
    try:
        keys = {'type', 'version', 'nonce', 'socket', 'sourceBefore', 'sourceAfter', 'capsuleWaitKnown', 'capsuleReturnCode',
            'remoteProcessCleanup', 'broker', 'route', 'threadsClosed', 'peersClosed', 'errors', 'passed', 'productionReady', 'aggregateResourcesValidated'}
        if (type(value) is not dict or set(value) != keys or value['type'] != 'ingress_terminal'
                or type(value['version']) is not int or value['version'] != 1 or value['nonce'] != owner['nonce']
                or not same(value['socket'], owner['socket']) or not same(value['sourceBefore'], expected_hashes(before, LAUNCHER_SOURCES))
                or not same(value['sourceBefore'], value['sourceAfter']) or value['capsuleWaitKnown'] is not True
                or type(value['capsuleReturnCode']) is not int or value['capsuleReturnCode'] != 0
                or value['remoteProcessCleanup'] != 'NOT_ATTESTED_BY_LAUNCHER'
                or any(value[key] is not True for key in ('threadsClosed', 'peersClosed', 'passed')) or value['errors'] != []
                or value['productionReady'] is not False or value['aggregateResourcesValidated'] is not False
                or not same(value['route'], {'beforeBytes': 40, 'afterBytes': 39, 'eof': True})): return False
        broker = value['broker']
        if (type(broker) is not dict or set(broker) != {'version', 'profile', 'reason', 'connectAccepted', 'observedBytes',
                'deliveredBytes', 'elapsedMs', 'brokerDescriptorsClosed', 'productionReady', 'externalNetworkCalls', 'modelCalls'}
                or type(broker['version']) is not int or broker['version'] != 1 or broker['profile'] != 'authored-offline-connect'
                or broker['reason'] != 'EOF' or broker['connectAccepted'] is not True or broker['brokerDescriptorsClosed'] is not True
                or broker['productionReady'] is not False or not integer(broker['elapsedMs']) or broker['elapsedMs'] > 5000
                or type(broker['externalNetworkCalls']) is not int or broker['externalNetworkCalls'] != 0
                or type(broker['modelCalls']) is not int or broker['modelCalls'] != 0): return False
        proxy = load_source(PROXY, before)
        return (same(broker['observedBytes'], {'ingress': len(proxy.REQUEST) + 79, 'upstream': 87})
            and same(broker['deliveredBytes'], {'ingress': len(proxy.RESPONSE) + 87, 'upstream': 79}))
    except (ValueError, TypeError, KeyError, AttributeError, OSError): return False


def evaluate(report):
    try:
        before = report['sourceSha256Before']; driver = load_driver(before)
        if (len(driver.SOURCES) != 24 or set(before) != set(driver.SOURCES) or not same(before, report['sourceSha256After'])
                or before.get(SELF) != LOADED_SELF_SHA256 or report.get('scenario') != SCENARIO or not same(report.get('command'), COMMAND)
                or any(hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest for path, digest in before.items())): return False
        frames = report['frames']
        if type(frames) is not list or any(type(frame) is not dict for frame in frames): return False
        ordered = []
        for kind in ('ingress_ownership', 'ready', 'started', 'terminal', 'ingress_terminal'):
            found = [(index, frame) for index, frame in enumerate(frames) if frame.get('type') == kind]
            if len(found) != 1: return False
            ordered.append(found[0])
        if [index for index, _ in ordered] != sorted(index for index, _ in ordered): return False
        if ordered[0][0] != 0 or ordered[-1][0] != len(frames) - 1: return False
        allowed = {'ingress_ownership', 'ready', 'started', 'child_output', 'terminal', 'ingress_terminal'}
        if any(frame.get('type') not in allowed for frame in frames): return False
        if any(frame.get('type') == 'child_output' and not ordered[2][0] < index < ordered[3][0]
               for index, frame in enumerate(frames)): return False
        owner, ready, _, terminal, ingress_terminal = [frame for _, frame in ordered]
        if not same(terminal, report['terminal']) or not validate_ownership(owner, before): return False
        start_request(ready, before, owner)
        if not validate_terminal(ingress_terminal, owner, before): return False
        return driver.evaluate(SCENARIO, report) is True
    except (ValueError, TypeError, KeyError, AttributeError, OSError): return False


class ObservedWire:
    def __init__(self, file):
        self.file, self.frames = file, []
        self.bytes = 0; self.digest = hashlib.sha256()

    def loads(self, raw):
        if type(raw) is not bytes or self.bytes + len(raw) > 16 * 1024 * 1024: raise ValueError('INGRESS_WIRE_LIMIT')
        self.bytes += len(raw); self.digest.update(raw); self.file.write(raw); self.file.flush()
        def unique(items):
            result = {}
            for key, value in items:
                if key in result: raise ValueError('INGRESS_DUPLICATE_WIRE_KEY')
                result[key] = value
            return result
        frame = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_WIRE')))
        if type(frame) is not dict: raise ValueError('INGRESS_FRAME_OBJECT_REQUIRED')
        self.frames.append(frame)
        return frame

    dumps = staticmethod(json.dumps)

    def start(self, ready, before, scenario=SCENARIO):
        if scenario != SCENARIO: raise ValueError('INGRESS_SCENARIO_REQUIRED')
        owners = [frame for frame in self.frames if frame.get('type') == 'ingress_ownership']
        if len(owners) != 1 or self.frames.index(owners[0]) >= self.frames.index(ready):
            raise ValueError('INGRESS_OWNERSHIP_ORDER_REQUIRED')
        return start_request(ready, before, owners[0])


def main():
    if sys.argv[1:]: raise ValueError('FIXED_INGRESS_MEASURE_NO_ARGUMENTS')
    identifier = uuid.uuid4()
    directory = Path('scratch') / ('session8-trusted-ingress-' + str(identifier)); directory.mkdir(exist_ok=False)
    driver = load_driver(); original_hashes = driver.source_hashes
    def hashes():
        before = original_hashes()
        if before.get(DRIVER) != driver.loadedSourceSha256 or before.get(SELF) != LOADED_SELF_SHA256:
            raise ValueError('INGRESS_LOADED_DRIVER_DRIFT')
        return before
    driver.source_hashes = hashes; driver.uuid = types.SimpleNamespace(uuid4=lambda: identifier)
    artifact = Path('scratch') / ('session8-cli-' + SCENARIO + '-measure-' + str(identifier) + '.json')
    receipt = directory / 'receipt.json'
    record = {'version': 1, 'scenario': SCENARIO, 'command': COMMAND, 'state': 'PREPARED', 'scenarioPassed': False,
        'driverArtifact': str(artifact), 'productionReady': False, 'aggregateResourcesValidated': False, 'actualModelCalls': 0}
    receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
    with (directory / 'candidate-frames.jsonl').open('xb') as wire:
        observed = ObservedWire(wire); driver.json = observed; driver.environment_start = observed.start
        driver.evaluate = lambda scenario, report: scenario == SCENARIO and evaluate(report)
        try: record.update(state='FINISHED', scenarioPassed=driver.measure(SCENARIO))
        except Exception as failure: record.update(state='FAILED', errorType=type(failure).__name__)
        record.update(candidateFrameBytes=observed.bytes, candidateFrameSha256=observed.digest.hexdigest())
    if artifact.exists():
        raw_artifact = artifact.read_bytes(); record['driverArtifactSha256'] = hashlib.sha256(raw_artifact).hexdigest()
        report = json.loads(raw_artifact); raw = bytearray()
        for frame in report.get('frames', []):
            if frame.get('type') == 'child_output' and frame.get('stream') == 'stdout':
                block = base64.b64decode(frame['data'], validate=True)
                if len(raw) + len(block) > 8388608: raise ValueError('INGRESS_RAW_ARCHIVE_LIMIT')
                raw.extend(block)
        (directory / 'child-stdout.bin').write_bytes(raw)
        record.update(childStdoutBytes=len(raw), childStdoutSha256=hashlib.sha256(raw).hexdigest(), childStdoutComplete=record['scenarioPassed'])
    receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(json.dumps({'receipt': str(receipt), 'scenarioPassed': record['scenarioPassed']}))
    return 0 if record['scenarioPassed'] else 1


if __name__ == '__main__': raise SystemExit(main())
