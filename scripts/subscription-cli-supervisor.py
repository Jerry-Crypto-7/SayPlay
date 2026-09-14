"""PID1 fixed CLI synthetic supervisor; deliberately not a production launcher."""
import base64
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

JOB_SECONDS = 180
COMMAND_SECONDS = 200  # Required outer command budget, enforced by measurement driver.
TERM_GRACE_SECONDS = 5
CLEANUP_SECONDS = 3
LEASE_SECONDS = 3
START_SECONDS = 5
MAX_OUTPUT = 8 * 1024 * 1024
MAX_FRAME = 4096
MAX_QUEUE = 65536
WORKER_FILES = {'subscription-worker-lockdown.py': '/usr/bin/worker-lockdown.py',
                'subscription-worker-boundary-child.py': '/usr/bin/worker-boundary-child.py'}
APPSERVER_FILES = {'subscription-appserver-noenv.py': '/usr/bin/appserver-noenv.py',
                   'subscription-text-model-catalog.json': '/usr/bin/text-model-catalog.json'}
FIXTURE_FILES = {'subscription-appserver-fixture-child.py': '/usr/bin/appserver-fixture-child.py',
                 'subscription-worker-lockdown.py': '/usr/bin/worker-lockdown.py'}
METADATA_PIPE_FILES = {'subscription-appserver-metadata-pipe-child.py': '/usr/bin/appserver-metadata-pipe-child.py',
                       'subscription-appserver-noenv.py': '/usr/bin/appserver-noenv.py',
                       'subscription-worker-lockdown.py': '/usr/bin/worker-lockdown.py',
                       'subscription-text-model-catalog.json': '/usr/bin/text-model-catalog.json'}
EXEC_WORKER_FILES = {'subscription-exec-server-worker-gate.py': '/usr/bin/exec-server-worker-gate.py',
                     'subscription-exec-server-worker-trampoline.py': '/usr/bin/exec-server-worker-trampoline.py',
                     'subscription-exec-worker-probe.py': '/usr/bin/exec-worker-probe.py',
                     'subscription-worker-lockdown.py': '/usr/bin/worker-lockdown.py',
                     **APPSERVER_FILES}
INTERACTIVE_MODES = ('appserver-fixture', 'appserver-metadata-pipe', 'exec-server-worker')
ENVIRONMENT_FILES = {**EXEC_WORKER_FILES,
                     'subscription-exec-environment-metadata-parent.py': '/usr/bin/exec-environment-metadata-parent.py'}
TRUSTED_CONTROL_FILES = {**EXEC_WORKER_FILES,
    'subscription-trusted-control-boundary-probe.py': '/usr/bin/trusted-control-boundary-probe.py',
    'subscription-trusted-control-boundary-parent.py': '/usr/bin/trusted-control-boundary-parent.py'}
TRUSTED_CONTROL_MODE = 'trusted-control-boundary'
CGROUP_MODE = 'trusted-cgroup-worker-boundary'
CGROUP_FILES = {**TRUSTED_CONTROL_FILES,
    'subscription-trusted-cgroup-worker-probe.py': '/usr/bin/trusted-cgroup-worker-probe.py',
    'subscription-trusted-cgroup-worker-child.py': '/usr/bin/trusted-cgroup-worker-child.py'}
STRESS_MODES = ('candidate-resource-stress-tasks', 'candidate-resource-stress-memory')
STRESS_FILES = {**TRUSTED_CONTROL_FILES,
    'subscription-candidate-resource-stress-worker.py': '/usr/bin/candidate-resource-stress-worker.py',
    'subscription-candidate-resource-stress-protocol.py': '/usr/bin/candidate-resource-stress-protocol.py',
    'subscription-candidate-resource-stress-child.py': '/usr/bin/candidate-resource-stress-child.py'}
INGRESS_FD = 198
INGRESS_MODE = 'trusted-ingress-boundary'
INGRESS_FILES = {**TRUSTED_CONTROL_FILES,
    'subscription-trusted-ingress-child.py': '/usr/bin/trusted-ingress-child.py',
    'subscription-trusted-ingress-worker-probe.py': '/usr/bin/trusted-ingress-worker-probe.py'}
HTTP_INGRESS_MODE = 'trusted-http-ingress-boundary'
HTTP_INGRESS_FILES = {**INGRESS_FILES,
    'subscription-trusted-http-ingress.py': '/usr/bin/trusted-http-ingress.py',
    'subscription-trusted-http-capsule-factory.py': '/usr/bin/trusted-http-capsule-factory.py',
    'subscription-trusted-http-worker-probe.py': '/usr/bin/trusted-http-worker-probe.py',
    'subscription-trusted-http-ingress-child.py': '/usr/bin/trusted-http-ingress-child.py'}
ENVIRONMENT_MODES = ('exec-environment-metadata', 'exec-environment-bootstrap-metadata', 'exec-environment-bootstrap-controlled')
CLI_PROXY_MODE = 'cli-proxy-refusal'
CLI_PROXY_FILES = {**ENVIRONMENT_FILES,
    'subscription-cli-proxy-refusal.py': '/usr/bin/cli-proxy-refusal.py',
    'subscription-cli-proxy-provenance.py': '/usr/bin/cli-proxy-provenance.py',
    'subscription-cli-proxy-refusal-child.py': '/usr/bin/cli-proxy-refusal-child.py'}
TRUSTED_CLI_MODE = 'trusted-cli-worker-boundary'
TRUSTED_CLI_FILES = {**TRUSTED_CONTROL_FILES,
    'subscription-cli-proxy-refusal.py': '/usr/bin/cli-proxy-refusal.py',
    'subscription-cli-proxy-provenance.py': '/usr/bin/cli-proxy-provenance.py',
    'subscription-trusted-cli-worker-probe.py': '/usr/bin/trusted-cli-worker-probe.py',
    'subscription-trusted-cli-worker-child.py': '/usr/bin/trusted-cli-worker-child.py'}
MODES = ('version', 'private-sentinel', 'sleep', 'setsid', 'flood', 'partial-setup', 'stopped-cli', 'paced-output', 'worker-boundary', 'appserver-noenv', TRUSTED_CONTROL_MODE, CGROUP_MODE, INGRESS_MODE, HTTP_INGRESS_MODE, CLI_PROXY_MODE, TRUSTED_CLI_MODE, *STRESS_MODES, *ENVIRONMENT_MODES, *INTERACTIVE_MODES)


def valid_ingress_identity(value):
    return (type(value) is dict and set(value) == {'dev', 'ino', 'type', 'family', 'socketType'}
            and all(type(v) is int and 0 <= v <= 9007199254740991 for v in value.values())
            and value['ino'] > 0 and value['type'] == stat.S_IFSOCK
            and value['family'] == 1 and value['socketType'] == 1)


def inspect_ingress_fd(expected=None):
    info = os.fstat(INGRESS_FD)
    if not stat.S_ISSOCK(info.st_mode):
        raise ValueError('INGRESS_SOCKET_REQUIRED')
    endpoint = socket.socket(fileno=INGRESS_FD)
    try:
        value = {'dev': info.st_dev, 'ino': info.st_ino, 'type': stat.S_IFMT(info.st_mode),
                 'family': int(endpoint.family), 'socketType': endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE)}
        if not valid_ingress_identity(value) or endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN):
            raise ValueError('CONNECTED_AF_UNIX_STREAM_REQUIRED')
        endpoint.getpeername()  # ENOTCONN rejects bound but unconnected endpoints.
        if expected is not None and (not valid_ingress_identity(expected) or expected != value):
            raise ValueError('INGRESS_SOCKET_IDENTITY_DRIFT')
        return value
    finally:
        endpoint.detach()  # Inspect the owned slot without closing it.


def close_ingress_fd(expected):
    info = os.fstat(INGRESS_FD)
    if not valid_ingress_identity(expected) or (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)) != (expected['dev'], expected['ino'], expected['type']):
        raise ValueError('INGRESS_CLOSE_IDENTITY_DRIFT')
    os.close(INGRESS_FD)


def ingress_startup_packet(boundary, identity, nonce):
    if not valid_ingress_identity(identity) or type(nonce) is not str or re.fullmatch('[a-f0-9]{32}', nonce) is None:
        raise ValueError('INGRESS_STARTUP_IDENTITY_REQUIRED')
    packet = json.loads(trusted_control_startup_packet(boundary))
    packet['ingress'] = {'fd': INGRESS_FD, 'socket': dict(identity), 'nonce': nonce}
    raw = (json.dumps(packet, separators=(',', ':')) + '\n').encode()
    if len(raw) > 4096:
        raise ValueError('INGRESS_STARTUP_LIMIT')
    return raw


def require_cli_worker_profile(cli_worker,ingress_identity,http_ingress,cli_proxy_refusal,cgroup_worker,stress_phase):
    if type(cli_worker) is not bool or cli_worker and (ingress_identity is not None or http_ingress is not False
            or cli_proxy_refusal is not False or cgroup_worker is not False or stress_phase is not None):
        raise ValueError('TRUSTED_CLI_LAUNCH_PROFILE_MISMATCH')


def require_launch_profile(mode, ingress_identity, http_ingress=False, cli_proxy_refusal=False, cgroup_worker=False, stress_phase=None, cli_worker=False):
    require_cli_worker_profile(cli_worker,ingress_identity,http_ingress,cli_proxy_refusal,cgroup_worker,stress_phase)
    if (mode==TRUSTED_CLI_MODE)!=cli_worker:raise ValueError('TRUSTED_CLI_LAUNCH_PROFILE_MISMATCH')
    require_stress_profile(stress_phase, ingress_identity, http_ingress, cli_proxy_refusal, cgroup_worker)
    if (mode in STRESS_MODES) != (stress_phase is not None) or stress_phase is not None and mode != 'candidate-resource-stress-' + stress_phase:
        raise ValueError('STRESS_LAUNCH_PROFILE_MISMATCH')
    if (type(cgroup_worker) is not bool or (mode == CGROUP_MODE) != cgroup_worker
            or cgroup_worker and (http_ingress or cli_proxy_refusal or ingress_identity is not None)):
        raise ValueError('INGRESS_LAUNCH_PROFILE_MISMATCH')
    if (type(cli_proxy_refusal) is not bool or (mode == CLI_PROXY_MODE) != cli_proxy_refusal
            or cli_proxy_refusal and (http_ingress or ingress_identity is not None)
            or type(http_ingress) is not bool or http_ingress and ingress_identity is None
            or (mode in (INGRESS_MODE, HTTP_INGRESS_MODE)) != (ingress_identity is not None)
            or mode in (INGRESS_MODE, HTTP_INGRESS_MODE) and mode != (HTTP_INGRESS_MODE if http_ingress else INGRESS_MODE)):
        raise ValueError('INGRESS_LAUNCH_PROFILE_MISMATCH')


def require_stress_profile(phase, ingress_identity, http_ingress, cli_proxy_refusal, cgroup_worker):
    if phase is not None and (type(phase) is not str or phase not in ('tasks', 'memory')
            or ingress_identity is not None or http_ingress is not False or cli_proxy_refusal is not False or cgroup_worker is not False):
        raise ValueError('STRESS_LAUNCH_PROFILE_MISMATCH')


def prepare_reexec(ingress_identity, http_ingress=False, cli_proxy_refusal=False, cgroup_worker=False, stress_phase=None, cli_worker=False):
    require_cli_worker_profile(cli_worker,ingress_identity,http_ingress,cli_proxy_refusal,cgroup_worker,stress_phase)
    require_stress_profile(stress_phase, ingress_identity, http_ingress, cli_proxy_refusal, cgroup_worker)
    if type(cgroup_worker) is not bool or cgroup_worker and (http_ingress or cli_proxy_refusal or ingress_identity is not None):
        raise ValueError('INGRESS_LAUNCH_PROFILE_MISMATCH')
    if (type(http_ingress) is not bool or type(cli_proxy_refusal) is not bool
            or http_ingress and ingress_identity is None or cli_proxy_refusal and (http_ingress or ingress_identity is not None)):
        raise ValueError('INGRESS_LAUNCH_PROFILE_MISMATCH')
    if ingress_identity is None:
        os.closerange(3, 65536)
        if cli_worker:return ['--inside-trusted-cli-worker-boundary']
        if stress_phase is not None: return ['--inside-candidate-resource-stress-' + stress_phase]
        return ['--inside-trusted-cgroup-worker-boundary'] if cgroup_worker else ['--inside-cli-proxy-refusal'] if cli_proxy_refusal else ['--inside']
    inspect_ingress_fd(ingress_identity)
    os.closerange(3, INGRESS_FD)
    os.closerange(INGRESS_FD + 1, 65536)
    os.set_inheritable(INGRESS_FD, True)
    flag = '--inside-trusted-http-ingress-fd' if http_ingress else '--inside-trusted-ingress-fd'
    return [flag, json.dumps(ingress_identity, separators=(',', ':'))]


def trusted_control_startup_packet(boundary):
    """Serialize PID1's own ready facts, never caller-supplied start data."""
    for key, prefix in (('namespace', 'pid'), ('mountNamespace', 'mnt')):
        if not isinstance(boundary.get(key), str) or not re.fullmatch(prefix + r':\[[1-9][0-9]*\]', boundary[key]):
            raise ValueError('TRUSTED_CONTROL_NAMESPACE_INVALID')
    descriptors = {}
    for key, role in (('control', 'outerSupervisorControl'), ('output', 'outerSupervisorOutput')):
        value = boundary.get(key)
        if (not isinstance(value, dict) or set(value) != {'dev', 'ino', 'type'}
                or any(type(value[k]) is not int for k in value)
                or value['dev'] < 0 or value['ino'] <= 0 or value['type'] != stat.S_IFIFO):
            raise ValueError('TRUSTED_CONTROL_DESCRIPTOR_INVALID')
        descriptors[role] = dict(value)
    if descriptors['outerSupervisorControl'] == descriptors['outerSupervisorOutput']:
        raise ValueError('TRUSTED_CONTROL_DESCRIPTOR_ALIAS')
    packet = {'version': 1, 'sourceOfOuter': 'supervisor-fixed-startup-pipe',
              'namespaces': {'trustedPid': boundary['namespace'], 'trustedMount': boundary['mountNamespace']},
              'protectedDescriptors': descriptors}
    raw = (json.dumps(packet, separators=(',', ':')) + '\n').encode('utf-8')
    if len(raw) > 4096:
        raise ValueError('TRUSTED_CONTROL_STARTUP_LIMIT')
    return raw


def write_trusted_control_startup(process, owned, boundary):
    write_startup_packet(process, owned, trusted_control_startup_packet(boundary))


def write_stress_startup(process, owned, boundary):
    """New profile keeps its own pipe open for finite observer-controlled actions."""
    if process.pid not in owned or process.stdin is None:
        raise ValueError('TRUSTED_CONTROL_PARENT_NOT_PINNED')
    raw = trusted_control_startup_packet(boundary)
    if os.write(process.stdin.fileno(), raw) != len(raw):
        raise RuntimeError('TRUSTED_CONTROL_STARTUP_PARTIAL_WRITE')


def write_startup_packet(process, owned, raw):
    if process.pid not in owned or process.stdin is None:
        raise ValueError('TRUSTED_CONTROL_PARENT_NOT_PINNED')
    if type(raw) is not bytes or not 0 < len(raw) <= 4096:
        raise ValueError('TRUSTED_CONTROL_STARTUP_LIMIT')
    # A fresh nonblocking pipe, one <= PIPE_BUF write; failures enter outer cleanup.
    try:
        if os.write(process.stdin.fileno(), raw) != len(raw):
            raise RuntimeError('TRUSTED_CONTROL_STARTUP_PARTIAL_WRITE')
    finally:
        process.stdin.close()


def parse_frame(raw):
    if len(raw) > MAX_FRAME:
        raise ValueError('CONTROL_FRAME_LIMIT')
    frame = json.loads(raw)
    if not isinstance(frame, dict):
        raise ValueError('INVALID_CONTROL')
    if frame.get('type') == 'stress_action':
        if set(frame) != {'type', 'action'} or type(frame['action']) is not str or frame['action'] not in ('start', 'ramp', 'release', 'cancel'):
            raise ValueError('FIXED_STRESS_ACTION_REQUIRED')
        return frame
    if frame.get('type') == 'start' and frame.get('mode') in STRESS_MODES:
        if (set(frame) != {'type', 'mode', 'helperSha256'} or type(frame['helperSha256']) is not dict
                or set(frame['helperSha256']) != set(STRESS_FILES)
                or any(type(v) is not str or re.fullmatch('[a-f0-9]{64}', v) is None for v in frame['helperSha256'].values())):
            raise ValueError('STRESS_IMAGE_IDENTITY_REQUIRED')
        return frame
    if frame.get('type') == 'start' and frame.get('mode') in (INGRESS_MODE, HTTP_INGRESS_MODE):
        helpers = HTTP_INGRESS_FILES if frame['mode'] == HTTP_INGRESS_MODE else INGRESS_FILES
        if (set(frame) != {'type', 'mode', 'helperSha256', 'nonce'} or type(frame['nonce']) is not str
                or re.fullmatch('[a-f0-9]{32}', frame['nonce']) is None
                or type(frame['helperSha256']) is not dict or set(frame['helperSha256']) != set(helpers)
                or any(type(value) is not str or re.fullmatch('[a-f0-9]{64}', value) is None for value in frame['helperSha256'].values())):
            raise ValueError('INGRESS_FIXED_START_REQUIRED')
        return frame
    if frame.get('type') == 'fixture_input':
        if set(frame) != {'type', 'seq', 'data'} or type(frame['seq']) is not int or not 1 <= frame['seq'] <= 2048 or not isinstance(frame['data'], str):
            raise ValueError('INVALID_FIXTURE_INPUT')
        data = base64.b64decode(frame['data'], validate=True)
        if not 1 <= len(data) <= 2048 or base64.b64encode(data).decode() != frame['data']:
            raise ValueError('INVALID_FIXTURE_INPUT')
        return frame
    if frame.get('type') == 'start' and frame.get('mode') == 'appserver-fixture':
        if set(frame) != {'type', 'mode', 'scenario', 'helperSha256'} or frame['scenario'] not in ('normal', 'cancel', 'output-limit') or not isinstance(frame['helperSha256'], dict) or set(frame['helperSha256']) != set(FIXTURE_FILES):
            raise ValueError('INVALID_FIXTURE_START')
        if not all(isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value) for value in frame['helperSha256'].values()):
            raise ValueError('INVALID_FIXTURE_IDENTITY')
        return frame
    if frame.get('type') == 'start' and frame.get('mode') in ('worker-boundary', 'appserver-noenv', 'appserver-metadata-pipe', 'exec-server-worker', TRUSTED_CONTROL_MODE, CGROUP_MODE, CLI_PROXY_MODE, TRUSTED_CLI_MODE, *ENVIRONMENT_MODES):
        helpers = {'worker-boundary': WORKER_FILES, 'appserver-noenv': APPSERVER_FILES,
                   'appserver-metadata-pipe': METADATA_PIPE_FILES, 'exec-server-worker': EXEC_WORKER_FILES,
                   TRUSTED_CONTROL_MODE: TRUSTED_CONTROL_FILES,
                   CGROUP_MODE: CGROUP_FILES,
                   CLI_PROXY_MODE: CLI_PROXY_FILES, TRUSTED_CLI_MODE: TRUSTED_CLI_FILES, **{mode: ENVIRONMENT_FILES for mode in ENVIRONMENT_MODES}}[frame['mode']]
        if set(frame) != {'type', 'mode', 'helperSha256'} or not isinstance(frame['helperSha256'], dict) or set(frame['helperSha256']) != set(helpers):
            raise ValueError('WORKER_IMAGE_IDENTITY_REQUIRED')
        if not all(isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value) for value in frame['helperSha256'].values()):
            raise ValueError('WORKER_IMAGE_IDENTITY_REQUIRED')
        return frame
    if frame.get('type') == 'start' and set(frame) == {'type', 'mode'} and frame['mode'] in MODES:
        return frame
    if frame in ({'type': 'heartbeat'}, {'type': 'cancel'}):
        return frame
    raise ValueError('INVALID_CONTROL')


def deliver_crossing_chunk(mode, total, already_exceeded):
    return mode in INTERACTIVE_MODES and total > MAX_OUTPUT and not already_exceeded


class FixtureInput:
    """One bounded chunk awaiting actual kernel pipe write, never buffered frames."""
    def __init__(self):
        self.pending = bytearray()
        self.total = 0
        self.seq = 0

    def accept(self, frame):
        if self.pending or frame['seq'] != self.seq + 1:
            raise ValueError('FIXTURE_INPUT_ORDER')
        data = base64.b64decode(frame['data'], validate=True)
        if self.total + len(data) > 2 * 1024 * 1024:
            raise ValueError('FIXTURE_INPUT_LIMIT')
        self.total += len(data)
        self.seq = frame['seq']
        self.pending.extend(data)

    def drain(self, fd):
        if not self.pending:
            return None
        try:
            count = os.write(fd, self.pending)
        except BlockingIOError:
            return None
        del self.pending[:count]
        return self.seq if not self.pending else None


class StressInput:
    """Finite trusted control writes; delivery is not worker or observer admission."""
    def __init__(self, phase):
        if phase not in ('tasks', 'memory'): raise ValueError('FIXED_STRESS_PHASE_REQUIRED')
        self.actions = ['start', 'release'] if phase == 'tasks' else ['start', 'ramp', 'release']
        self.pending = bytearray()
        self.position = 0
        self.terminal = False
        self.current = None

    def accept(self, action):
        if self.pending or self.terminal or type(action) is not str:
            raise ValueError('STRESS_ACTION_ORDER')
        if action == 'cancel':
            self.terminal = True
        elif self.position >= len(self.actions) or action != self.actions[self.position]:
            raise ValueError('STRESS_ACTION_ORDER')
        else:
            self.position += 1
            self.terminal = action == 'release'
        self.current = action
        self.pending.extend(('{"version":1,"action":"' + action + '"}\n').encode())

    def drain(self, fd):
        if not self.pending: return None
        try: count = os.write(fd, self.pending)
        except BlockingIOError: return None
        if type(count) is not int or not 0 < count <= len(self.pending): raise ValueError('STRESS_CONTROL_WRITE_UNKNOWN')
        del self.pending[:count]
        return self.current if not self.pending else None


class OwnedInputClose:
    """Close an owned input at most once; uncertainty survives final cleanup."""
    def __init__(self):
        self.attempted = False
        self.known = True

    def close(self, process):
        if self.attempted or process is None or process.stdin is None: return
        self.attempted = True
        try: process.stdin.close()
        except Exception: self.known = False


def fixed_arguments(mode, scenario=None):
    if mode not in MODES:
        raise ValueError('INVALID_MODE')
    if mode == 'version':
        return ['--version']
    if mode in ('exec-server-worker', TRUSTED_CONTROL_MODE, CGROUP_MODE, INGRESS_MODE, HTTP_INGRESS_MODE, CLI_PROXY_MODE, TRUSTED_CLI_MODE, *STRESS_MODES, *ENVIRONMENT_MODES):
        raise ValueError('EXEC_WORKER_REQUIRES_DIRECT_TRUSTED_ENTRY')
    if mode == 'appserver-fixture':
        if scenario not in ('normal', 'cancel', 'output-limit'):
            raise ValueError('FIXED_SCENARIO_REQUIRED')
        return ['sandbox', '--permission-profile', 'private-sentinel', '--',
                '/usr/bin/python3', '-I', '-S', '/usr/bin/appserver-fixture-child.py', scenario]
    if mode == 'worker-boundary':
        return ['sandbox', '--permission-profile', 'private-sentinel', '--',
                '/usr/bin/python3', '-I', '-S', '/usr/bin/worker-boundary-child.py']
    if mode == 'appserver-noenv':
        return ['sandbox', '--permission-profile', 'appserver-metadata', '--',
                '/usr/bin/python3', '-I', '-S', '/usr/bin/appserver-noenv.py']
    if mode == 'appserver-metadata-pipe':
        return ['sandbox', '--permission-profile', 'appserver-metadata', '--',
                '/usr/bin/python3', '-I', '-S', '/usr/bin/appserver-metadata-pipe-child.py']
    child = '/usr/bin/child-probe.py' if mode == 'private-sentinel' else '/usr/bin/fixed-child.py'
    return ['sandbox', '--permission-profile', 'private-sentinel', '--',
            '/usr/bin/python3', '-I', '-S', child, *([] if mode == 'private-sentinel' else [{'partial-setup': 'setsid', 'stopped-cli': 'sleep'}.get(mode, mode)])]


def enter_root():
    assert os.uname().machine == 'x86_64' and os.getpid() == 1
    if len(sys.argv) not in (2, 3) or len(sys.argv) == 3 and sys.argv[2] not in ('--trusted-ingress-fd', '--trusted-http-ingress-fd', '--cli-proxy-refusal', '--trusted-cgroup-worker-boundary', '--trusted-cli-worker-boundary', *('--' + mode for mode in STRESS_MODES)):
        raise ValueError('FIXED_CAPSULE_ENTRY_REQUIRED')
    cli_proxy_refusal = len(sys.argv) == 3 and sys.argv[2] == '--cli-proxy-refusal'
    cgroup_worker = len(sys.argv) == 3 and sys.argv[2] == '--trusted-cgroup-worker-boundary'
    cli_worker = len(sys.argv) == 3 and sys.argv[2] == '--trusted-cli-worker-boundary'
    stress_phase = sys.argv[2].removeprefix('--candidate-resource-stress-') if len(sys.argv) == 3 and sys.argv[2] in tuple('--' + mode for mode in STRESS_MODES) else None
    ingress_identity = inspect_ingress_fd() if len(sys.argv) == 3 and not cli_proxy_refusal and not cgroup_worker and not cli_worker and stress_phase is None else None
    root = Path(sys.argv[1])
    assert str(root).startswith('/tmp/rc-runtime.') and root.resolve() == root
    (root / 'oldroot').mkdir()
    libc = ctypes.CDLL(None, use_errno=True)
    os.chdir(root)
    if libc.syscall(155, b'.', b'oldroot'):
        raise OSError(ctypes.get_errno(), 'PIVOT_ROOT_FAILED')
    os.chdir('/')
    if libc.umount2(b'/oldroot', 2):
        raise OSError(ctypes.get_errno(), 'OLD_ROOT_DETACH_FAILED')
    os.rmdir('/oldroot')
    flags = prepare_reexec(ingress_identity, len(sys.argv) == 3 and sys.argv[2] == '--trusted-http-ingress-fd', cli_proxy_refusal, cgroup_worker, stress_phase,cli_worker)
    os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S', '/usr/bin/supervisor.py', *flags], {'PATH': '/usr/bin:/bin'})


def fixed_command(mode, scenario=None):
    if mode==TRUSTED_CLI_MODE:
        if scenario is not None:raise ValueError('TRUSTED_CLI_FORBIDS_SCENARIO')
        return ['/usr/bin/python3','-I','-S','/usr/bin/trusted-cli-worker-child.py']
    if mode in STRESS_MODES:
        if scenario is not None: raise ValueError('STRESS_FORBIDS_SCENARIO')
        return ['/usr/bin/python3', '-I', '-S', '/usr/bin/candidate-resource-stress-child.py', '--inside-' + mode.removeprefix('candidate-resource-stress-')]
    if mode == CGROUP_MODE:
        if scenario is not None: raise ValueError('CGROUP_WORKER_FORBIDS_SCENARIO')
        return ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-cgroup-worker-child.py']
    if mode == CLI_PROXY_MODE:
        if scenario is not None: raise ValueError('CLI_PROXY_FORBIDS_SCENARIO')
        return ['/usr/bin/python3', '-I', '-S', '/usr/bin/cli-proxy-refusal-child.py']
    if mode == HTTP_INGRESS_MODE:
        if scenario is not None: raise ValueError('INGRESS_FORBIDS_SCENARIO')
        return ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-http-ingress-child.py']
    if mode == INGRESS_MODE:
        if scenario is not None: raise ValueError('INGRESS_FORBIDS_SCENARIO')
        return ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-ingress-child.py']
    if mode in ENVIRONMENT_MODES:
        if scenario is not None:
            raise ValueError('ENVIRONMENT_METADATA_FORBIDS_SCENARIO')
        flags = {'exec-environment-metadata': [], 'exec-environment-bootstrap-metadata': ['--bootstrap-metadata'],
                 'exec-environment-bootstrap-controlled': ['--bootstrap-controlled-cleanup']}
        return ['/usr/bin/python3', '-I', '-S', '/usr/bin/exec-environment-metadata-parent.py', *flags[mode]]
    if mode == TRUSTED_CONTROL_MODE:
        if scenario is not None: raise ValueError('TRUSTED_CONTROL_FORBIDS_SCENARIO')
        return ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-control-boundary-parent.py']
    if mode == 'exec-server-worker':
        if scenario is not None:
            raise ValueError('EXEC_WORKER_FORBIDS_SCENARIO')
        return ['/usr/bin/python3', '-I', '-S', '/usr/bin/exec-server-worker-gate.py', '--inside']
    return ['/usr/bin/codex', *fixed_arguments(mode, scenario)]


class Channel:
    def __init__(self):
        self.pending = bytearray()
        self.failed = False
        os.set_blocking(1, False)

    def emit(self, event_type, **data):
        encoded = (json.dumps({'version': 1, 'type': event_type, **data}, separators=(',', ':')) + '\n').encode()
        if len(self.pending) + len(encoded) > MAX_QUEUE:
            self.failed = True
            return False
        self.pending.extend(encoded)
        self.drain()
        return not self.failed

    def drain(self):
        for _ in range(4):
            if not self.pending:
                return
            try:
                count = os.write(1, self.pending[:16384])
                del self.pending[:count]
            except BlockingIOError:
                return
            except BrokenPipeError:
                self.failed = True
                self.pending.clear()
                return


def reap_process(process):
    if process is not None:
        process.poll()
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
            if process is not None and pid == process.pid and process.returncode is None:
                process.returncode = os.waitstatus_to_exitcode(status)
            if pid == 0:
                break
        except ChildProcessError:
            break


def validate_runtime_aliases():
    # Real readonly mount roots survive the pinned sandbox's canonicalization.
    # The same inode/device establishes that they expose only existing /usr data.
    for name in ('bin', 'lib', 'lib64'):
        alias = '/' + name
        info = os.lstat(alias)
        source = os.stat('/usr/' + name)
        if (not stat.S_ISDIR(info.st_mode)
                or (info.st_dev, info.st_ino) != (source.st_dev, source.st_ino)
                or not os.statvfs(alias).f_flag & os.ST_RDONLY):
            raise ValueError('READONLY_RUNTIME_ALIAS_REQUIRED:' + name)

def bootstrap_http_loopback():
    """Activate only lo in this mapped user's own exclusive capsule netns."""
    import fcntl
    if os.getpid() != 1 or os.uname().machine != 'x86_64':
        raise ValueError('HTTP_EXCLUSIVE_PID1_REQUIRED')
    mapping = [line.split() for line in Path('/proc/self/uid_map').read_text().splitlines()]
    if (len(mapping) != 1 or len(mapping[0]) != 3
            or not all(value.isdecimal() for value in mapping[0])):
        raise ValueError('HTTP_MAPPED_USER_REQUIRED')
    inside, outside, count = map(int, mapping[0])
    if count != 1 or inside != outside or inside != os.geteuid():
        raise ValueError('HTTP_MAPPED_USER_REQUIRED')
    namespace = os.readlink('/proc/self/ns/net')
    user_namespace = os.readlink('/proc/self/ns/user')
    if (re.fullmatch(r'net:\[[1-9][0-9]*\]', namespace) is None
            or re.fullmatch(r'user:\[[1-9][0-9]*\]', user_namespace) is None
            or namespace != os.readlink('/proc/1/ns/net')
            or [name for _, name in socket.if_nameindex()] != ['lo']):
        raise ValueError('HTTP_EXCLUSIVE_LOOPBACK_REQUIRED')
    fds = []
    try:
        network = os.open('/proc/self/ns/net', os.O_RDONLY | os.O_CLOEXEC); fds.append(network)
        user = os.open('/proc/self/ns/user', os.O_RDONLY | os.O_CLOEXEC); fds.append(user)
        owner = fcntl.ioctl(network, 0xb701); fds.append(owner)  # NS_GET_USERNS
        current, actual = os.fstat(user), os.fstat(owner)
        if (current.st_dev, current.st_ino) != (actual.st_dev, actual.st_ino):
            raise ValueError('HTTP_NETWORK_OWNER_MISMATCH')
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
            control.set_inheritable(False)
            request = struct.pack('16sH22x', b'lo', 0)
            def flags():
                raw = fcntl.ioctl(control.fileno(), 0x8913, request)  # SIOCGIFFLAGS
                if len(raw) != 40 or raw[:16] != request[:16]:
                    raise ValueError('HTTP_LOOPBACK_FLAGS_INVALID')
                return struct.unpack_from('H', raw, 16)[0]
            before = flags()
            if not before & 8: raise ValueError('HTTP_LOOPBACK_FLAG_REQUIRED')
            if not before & 1:
                fcntl.ioctl(control.fileno(), 0x8914, struct.pack('16sH22x', b'lo', before | 1))
            after = flags()
            if (after & 9 != 9 or [name for _, name in socket.if_nameindex()] != ['lo']
                    or os.readlink('/proc/self/ns/net') != namespace):
                raise ValueError('HTTP_LOOPBACK_READBACK_FAILED')
        return {'interface': 'lo', 'namespace': namespace, 'ownerUserNamespace': user_namespace,
                'beforeFlags': before, 'afterFlags': after}
    finally:
        failure = None
        for fd in reversed(fds):
            try: os.close(fd)
            except OSError as error: failure = failure or error
        if failure is not None: raise failure


def main(ingress_identity=None, http_ingress=False, cli_proxy_refusal=False, cgroup_worker=False, stress_phase=None, cli_worker=False):
    require_cli_worker_profile(cli_worker,ingress_identity,http_ingress,cli_proxy_refusal,cgroup_worker,stress_phase)
    require_stress_profile(stress_phase, ingress_identity, http_ingress, cli_proxy_refusal, cgroup_worker)
    if type(cgroup_worker) is not bool or cgroup_worker and (http_ingress or cli_proxy_refusal or ingress_identity is not None):
        raise ValueError('INGRESS_LAUNCH_PROFILE_MISMATCH')
    if (type(http_ingress) is not bool or type(cli_proxy_refusal) is not bool or http_ingress and ingress_identity is None
            or cli_proxy_refusal and (http_ingress or ingress_identity is not None)):
        raise ValueError('INGRESS_LAUNCH_PROFILE_MISMATCH')
    if ingress_identity is not None:
        inspect_ingress_fd(ingress_identity)
        os.set_inheritable(INGRESS_FD, False)
    ingress_fd_open = ingress_identity is not None
    spec = importlib.util.spec_from_file_location('runtime_probe', '/usr/bin/runtime_probe.py')
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    facts = probe.sandbox(allow_runtime_aliases=True)
    http_loopback = bootstrap_http_loopback() if http_ingress or cli_proxy_refusal or cli_worker else None
    if ingress_identity is not None and probe.children():
        raise RuntimeError('INGRESS_BOOTSTRAP_DESCENDANTS_REMAIN')
    validate_runtime_aliases()
    if os.uname().nodename != 'reality-compiler-probe':
        raise RuntimeError('UTS_HOSTNAME_MISMATCH')
    Path('/work/appserver-home').mkdir()
    with Path('/private/config.toml').open('a', encoding='utf-8') as config:
        config.write('\n[permissions.appserver-metadata.filesystem]\n":root" = "read"\n"/private" = "deny"\n"/work/appserver-home" = "write"\n"/tmp" = "write"\n\n[permissions.appserver-metadata.network]\nenabled = false\n')
    hashes = {}
    for name in ('codex', 'bwrap'):
        with open('/usr/bin/' + name, 'rb') as stream:
            hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    probe.check_runtime_identity(hashes['codex'], hashes['bwrap'])
    channel = Channel()
    selector = selectors.DefaultSelector()
    os.set_blocking(0, False)
    selector.register(0, selectors.EVENT_READ, 'control')
    pending = bytearray()
    fixture_input = FixtureInput()
    stress_input = StressInput(stress_phase) if stress_phase is not None else None
    input_close = OwnedInputClose()
    process = None
    owned = {}
    retired_count = 0
    total = 0
    output_limit_exceeded = False
    registry_overflow = False
    stream_eof = {'stdout': False, 'stderr': False}
    digest = hashlib.sha256()
    captures = {'stdout': bytearray(), 'stderr': bytearray()}
    began = time.monotonic()
    started = None
    lease = began + START_SECONDS
    reason = None
    terminating = None
    mode = None
    kill_sent = False
    signal_failures = []
    fixture = None
    fixture_stop_sent = False
    signal.signal(signal.SIGTERM, lambda *_: None)
    expected = {'namespace': os.readlink('/proc/self/ns/pid'), 'mountNamespace': os.readlink('/proc/self/ns/mnt'),
                'output': {'dev': os.fstat(1).st_dev, 'ino': os.fstat(1).st_ino, 'type': stat.S_IFMT(os.fstat(1).st_mode)}}
    worker_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in WORKER_FILES.items()}
    appserver_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in APPSERVER_FILES.items()}
    fixture_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in FIXTURE_FILES.items()}
    metadata_pipe_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in METADATA_PIPE_FILES.items()}
    exec_worker_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in EXEC_WORKER_FILES.items()}
    environment_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in ENVIRONMENT_FILES.items()}
    trusted_control_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in TRUSTED_CONTROL_FILES.items()}
    ingress_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in INGRESS_FILES.items()}
    http_ingress_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in HTTP_INGRESS_FILES.items()} if http_ingress else None
    cli_proxy_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in CLI_PROXY_FILES.items()} if cli_proxy_refusal else None
    trusted_cli_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in TRUSTED_CLI_FILES.items()} if cli_worker else None
    cgroup_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in CGROUP_FILES.items()} if cgroup_worker else None
    stress_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in STRESS_FILES.items()} if stress_phase is not None else None
    control_info = os.fstat(0)
    worker_boundary = {'helperSha256': worker_hashes, **expected,
                       'control': {'dev': control_info.st_dev, 'ino': control_info.st_ino, 'type': stat.S_IFMT(control_info.st_mode)}}
    channel.emit('ready', sandbox=facts, binarySha256=hashes['codex'], bwrapSha256=hashes['bwrap'],
                 utsBoundary={'hostname': 'reality-compiler-probe', 'namespace': os.readlink('/proc/self/ns/uts')},
                 appServerBoundary={'helperSha256': appserver_hashes},
                 appServerFixtureBoundary={'helperSha256': fixture_hashes},
                 appServerMetadataPipeBoundary={'helperSha256': metadata_pipe_hashes},
                 execServerWorkerBoundary={'helperSha256': exec_worker_hashes},
                 execEnvironmentMetadataBoundary={'helperSha256': environment_hashes},
                 trustedControlBoundary={'helperSha256': trusted_control_hashes},
                 **({'trustedCgroupWorkerBoundary': {'helperSha256': cgroup_hashes}} if cgroup_worker else {}),
                 **({'candidateResourceStressBoundary': {'phase': stress_phase, 'helperSha256': stress_hashes}} if stress_phase is not None else {}),
                 trustedIngressBoundary={'helperSha256': ingress_hashes},
                 **({'trustedHttpIngressBoundary': {'helperSha256': http_ingress_hashes},
                     'trustedHttpLoopback': http_loopback} if http_ingress else {}),
                 **({'cliProxyRefusalBoundary': {'helperSha256': cli_proxy_hashes},
                     'trustedHttpLoopback': http_loopback} if cli_proxy_refusal else {}),
                 **({'trustedCliWorkerBoundary': {'helperSha256': trusted_cli_hashes},
                     'trustedHttpLoopback': http_loopback} if cli_worker else {}),
                 **({'trustedIngressFd': {'fd': INGRESS_FD, 'socket': ingress_identity,
                     'bootstrapInheritance': 'trusted-setup-only', 'preservedAcrossPivot': True}} if ingress_identity is not None else {}),
                 workerBoundary=worker_boundary,
                 limits={'jobMs': 180000, 'commandMs': 200000, 'termGraceMs': 5000, 'maxOutputBytes': MAX_OUTPUT,
                         'commandBudgetEnforcedHere': False, 'aggregateResourcesEnforced': False})

    def discover():
        nonlocal retired_count, registry_overflow, kill_sent
        # Reaped PID numbers may be reused; never treat a stale handle as the new child.
        for pid, fd in list(owned.items()):
            try:
                signal.pidfd_send_signal(fd, 0)
            except ProcessLookupError:
                os.close(fd)
                del owned[pid]
                retired_count += 1
        for pid in probe.children():
            if pid in owned:
                continue
            try:
                fd = os.pidfd_open(pid)
                if len(owned) >= 4096:
                    registry_overflow = True
                    kill_sent = True
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                    finally:
                        os.close(fd)
                    continue
                owned[pid] = fd
            except ProcessLookupError:
                pass

    def send(sig):
        discover()
        for pid, fd in owned.items():
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass
            except OSError as error:
                if len(signal_failures) < 32:
                    signal_failures.append({'pid': pid, 'errno': error.errno})

    def reap():
        reap_process(process)

    try:
        while True:
            now = time.monotonic()
            channel.drain()
            discover()
            reap()
            if reason is None and mode == 'stopped-cli' and process is not None and process.returncode is None and fixture is None:
                # Fixed fault only: wait for actual CLI exec, never stop a caller PID
                # or mistake the pre-exec setpriv process for the installed CLI.
                try:
                    executable = os.readlink(f'/proc/{process.pid}/exe')
                    if executable == '/usr/bin/codex' and process.pid in owned:
                        if not fixture_stop_sent:
                            signal.pidfd_send_signal(owned[process.pid], signal.SIGSTOP)
                            fixture_stop_sent = True
                        status = Path(f'/proc/{process.pid}/stat').read_text().rsplit(') ', 1)[1].split()[0]
                        if status == 'T':
                            fixture = {'kind': 'owned-cli-stopped', 'pid': process.pid, 'executable': executable,
                                       'state': status, 'signal': 'SIGSTOP', 'sinceStartMs': round((now - started) * 1000)}
                            channel.emit('fixture_ready', mode=mode, **fixture)
                except (OSError, IndexError):
                    pass
                if fixture is None and now - started >= 5:
                    reason = 'FIXTURE_SETUP_TIMEOUT'
            if reason is None:
                if registry_overflow:
                    reason = 'PIDFD_REGISTRY_LIMIT'
                elif channel.failed:
                    reason = 'OUTPUT_BACKPRESSURE'
                elif now >= lease:
                    reason = 'LEASE_EXPIRED' if started else 'START_TIMEOUT'
                elif started is not None and now - started >= JOB_SECONDS:
                    reason = 'JOB_DEADLINE'
                elif process is not None and process.returncode is not None:
                    reason = 'EXITED'
            if reason is not None and terminating is None:
                terminating = now
                input_close.close(process)
                fixture_input.pending.clear()
                send(signal.SIGTERM)
            if terminating is not None:
                # Repeat ownership discovery: descendants may fork during TERM grace.
                send(signal.SIGKILL if now - terminating >= TERM_GRACE_SECONDS else signal.SIGTERM)
                kill_sent |= now - terminating >= TERM_GRACE_SECONDS
                reap()
                if not probe.children() and not any(k.data in ('stdout', 'stderr') for k in selector.get_map().values()):
                    break
                if now - terminating >= TERM_GRACE_SECONDS + CLEANUP_SECONDS:
                    break
            if fixture_input.pending and reason is None:
                try:
                    ack_seq = fixture_input.drain(process.stdin.fileno())
                    if ack_seq is not None:
                        channel.emit('fixture_input_ack', seq=ack_seq)
                except OSError:
                    reason = 'FIXTURE_INPUT_PIPE_FAILED'
            if stress_input is not None and stress_input.pending and reason is None:
                try:
                    delivered = stress_input.drain(process.stdin.fileno())
                    if delivered is not None:
                        channel.emit('stress_action_delivered', action=delivered, workerAcknowledged=False, observerAdmissionAttestedHere=False)
                except (OSError, ValueError) as error:
                    reason = reason or 'STRESS_CONTROL_WRITE_ERROR'
                    channel.emit('failure', error=str(error))
            for key, _ in selector.select(0.02):
                try:
                    block = os.read(key.fd, 4096)
                except BlockingIOError:
                    continue
                if not block:
                    selector.unregister(key.fileobj)
                    if key.data in stream_eof:
                        stream_eof[key.data] = True
                    if key.data == 'control' and reason is None:
                        reason = 'CONTROL_EOF'
                    continue
                if key.data != 'control':
                    total += len(block)
                    digest.update(block)
                    if total > MAX_OUTPUT:
                        if deliver_crossing_chunk(mode, total, output_limit_exceeded):
                            # Deliver the actual crossing chunk to the generation
                            # parser so it can reject without a synthetic body.
                            channel.emit('child_output', stream=key.data, encoding='base64', data=base64.b64encode(block).decode())
                        output_limit_exceeded = True
                        reason = reason or 'OUTPUT_LIMIT'
                        continue
                    if len(captures[key.data]) < 131072:
                        captures[key.data].extend(block[:131072 - len(captures[key.data])])
                    channel.emit('child_output', stream=key.data, encoding='base64', data=base64.b64encode(block).decode())
                    continue
                pending.extend(block)
                while b'\n' in pending:
                    raw, _, rest = pending.partition(b'\n')
                    pending = bytearray(rest)
                    try:
                        frame = parse_frame(raw)
                        if frame['type'] == 'cancel':
                            reason = reason or 'CANCELLED'
                        elif frame['type'] == 'heartbeat':
                            if started is not None:
                                lease = time.monotonic() + LEASE_SECONDS
                        elif frame['type'] == 'fixture_input':
                            if mode not in INTERACTIVE_MODES or process is None or reason is not None:
                                raise ValueError('FIXTURE_INPUT_ORDER')
                            fixture_input.accept(frame)
                        elif frame['type'] == 'stress_action':
                            if stress_input is None or mode not in STRESS_MODES or process is None or reason is not None:
                                raise ValueError('STRESS_ACTION_ORDER')
                            stress_input.accept(frame['action'])
                        elif process is not None or reason is not None:
                            raise ValueError('DUPLICATE_OR_TERMINAL_START')
                        else:
                            mode = frame['mode']
                            require_launch_profile(mode, ingress_identity, http_ingress, cli_proxy_refusal, cgroup_worker, stress_phase,cli_worker)
                            env = {'PATH': '/usr/bin:/bin', 'HOME': '/work/home', 'CODEX_HOME': '/private',
                                   'LANG': 'C.UTF-8', 'TMPDIR': '/tmp',
                                   'RC_PROBE_SUPERVISOR_PID_NS': expected['namespace'], 'RC_PROBE_SUPERVISOR_MOUNT_NS': expected['mountNamespace'],
                                   **{'RC_PROBE_OUTPUT_' + k.upper(): str(v) for k, v in expected['output'].items()}}
                            if mode == 'worker-boundary' and frame['helperSha256'] != worker_hashes:
                                raise ValueError('WORKER_IMAGE_IDENTITY_MISMATCH')
                            if mode == 'appserver-noenv' and frame['helperSha256'] != appserver_hashes:
                                raise ValueError('APPSERVER_IMAGE_IDENTITY_MISMATCH')
                            if mode == 'appserver-fixture' and frame['helperSha256'] != fixture_hashes:
                                raise ValueError('FIXTURE_IMAGE_IDENTITY_MISMATCH')
                            if mode == 'appserver-metadata-pipe' and frame['helperSha256'] != metadata_pipe_hashes:
                                raise ValueError('METADATA_PIPE_IMAGE_IDENTITY_MISMATCH')
                            if mode == 'exec-server-worker' and frame['helperSha256'] != exec_worker_hashes:
                                raise ValueError('EXEC_WORKER_IMAGE_IDENTITY_MISMATCH')
                            if mode in ENVIRONMENT_MODES and frame['helperSha256'] != environment_hashes:
                                raise ValueError('ENVIRONMENT_METADATA_IMAGE_IDENTITY_MISMATCH')
                            if mode == CLI_PROXY_MODE and frame['helperSha256'] != cli_proxy_hashes:
                                raise ValueError('CLI_PROXY_IMAGE_IDENTITY_MISMATCH')
                            if mode == TRUSTED_CLI_MODE and frame['helperSha256'] != trusted_cli_hashes:
                                raise ValueError('TRUSTED_CLI_IMAGE_IDENTITY_MISMATCH')
                            if mode == TRUSTED_CONTROL_MODE and frame['helperSha256'] != trusted_control_hashes:
                                raise ValueError('TRUSTED_CONTROL_IMAGE_IDENTITY_MISMATCH')
                            if mode == CGROUP_MODE and frame['helperSha256'] != cgroup_hashes:
                                raise ValueError('CGROUP_WORKER_IMAGE_IDENTITY_MISMATCH')
                            if mode in STRESS_MODES and frame['helperSha256'] != stress_hashes:
                                raise ValueError('STRESS_IMAGE_IDENTITY_MISMATCH')
                            if mode in (INGRESS_MODE, HTTP_INGRESS_MODE):
                                if frame['helperSha256'] != (http_ingress_hashes if mode == HTTP_INGRESS_MODE else ingress_hashes):
                                    raise ValueError('INGRESS_IMAGE_IDENTITY_MISMATCH')
                                inspect_ingress_fd(ingress_identity)
                            try:
                                process = subprocess.Popen(['/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
                                    '--no-new-privs', *fixed_command(mode, frame.get('scenario'))], stdin=subprocess.PIPE if mode in (*INTERACTIVE_MODES, *STRESS_MODES, TRUSTED_CONTROL_MODE, TRUSTED_CLI_MODE, CGROUP_MODE, INGRESS_MODE, HTTP_INGRESS_MODE) else subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True, start_new_session=True, env=env,
                                    pass_fds=(INGRESS_FD,) if mode in (INGRESS_MODE, HTTP_INGRESS_MODE) else ())
                            finally:
                                if mode in (INGRESS_MODE, HTTP_INGRESS_MODE):
                                    close_ingress_fd(ingress_identity)
                                    ingress_fd_open = False
                            if mode == 'partial-setup':
                                raise RuntimeError('INJECTED_POST_SPAWN_PRE_PIPE_SETUP_FAILURE')
                            started = time.monotonic()
                            if process.stdin is not None:
                                os.set_blocking(process.stdin.fileno(), False)
                            lease = started + LEASE_SECONDS
                            for name, pipe in [('stdout', process.stdout), ('stderr', process.stderr)]:
                                os.set_blocking(pipe.fileno(), False)
                                selector.register(pipe, selectors.EVENT_READ, name)
                            discover()
                            if mode in (TRUSTED_CONTROL_MODE, CGROUP_MODE, TRUSTED_CLI_MODE):
                                write_trusted_control_startup(process, owned, worker_boundary)
                            if mode in STRESS_MODES:
                                write_stress_startup(process, owned, worker_boundary)
                            if mode in (INGRESS_MODE, HTTP_INGRESS_MODE):
                                write_startup_packet(process, owned, ingress_startup_packet(worker_boundary, ingress_identity, frame['nonce']))
                            channel.emit('started', mode=mode, pid=process.pid)
                    except (ValueError, TypeError, RuntimeError, OSError) as error:
                        reason = reason or 'CONTROL_OR_SETUP_ERROR'
                        channel.emit('failure', error=str(error))
                if len(pending) > MAX_FRAME:
                    reason = reason or 'CONTROL_FRAME_LIMIT'
                    pending.clear()
    finally:
        input_close.close(process)
        if ingress_fd_open:
            try:
                close_ingress_fd(ingress_identity)
                ingress_fd_open = False
            except OSError as error:
                if error.errno == errno.EBADF:
                    ingress_fd_open = False
                else:
                    channel.emit('failure', error='INGRESS_CLOSE_FAILED')
            except ValueError:
                channel.emit('failure', error='INGRESS_CLOSE_IDENTITY_DRIFT')
        # Covers unexpected trusted-loop exceptions without blocking on a host writer.
        if probe.children():
            kill_sent = True
            send(signal.SIGKILL)
            until = time.monotonic() + CLEANUP_SECONDS
            while probe.children() and time.monotonic() < until:
                send(signal.SIGKILL)
                reap()
                time.sleep(0.01)
        reap()
        # Process pipes may exist even when setup failed before registration.
        if process is not None:
            for name, pipe in [('stdout', process.stdout), ('stderr', process.stderr)]:
                os.set_blocking(pipe.fileno(), False)
                for _ in range(256):
                    try:
                        block = os.read(pipe.fileno(), 4096)
                    except BlockingIOError:
                        break
                    if not block:
                        stream_eof[name] = True
                        break
                    total += len(block)
                    digest.update(block)
                    if total > MAX_OUTPUT:
                        if deliver_crossing_chunk(mode, total, output_limit_exceeded):
                            channel.emit('child_output', stream=name, encoding='base64', data=base64.b64encode(block).decode())
                        output_limit_exceeded = True
                        continue
                    channel.emit('child_output', stream=name, encoding='base64', data=base64.b64encode(block).decode())
                pipe.close()
        absent = []
        for pid, fd in owned.items():
            try:
                signal.pidfd_send_signal(fd, 0)
                absent.append(False)
            except ProcessLookupError:
                absent.append(True)
            finally:
                os.close(fd)
        # The normal loop drains through EOF. On exceptional cleanup, report any
        # unconsumed pipe honestly instead of assigning a complete-response hash.
        cleanup = not probe.children() and all(absent) and not signal_failures and not registry_overflow and not ingress_fd_open and input_close.known
        private_checks = None
        if mode == 'private-sentinel':
            private_checks = probe.checks({'stdout': captures['stdout'].decode(errors='replace')}, False, expected, False)
        channel.emit('terminal', reason=reason, mode=mode, exitCode=process.returncode if process else None,
                     elapsedMs=round((time.monotonic() - began) * 1000), outputBytes=total, observedOutputSha256=digest.hexdigest(),
                     outputComplete=all(stream_eof.values()) if process else True, streamEOF=stream_eof,
                     outputLimitExceeded=output_limit_exceeded, registryOverflow=registry_overflow,
                     cleanup={'verified': cleanup, 'namespaceEmpty': not probe.children(), 'observedPidfds': len(owned) + retired_count,
                              'allObservedPidfdsESRCH': all(absent), 'killSent': kill_sent, 'signalFailures': signal_failures,
                              **({'ownedControlCloseKnown': input_close.known} if stress_phase is not None else {})},
                     fixture=fixture, terminationElapsedMs=round((time.monotonic() - terminating) * 1000) if terminating is not None else None,
                     privateChecks=private_checks, credentialFilesRead=False, modelCalls=0, productionReady=False,
                     productionAuth='NOT_RUN', productionNetwork='NOT_RUN', productionCleanup='NOT_RUN')
        until = time.monotonic() + 0.5
        while channel.pending and time.monotonic() < until:
            channel.drain()
            time.sleep(0.01)
        selector.close()
    return 0 if cleanup and not channel.failed and not channel.pending and not output_limit_exceeded else 1


if __name__ == '__main__':
    if sys.argv[1:] in (['--inside-candidate-resource-stress-tasks'], ['--inside-candidate-resource-stress-memory']):
        raise SystemExit(main(stress_phase=sys.argv[1].removeprefix('--inside-candidate-resource-stress-')))
    if sys.argv[1:] == ['--inside-trusted-cgroup-worker-boundary']:
        raise SystemExit(main(cgroup_worker=True))
    elif sys.argv[1:] == ['--inside-cli-proxy-refusal']:
        raise SystemExit(main(cli_proxy_refusal=True))
    elif sys.argv[1:] == ['--inside-trusted-cli-worker-boundary']:
        raise SystemExit(main(cli_worker=True))
    elif len(sys.argv) == 3 and sys.argv[1] in ('--inside-trusted-ingress-fd', '--inside-trusted-http-ingress-fd'):
        identity = json.loads(sys.argv[2])
        if not valid_ingress_identity(identity):
            raise SystemExit('INGRESS_REEXEC_IDENTITY_REQUIRED')
        raise SystemExit(main(identity, sys.argv[1] == '--inside-trusted-http-ingress-fd'))
    elif sys.argv[1:] != ['--inside']:
        enter_root()
    raise SystemExit(main())
