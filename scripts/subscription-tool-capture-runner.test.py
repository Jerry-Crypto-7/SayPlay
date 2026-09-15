"""Offline runner regression; no host Codex client or Linux workload."""
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


def module(name):
    path = Path(__file__).with_name('subscription-' + name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


m = module('tool-capture-runner')
h = module('tool-capture-harness')
c = module('exec-request-capture')


class Completed:
    def __init__(self): self.completed = False
    def receive(self, raw):
        if self.completed: raise ValueError('CONTROLLER_CLOSED')
        assert raw == b'{"complete":true}\n'
        self.completed = True


@pytest.mark.parametrize('chunks', [
    [b'{"complete":true}\n{'],
    [b'{"complete":true}\n', b'{'],
    [b'{"complete":true}\n', b'{}\n'],
], ids=['same-read-partial', 'drain-partial', 'drain-frame'])
def test_post_completion_output_never_silently_passes(chunks):
    controller = Completed()
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    eof = {'stdout': False, 'stderr': False}
    with pytest.raises(ValueError):
        partial = bytearray()
        for raw in chunks + [b'']:
            m.feed_output(controller, output, partial, eof, 'stdout', raw)


def test_split_completion_and_eof_are_accepted():
    controller = Completed()
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    eof = {'stdout': False, 'stderr': False}
    partial = bytearray()
    for raw in [b'{"complete":', b'true}\n', b'']:
        m.feed_output(controller, output, partial, eof, 'stdout', raw)
    assert controller.completed and eof['stdout'] and not partial


def capture_raw():
    frames = [
        {'id': 1, 'method': 'initialize', 'params': {
            'clientName': 'codex-environment', 'resumeSessionId': None}},
        {'method': 'initialized', 'params': {}},
        {'id': 2, 'method': 'environment/info', 'params': None},
        *[{'id': i, 'method': 'fs/getMetadata', 'params': {'path': path, 'sandbox': None}}
          for i, path in enumerate(c.PATHS, 3)],
        {'id': 5, 'method': 'process/start', 'params': {'processId': '12345', 'argv': ['fixture']}},
    ]
    report = io.BytesIO()
    assert c.run(io.BytesIO(b''.join(c.encode(f) for f in frames)), io.BytesIO(), report) == 0
    return report.getvalue()


def fake_file(monkeypatch, raw, changed=False):
    attrs = dict(st_mode=0o100600, st_size=len(raw), st_dev=1, st_ino=2,
                 st_mtime_ns=3, st_ctime_ns=4)
    before = SimpleNamespace(**attrs)
    after = SimpleNamespace(**{**attrs, 'st_ino': 3 if changed else 2})
    monkeypatch.setattr(m.os, 'O_NOFOLLOW', 0, raising=False)
    monkeypatch.setattr(m.os, 'O_CLOEXEC', 0, raising=False)
    monkeypatch.setattr(m.os, 'O_NONBLOCK', 0, raising=False)
    monkeypatch.setattr(m.os, 'open', Mock(return_value=90))
    monkeypatch.setattr(m.os, 'fstat', Mock(side_effect=[before, after]))
    source = io.BytesIO(raw)
    monkeypatch.setattr(m.os, 'read', lambda fd, n: source.read(min(n, 7)))
    close = Mock()
    monkeypatch.setattr(m.os, 'close', close)
    return close


def test_capture_reader_replays_exact_protocol_with_short_reads(monkeypatch):
    raw = capture_raw()
    close = fake_file(monkeypatch, raw)
    report = m.read_capture(c)
    assert report['rawHex'] == raw.hex() and report['report']['captureComplete']
    close.assert_called_once_with(90)


def test_failed_endpoint_report_is_preserved_only_as_diagnostics(monkeypatch):
    report = json.loads(capture_raw())
    report['captureComplete'] = False
    report['error'] = 'CAPTURE_FAILED'
    raw = c.encode(report)
    fake_file(monkeypatch, raw)
    result = m.read_capture(c, diagnostics=True)
    assert result['validated'] is False and result['rawHex'] == raw.hex()


@pytest.mark.parametrize('case', ['missing-reply', 'different-reply', 'forged-digest', 'changed-file'])
def test_capture_reader_refuses_tampered_or_changing_evidence(monkeypatch, case):
    report = json.loads(capture_raw())
    if case == 'missing-reply': del report['events'][1]
    if case == 'different-reply': report['events'][1]['rawHex'] = b'{}\n'.hex()
    if case == 'forged-digest': report['requestSha256'] = '0' * 64
    close = fake_file(monkeypatch, c.encode(report), case == 'changed-file')
    with pytest.raises(ValueError): m.read_capture(c)
    close.assert_called_once_with(90)


def test_setup_and_cleanup_failures_still_close_pipes_sockets_selector(monkeypatch):
    class Directory:
        def __init__(self, *args): pass
        def __truediv__(self, other): return self
        def mkdir(self, **kwargs): pass
        def open(self, *args): return io.BytesIO()
    monkeypatch.setattr(m, 'Path', Directory)
    listener = Mock()
    monkeypatch.setattr(m.socket, 'socket', Mock(return_value=listener))
    selector = Mock()
    monkeypatch.setattr(m.selectors, 'DefaultSelector', Mock(return_value=selector))
    pipes = [Mock(), Mock(), Mock()]
    for i, pipe in enumerate(pipes, 10): pipe.fileno.return_value = i
    process = SimpleNamespace(pid=2, stdin=pipes[0], stdout=pipes[1], stderr=pipes[2])
    monkeypatch.setattr(m.subprocess, 'Popen', Mock(return_value=process))
    monkeypatch.setattr(m.os, 'pidfd_open', Mock(return_value=99), raising=False)
    close = Mock()
    monkeypatch.setattr(m.os, 'close', close)
    blocking = Mock(side_effect=[OSError('setup failure'), None, None])
    monkeypatch.setattr(m.os, 'set_blocking', blocking)
    monkeypatch.setattr(m.os, 'read', Mock(return_value=b''))
    monkeypatch.setattr(m, 'cleanup', Mock(side_effect=OSError('cleanup failure')))
    result = m.drive(h, None, None)
    assert not result['passed'] and result['cleanup']['errors'] == ['CLEANUP_UNKNOWN']
    assert blocking.call_args_list[-2].args == (11, False)
    assert blocking.call_args_list[-1].args == (12, False)
    for pipe in pipes: pipe.close.assert_called_once()
    listener.close.assert_called_once()
    selector.close.assert_called_once()
    close.assert_called_once_with(99)


def test_host_entry_rejected_before_loading_client_or_helpers(monkeypatch):
    monkeypatch.setattr(m.os, 'getpid', lambda: 123)
    loader = Mock()
    monkeypatch.setattr(m, 'load', loader)
    with pytest.raises(ValueError, match='EXCLUSIVE_LINUX_PID1_REQUIRED'): m.main()
    loader.assert_not_called()


def test_capsule_is_fixed_and_does_not_copy_worker_executables():
    raw = Path(__file__).with_name('subscription-tool-capture-capsule.sh').read_text()
    assert '[ "$#" -eq 0 ] || exit 64' in raw
    assert 'tool-capture-runner.py' in raw
    assert 'cp /mnt/d/claude/Hackaton/scripts/subscription-trusted-cli-worker-probe.py' not in raw
    assert 'cp /mnt/d/claude/Hackaton/scripts/subscription-exec-server-worker-gate.py' not in raw
    assert 'mount -t tmpfs -o remount,ro' in raw
