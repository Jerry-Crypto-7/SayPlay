"""Fixed ingress SCM_RIGHTS resource integration; preserves actual wire frames."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import types
import uuid

SELF = 'scripts/subscription-trusted-ingress-systemd.measure.py'
BASIC = 'scripts/subscription-trusted-ingress.measure.py'
RESOURCE = 'scripts/subscription-exec-environment-systemd.measure.py'
RELAY = 'scripts/subscription-systemd-fixture-transport.py'
PROBE = 'scripts/subscription-systemd-cli-probe.py'
RECEIVER = 'scripts/subscription-systemd-ingress-receiver.py'
RENDEZVOUS = 'scripts/subscription-systemd-ingress-rendezvous.py'
SCENARIO = 'trusted-ingress-boundary'
COMMAND = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/scripts/subscription-systemd-fixture-transport.py', '--trusted-ingress-boundary']
LOADED_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def load(path, before=None):
    raw = Path(path).read_bytes()
    if before is not None and hashlib.sha256(raw).hexdigest() != before.get(path): raise ValueError('SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('systemd_ingress_' + Path(path).name, path)
    value = importlib.util.module_from_spec(spec); exec(compile(raw, path, 'exec'), value.__dict__)
    value.loadedSha = hashlib.sha256(raw).hexdigest()
    return value


def stack(before=None):
    basic, resource = load(BASIC, before), load(RESOURCE, before)
    driver = basic.load_driver(before)
    driver.SOURCES = tuple(dict.fromkeys((*driver.SOURCES, SELF, RESOURCE, RELAY, PROBE, RECEIVER, RENDEZVOUS)))
    driver.COMMAND = list(COMMAND)
    driver.environment_evaluation = child_evaluation
    driver.composedSources = {SELF: LOADED_SHA, BASIC: basic.loadedSha, RESOURCE: resource.loadedSha}
    resource.SELF = SELF; resource.load_driver = lambda before=None: driver
    resource.fixed_command = lambda scenario: list(COMMAND) if scenario == SCENARIO else None
    return basic, resource, driver


def single(frames, kind, field):
    values = [frame for frame in frames if frame.get('type') == kind]
    if len(values) != 1: raise ValueError('EXACT_FRAME_REQUIRED')
    frame = values[0]
    if set(frame) != {'version', 'type', field} or type(frame['version']) is not int or frame['version'] != 1:
        raise ValueError('EXACT_FRAME_SCHEMA')
    return frame[field]


def admission(frames, ready, before):
    try: return _admission(frames, ready, before)
    except (TypeError, KeyError, AttributeError) as error: raise ValueError('MALFORMED_PRESTART_EVIDENCE') from error


def _admission(frames, ready, before):
    basic, resource, _ = stack(before)
    own = single(frames, 'systemd_ownership', 'ownership')
    owner = single(frames, 'systemd_ingress_ownership', 'ownership')
    handoff = single(frames, 'systemd_ingress_handoff', 'handoff')
    if not resource.validate_ready(ready, own, before): raise ValueError('RESOURCE_ADMISSION')
    sources = load(RENDEZVOUS, before).SOURCES
    if (set(owner) != {'unit', 'uuid', 'nonce', 'controllerPid', 'controllerStartTicks', 'rendezvous', 'sourceSha256'}
            or owner['unit'] != own['unit'] or owner['uuid'] != own['unit'][19:-8]
            or type(owner['nonce']) is not str or re.fullmatch('[a-f0-9]{32}', owner['nonce']) is None
            or type(owner['controllerPid']) is not int or owner['controllerPid'] != own['driverPid']
            or type(owner['controllerStartTicks']) is not str or re.fullmatch('[1-9][0-9]{0,31}', owner['controllerStartTicks']) is None
            or not basic.same(owner['sourceSha256'], basic.expected_hashes(before, sources))): raise ValueError('INGRESS_OWNER_BINDING')
    path = owner['rendezvous']
    if (type(path) is not dict or set(path) != {'path', 'dev', 'ino'} or not basic.integer(path['dev'])
            or not basic.integer(path['ino'], 1) or path['path'] != f"/run/user/{own['uid']}/rc-ingress-{owner['uuid']}/handoff.sock"):
        raise ValueError('RENDEZVOUS_BINDING')
    if (set(handoff) != {'version', 'unit', 'nonce', 'socket', 'readback', 'control', 'receiverAck', 'transferObserved', 'remoteCleanup', 'productionReady'}
            or type(handoff['version']) is not int or handoff['version'] != 1 or handoff['unit'] != owner['unit']
            or handoff['nonce'] != owner['nonce'] or not basic.valid_socket(handoff['socket'])
            or not basic.same(handoff['readback'], resource.READBACK)
            or not basic.same(handoff['control'], ready['systemdFixtureBoundary']['control'])
            or handoff['transferObserved'] is not True or handoff['remoteCleanup'] != 'NOT_ATTESTED' or handoff['productionReady'] is not False):
        raise ValueError('HANDOFF_BINDING')
    ingress = {'fd': 198, 'nonce': owner['nonce'], 'socket': handoff['socket']}
    ack = {'version': 1, 'type': 'fd_received', 'uuid': owner['uuid'], **ingress}
    if not basic.same(handoff['receiverAck'], ack): raise ValueError('RECEIVER_ACK_BINDING')
    if not basic.same(ready.get('systemdIngressBoundary'), {'nonce': owner['nonce'], 'ownership': owner, 'handoff': handoff}):
        raise ValueError('POST_PIVOT_BINDING')
    if not basic.same(ready.get('trustedIngressFd'), {'fd': 198, 'socket': ingress['socket'], 'bootstrapInheritance': 'trusted-setup-only', 'preservedAcrossPivot': True}):
        raise ValueError('FD198_BINDING')
    sandbox = ready.get('sandbox')
    if (not basic.same(ready.get('limits'), basic.LIMITS) or type(sandbox) is not dict or set(sandbox) != set(basic.SANDBOX) | {'uid', 'gid'}
            or not basic.integer(sandbox['uid']) or not basic.integer(sandbox['gid'])
            or not basic.same({key: sandbox[key] for key in basic.SANDBOX}, basic.SANDBOX)):
        raise ValueError('RUNTIME_FACTS')
    helpers = basic.expected_hashes(before, basic.HELPERS)
    if not basic.same(ready.get('trustedIngressBoundary'), {'helperSha256': helpers}): raise ValueError('HELPER_BINDING')
    worker = ready.get('workerBoundary')
    if type(worker) is not dict: raise ValueError('WORKER_BOUNDARY_REQUIRED')
    for key, prefix in (('namespace', 'pid'), ('mountNamespace', 'mnt')):
        if type(worker.get(key)) is not str or re.fullmatch(prefix + r':\[[1-9][0-9]*\]', worker[key]) is None:
            raise ValueError('WORKER_NAMESPACE_REQUIRED')
    for key in ('control', 'output'):
        value = worker.get(key)
        if (type(value) is not dict or set(value) != {'dev', 'ino', 'type'}
                or not all(basic.integer(item) for item in value.values()) or value['ino'] == 0 or value['type'] != 4096):
            raise ValueError('WORKER_PIPE_REQUIRED')
    if basic.same(worker['control'], worker['output']): raise ValueError('WORKER_PIPE_ALIAS')
    return ingress, helpers


def child_evaluation(report):
    try:
        before = report['sourceSha256Before']; basic = load(BASIC, before)
        ready = [frame for frame in report['frames'] if frame.get('type') == 'ready']
        if len(ready) != 1: return False
        ingress, helpers = admission(report['frames'], ready[0], before)
        raw = bytearray()
        for frame in report['frames']:
            if frame.get('type') != 'child_output': continue
            if frame.get('stream') != 'stdout' or frame.get('encoding') != 'base64': return False
            raw.extend(base64.b64decode(frame['data'], validate=True))
            if len(raw) > 2 * 1024 * 1024: return False
        modules = {name: load('scripts/' + name, before) for name in basic.HELPERS if name.endswith('.py')}
        policy = modules['subscription-appserver-noenv.py']; body = policy.strict_json(bytes(raw))
        if not basic.same(body.get('helperSha256Before'), helpers) or not basic.same(body.get('helperSha256After'), helpers): return False
        deps = (modules['subscription-trusted-control-boundary-parent.py'], modules['subscription-exec-server-worker-gate.py'], policy,
            modules['subscription-trusted-ingress-worker-probe.py'], lambda: load('scripts/subscription-trusted-control-boundary-probe.py', before))
        return modules['subscription-trusted-ingress-child.py'].validate_report(body, deps, ready[0]['workerBoundary'], ingress) is True
    except (ValueError, TypeError, KeyError, OSError, AttributeError): return False


def final_ingress(value, ingress, unit, before):
    basic = load(BASIC, before)
    if (set(value) != {'version', 'unit', 'nonce', 'route', 'broker', 'threadsClosed', 'ownedCleanupVerified', 'pathCleanup',
            'peersClosed', 'errors', 'remoteUnitCleanup', 'productionReady', 'passed', 'sourceStable'}
            or type(value['version']) is not int or value['version'] != 1 or value['unit'] != unit or value['nonce'] != ingress['nonce']
            or any(value[key] is not True for key in ('threadsClosed', 'ownedCleanupVerified', 'peersClosed', 'passed', 'sourceStable'))
            or value['errors'] != [] or value['remoteUnitCleanup'] != 'NOT_ATTESTED' or value['productionReady'] is not False
            or not basic.same(value['pathCleanup'], {'socketRemoved': True, 'directoryRemoved': True})
            or not basic.same(value['route'], {'beforeBytes': 40, 'afterBytes': 39, 'eof': True})): return False
    broker = value['broker']; proxy = load('scripts/subscription-trusted-egress-proxy.py', before)
    return (type(broker) is dict and set(broker) == {'version', 'profile', 'reason', 'connectAccepted', 'observedBytes', 'deliveredBytes',
            'elapsedMs', 'brokerDescriptorsClosed', 'productionReady', 'externalNetworkCalls', 'modelCalls'}
        and type(broker['version']) is int and broker['version'] == 1 and broker['profile'] == 'authored-offline-connect'
        and broker['reason'] == 'EOF' and broker['connectAccepted'] is True and broker['brokerDescriptorsClosed'] is True
        and broker['productionReady'] is False and basic.integer(broker['elapsedMs']) and broker['elapsedMs'] <= 5000
        and type(broker['externalNetworkCalls']) is int and broker['externalNetworkCalls'] == 0
        and type(broker['modelCalls']) is int and broker['modelCalls'] == 0
        and basic.same(broker['observedBytes'], {'ingress': len(proxy.REQUEST) + 79, 'upstream': 87})
        and basic.same(broker['deliveredBytes'], {'ingress': len(proxy.RESPONSE) + 87, 'upstream': 79}))


def evaluate(report):
    try:
        before = report['sourceSha256Before']; basic, resource, driver = stack(before)
        if len(driver.SOURCES) != 30 or before.get(SELF) != LOADED_SHA: return False
        frames = report['frames']; kinds = ('systemd_ownership', 'systemd_ingress_ownership', 'systemd_ingress_handoff', 'ready', 'started', 'terminal', 'systemd_ingress_terminal')
        if type(frames) is not list or any(type(frame) is not dict for frame in frames): return False
        indexes = []
        for kind in kinds:
            found = [i for i, frame in enumerate(frames) if frame.get('type') == kind]
            if len(found) != 1: return False
            indexes.extend(found)
        if indexes != sorted(indexes) or indexes[0] != 0 or indexes[-1] != len(frames) - 1: return False
        if any(frame.get('type') not in (*kinds, 'child_output') or frame.get('type') == 'child_output' and not indexes[4] < i < indexes[5] for i, frame in enumerate(frames)): return False
        ready = frames[indexes[3]]; ingress, _ = admission(frames, ready, before)
        value = single(frames, 'systemd_ingress_terminal', 'result')
        if not final_ingress(value, ingress, ready['systemdFixtureBoundary']['unit'], before): return False
        return resource.evaluate(report, SCENARIO) is True
    except (ValueError, TypeError, KeyError, OSError, AttributeError): return False


def start_request(frames, ready, before, requested=SCENARIO):
    if requested != SCENARIO: raise ValueError('FIXED_PROFILE')
    if type(frames) is not list or any(type(frame) is not dict for frame in frames) or type(ready) is not dict:
        raise ValueError('PRESTART_FRAME_OBJECTS_REQUIRED')
    if [frame.get('type') for frame in frames] != ['systemd_ownership', 'systemd_ingress_ownership', 'systemd_ingress_handoff', 'ready']:
        raise ValueError('PRESTART_ORDER')
    basic = load(BASIC, before)
    if not basic.same(frames[-1], ready): raise ValueError('OBSERVED_READY_REQUIRED')
    ingress, helpers = admission(frames, ready, before)
    return {'type': 'start', 'mode': SCENARIO, 'helperSha256': helpers, 'nonce': ingress['nonce']}


def main():
    if sys.argv[1:]: raise ValueError('FIXED_NO_ARGUMENTS')
    identifier = uuid.uuid4(); directory = Path('scratch') / ('session8-trusted-ingress-systemd-' + str(identifier)); directory.mkdir(exist_ok=False)
    basic, _, driver = stack(); original_hashes = driver.source_hashes
    def hashes():
        before = original_hashes()
        if (any(before.get(path) != digest for path, digest in driver.composedSources.items())
                or before[basic.DRIVER] != driver.loadedSourceSha256): raise ValueError('LOADED_SOURCE_DRIFT')
        return before
    driver.source_hashes = hashes; driver.uuid = types.SimpleNamespace(uuid4=lambda: identifier)
    artifact = Path('scratch') / ('session8-cli-' + SCENARIO + '-measure-' + str(identifier) + '.json')
    receipt = directory / 'receipt.json'
    result = {'version': 1, 'scenarioPassed': False, 'state': 'PREPARED', 'driverArtifact': str(artifact), 'productionReady': False,
        'actualModelCalls': 0, 'candidateExhaustionValidated': False, 'aggregateResourceReadbackValidated': False}
    receipt.write_text(json.dumps(result, indent=2), encoding='utf-8')
    with (directory / 'candidate-frames.jsonl').open('xb') as wire:
        observed = basic.ObservedWire(wire); driver.json = observed
        def start(ready, before, requested=SCENARIO):
            return start_request(observed.frames, ready, before, requested)
        driver.environment_start = start; driver.evaluate = lambda scenario, report: scenario == SCENARIO and evaluate(report)
        try:
            passed = driver.measure(SCENARIO); result.update(state='FINISHED', scenarioPassed=passed, aggregateResourceReadbackValidated=passed)
        except Exception as error: result.update(state='FAILED', errorType=type(error).__name__)
        result.update(candidateFrameBytes=observed.bytes, candidateFrameSha256=observed.digest.hexdigest())
    if artifact.exists(): result['driverArtifactSha256'] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    receipt.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({'receipt': str(receipt), 'scenarioPassed': result['scenarioPassed']}))
    return 0 if result['scenarioPassed'] else 1


if __name__ == '__main__': raise SystemExit(main())
