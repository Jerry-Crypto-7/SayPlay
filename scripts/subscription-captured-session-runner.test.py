"""Native, credential-free runner regression checks; no Linux launch."""
import importlib.util
import json
from pathlib import Path
import socket
import threading
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('captured_session_runner_tested', ROOT / 'subscription-captured-session-runner.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def client():
    return m.Client({}, lambda raw: json.loads(raw))


def note(method, **kwargs):
    return {'method': 'process/' + method, 'params': {'processId': m.PROCESS, **kwargs}}


def test_native_guard_precedes_loading_or_launch(monkeypatch):
    monkeypatch.setattr(m.sys, 'platform', 'win32')
    monkeypatch.setattr(m, 'load', lambda _: pytest.fail('loaded before guard'))
    monkeypatch.setattr(m.subprocess, 'Popen', lambda *_a, **_k: pytest.fail('launched before guard'))
    with pytest.raises(ValueError, match='EXCLUSIVE_LINUX_PID1_REQUIRED'):
        m.main()
    with pytest.raises(ValueError, match='EXCLUSIVE_LINUX_PID1_REQUIRED'):
        m.drive(None)


@pytest.mark.parametrize('pid,machine', [(2, 'x86_64'), (1, 'aarch64')])
def test_linux_wrong_namespace_or_architecture_refused(monkeypatch, pid, machine):
    monkeypatch.setattr(m.sys, 'platform', 'linux')
    monkeypatch.setattr(m.os, 'getpid', lambda: pid)
    monkeypatch.setattr(m.os, 'uname', lambda: type('U', (), {'machine': machine})(), raising=False)
    with pytest.raises(ValueError, match='EXCLUSIVE_LINUX_PID1_REQUIRED'):
        m.require_capsule()


def test_lifecycle_output_after_exit_and_reply_after_closed():
    c = client()
    c.lifecycle(note('exited', exitCode=0, sandboxDenied=False))
    c.lifecycle(note('output', stream='stdout', chunk='e30K'))
    c.lifecycle(note('closed'))
    c.lifecycle({'id': 9, 'result': {'processId': m.PROCESS}})
    assert c.started and c.closed and bytes(c.output['stdout']) == b'{}\n'


@pytest.mark.parametrize('frame', [
    note('exited', exitCode=1, sandboxDenied=False),
    note('exited', exitCode=False, sandboxDenied=False),
    note('exited', exitCode=0, sandboxDenied=True),
    note('closed'), note('other'),
    note('output', stream='wrong', chunk=''),
    {'id': 9, 'result': {'processId': 'foreign'}},
    {'id': 10, 'result': {'processId': m.PROCESS}},
    {'method': 'process/output', 'params': {'processId': 'foreign'}},
])
def test_invalid_terminal_evidence_refused(frame):
    with pytest.raises(ValueError):
        client().lifecycle(frame)


def test_output_after_closed_refused():
    c = client()
    c.lifecycle(note('exited', exitCode=0, sandboxDenied=False))
    c.lifecycle(note('closed'))
    with pytest.raises(ValueError, match='CLIENT_PROCESS_ID'):
        c.lifecycle(note('output', stream='stdout', chunk='e30K'))


def test_output_bound_before_probe_parse():
    import base64
    with pytest.raises(ValueError, match='WORKER_OUTPUT_BOUND'):
        client().lifecycle(note('output', stream='stdout', chunk=base64.b64encode(b'x' * 65537).decode()))


def test_frame_bound_and_truncated_eof():
    class Peer:
        def __init__(self, raw): self.raw = raw
        def recv(self, _): raw, self.raw = self.raw, b''; return raw
    with pytest.raises(ValueError, match='CLIENT_FRAME_BOUND'):
        client().receive(Peer(b'x' * 131073))
    with pytest.raises(ValueError, match='CLIENT_UNEXPECTED_EOF'):
        client().receive(Peer(b'{'))


def test_socket_peer_discovery_lifecycle_and_halfclose():
    c = client()
    a, b = socket.socketpair()
    a.settimeout(3)
    b.settimeout(3)
    errors = []
    def task():
        try: c.run(a)
        except BaseException as exc: errors.append(str(exc))
        finally: a.close()
    thread = threading.Thread(target=task)
    thread.start()
    def receive():
        raw = bytearray()
        while not raw.endswith(b'\n'):
            block = b.recv(1)
            assert block
            raw.extend(block)
        return json.loads(raw)
    try:
        for expected in m.discovery():
            assert receive() == expected
            if 'id' in expected:
                b.sendall(m.encode({'id': expected['id'], 'result': {}}))
        assert receive() == {}
        b.sendall(b''.join(m.encode(f) for f in [
            note('output', stream='stdout', chunk='e30K'),
            note('exited', exitCode=0, sandboxDenied=False), note('closed'),
            {'id': 9, 'result': {'processId': m.PROCESS}}]))
        assert b.recv(1) == b''
        b.shutdown(socket.SHUT_WR)
    finally:
        b.close()
        thread.join(3)
    assert not thread.is_alive() and errors == []
    assert c.started and c.closed and c.exited


def test_source_inventory_covers_runtime_imports():
    assert len(m.FILES) == 20 and len(set(m.FILES.values())) == 20
    assert all(value.startswith('/usr/bin/') for value in m.FILES.values())
    assert m.FILES['runner'] == '/usr/bin/captured-session-runner.py'
    assert {'trampoline', 'lockdown', 'exec_probe', 'boundary', 'cli_probe', 'parent',
            'capture', 'session', 'transport', 'adapter', 'fixture', 'probe', 'supervisor'} <= set(m.FILES)


def test_cleanup_exception_preserves_failed_terminal_report(monkeypatch):
    def fail_prepare():
        raise ValueError('SETUP_FAILED')
    def fail_cleanup(*_):
        raise OSError('CLEANUP_FAILED')
    modules = {'capture': SimpleNamespace(cleanup=fail_cleanup), 'session': SimpleNamespace(),
               'gate': SimpleNamespace(), 'parent': SimpleNamespace(prepare_home=fail_prepare),
               'boundary': SimpleNamespace(), 'cli_probe': SimpleNamespace(adapt=lambda _: None)}
    monkeypatch.setattr(m, 'Path', lambda _: SimpleNamespace(read_bytes=lambda: b'{}'))
    monkeypatch.setattr(m, 'load', modules.__getitem__)
    monkeypatch.setattr(m, 'require_capsule', lambda: None)
    monkeypatch.setattr(m.os, 'readlink', lambda path: 'pid:[1]' if path.endswith('pid') else 'mnt:[2]')
    report = m.drive(None)
    assert report['passed'] is False and report['error'] == 'SETUP_FAILED'
    assert report['cleanup']['namespaceEmpty'] is False
    assert report['cleanup']['errors'] == ['CLEANUP_OUTCOME_UNKNOWN']
    assert report['peerErrors'] == ['NAMESPACE_CLEANUP_FAILED:CLEANUP_FAILED']


def test_pivot_guard_before_source_lookup(monkeypatch):
    monkeypatch.setattr(m.sys, 'platform', 'win32')
    with pytest.raises(ValueError, match='EXCLUSIVE_LINUX_PID1_REQUIRED'):
        m.enter_root('/tmp/rc-runtime.test')


def test_executor_drops_caps_without_changing_policy_arguments():
    policy_spec = importlib.util.spec_from_file_location('runner_test_policy', ROOT / 'subscription-appserver-noenv.py')
    policy = importlib.util.module_from_spec(policy_spec)
    policy_spec.loader.exec_module(policy)
    argv = m.executor_argv(policy)
    assert argv[:5] == ('/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all',
                        '--ambient-caps=-all', '--no-new-privs')
    assert argv[5:-3] == policy.ARGV[:-2]
    assert argv[-3:] == ('exec-server', '--listen', 'stdio')
    assert argv[5] == '/usr/bin/codex'
