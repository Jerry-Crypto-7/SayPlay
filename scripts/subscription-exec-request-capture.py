"""Authored exec-server peer fixture; records requests, never executes them.

Stdio is exclusively protocol. One bounded evidence document goes to stderr.
The caller must supply an isolated client and enforce the process deadline.
"""
import hashlib
import json
import sys

MAX_LINE = 131072
MAX_INPUT = 262144
PATHS = ('file:///work/.agents/skills', 'file:///work/exec-worker/.agents/skills')
DIRECTORIES = ('file:///work/exec-worker', 'file:///work', 'file:///')
GIT_MARKERS = ('file:///work/exec-worker/.git', 'file:///work/.git', 'file:///.git')


def encode(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      separators=(',', ':'), sort_keys=True).encode() + b'\n'


def need(value, reason):
    if not value:
        raise ValueError(reason)


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'DUPLICATE_KEY')
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError('NONFINITE_JSON')


class Capture:
    def __init__(self):
        self.events = []
        self.input_bytes = 0
        self.stage = 0
        self.stats = set()
        self.discovery = set()
        self.captured = None
        self.failed = False

    def receive(self, raw):
        try:
            need(not self.failed and self.captured is None, 'CAPTURE_CLOSED')
            need(type(raw) is bytes and 0 < len(raw) <= MAX_LINE
                 and raw.endswith(b'\n') and b'\n' not in raw[:-1], 'FRAME_BOUND')
            self.input_bytes += len(raw)
            need(self.input_bytes <= MAX_INPUT, 'INPUT_BOUND')
            self.events.append({'direction': 'client', 'rawHex': raw.hex()})
            frame = json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                               parse_constant=invalid_constant)
            need(type(frame) is dict, 'FRAME_OBJECT')
            response = self.dispatch(frame)
            if response is None:
                return b''
            return encode(response)
        except (ValueError, TypeError, KeyError, RecursionError):
            self.failed = True
            raise

    def dispatch(self, frame):
        if self.stage == 0:
            need(frame == {'id': 1, 'method': 'initialize', 'params': {
                'clientName': 'codex-environment', 'resumeSessionId': None}}
                and type(frame.get('id')) is int, 'INITIALIZE_REQUIRED')
            self.stage = 1
            return {'id': 1, 'result': {'sessionId': 'capture-fixture'}}
        if self.stage == 1:
            need(frame == {'method': 'initialized', 'params': {}}, 'INITIALIZED_REQUIRED')
            self.stage = 2
            return None
        if self.stage == 2:
            need(frame == {'id': 2, 'method': 'environment/info', 'params': None}
                 and type(frame.get('id')) is int, 'INFO_REQUIRED')
            self.stage = 3
            return {'id': 2, 'result': {'shell': {'name': 'sh', 'path': '/bin/sh'},
                'cwd': 'file:///work', 'capabilities': {'networkProxyLaunch': True}}}
        if self.stage in (3, 4):
            params = frame.get('params')
            need(type(params) is dict and params.get('path') in PATHS, 'STAT_PATH')
            path = params['path']
            need(path not in self.stats and frame == {'id': self.stage,
                'method': 'fs/getMetadata', 'params': {'path': path, 'sandbox': None}}
                and type(frame.get('id')) is int, 'STAT_REQUIRED')
            self.stats.add(path)
            self.stage += 1
            return {'id': frame['id'], 'error': {'code': -32004,
                'message': 'Authored capture fixture: path absent'}}
        if frame.get('method') == 'fs/getMetadata':
            # Authored fixed workspace tree: directories exist, git markers do
            # not. No host lookup. Each of six paths may be queried once only.
            params = frame.get('params')
            need(type(params) is dict and params.get('path') in DIRECTORIES + GIT_MARKERS,
                 'WORKDIR_STAT_REQUIRED')
            path = params['path']
            need(path not in self.discovery and frame == {'id': self.stage,
                'method': 'fs/getMetadata', 'params': {'path': path, 'sandbox': None}}
                and type(frame.get('id')) is int, 'WORKDIR_STAT_REQUIRED')
            self.discovery.add(path)
            self.stage += 1
            if path in GIT_MARKERS:
                return {'id': frame['id'], 'error': {'code': -32004,
                    'message': 'Authored capture fixture: git marker absent'}}
            return {'id': frame['id'], 'result': {'isDirectory': True, 'isFile': False,
                'isSymlink': False, 'size': 0, 'createdAtMs': 0, 'modifiedAtMs': 0}}
        # Observe the envelope, without admitting argv, env, sandbox or trace.
        # Preserve fields and whitespace in events; do not normalize the request.
        need(frame.get('method') == 'process/start'
             and type(frame.get('id')) is int and frame['id'] >= self.stage
             and type(frame.get('params')) is dict, 'START_REQUIRED')
        self.captured = self.events[-1]['rawHex']
        return {'id': frame['id'], 'error': {'code': -32000,
            'message': 'Capture fixture refuses all process execution'}}

    def report(self, error):
        raw = bytes.fromhex(self.captured) if self.captured is not None else None
        return {'version': 1, 'kind': 'authored-exec-server-peer-capture',
            'events': self.events, 'inputBytes': self.input_bytes,
            'requestRawHex': self.captured,
            'requestSha256': hashlib.sha256(raw).hexdigest() if raw is not None else None,
            'captureComplete': raw is not None and error is None and not self.failed,
            'error': error, 'clientProvenance': 'not-attested',
            'bootstrapResponses': 'authored-fixture', 'executionAttempted': False,
            'inferenceAttested': False, 'productionReady': False}


def run(source, destination, evidence):
    capture = Capture()
    error = None
    try:
        while capture.captured is None:
            raw = source.readline(MAX_LINE + 1)
            need(bool(raw), 'CLIENT_EOF_BEFORE_START')
            response = capture.receive(raw)
            if response:
                count = destination.write(response)
                need(count == len(response), 'RESPONSE_SHORT_WRITE')
                destination.flush()
                capture.events.append({'direction': 'fixture', 'rawHex': response.hex()})
    except (ValueError, TypeError, KeyError, RecursionError, OSError):
        # No exception text: it may contain caller data. Raw input is solely in evidence.
        error = 'CAPTURE_FAILED'
    document = encode(capture.report(error))
    try:
        need(evidence.write(document) == len(document), 'EVIDENCE_SHORT_WRITE')
        evidence.flush()
    except (OSError, ValueError):
        return 2
    return 0 if error is None else 1


if __name__ == '__main__':
    if sys.argv[1:] != ['--stdio-fixture']:
        raise SystemExit('Use --stdio-fixture with an isolated, credential-free client')
    raise SystemExit(run(sys.stdin.buffer, sys.stdout.buffer, sys.stderr.buffer))
