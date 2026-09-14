"""Fixed HTTP capsule measurement over source-bound existing capture/cleanup code."""
import base64
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import sys

SELF = 'scripts/subscription-trusted-http-ingress-capsule.measure.py'
BASE = 'scripts/subscription-trusted-ingress.measure.py'
LAUNCHER = 'scripts/subscription-trusted-http-ingress-launcher.py'
SCENARIO = 'trusted-http-ingress-boundary'
HTTP_HELPERS = ('subscription-trusted-http-ingress.py', 'subscription-trusted-http-capsule-factory.py',
    'subscription-trusted-http-worker-probe.py', 'subscription-trusted-http-ingress-child.py')
COMMAND = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/python3', '-I', '-S', '/mnt/d/claude/Hackaton/' + LAUNCHER]
LOADED_SELF_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def load_source(path, before=None):
    raw = Path(path).read_bytes()
    if before is not None and hashlib.sha256(raw).hexdigest() != before.get(path):
        raise ValueError('HTTP_MEASURE_SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('private_http_measure_' + Path(path).name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, path, 'exec'), module.__dict__)
    return module


def load_base(before=None):
    base = load_source(BASE, before)
    base.LAUNCHER_SOURCES = (*base.LAUNCHER_SOURCES, *HTTP_HELPERS, Path(LAUNCHER).name)
    if len(set(base.LAUNCHER_SOURCES)) != 19: raise ValueError('HTTP_LAUNCHER_SCOPE')
    return base


def start_request(ready, before, owner):
    base = load_base(before)
    # Validate the actual legacy ten-helper boundary, pins, limits and descriptors.
    # The returned legacy request is never sent or used as a synthetic wire frame.
    base.start_request(ready, before, owner)
    hashes = base.expected_hashes(before, (*base.HELPERS, *HTTP_HELPERS))
    if not base.same(ready.get('trustedHttpIngressBoundary'), {'helperSha256': hashes}):
        raise ValueError('HTTP_READY_HELPER_MISMATCH')
    loopback = ready.get('trustedHttpLoopback')
    if (type(loopback) is not dict or set(loopback) != {'interface', 'namespace', 'ownerUserNamespace', 'beforeFlags', 'afterFlags'}
            or loopback.get('interface') != 'lo'
            or type(loopback.get('namespace')) is not str or re.fullmatch(r'net:\[[1-9][0-9]*\]', loopback['namespace']) is None
            or type(loopback.get('ownerUserNamespace')) is not str or re.fullmatch(r'user:\[[1-9][0-9]*\]', loopback['ownerUserNamespace']) is None
            or any(type(loopback.get(key)) is not int or not 0 <= loopback[key] <= 65535 for key in ('beforeFlags', 'afterFlags'))
            or loopback['beforeFlags'] & 8 != 8 or loopback['afterFlags'] & 9 != 9):
        raise ValueError('HTTP_LOOPBACK_ADMISSION_FAILED')
    return {'type': 'start', 'mode': SCENARIO, 'helperSha256': hashes, 'nonce': owner['nonce']}


def child_evaluation(report):
    try:
        before = report['sourceSha256Before']; base = load_base(before)
        owners = [f for f in report['frames'] if f.get('type') == 'ingress_ownership']
        ready = [f for f in report['frames'] if f.get('type') == 'ready']
        if len(owners) != 1 or len(ready) != 1: return False
        expected = start_request(ready[0], before, owners[0])['helperSha256']
        raw = bytearray()
        for frame in report['frames']:
            if frame.get('type') != 'child_output': continue
            if frame.get('stream') != 'stdout' or frame.get('encoding') != 'base64': return False
            block = base64.b64decode(frame['data'], validate=True)
            if len(raw) + len(block) > 2 * 1024 * 1024: return False
            raw.extend(block)
        modules = {name: load_source('scripts/' + name, before)
            for name in (*base.HELPERS, *HTTP_HELPERS) if name.endswith('.py')}
        policy = modules['subscription-appserver-noenv.py']; body = policy.strict_json(bytes(raw))
        if (not base.same(body.get('helperSha256Before'), expected)
                or not base.same(body.get('helperSha256After'), expected)): return False
        if body['parentReport']['marker']['value']['trustedHttpIngress']['networkNamespace'] != ready[0]['trustedHttpLoopback']['namespace']:
            return False
        deps = (modules['subscription-trusted-control-boundary-parent.py'], modules['subscription-exec-server-worker-gate.py'],
            policy, modules['subscription-trusted-http-worker-probe.py'],
            lambda: load_source('scripts/subscription-trusted-control-boundary-probe.py', before))
        ingress = {key: owners[0][key] for key in ('fd', 'nonce', 'socket')}
        return modules['subscription-trusted-http-ingress-child.py'].validate_report(body, deps, ready[0]['workerBoundary'], ingress) is True
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError): return False


def load_driver(before=None):
    base = load_base(before); driver = base.load_driver(before)
    driver.SOURCES = tuple(dict.fromkeys((*driver.SOURCES, *('scripts/' + n for n in HTTP_HELPERS), LAUNCHER, SELF)))
    if len(driver.SOURCES) != 30: raise ValueError('HTTP_MEASURE_SOURCE_SCOPE')
    driver.SCENARIOS = (*driver.SCENARIOS, SCENARIO)
    driver.ENVIRONMENT_MODES = (*driver.ENVIRONMENT_MODES, SCENARIO)
    driver.COMMAND = list(COMMAND); driver.environment_evaluation = child_evaluation
    return driver


def evaluate(report):
    try:
        before = report['sourceSha256Before']; base = load_base(before); driver = load_driver(before)
        if (set(before) != set(driver.SOURCES) or not base.same(before, report['sourceSha256After'])
                or before.get(SELF) != LOADED_SELF_SHA256 or report.get('scenario') != SCENARIO
                or not base.same(report.get('command'), COMMAND)
                or any(hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest for path, digest in before.items())): return False
        frames = report['frames']
        if type(frames) is not list or any(type(f) is not dict for f in frames): return False
        ordered = []
        for kind in ('ingress_ownership', 'ready', 'started', 'terminal', 'ingress_terminal'):
            found = [(i, f) for i, f in enumerate(frames) if f.get('type') == kind]
            if len(found) != 1: return False
            ordered.append(found[0])
        if ([i for i, _ in ordered] != sorted(i for i, _ in ordered)
                or ordered[0][0] != 0 or ordered[-1][0] != len(frames) - 1): return False
        allowed = {'ingress_ownership', 'ready', 'started', 'child_output', 'terminal', 'ingress_terminal'}
        if any(f.get('type') not in allowed for f in frames): return False
        if any(f.get('type') == 'child_output' and not ordered[2][0] < i < ordered[3][0] for i, f in enumerate(frames)): return False
        owner, ready, _, terminal, outer = [f for _, f in ordered]
        if not base.same(terminal, report['terminal']): return False
        start_request(ready, before, owner)
        if not base.validate_terminal(outer, owner, before): return False
        return driver.evaluate(SCENARIO, report) is True
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError): return False


def main():
    if sys.argv[1:]: raise ValueError('FIXED_HTTP_MEASURE_NO_ARGUMENTS')
    # Reuse original raw capture/archive and fixed local process handling without
    # converting any owner, ready, child or terminal frame into a legacy fixture.
    base = load_base(); loaded_base = hashlib.sha256(Path(BASE).read_bytes()).hexdigest()
    original_driver = load_driver
    def bound_driver():
        driver = original_driver(); original_hashes = driver.source_hashes
        def hashes():
            result = original_hashes()
            if result.get(BASE) != loaded_base or result.get(SELF) != LOADED_SELF_SHA256: raise ValueError('HTTP_CAPTURE_SOURCE_DRIFT')
            return result
        driver.source_hashes = hashes
        return driver
    class Wire(base.ObservedWire):
        def start(self, ready, before, scenario=SCENARIO):
            if scenario != SCENARIO: raise ValueError('HTTP_SCENARIO_REQUIRED')
            owners = [f for f in self.frames if f.get('type') == 'ingress_ownership']
            if len(owners) != 1 or self.frames.index(owners[0]) >= self.frames.index(ready): raise ValueError('HTTP_OWNER_ORDER')
            return start_request(ready, before, owners[0])
    base.SCENARIO = SCENARIO; base.COMMAND = list(COMMAND); base.SELF = SELF
    base.LOADED_SELF_SHA256 = LOADED_SELF_SHA256
    base.load_driver = bound_driver; base.ObservedWire = Wire; base.evaluate = evaluate
    return base.main()


if __name__ == '__main__': raise SystemExit(main())
