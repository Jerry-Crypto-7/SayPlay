"""Owned socket-pair integration with authored peers, no remote worker launch."""
import importlib.util
import hashlib
import json
from pathlib import Path
import socket
import threading

import pytest


PATH = Path(__file__).with_name('subscription-captured-worker-transport.py')
SPEC = importlib.util.spec_from_file_location('captured_pump_test', PATH)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
ADAPTER = PATH.with_name('subscription-captured-start-adapter.py').read_bytes()
BASE = PATH.with_name('subscription-exec-server-worker-gate.py').read_bytes()
CAPTURE = PATH.with_name('subscription-captured-start.fixture.json').read_bytes()
PROCESS = '75019-eefe8e86-65cd-45ed-9ab0-b55a100b8ace'
THREAD = '01a0905c-d025-73e0-9b43-40038e02cd46'
PID, MOUNT = 'pid:[101]', 'mnt:[202]'


def transport():
    return m.WireTransport(ADAPTER, BASE, PROCESS, THREAD, PID, MOUNT)


def enc(frame):
    return json.dumps(frame, separators=(',', ':')).encode() + b'\n'


def receive_line(peer):
    raw = bytearray()
    while not raw.endswith(b'\n'):
        data = peer.recv(1)
        assert data, 'unexpected peer EOF'
        raw.extend(data)
        assert len(raw) <= 131072
    return json.loads(raw)


def send_chunks(peer, raw, size):
    for start in range(0, len(raw), size):
        peer.sendall(raw[start:start + size])


def endpoints():
    client, client_peer = socket.socketpair()
    worker, worker_peer = socket.socketpair()
    client_peer.settimeout(3)
    worker_peer.settimeout(3)
    return client, worker, client_peer, worker_peer


@pytest.mark.parametrize('chunk_size', [1, 11, 4096])
def test_actual_socket_pump_bootstrap_read_halfclose_and_replay(chunk_size, artifact_path=None):
    t = transport()
    client, worker, client_peer, worker_peer = endpoints()
    errors, observed = [], {}

    def client_task():
        # It is legitimate to queue client bytes while worker bootstrap runs.
        send_chunks(client_peer, CAPTURE, chunk_size)
        assert receive_line(client_peer) == {'id': 9, 'result': {'processId': PROCESS}}
        request = t.adapter.base.read_request(10)
        request['params']['processId'] = PROCESS
        send_chunks(client_peer, enc(request), chunk_size)
        client_peer.shutdown(socket.SHUT_WR)
        observed['client'] = [receive_line(client_peer) for _ in range(4)]
        assert client_peer.recv(1) == b''

    def worker_task():
        assert receive_line(worker_peer) == t.adapter.base.initialize_request()
        send_chunks(worker_peer, enc({'id': 1, 'result': {'sessionId': 'fixture'}}), chunk_size)
        assert receive_line(worker_peer) == {'method': 'initialized', 'params': {}}
        start = receive_line(worker_peer)
        observed['start'] = start
        assert start['params']['argv'] == list(t.adapter.base.TRUSTED_CLI_TRAMPOLINE_ARGV)
        assert start['params']['env'] == t.gate.worker_env
        send_chunks(worker_peer, enc({'id': 2, 'result': {'processId': 'fixed-worker'}}), chunk_size)
        assert receive_line(worker_peer) == t.adapter.base.read_request(3)
        assert worker_peer.recv(1) == b''
        frames = [
            {'method': 'process/output', 'params': {'processId': 'fixed-worker', 'seq': 1,
                'stream': 'stdout', 'chunk': 'YQ=='}},
            {'method': 'process/exited', 'params': {'processId': 'fixed-worker', 'seq': 2,
                'exitCode': 0, 'sandboxDenied': False}},
            {'method': 'process/closed', 'params': {'processId': 'fixed-worker', 'seq': 3}},
            {'id': 3, 'result': {'chunks': [], 'nextSeq': 1, 'exited': False,
                'exitCode': None, 'closed': False, 'failure': None, 'sandboxDenied': False}}]
        send_chunks(worker_peer, b''.join(enc(frame) for frame in frames), chunk_size)
        worker_peer.shutdown(socket.SHUT_WR)

    def run_owned(function, peer):
        try:
            function()
        except BaseException as error:
            errors.append(error)
        finally:
            peer.close()

    threads = [threading.Thread(target=run_owned, args=(client_task, client_peer), daemon=True),
               threading.Thread(target=run_owned, args=(worker_task, worker_peer), daemon=True)]
    for thread in threads: thread.start()
    try:
        report = m.pump(t, client, worker, timeout=3)
    finally:
        for thread in threads: thread.join(4)
        client_peer.close()
        worker_peer.close()
    assert not any(thread.is_alive() for thread in threads)
    assert not errors, repr(errors)
    assert report['complete'] and report['error'] is None
    assert report['localSocketsClosed'] and client.fileno() == worker.fileno() == -1
    assert sum(report['socketIo']['receivedBytes'].values()) == report['protocol']['inputBytes']
    assert report['socketIo']['sentBytes'] == report['protocol']['writtenBytes']
    assert report['socketIo']['inputEof'] == {'client': True, 'worker': True}
    assert not any(report[key] for key in ('executionAttested', 'remoteCleanupAttested', 'productionReady'))
    mapped = observed['client']
    assert all(frame['params']['processId'] == PROCESS for frame in mapped[:3])
    assert mapped[0]['params']['chunk'] == 'YQ==' and mapped[-1]['id'] == 10
    assert m.validate_wire_report(report['protocol'], ADAPTER, BASE, PROCESS, THREAD, PID, MOUNT)
    if artifact_path is not None:
        artifact = {'version': 1, 'profile': 'authored-local-socketpair-evidence',
            'scope': 'Authored Python peers only; no stock client, worker execution or isolation attestation.',
            'sources': {str(path.name): hashlib.sha256(path.read_bytes()).hexdigest() for path in (
                PATH, Path(__file__), PATH.with_name('subscription-captured-start-adapter.py'),
                PATH.with_name('subscription-exec-server-worker-gate.py'),
                PATH.with_name('subscription-captured-start.fixture.json'))},
            'pump': report, 'peerObserved': observed, 'peerThreadsJoined': True,
            'peerErrors': [], 'chunkSize': chunk_size}
        with Path(artifact_path).open('x', encoding='utf-8') as output:
            json.dump(artifact, output, indent=2)
            output.write('\n')


@pytest.mark.parametrize('case', ['deadline', 'cancel', 'worker-eof', 'worker-malformed'])
def test_pump_failure_closes_only_owned_endpoints_and_invalidates_protocol(case):
    t = transport()
    client, worker, client_peer, worker_peer = endpoints()
    # An unrelated socket pair must survive cleanup.
    unrelated, unrelated_peer = socket.socketpair()
    try:
        if case == 'worker-eof': worker_peer.shutdown(socket.SHUT_WR)
        if case == 'worker-malformed': worker_peer.sendall(b'{"id":1,"id":1}\n')
        report = m.pump(t, client, worker, timeout=0.1 if case == 'deadline' else 1,
                        cancelled=(lambda: True) if case == 'cancel' else None)
        assert not report['complete'] and report['error']
        if case == 'deadline': assert report['error'] == 'PUMP_DEADLINE'
        if case == 'cancel': assert report['error'] == 'PUMP_CANCELLED'
        assert report['localSocketsClosed'] and client.fileno() == worker.fileno() == -1
        assert t.failed and not t.pending('client') and not t.pending('worker')
        assert not m.validate_wire_report(report['protocol'], ADAPTER, BASE, PROCESS, THREAD, PID, MOUNT)
        unrelated.sendall(b'x')
        assert unrelated_peer.recv(1) == b'x'
    finally:
        for peer in (client_peer, worker_peer, unrelated, unrelated_peer): peer.close()


@pytest.mark.parametrize('timeout', [0, -1, True, float('nan'), float('inf'), 181])
def test_invalid_deadlines_close_owned_sockets(timeout):
    t = transport()
    client, worker, client_peer, worker_peer = endpoints()
    try:
        report = m.pump(t, client, worker, timeout=timeout)
        assert report['error'] == 'PUMP_TIMEOUT' and not report['complete']
        assert report['localSocketsClosed'] and client.fileno() == worker.fileno() == -1
    finally:
        client_peer.close()
        worker_peer.close()


@pytest.mark.parametrize('case', ['written', 'aborted'])
def test_pump_refuses_preused_protocol_accounting(case):
    t = transport()
    if case == 'written': t.written('worker', 1)
    else: t.abort()
    client, worker, client_peer, worker_peer = endpoints()
    try:
        report = m.pump(t, client, worker)
        assert report['error'] == 'FRESH_WIRE_TRANSPORT_REQUIRED'
        assert not report['complete'] and report['localSocketsClosed']
        assert report['socketIo']['sentBytes'] == {'client': 0, 'worker': 0}
        assert report['socketIo']['receivedBytes'] == {'client': 0, 'worker': 0}
        assert client.fileno() == worker.fileno() == -1
    finally:
        client_peer.close()
        worker_peer.close()


def test_send_exception_retains_cleanup_and_fails_accounting():
    class FailingSendSocket(socket.socket):
        def send(self, data, flags=0):
            raise OSError('authored send failure')

    t = transport()
    client, worker, client_peer, worker_peer = endpoints()
    failing_worker = FailingSendSocket(fileno=worker.detach())
    try:
        report = m.pump(t, client, failing_worker, timeout=1)
        assert report['error'] == 'OSError'
        assert not report['complete'] and report['localSocketsClosed']
        assert client.fileno() == failing_worker.fileno() == -1
        assert report['socketIo']['sentBytes'] == {'client': 0, 'worker': 0}
        assert t.failed and not t.pending('worker')
    finally:
        client_peer.close()
        worker_peer.close()
