"""Fixed HTTP resource wrapper; replay actual SCM and HTTP records separately."""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import importlib.util

SELF = 'scripts/subscription-trusted-http-ingress-systemd.measure.py'
PHYSICAL = 'scripts/subscription-trusted-ingress-systemd.measure.py'
HTTP = 'scripts/subscription-trusted-http-ingress-capsule.measure.py'
SCENARIO = 'trusted-http-ingress-boundary'
COMMAND = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/scripts/subscription-systemd-fixture-transport.py', '--trusted-http-ingress-boundary']
LOADED_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def load(path, before=None):
    raw = Path(path).read_bytes()
    if before is not None and hashlib.sha256(raw).hexdigest() != before.get(path): raise ValueError('HTTP_RESOURCE_SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('private_http_resource_' + Path(path).name, path)
    module = importlib.util.module_from_spec(spec); exec(compile(raw, path, 'exec'), module.__dict__)
    module.loadedSha = hashlib.sha256(raw).hexdigest()
    return module


def stack(before=None):
    physical = load(PHYSICAL, before); http = load(HTTP, before)
    basic, resource, _ = physical.stack(before)
    driver = http.load_driver(before)
    driver.SOURCES = tuple(dict.fromkeys((*driver.SOURCES, SELF, PHYSICAL, physical.RESOURCE, physical.RELAY,
        physical.PROBE, physical.RECEIVER, physical.RENDEZVOUS)))
    if len(driver.SOURCES) != 37: raise ValueError('HTTP_RESOURCE_SOURCE_COUNT')
    driver.COMMAND = list(COMMAND); driver.environment_evaluation = child_evaluation
    driver.composedSources = {SELF: LOADED_SHA, PHYSICAL: physical.loadedSha, HTTP: http.loadedSha,
        physical.BASIC: basic.loadedSha, physical.RESOURCE: resource.loadedSha}
    resource.SELF = SELF; resource.load_driver = lambda before=None: driver
    resource.fixed_command = lambda scenario: list(COMMAND) if scenario == SCENARIO else None
    return basic, resource, driver


def admission(frames, ready, before):
    try:
        physical = load(PHYSICAL, before); http = load(HTTP, before)
        ingress, _ = physical.admission(frames, ready, before)
        basic = http.load_base(before)
        # Physical systemd ownership is never converted to a basic launcher owner.
        if ready.get('binarySha256') != basic.CLI_SHA256 or ready.get('bwrapSha256') != basic.BWRAP_SHA256:
            raise ValueError('HTTP_RESOURCE_BINARY_PIN')
        helpers = basic.expected_hashes(before, (*basic.HELPERS, *http.HTTP_HELPERS))
        if not basic.same(ready.get('trustedHttpIngressBoundary'), {'helperSha256': helpers}): raise ValueError('HTTP_RESOURCE_HELPERS')
        loop = ready.get('trustedHttpLoopback')
        if (type(loop) is not dict or set(loop) != {'interface', 'namespace', 'ownerUserNamespace', 'beforeFlags', 'afterFlags'}
                or loop.get('interface') != 'lo'
                or type(loop.get('namespace')) is not str or re.fullmatch(r'net:\[[1-9][0-9]*\]', loop['namespace']) is None
                or type(loop.get('ownerUserNamespace')) is not str or re.fullmatch(r'user:\[[1-9][0-9]*\]', loop['ownerUserNamespace']) is None
                or any(type(loop.get(key)) is not int or not 0 <= loop[key] <= 65535 for key in ('beforeFlags', 'afterFlags'))
                or loop['beforeFlags'] & 8 != 8 or loop['afterFlags'] & 9 != 9): raise ValueError('HTTP_RESOURCE_LOOPBACK')
        return ingress, helpers
    except (TypeError, KeyError, AttributeError) as error: raise ValueError('HTTP_RESOURCE_MALFORMED_ADMISSION') from error


def start_request(frames, ready, before, requested=SCENARIO):
    if requested != SCENARIO: raise ValueError('FIXED_HTTP_RESOURCE_PROFILE')
    physical = load(PHYSICAL, before)
    # This validates actual prestart ordering only; its old request is not sent.
    physical.start_request(frames, ready, before)
    ingress, helpers = admission(frames, ready, before)
    return {'type': 'start', 'mode': SCENARIO, 'helperSha256': helpers, 'nonce': ingress['nonce']}


def child_evaluation(report):
    try:
        before = report['sourceSha256Before']; http = load(HTTP, before); basic = http.load_base(before)
        readies = [frame for frame in report['frames'] if frame.get('type') == 'ready']
        if len(readies) != 1: return False
        ready = readies[0]; ingress, helpers = admission(report['frames'], ready, before)
        raw = bytearray()
        for frame in report['frames']:
            if frame.get('type') != 'child_output': continue
            if frame.get('stream') != 'stdout' or frame.get('encoding') != 'base64': return False
            block = base64.b64decode(frame['data'], validate=True)
            if len(raw) + len(block) > 2 * 1024 * 1024: return False
            raw.extend(block)
        modules = {name: load('scripts/' + name, before) for name in (*basic.HELPERS, *http.HTTP_HELPERS) if name.endswith('.py')}
        policy = modules['subscription-appserver-noenv.py']; body = policy.strict_json(bytes(raw))
        if (not basic.same(body.get('helperSha256Before'), helpers) or not basic.same(body.get('helperSha256After'), helpers)
                or body['parentReport']['marker']['value']['trustedHttpIngress']['networkNamespace'] != ready['trustedHttpLoopback']['namespace']): return False
        deps = (modules['subscription-trusted-control-boundary-parent.py'], modules['subscription-exec-server-worker-gate.py'], policy,
            modules['subscription-trusted-http-worker-probe.py'], lambda: load('scripts/subscription-trusted-control-boundary-probe.py', before))
        return modules['subscription-trusted-http-ingress-child.py'].validate_report(body, deps, ready['workerBoundary'], ingress) is True
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError): return False


def evaluate(report):
    try:
        before = report['sourceSha256Before']; basic, resource, driver = stack(before); physical = load(PHYSICAL, before)
        if before.get(SELF) != LOADED_SHA: return False
        frames = report['frames']; kinds = ('systemd_ownership', 'systemd_ingress_ownership', 'systemd_ingress_handoff', 'ready', 'started', 'terminal', 'systemd_ingress_terminal')
        if type(frames) is not list or any(type(f) is not dict for f in frames): return False
        indexes = []
        for kind in kinds:
            found = [i for i, f in enumerate(frames) if f.get('type') == kind]
            if len(found) != 1: return False
            indexes.extend(found)
        if indexes != sorted(indexes) or indexes[0] != 0 or indexes[-1] != len(frames)-1: return False
        if any(f.get('type') not in (*kinds, 'child_output') or f.get('type') == 'child_output' and not indexes[4] < i < indexes[5] for i, f in enumerate(frames)): return False
        ready = frames[indexes[3]]; ingress, _ = admission(frames, ready, before)
        value = physical.single(frames, 'systemd_ingress_terminal', 'result')
        if not physical.final_ingress(value, ingress, ready['systemdFixtureBoundary']['unit'], before): return False
        return resource.evaluate(report, SCENARIO) is True
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError): return False


def main():
    if sys.argv[1:]: raise ValueError('FIXED_HTTP_RESOURCE_NO_ARGUMENTS')
    physical = load(PHYSICAL)
    physical.SCENARIO = SCENARIO; physical.COMMAND = list(COMMAND)
    physical.stack = stack; physical.start_request = start_request; physical.evaluate = evaluate
    return physical.main()


if __name__ == '__main__': raise SystemExit(main())
