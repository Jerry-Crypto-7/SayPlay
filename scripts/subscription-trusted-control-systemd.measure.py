"""Fixed trusted-control probe inside the existing private-peer resource relay."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import uuid

SCENARIO = 'trusted-control-boundary'
SELF = 'scripts/subscription-trusted-control-systemd.measure.py'
TRUSTED = 'scripts/subscription-trusted-control-boundary.measure.py'
RESOURCE = 'scripts/subscription-exec-environment-systemd.measure.py'
RELAY = 'scripts/subscription-systemd-fixture-transport.py'
PROBE = 'scripts/subscription-systemd-cli-probe.py'
COMMAND = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/scripts/subscription-systemd-fixture-transport.py',
    '--trusted-control-boundary']
LOADED_SELF_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def load_source(path, expected=None):
    raw = Path(path).read_bytes()
    if expected is not None and hashlib.sha256(raw).hexdigest() != expected.get(path):
        raise ValueError('TRUSTED_SYSTEMD_DEPENDENCY_SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('trusted_systemd_' + Path(path).name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, path, 'exec'), module.__dict__)
    module.loadedWrapperSha256 = hashlib.sha256(raw).hexdigest()
    return module


def load_stack(expected=None):
    trusted = load_source(TRUSTED, expected)
    resource = load_source(RESOURCE, expected)
    driver = trusted.load_driver(expected)
    driver.SOURCES = tuple(dict.fromkeys((*driver.SOURCES, SELF, TRUSTED, RESOURCE, RELAY, PROBE)))
    driver.COMMAND = list(COMMAND)
    driver.composedSourceSha256 = {SELF: LOADED_SELF_SHA256, TRUSTED: trusted.loadedWrapperSha256,
                                  RESOURCE: resource.loadedWrapperSha256}
    # Isolated module composition reuses the existing full resource validator
    # and the trusted driver's full parent validator, without editing either.
    resource.SELF = SELF
    resource.load_driver = lambda before=None: driver
    def fixed_command(scenario):
        if scenario != SCENARIO:
            raise ValueError('FIXED_TRUSTED_SYSTEMD_SCENARIO_REQUIRED')
        return list(COMMAND)
    resource.fixed_command = fixed_command
    return driver, resource


def evaluate(report):
    try:
        driver, resource = load_stack(report['sourceSha256Before'])
        if any(report['sourceSha256Before'].get(path) != digest for path, digest in driver.composedSourceSha256.items()):
            return False
        return resource.evaluate(report, SCENARIO) is True
    except (ValueError, KeyError, TypeError, AttributeError, OSError):
        return False


def main():
    if sys.argv[1:]:
        raise ValueError('FIXED_TRUSTED_SYSTEMD_NO_ARGUMENTS')
    identifier = uuid.uuid4()
    directory = Path('scratch') / ('session8-trusted-control-systemd-' + str(identifier))
    directory.mkdir(exist_ok=False)
    driver, resource = load_stack()
    original_hashes = driver.source_hashes
    def hashes():
        before = original_hashes()
        if before.get('scripts/subscription-cli-supervisor.measure.py') != driver.loadedSourceSha256:
            raise ValueError('TRUSTED_SYSTEMD_LOADED_DRIVER_DRIFT')
        if any(before.get(path) != digest for path, digest in driver.composedSourceSha256.items()):
            raise ValueError('TRUSTED_SYSTEMD_LOADED_WRAPPER_DRIFT')
        return before
    driver.source_hashes = hashes
    driver.uuid = types.SimpleNamespace(uuid4=lambda: identifier)
    artifact = Path('scratch') / ('session8-cli-' + SCENARIO + '-measure-' + str(identifier) + '.json')
    receipt = directory / 'receipt.json'
    result = {'version': 1, 'scenario': SCENARIO, 'command': list(COMMAND), 'driverArtifact': str(artifact),
        'state': 'PREPARED', 'scenarioPassed': False, 'productionReady': False, 'actualModelCalls': 0,
        'aggregateResourceReadbackValidated': False, 'candidateExhaustionValidated': False,
        'newCgroupEscapeSweepPerformed': False}
    receipt.write_text(json.dumps(result, indent=2), encoding='utf-8')
    with (directory / 'candidate-frames.jsonl').open('xb') as wire:
        observed = resource.ObservedWire(wire)
        driver.json = observed
        original_start = driver.environment_start
        def start(ready, before, requested=SCENARIO):
            if requested != SCENARIO:
                raise ValueError('TRUSTED_SYSTEMD_PROFILE_CONFUSION')
            return observed.admit_start(ready, before, lambda ready, before: original_start(ready, before, SCENARIO))
        driver.environment_start = start
        driver.evaluate = lambda scenario, report: scenario == SCENARIO and evaluate(report)
        try:
            passed = driver.measure(SCENARIO)
            result.update(state='FINISHED', scenarioPassed=passed, aggregateResourceReadbackValidated=passed)
        except Exception as failure:
            result.update(state='FAILED', errorType=type(failure).__name__)
        result.update(candidateFrameBytes=observed.bytes, candidateFrameSha256=observed.digest.hexdigest(),
            rawScope='Existing reader candidate lines; unread rejected overlong/overbudget lines are not a complete transcript.')
    if artifact.exists():
        result['driverArtifactSha256'] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    receipt.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({'receipt': str(receipt), 'scenarioPassed': result['scenarioPassed']}))
    return 0 if result['scenarioPassed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
