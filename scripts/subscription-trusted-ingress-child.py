"""Fixed inherited UNIX ingress capability held across a separate worker probe."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
import time
import types

FD = 198
BROKER_SECONDS = 5
REQUEST = b'CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\n\r\n'
RESPONSE = b'HTTP/1.1 200 Connection Established\r\n\r\n'
MARKER_PATH = '/work/trusted-ingress-boundary.json'
GATE_ARGV = ('/usr/bin/python3', '-I', '-S', '/usr/bin/exec-server-worker-gate.py', '--trusted-ingress-boundary')
CATALOG_SHA256 = '59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791'
HELPERS = {
    'subscription-exec-server-worker-gate.py': '/usr/bin/exec-server-worker-gate.py',
    'subscription-exec-server-worker-trampoline.py': '/usr/bin/exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py': '/usr/bin/exec-worker-probe.py',
    'subscription-trusted-control-boundary-probe.py': '/usr/bin/trusted-control-boundary-probe.py',
    'subscription-worker-lockdown.py': '/usr/bin/worker-lockdown.py',
    'subscription-appserver-noenv.py': '/usr/bin/appserver-noenv.py',
    'subscription-text-model-catalog.json': '/usr/bin/text-model-catalog.json',
    'subscription-trusted-control-boundary-parent.py': '/usr/bin/trusted-control-boundary-parent.py',
    'subscription-trusted-ingress-child.py': '/usr/bin/trusted-ingress-child.py',
    'subscription-trusted-ingress-worker-probe.py': '/usr/bin/trusted-ingress-worker-probe.py',
}


def load_fixed(name):
    spec = importlib.util.spec_from_file_location('ingress_private_' + name.replace('-', '_'), HELPERS[name])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hashes():
    result = {}
    for name, path in HELPERS.items():
        with open(path, 'rb') as handle: raw = handle.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024: raise ValueError('INGRESS_HELPER_LIMIT')
        result[name] = hashlib.sha256(raw).hexdigest()
    if result['subscription-text-model-catalog.json'] != CATALOG_SHA256:
        raise ValueError('INGRESS_PINNED_CATALOG_REQUIRED')
    return result


def valid_ingress(value):
    if (type(value) is not dict or set(value) != {'fd', 'nonce', 'socket'} or type(value['fd']) is not int or value['fd'] != FD
            or type(value['nonce']) is not str or re.fullmatch('[a-f0-9]{32}', value['nonce']) is None):
        return False
    identity = value['socket']
    return (type(identity) is dict and set(identity) == {'dev', 'ino', 'type', 'family', 'socketType'}
        and all(type(item) is int and 0 <= item <= 9007199254740991 for item in identity.values())
        and identity['ino'] > 0 and identity['type'] == stat.S_IFSOCK
        and identity['family'] == 1 and identity['socketType'] == 1)


def inspect_socket(channel):
    info = os.fstat(FD)
    if (channel.fileno() != FD or not stat.S_ISSOCK(info.st_mode) or channel.family != socket.AF_UNIX
            or channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
            or channel.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 0 or os.get_inheritable(FD)):
        raise ValueError('FIXED_CONNECTED_UNIX_INGRESS_REQUIRED')
    channel.getpeername()  # Connected check only; not creation-time peer auth.
    return {'dev': info.st_dev, 'ino': info.st_ino, 'type': stat.S_IFMT(info.st_mode),
            'family': int(socket.AF_UNIX), 'socketType': int(socket.SOCK_STREAM)}


class Route:
    def __init__(self, channel, expected, budget):
        if not valid_ingress(expected) or inspect_socket(channel) != expected['socket']:
            raise ValueError('INGRESS_PACKET_SOCKET_IDENTITY')
        self.channel, self.expected, self.budget = channel, expected, budget
        self.began = None
        self.ended = None
        self.steps = []
        self.observations = []
        self.closed = False
        self.eof = False
        self.error = None

    def timeout(self):
        total_remaining = self.budget.require_remaining()
        now = time.monotonic()
        work_remaining = 22 - (now - self.budget.began)
        if work_remaining <= 0:
            raise ValueError('INGRESS_ROUTE_WORK_DEADLINE')
        remaining = min(BROKER_SECONDS - (now - self.began), work_remaining, total_remaining)
        if remaining <= 0: raise ValueError('INGRESS_BROKER_DEADLINE')
        self.channel.settimeout(remaining)

    def exchange(self, label, request, response):
        for direction, expected in (('sent', request), ('received', response)):
            actual = bytearray()
            step = {'phase': label, 'direction': direction, 'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest(), 'rawHex': ''}
            self.steps.append(step)
            while len(actual) < len(expected):
                self.timeout()
                if direction == 'sent':
                    size = self.channel.send(expected[len(actual):])
                    if size <= 0: raise ValueError('INGRESS_SEND_UNKNOWN')
                    actual.extend(expected[len(actual):len(actual) + size])
                else:
                    block = self.channel.recv(len(expected) - len(actual))
                    if not block: raise ValueError('INGRESS_EARLY_EOF')
                    actual.extend(block)
                step.update(bytes=len(actual), sha256=hashlib.sha256(actual).hexdigest(), rawHex=actual.hex())
                if direction == 'received' and actual != expected[:len(actual)]:
                    raise ValueError('INGRESS_FIXED_RESPONSE_MISMATCH')

    def observe(self, phase):
        try:
            expected_phase = 'BEFORE' if not self.observations else 'AFTER'
            if phase != expected_phase or self.closed: raise ValueError('INGRESS_PHASE_ORDER')
            identity = inspect_socket(self.channel)
            if identity != self.expected['socket']: raise ValueError('INGRESS_SOCKET_CHANGED')
            if phase == 'BEFORE':
                self.began = time.monotonic()
                self.exchange('CONNECT', REQUEST, RESPONSE)
            challenge = phase.encode() + b' ' + self.expected['nonce'].encode() + b'\n'
            self.exchange(phase, challenge, b'ACK ' + challenge)
            if phase == 'AFTER':
                self.channel.shutdown(socket.SHUT_WR)
                self.timeout()
                tail = self.channel.recv(1)
                self.steps.append({'phase': 'EOF', 'direction': 'received', 'bytes': len(tail),
                    'sha256': hashlib.sha256(tail).hexdigest(), 'rawHex': tail.hex()})
                if tail != b'': raise ValueError('INGRESS_TRAILING_BYTES')
                self.timeout()
                self.eof = True
                self.close()
            self.observations.append({'phase': phase, 'socket': identity, 'cloexec': True,
                'elapsedMs': (time.monotonic() - self.budget.began) * 1000})
        except Exception as failure:
            self.error = self.error or type(failure).__name__ + ':' + str(failure)
            raise

    def close(self):
        if not self.closed:
            self.channel.close()
            self.closed = True
            self.ended = time.monotonic()

    def report(self):
        return {'fd': FD, 'expected': self.expected, 'steps': self.steps, 'observations': self.observations,
            'eofObserved': self.eof, 'closed': self.closed, 'error': self.error,
            'brokerElapsedMs': None if self.began is None else ((self.ended if self.ended is not None else time.monotonic()) - self.began) * 1000}


def adapt(parent, gate, policy, ingress_probe, base_loader, ingress, route=None):
    """Adapt private loaded modules; never mutate historical source files."""
    old_packet = getattr(parent, '_ingress_original_packet', parent.validate_outer_packet)
    parent._ingress_original_packet = old_packet
    def packet(value):
        return (type(value) is dict and set(value) == {'version', 'sourceOfOuter', 'namespaces', 'protectedDescriptors', 'ingress'}
            and old_packet({key: item for key, item in value.items() if key != 'ingress'}) and valid_ingress(value['ingress'])
            and value['ingress'] == ingress)
    parent.validate_outer_packet = packet
    def matches(value, expected):
        if not packet(value): return False
        # Original matcher references the module's validator, so perform exact
        # actual outer fields comparison directly, retaining the original raw5.
        wanted = {'version': 1, 'sourceOfOuter': 'supervisor-fixed-startup-pipe',
            'namespaces': {'trustedPid': expected.get('namespace'), 'trustedMount': expected.get('mountNamespace')},
            'protectedDescriptors': {'outerSupervisorControl': expected.get('control'), 'outerSupervisorOutput': expected.get('output')}}
        return old_packet(wanted) and json.dumps(wanted, sort_keys=True) == json.dumps({key: item for key, item in value.items() if key != 'ingress'}, sort_keys=True)
    parent.packet_matches_ready = matches
    parent.HELPER_FILES = dict(HELPERS)
    parent.MARKER_PATH = MARKER_PATH
    parent.MARKER_PENDING = MARKER_PATH + '.pending'
    parent.GATE_ARGV = GATE_ARGV
    proxy = types.SimpleNamespace(MAX_MARKER_BYTES=4096, strict_json=policy.strict_json,
        validate_marker=lambda value: (ingress_probe.validate_marker_with(base_loader(), value)
            and value['trustedIngressSocket'] == {key: ingress['socket'][key] for key in ('dev', 'ino', 'type')}),
        validate_report=lambda value, marker: ingress_probe.validate_report_with(base_loader(), value, marker))
    def make_marker(outer, pipes, objects, _probe):
        marker = {'version': 1, 'namespaces': outer['namespaces'], 'protectedDescriptors': {**outer['protectedDescriptors'], **pipes},
            'authoredProtectedObjects': objects, 'trustedIngressSocket': {key: ingress['socket'][key] for key in ('dev', 'ino', 'type')}}
        if not proxy.validate_marker(marker): raise ValueError('INGRESS_MARKER_INVALID')
        return marker
    parent.make_marker = make_marker
    gate_view = types.SimpleNamespace(integer=gate.integer, initialize_request=gate.initialize_request,
        read_request=gate.read_request, control_start_request=gate.ingress_start_request)
    def entry(_gate):
        if _gate.control_start_request() != gate.ingress_start_request(): raise ValueError('INGRESS_FIXED_START_REQUIRED')
        return GATE_ARGV
    parent.require_fixed_worker_entry = entry
    if route is not None:
        observe = parent.trusted_observation
        def observed(process, marker, budget):
            result = observe(process, marker, budget)
            route.observe('BEFORE' if not route.observations else 'AFTER')
            if process.poll() is not None: raise ValueError('INGRESS_APPSERVER_NOT_ALIVE')
            if time.monotonic() - budget.began >= parent.WORK_SECONDS:
                raise ValueError('INGRESS_POST_ROUTE_WORK_DEADLINE')
            return result
        parent.trusted_observation = observed
    return gate_view, proxy


def validate_route(value, ingress):
    try:
        if (type(value) is not dict or set(value) != {'fd', 'expected', 'steps', 'observations', 'eofObserved', 'closed', 'error', 'brokerElapsedMs'}
                or type(value['fd']) is not int or value['fd'] != FD or value['expected'] != ingress or not valid_ingress(ingress)
                or not valid_ingress(value['expected'])
                or value['eofObserved'] is not True or value['closed'] is not True or value['error'] is not None
                or type(value['brokerElapsedMs']) not in (int, float) or not 0 <= value['brokerElapsedMs'] < 5000): return False
        expected_steps = []
        for phase, request, response in [('CONNECT', REQUEST, RESPONSE)] + [
            (phase, phase.encode() + b' ' + ingress['nonce'].encode() + b'\n', b'ACK ' + phase.encode() + b' ' + ingress['nonce'].encode() + b'\n')
            for phase in ('BEFORE', 'AFTER')]:
            for direction, raw in (('sent', request), ('received', response)):
                expected_steps.append({'phase': phase, 'direction': direction, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'rawHex': raw.hex()})
        expected_steps.append({'phase': 'EOF', 'direction': 'received', 'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest(), 'rawHex': ''})
        if json.dumps(value['steps'], sort_keys=True) != json.dumps(expected_steps, sort_keys=True): return False
        if type(value['observations']) is not list or len(value['observations']) != 2: return False
        previous = -1
        for phase, observation in zip(('BEFORE', 'AFTER'), value['observations']):
            if (type(observation) is not dict or set(observation) != {'phase', 'socket', 'cloexec', 'elapsedMs'}
                    or observation['phase'] != phase or observation['socket'] != ingress['socket'] or observation['cloexec'] is not True
                    or not valid_ingress({'fd': FD, 'nonce': ingress['nonce'], 'socket': observation['socket']})
                    or type(observation['elapsedMs']) not in (int, float) or not previous <= observation['elapsedMs'] < 22000): return False
            previous = observation['elapsedMs']
        return True
    except (ValueError, TypeError, KeyError): return False


def validate_report(report, dependencies, expected_worker_boundary, expected_ingress):
    try:
        if (type(report) is not dict or set(report) != {'version', 'profile', 'success', 'error', 'parentReport', 'route', 'helperSha256Before', 'helperSha256After'}
                or type(report['version']) is not int or report['version'] != 1 or report['profile'] != 'fixed-trusted-ingress-child'
                or report['success'] is not True or report['error'] is not None or not validate_route(report['route'], expected_ingress)):
            return False
        parent, gate, policy, ingress_probe, base_loader = dependencies
        gate_view, proxy = adapt(parent, gate, policy, ingress_probe, base_loader, expected_ingress)
        body = report['parentReport']
        if (body['helperSha256Before'] != report['helperSha256Before'] or body['helperSha256After'] != report['helperSha256After']
                or not parent.validate_report(body, policy, gate_view, proxy, expected_worker_boundary)):
            return False
        observations = report['route']['observations']
        return (body['beforeWorker']['elapsedMs'] <= observations[0]['elapsedMs'] <= body['afterWorker']['elapsedMs']
            and body['afterWorker']['elapsedMs'] <= observations[1]['elapsedMs'] <= body['sessions']['appserver']['cleanupHistory'][0]['elapsedMs'])
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError): return False


def main():
    if sys.platform != 'linux' or sys.argv[1:]: raise ValueError('FIXED_INGRESS_ENTRY_REQUIRED')
    began = time.monotonic()
    os.set_inheritable(FD, False)  # Before loading helpers or spawning anything.
    channel = socket.socket(fileno=FD)
    route = None
    try:
        identity = inspect_socket(channel)
        if not os.statvfs('/usr/bin').f_flag & os.ST_RDONLY: raise ValueError('INGRESS_READONLY_IMAGE_REQUIRED')
        before = hashes()
        parent = load_fixed('subscription-trusted-control-boundary-parent.py')
        policy = load_fixed('subscription-appserver-noenv.py')
        gate = load_fixed('subscription-exec-server-worker-gate.py')
        ingress_probe = load_fixed('subscription-trusted-ingress-worker-probe.py')
        base_loader = lambda: load_fixed('subscription-trusted-control-boundary-probe.py')
        budget = parent.Budget(); budget.began = began
        old_packet = parent.validate_outer_packet
        parent.validate_outer_packet = lambda value: (type(value) is dict and set(value) == {'version', 'sourceOfOuter', 'namespaces', 'protectedDescriptors', 'ingress'}
            and old_packet({key: item for key, item in value.items() if key != 'ingress'}) and valid_ingress(value['ingress']))
        packet = parent.read_startup_packet(budget, policy)
        parent.validate_outer_packet = old_packet
        ingress = packet['value']['ingress']
        if ingress['socket'] != identity: raise ValueError('INGRESS_STARTUP_IDENTITY_MISMATCH')
        route = Route(channel, ingress, budget)
        gate_view, proxy = adapt(parent, gate, policy, ingress_probe, base_loader, ingress, route)
        body = parent.run_parent(policy, gate_view, proxy, budget, packet)
        route.close()
        after = hashes()
        body.update(helperSha256Before=before, helperSha256After=after, success=body['error'] is None)
        body['elapsedMs'] = (time.monotonic() - began) * 1000
        report = {'version': 1, 'profile': 'fixed-trusted-ingress-child', 'success': body['error'] is None and route.error is None,
            'error': body['error'] or route.error, 'parentReport': body, 'route': route.report(), 'helperSha256Before': before, 'helperSha256After': after}
        # External evaluator must bind actual ownership nonce/socket and ready;
        # internal consistency cannot establish their provenance.
        deps = (load_fixed('subscription-trusted-control-boundary-parent.py'), gate, policy, ingress_probe, base_loader)
        outer = packet['value']
        expected = {'namespace': outer['namespaces']['trustedPid'], 'mountNamespace': outer['namespaces']['trustedMount'],
            'control': outer['protectedDescriptors']['outerSupervisorControl'], 'output': outer['protectedDescriptors']['outerSupervisorOutput']}
        if not validate_report(report, deps, expected, ingress):
            report.update(success=False, error=report['error'] or 'INGRESS_REPORT_INVALID')
        body['elapsedMs'] = (time.monotonic() - began) * 1000
        if body['elapsedMs'] >= parent.TOTAL_SECONDS * 1000:
            report.update(success=False, error=report['error'] or 'INGRESS_FINAL_SHARED_DEADLINE')
        print(json.dumps(report, separators=(',', ':'), allow_nan=False), flush=True)
        return 0 if report['success'] else 1
    finally:
        if route is not None: route.close()
        else: channel.close()


if __name__ == '__main__': raise SystemExit(main())
