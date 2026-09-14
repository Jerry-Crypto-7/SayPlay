"""Fixed trusted-control measurement reusing the reviewed capsule driver."""
import base64
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import sys
import types
import uuid

SCENARIO = 'trusted-control-boundary'
SELF = 'scripts/subscription-trusted-control-boundary.measure.py'
DRIVER = 'scripts/subscription-cli-supervisor.measure.py'
HELPERS = ('subscription-exec-server-worker-gate.py', 'subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py', 'subscription-trusted-control-boundary-probe.py',
    'subscription-worker-lockdown.py', 'subscription-appserver-noenv.py',
    'subscription-text-model-catalog.json', 'subscription-trusted-control-boundary-parent.py')


def load_bytes(name, raw):
    path = Path('scripts') / name
    spec = importlib.util.spec_from_file_location('trusted_measure_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def load_driver(before=None):
    raw = Path(DRIVER).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if before is not None and before.get(DRIVER) != digest: raise ValueError('DRIVER_SOURCE_DRIFT')
    driver = load_bytes(Path(DRIVER).name, raw)
    driver.loadedSourceSha256 = digest
    driver.SOURCES = tuple(dict.fromkeys((*driver.SOURCES, SELF)))
    driver.SCENARIOS = (*driver.SCENARIOS, SCENARIO)
    driver.ENVIRONMENT_MODES = (*driver.ENVIRONMENT_MODES, SCENARIO)
    driver.environment_start = start_request
    driver.environment_evaluation = parent_evaluation
    return driver


def start_request(ready, before, mode=SCENARIO):
    if mode != SCENARIO or type(ready) is not dict: raise ValueError('FIXED_TRUSTED_START_REQUIRED')
    hashes = {name: before.get('scripts/' + name) for name in HELPERS}
    if any(type(value) is not str or len(value) != 64 or any(c not in '0123456789abcdef' for c in value) for value in hashes.values()):
        raise ValueError('TRUSTED_HELPER_HASH_REQUIRED')
    if ready.get('trustedControlBoundary') != {'helperSha256': hashes} or type(ready.get('workerBoundary')) is not dict:
        raise ValueError('TRUSTED_HELPER_READY_MISMATCH')
    worker = ready['workerBoundary']
    for key, kind in (('namespace', 'pid'), ('mountNamespace', 'mnt')):
        if type(worker.get(key)) is not str or not re.fullmatch(kind + r':\[[1-9][0-9]*\]', worker[key]):
            raise ValueError('OUTER_NAMESPACE_REQUIRED')
    for key in ('control', 'output'):
        value = worker.get(key)
        if (type(value) is not dict or set(value) != {'dev', 'ino', 'type'}
                or any(type(v) is not int or not 0 <= v <= 9007199254740991 for v in value.values())
                or value['ino'] == 0 or value['type'] != 0o010000): raise ValueError('OUTER_PIPE_IDENTITY_REQUIRED')
    if worker['control'] == worker['output']: raise ValueError('DISTINCT_OUTER_PIPES_REQUIRED')
    return {'type': 'start', 'mode': SCENARIO, 'helperSha256': hashes}


def parent_evaluation(report):
    try:
        ready = [v for v in report['frames'] if type(v) is dict and v.get('type') == 'ready']
        if len(ready) != 1: return False
        hashes = start_request(ready[0], report['sourceSha256Before'], report['scenario'])['helperSha256']
        sources = {name: (Path('scripts') / name).read_bytes() for name in HELPERS}
        if any(hashlib.sha256(raw).hexdigest() != hashes[name] for name, raw in sources.items()): return False
        raw = bytearray()
        for frame in report['frames']:
            if frame.get('type') != 'child_output': continue
            if frame.get('stream') != 'stdout' or frame.get('encoding') != 'base64': return False
            chunk = base64.b64decode(frame['data'], validate=True)
            if len(raw) + len(chunk) > 2 * 1024 * 1024: return False
            raw.extend(chunk)
        gate = load_bytes('subscription-exec-server-worker-gate.py', sources['subscription-exec-server-worker-gate.py'])
        parent = load_bytes('subscription-trusted-control-boundary-parent.py', sources['subscription-trusted-control-boundary-parent.py'])
        policy = load_bytes('subscription-appserver-noenv.py', sources['subscription-appserver-noenv.py'])
        probe = load_bytes('subscription-trusted-control-boundary-probe.py', sources['subscription-trusted-control-boundary-probe.py'])
        body = gate.strict_json(bytes(raw))
        if body.get('helperSha256Before') != hashes or body.get('helperSha256After') != hashes: return False
        return parent.validate_report(body, policy, gate, probe, ready[0]['workerBoundary']) is True
    except (ValueError, KeyError, TypeError, AttributeError, OSError, RecursionError): return False


def evaluate(report):
    try:
        before = report['sourceSha256Before']
        driver = load_driver(before)
        if (set(before) != set(driver.SOURCES) or before != report['sourceSha256After']
                or report.get('command') != driver.COMMAND): return False
        if any(hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest for path, digest in before.items()): return False
        return driver.evaluate(SCENARIO, report) is True
    except (ValueError, KeyError, TypeError, AttributeError, OSError): return False


def main():
    if sys.argv[1:]: raise ValueError('FIXED_TRUSTED_MEASUREMENT_NO_ARGUMENTS')
    identifier = uuid.uuid4()
    directory = Path('scratch') / ('session8-trusted-control-boundary-' + str(identifier))
    directory.mkdir(exist_ok=False)
    driver = load_driver()
    original_hashes = driver.source_hashes
    def hashes():
        before = original_hashes()
        if before[DRIVER] != driver.loadedSourceSha256: raise ValueError('LOADED_DRIVER_SOURCE_DRIFT')
        return before
    driver.source_hashes = hashes
    driver.uuid = types.SimpleNamespace(uuid4=lambda: identifier)
    driver.evaluate = lambda scenario, report: scenario == SCENARIO and evaluate(report)
    artifact = Path('scratch') / ('session8-cli-' + SCENARIO + '-measure-' + str(identifier) + '.json')
    receipt = directory / 'receipt.json'
    result = {'version': 1, 'scenario': SCENARIO, 'driverArtifact': str(artifact), 'command': driver.COMMAND,
        'state': 'PREPARED', 'scenarioPassed': False, 'productionReady': False,
        'aggregateResourcesValidated': False, 'actualModelCalls': 0}
    receipt.write_text(json.dumps(result, indent=2), encoding='utf-8')
    try:
        result.update(state='FINISHED', scenarioPassed=driver.measure(SCENARIO))
    except Exception as error: result.update(state='FAILED', errorType=type(error).__name__)
    if artifact.exists():
        artifact_raw = artifact.read_bytes()
        result['driverArtifactSha256'] = hashlib.sha256(artifact_raw).hexdigest()
        report = json.loads(artifact_raw)
        raw = bytearray()
        for frame in report.get('frames', []):
            if frame.get('type') == 'child_output' and frame.get('stream') == 'stdout':
                chunk = base64.b64decode(frame['data'], validate=True)
                if len(raw) + len(chunk) > 8388608: raise ValueError('RAW_ARCHIVE_BOUND')
                raw.extend(chunk)
        (directory / 'parent-stdout.bin').write_bytes(raw)
        result.update(parentStdoutBytes=len(raw), parentStdoutSha256=hashlib.sha256(raw).hexdigest(),
            parentStdoutComplete=result['scenarioPassed'], rawScope='Exact received parent stdout; complete only with successful EOF/hash validation. Wire representation remains driver frames.')
    receipt.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({'receipt': str(receipt), 'scenarioPassed': result['scenarioPassed']}))
    return 0 if result['scenarioPassed'] else 1


if __name__ == '__main__': raise SystemExit(main())
