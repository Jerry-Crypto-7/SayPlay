"""Capture peer tests use authored inputs; they do not run a Codex client."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys

import pytest

PATH = Path(__file__).with_name('subscription-exec-request-capture.py')
spec = importlib.util.spec_from_file_location('capture_test', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def bootstrap():
    return [
        {'id': 1, 'method': 'initialize', 'params': {
            'clientName': 'codex-environment', 'resumeSessionId': None}},
        {'method': 'initialized', 'params': {}},
        {'id': 2, 'method': 'environment/info', 'params': None},
        *[{'id': i, 'method': 'fs/getMetadata', 'params': {'path': p, 'sandbox': None}}
          for i, p in enumerate(m.PATHS, 3)],
    ]


def wire():
    return b''.join(m.encode(f) for f in bootstrap())


START = b' {"trace":{"fixture":true}, "id":17,"method":"process/start", "params":{"processId":"12345-550e8400-e29b-41d4-a716-446655440000","argv":["/bin/sh","-c","arbitrary authored command"],"env":{"FIXTURE":"value"},"sandbox":null}}\n'


def invoke(raw, destination=None):
    output = io.BytesIO() if destination is None else destination
    evidence = io.BytesIO()
    source = io.BytesIO(raw)
    code = m.run(source, output, evidence)
    return code, output, json.loads(evidence.getvalue()), source


def test_capture_preserves_exact_frame_refuses_execution_and_stops_reading():
    code, output, report, source = invoke(wire() + START + b'never consumed\n')
    assert code == 0 and report['captureComplete']
    assert source.read() == b'never consumed\n'
    assert report['requestRawHex'] == START.hex()
    assert report['requestSha256'] == hashlib.sha256(START).hexdigest()
    assert report['executionAttempted'] is False
    assert report['clientProvenance'] == 'not-attested'
    assert report['inferenceAttested'] is False and report['productionReady'] is False
    frames = [json.loads(line) for line in output.getvalue().splitlines()]
    assert len(frames) == 5 and frames[-1]['id'] == 17
    assert frames[-1]['error']['code'] == -32000
    assert b''.join(bytes.fromhex(e['rawHex']) for e in report['events']
                    if e['direction'] == 'client') == wire() + START


@pytest.mark.parametrize('bad', [
    b'{"id":5,"id":6,"method":"process/start","params":{}}\n',
    b'{"id":5,"method":"process/start","params":{"x":NaN}}\n',
    b'{"id":5,"method":"process/start","params":{"x":Infinity}}\n',
    b'{"id":true,"method":"process/start","params":{}}\n',
    b'{"id":4,"method":"process/start","params":{}}\n',
    b'{"id":5,"method":"fs/readFile","params":{}}\n',
    b'[]\n', b'\xff\n', b'{}', b'{}\n{}\n',
    b' ' * m.MAX_LINE + b'\n',
], ids=['duplicate-key', 'nan', 'infinity', 'boolean-id', 'reused-id',
        'filesystem-method', 'array', 'invalid-utf8', 'partial-line',
        'multiple-lines', 'oversized-line'])
def test_invalid_frame_permanently_closes_capture(bad):
    capture = m.Capture()
    for frame in bootstrap():
        capture.receive(m.encode(frame))
    with pytest.raises((ValueError, RecursionError)):
        capture.receive(bad)
    assert capture.failed and capture.captured is None
    with pytest.raises(ValueError, match='CAPTURE_CLOSED'):
        capture.receive(START)


@pytest.mark.parametrize('case', ['start-first', 'missing-initialized', 'repeated-stat', 'other-path', 'eof'])
def test_incomplete_or_invalid_bootstrap_cannot_capture(case):
    frames = bootstrap()
    if case == 'start-first':
        raw = START
    else:
        if case == 'missing-initialized':
            del frames[1]
        elif case == 'repeated-stat':
            frames[-1]['params']['path'] = m.PATHS[0]
        elif case == 'other-path':
            frames[-1]['params']['path'] = 'file:///unavailable'
        raw = b''.join(m.encode(f) for f in frames) + (b'' if case == 'eof' else START)
    code, _, report, _ = invoke(raw)
    assert code == 1 and not report['captureComplete']
    assert report['requestRawHex'] is None and report['error'] == 'CAPTURE_FAILED'


def test_total_input_budget_applies_across_frames():
    capture = m.Capture()
    frames = bootstrap()
    for frame in frames[:2]:
        capture.receive(b' ' * 100000 + m.encode(frame))
    with pytest.raises(ValueError, match='INPUT_BOUND'):
        capture.receive(b' ' * 100000 + m.encode(frames[2]))
    assert capture.failed


def test_partial_response_write_stops_before_next_input():
    class Short(io.BytesIO):
        def write(self, data):
            return super().write(data[:3])
    code, _, report, source = invoke(wire() + START, Short())
    assert code == 1 and not report['captureComplete']
    assert source.read().endswith(START)
    assert len(report['events']) == 1


def test_rejection_flush_failure_is_not_successful_capture():
    class Broken(io.BytesIO):
        def flush(self):
            if b'-32000' in self.getvalue():
                raise OSError('authored failure')
    code, _, report, _ = invoke(wire() + START, Broken())
    assert code == 1 and not report['captureComplete']
    assert report['requestRawHex'] == START.hex()


def test_evidence_write_failure_returns_failure():
    class Broken(io.BytesIO):
        def write(self, data):
            raise OSError('authored failure')
    assert m.run(io.BytesIO(wire() + START), io.BytesIO(), Broken()) == 2


def test_real_stdio_process_with_authored_client_bytes():
    result = subprocess.run([sys.executable, '-I', '-S', str(PATH), '--stdio-fixture'],
        input=wire() + START, capture_output=True, timeout=10, env={})
    assert result.returncode == 0
    report = json.loads(result.stderr)
    assert report['captureComplete'] and report['requestRawHex'] == START.hex()
    assert json.loads(result.stdout.splitlines()[-1])['error']['code'] == -32000


WORKDIR = {'id': 5, 'method': 'fs/getMetadata',
           'params': {'path': 'file:///work/exec-worker', 'sandbox': None}}


def test_observed_stock_workdir_stat_then_start_is_captured():
    start = json.loads(START)
    start['id'] = 6
    code, output, report, _ = invoke(wire() + m.encode(WORKDIR) + m.encode(start))
    assert code == 0 and report['captureComplete']
    response = json.loads(output.getvalue().splitlines()[-2])
    assert response['result'] == {'isDirectory': True, 'isFile': False,
        'isSymlink': False, 'size': 0, 'createdAtMs': 0, 'modifiedAtMs': 0}
    assert report['requestRawHex'] == m.encode(start).hex()


@pytest.mark.parametrize('case', ['repeat', 'other-path', 'reused-id'])
def test_workdir_stat_does_not_open_general_filesystem_access(case):
    stat_request = json.loads(json.dumps(WORKDIR))
    start = json.loads(START)
    start['id'] = 6
    if case == 'other-path': stat_request['params']['path'] = 'file:///work/other'
    if case == 'reused-id': start['id'] = 5
    raw = wire() + m.encode(stat_request)
    if case == 'repeat': raw += m.encode(stat_request)
    code, _, report, _ = invoke(raw + m.encode(start))
    assert code == 1 and not report['captureComplete']


def test_bounded_authored_git_discovery_then_capture():
    requests = [WORKDIR] + [{'id': i, 'method': 'fs/getMetadata',
        'params': {'path': path, 'sandbox': None}} for i, path in enumerate(m.GIT_MARKERS, 6)]
    start = json.loads(START)
    start['id'] = 9
    code, output, report, _ = invoke(wire() + b''.join(m.encode(r) for r in requests) + m.encode(start))
    assert code == 0 and report['captureComplete']
    replies = [json.loads(line) for line in output.getvalue().splitlines()]
    assert all(r['error']['code'] == -32004 for r in replies[-4:-1])
