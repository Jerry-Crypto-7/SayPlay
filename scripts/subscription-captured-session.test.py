"""Authored discovery and dynamically routed one-worker session regressions."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import threading

import pytest

PATH = Path(__file__).with_name('subscription-captured-session.py')
SPEC = importlib.util.spec_from_file_location('captured_session_test', PATH)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
TRANSPORT = PATH.with_name('subscription-captured-worker-transport.py').read_bytes()
ADAPTER = PATH.with_name('subscription-captured-start-adapter.py').read_bytes()
BASE = PATH.with_name('subscription-exec-server-worker-gate.py').read_bytes()
CAPTURE = json.loads(PATH.with_name('subscription-captured-start.fixture.json').read_bytes())
PROCESS = CAPTURE['params']['processId']
THREAD = CAPTURE['params']['env']['CODEX_THREAD_ID']
PID, MOUNT = 'pid:[101]', 'mnt:[202]'
SKILLS = ['file:///work/.agents/skills', 'file:///work/exec-worker/.agents/skills']
GIT = ['file:///work/exec-worker/.git', 'file:///work/.git', 'file:///.git']


def enc(frame):
    return json.dumps(frame, separators=(',', ':')).encode() + b'\n'


def metadata(identifier, path):
    return {'id': identifier, 'method': 'fs/getMetadata', 'params': {'path': path, 'sandbox': None}}


def frames(skills=SKILLS, git=GIT):
    return [
        {'id': 1, 'method': 'initialize', 'params': {'clientName': 'codex-environment', 'resumeSessionId': None}},
        {'method': 'initialized', 'params': {}},
        {'id': 2, 'method': 'environment/info', 'params': None},
        metadata(3, skills[0]), metadata(4, skills[1]),
        metadata(5, 'file:///work/exec-worker'),
        *[metadata(i, path) for i, path in enumerate(git, 6)]]


def make():
    return m.create(TRANSPORT, ADAPTER, BASE, THREAD, PID, MOUNT)


def flush(t, side):
    raw = t.pending(side)
    if raw: t.written(side, len(raw))
    return raw


def boot():
    t = make()
    assert t.bound_process_id is None
    flush(t, 'worker')
    t.feed('worker', enc({'id': 1, 'result': {'sessionId': 'fixture'}}))
    flush(t, 'worker')
    return t


def discovery(t, count=9):
    for frame in frames()[:count]:
        t.feed('client', enc(frame))
        flush(t, 'client')
    return t


def start(t, process=PROCESS):
    frame = copy.deepcopy(CAPTURE)
    frame['params']['processId'] = process
    t.feed('client', enc(frame))
    final = json.loads(flush(t, 'worker'))
    assert final['params']['processId'] == 'fixed-worker'
    assert final['params']['argv'] == list(t.adapter.base.TRUSTED_CLI_TRAMPOLINE_ARGV)
    t.feed('worker', enc({'id': 2, 'result': {'processId': 'fixed-worker'}}))
    assert json.loads(flush(t, 'client')) == {'id': 9, 'result': {'processId': process}}


def note(method, seq, **fields):
    return {'method': 'process/' + method, 'params': {'processId': 'fixed-worker', 'seq': seq, **fields}}


def finish(t):
    t.feed('worker', enc(note('exited', 1, exitCode=0, sandboxDenied=False)) + enc(note('closed', 2)))
    t.eof('client')
    t.eof('worker')
    flush(t, 'client')
    return t.report()


def validate(report, thread=THREAD, pid=PID, mount=MOUNT):
    return m.validate_report(report, TRANSPORT, ADAPTER, BASE, thread, pid, mount)


def failed(t):
    assert t.failed and not t.pending('worker') and not t.pending('client')
    assert not t.report()['complete'] and not validate(t.report())


@pytest.mark.parametrize('process', [PROCESS, '1-00000000-0000-0000-0000-000000000000',
    '2147483647-ffffffff-ffff-ffff-ffff-ffffffffffff'])
def test_dynamic_routing_is_bound_only_at_start_and_replays(process):
    t = discovery(boot())
    assert t.bootstrap_step == 9 and t.bound_process_id is None
    start(t, process)
    assert t.bound_process_id == process
    report = finish(t)
    assert report['complete'] and validate(report)
    assert report['profile'] == 'authored-captured-session-final-wire'
    assert report['boundProcessId'] == process and report['clientBootstrapComplete']
    assert report['expectedThreadId'] == THREAD
    assert report['transportSha256'] == hashlib.sha256(TRANSPORT).hexdigest()
    assert not any(report[k] for k in ('routingIdentityAttested', 'metadataAttested', 'productionReady'))
    assert not validate(report, thread='00000000-0000-0000-0000-000000000000')
    assert not validate(report, pid='pid:[303]')
    assert not validate(report, mount='mnt:[404]')


@pytest.mark.parametrize('reverse_skills,reverse_git', [(False, False), (True, False), (False, True), (True, True)])
def test_discovery_permutations_git_pipeline_and_fragmented_inputs(reverse_skills, reverse_git):
    t = boot()
    sequence = frames(SKILLS[::-1] if reverse_skills else SKILLS, GIT[::-1] if reverse_git else GIT)
    for frame in sequence[:6]:
        for byte in enc(frame): t.feed('client', bytes([byte]))
        flush(t, 'client')
    t.feed('client', b''.join(enc(f) for f in sequence[6:]))
    replies = [json.loads(raw) for raw in flush(t, 'client').splitlines()]
    assert [r['id'] for r in replies] == [6, 7, 8]
    assert all(r['error']['code'] == -32004 for r in replies)
    start(t)
    assert validate(finish(t))


@pytest.mark.parametrize('count', range(9))
def test_start_before_discovery_complete_never_forwards_worker_start(count):
    t = discovery(boot(), count)
    with pytest.raises(ValueError): t.feed('client', enc(CAPTURE))
    assert t.bound_process_id is None
    failed(t)


@pytest.mark.parametrize('index', [0, 2, 3, 4, 5, 8])
def test_next_phase_requires_fully_written_reply(index):
    t = discovery(boot(), index)
    t.feed('client', enc(frames()[index]))
    assert t.pending('client')
    t.written('client', len(t.pending('client')) - 1)
    following = frames()[index + 1] if index < 8 else CAPTURE
    with pytest.raises(ValueError): t.feed('client', enc(following))
    failed(t)


@pytest.mark.parametrize('case', ['bool-id', 'wrong-id', 'extra-field', 'wrong-method', 'wrong-client',
    'resume', 'info-params', 'skills-duplicate', 'skills-path', 'sandbox', 'cwd-parent',
    'git-duplicate', 'git-path', 'git-order-id', 'duplicate-json'])
def test_invalid_discovery_fails_closed(case):
    index = {'info-params': 2, 'skills-duplicate': 4, 'skills-path': 3, 'sandbox': 3,
        'cwd-parent': 5, 'git-duplicate': 7, 'git-path': 6, 'git-order-id': 6}.get(case, 0)
    t = discovery(boot(), index)
    frame = copy.deepcopy(frames()[index])
    if case == 'bool-id': frame['id'] = True
    elif case == 'wrong-id': frame['id'] = 2
    elif case == 'extra-field': frame['extra'] = None
    elif case == 'wrong-method': frame['method'] = 'process/start'
    elif case == 'wrong-client': frame['params']['clientName'] = 'other'
    elif case == 'resume': frame['params']['resumeSessionId'] = 'fixture'
    elif case == 'info-params': frame['params'] = {}
    elif case == 'skills-duplicate': frame['params']['path'] = SKILLS[0]
    elif case == 'skills-path': frame['params']['path'] = 'file:///etc'
    elif case == 'sandbox': frame['params']['sandbox'] = {}
    elif case == 'cwd-parent': frame['params']['path'] = 'file:///work'
    elif case == 'git-duplicate': frame['params']['path'] = GIT[0]
    elif case == 'git-path': frame['params']['path'] = 'file:///work/other/.git'
    elif case == 'git-order-id': frame['id'] = 7
    raw = enc(frame) if case != 'duplicate-json' else b'{"id":1,"id":1,"method":"initialize","params":{}}\n'
    with pytest.raises(ValueError): t.feed('client', raw)
    assert t.bound_process_id is None
    failed(t)


@pytest.mark.parametrize('case', ['thread', 'argv', 'env', 'sandbox', 'id', 'zero-handle', 'large-handle', 'uppercase-handle'])
def test_binding_does_not_relax_original_start_contract(case):
    t = discovery(boot())
    frame = copy.deepcopy(CAPTURE)
    if case == 'thread': frame['params']['env']['CODEX_THREAD_ID'] = '00000000-0000-0000-0000-000000000000'
    elif case == 'argv': frame['params']['argv'][-1] = '/bin/true'
    elif case == 'env': frame['params']['env']['EXTRA'] = 'x'
    elif case == 'sandbox': frame['params']['sandbox']['windowsSandboxPrivateDesktop'] = False
    elif case == 'id': frame['id'] = 10
    elif case == 'zero-handle': frame['params']['processId'] = '0-' + PROCESS.split('-', 1)[1]
    elif case == 'large-handle': frame['params']['processId'] = '2147483648-' + PROCESS.split('-', 1)[1]
    else: frame['params']['processId'] = PROCESS.upper()
    with pytest.raises(ValueError): t.feed('client', enc(frame))
    assert t.bound_process_id is None
    failed(t)


@pytest.mark.parametrize('field,value', [('boundProcessId', '1-00000000-0000-0000-0000-000000000000'),
    ('bootstrapStep', 8), ('clientBootstrapComplete', False), ('routingIdentityAttested', True),
    ('metadataAttested', True), ('expectedThreadId', 'other'), ('transportSha256', '0' * 64)])
def test_replay_rejects_session_attestation_tampering(field, value):
    t = discovery(boot())
    start(t)
    report = finish(t)
    report[field] = value
    assert not validate(report)


@pytest.mark.parametrize('case', ['second-start', 'wrong-read-handle', 'wrong-read-id'])
def test_bound_session_rejects_crosstalk(case):
    t = discovery(boot())
    start(t)
    frame = copy.deepcopy(CAPTURE) if case == 'second-start' else t.adapter.base.read_request(10)
    if case != 'second-start': frame['params']['processId'] = PROCESS
    if case == 'wrong-read-handle': frame['params']['processId'] = '1-00000000-0000-0000-0000-000000000000'
    if case == 'wrong-read-id': frame['id'] = 11
    with pytest.raises(ValueError): t.feed('client', enc(frame))
    failed(t)


def test_transport_source_pin_rejects_modified_source_before_execution():
    with pytest.raises(ValueError, match='TRANSPORT_SOURCE'):
        m.create(b'raise RuntimeError("must not execute")\n' + TRANSPORT,
            ADAPTER, BASE, THREAD, PID, MOUNT)


def test_bootstrap_responses_exactly_match_existing_authored_capture_peer():
    reference_path = PATH.with_name('subscription-exec-request-capture.py')
    reference_spec = importlib.util.spec_from_file_location('session_capture_reference', reference_path)
    reference = importlib.util.module_from_spec(reference_spec)
    reference_spec.loader.exec_module(reference)
    capture = reference.Capture()
    t = boot()
    for frame in frames():
        raw = enc(frame)
        expected = capture.receive(raw)
        t.feed('client', raw)
        actual = flush(t, 'client')
        assert (json.loads(actual) if actual else None) == (json.loads(expected) if expected else None)


def test_cancel_during_client_discovery_closes_owned_sockets_without_start():
    t = make()
    client, client_peer = socket.socketpair()
    worker, worker_peer = socket.socketpair()
    unrelated, unrelated_peer = socket.socketpair()
    worker_peer.settimeout(3)
    cancelled = threading.Event()
    errors, observed = [], bytearray()

    def receive(peer):
        raw = bytearray()
        while not raw.endswith(b'\n'):
            part = peer.recv(1)
            assert part, 'unexpected EOF'
            raw.extend(part)
            assert len(raw) <= 131072
        return json.loads(raw)

    def peer_task():
        try:
            assert receive(worker_peer) == t.adapter.base.initialize_request()
            worker_peer.sendall(enc({'id': 1, 'result': {'sessionId': 'fixture'}}))
            assert receive(worker_peer) == {'method': 'initialized', 'params': {}}
            client_peer.sendall(enc(frames()[0]))
            client_peer.settimeout(3)
            assert receive(client_peer)['id'] == 1
            cancelled.set()
            while True:
                part = worker_peer.recv(1024)
                if not part: break
                observed.extend(part)
        except BaseException as error:
            errors.append(repr(error))
        finally:
            worker_peer.close()
            client_peer.close()

    thread = threading.Thread(target=peer_task, daemon=True)
    thread.start()
    try:
        report = m.pump(t, client, worker, timeout=3, cancelled=cancelled.is_set)
        thread.join(4)
        assert not thread.is_alive() and not errors, errors
        assert report['error'] == 'PUMP_CANCELLED' and not report['complete']
        assert report['localSocketsClosed'] and client.fileno() == worker.fileno() == -1
        assert t.bootstrap_step == 1 and t.bound_process_id is None
        assert not observed
        failed(t)
        unrelated.sendall(b'preserved')
        assert unrelated_peer.recv(9) == b'preserved'
    finally:
        for peer in (client_peer, worker_peer, unrelated, unrelated_peer): peer.close()


@pytest.mark.parametrize('chunk_size', [1, 17, 4096])
def test_actual_socket_session_discovery_start_read_and_eof(chunk_size, artifact_path=None):
    t = make()
    client, client_peer = socket.socketpair()
    worker, worker_peer = socket.socketpair()
    client_peer.settimeout(4)
    worker_peer.settimeout(4)
    errors, observed = [], {}

    def send(peer, raw):
        for index in range(0, len(raw), chunk_size): peer.sendall(raw[index:index + chunk_size])

    def receive(peer):
        raw = bytearray()
        while not raw.endswith(b'\n'):
            part = peer.recv(1)
            assert part, 'unexpected EOF'
            raw.extend(part)
            assert len(raw) <= 131072
        return json.loads(raw)

    def client_task():
        replies = []
        for frame in frames()[:6]:
            send(client_peer, enc(frame))
            if 'id' in frame:
                reply = receive(client_peer)
                assert reply['id'] == frame['id']
                replies.append(reply)
        send(client_peer, b''.join(enc(f) for f in frames()[6:]))
        replies.extend(receive(client_peer) for _ in range(3))
        assert [r['id'] for r in replies] == list(range(1, 9))
        observed['discovery'] = replies
        send(client_peer, enc(CAPTURE))
        assert receive(client_peer) == {'id': 9, 'result': {'processId': PROCESS}}
        read = t.adapter.base.read_request(10)
        read['params']['processId'] = PROCESS
        send(client_peer, enc(read))
        client_peer.shutdown(socket.SHUT_WR)
        observed['client'] = [receive(client_peer) for _ in range(4)]
        assert client_peer.recv(1) == b''

    def worker_task():
        assert receive(worker_peer) == t.adapter.base.initialize_request()
        send(worker_peer, enc({'id': 1, 'result': {'sessionId': 'fixture'}}))
        assert receive(worker_peer) == {'method': 'initialized', 'params': {}}
        observed['start'] = receive(worker_peer)
        assert observed['start']['params']['argv'] == list(t.adapter.base.TRUSTED_CLI_TRAMPOLINE_ARGV)
        assert observed['start']['params']['env'] == t.gate.worker_env
        send(worker_peer, enc({'id': 2, 'result': {'processId': 'fixed-worker'}}))
        assert receive(worker_peer) == t.adapter.base.read_request(3)
        assert worker_peer.recv(1) == b''
        events = [note('output', 1, stream='stdout', chunk='AP8K'),
            note('exited', 2, exitCode=0, sandboxDenied=False), note('closed', 3),
            {'id': 3, 'result': {'chunks': [], 'nextSeq': 1, 'exited': False, 'exitCode': None,
                'closed': False, 'failure': None, 'sandboxDenied': False}}]
        send(worker_peer, b''.join(enc(f) for f in events))
        worker_peer.shutdown(socket.SHUT_WR)

    def owned(function, peer):
        try: function()
        except BaseException as error: errors.append(repr(error))
        finally: peer.close()

    threads = [threading.Thread(target=owned, args=(client_task, client_peer), daemon=True),
        threading.Thread(target=owned, args=(worker_task, worker_peer), daemon=True)]
    for thread in threads: thread.start()
    try:
        report = m.pump(t, client, worker, timeout=4)
    finally:
        for thread in threads: thread.join(5)
        client_peer.close()
        worker_peer.close()
    assert not any(thread.is_alive() for thread in threads)
    assert not errors, errors
    assert report['complete'] and report['error'] is None
    assert report['localSocketsClosed'] and client.fileno() == worker.fileno() == -1
    assert sum(report['socketIo']['receivedBytes'].values()) == report['protocol']['inputBytes']
    assert report['socketIo']['sentBytes'] == report['protocol']['writtenBytes']
    assert all(f['params']['processId'] == PROCESS for f in observed['client'][:3])
    assert observed['client'][0]['params']['chunk'] == 'AP8K'
    assert observed['client'][-1]['id'] == 10
    assert validate(report['protocol'])
    if artifact_path is not None:
        artifact = {'version': 1, 'scope': 'Authored local socket peers only; no real client, worker execution or metadata attestation.',
            'sources': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (PATH, Path(__file__),
                PATH.with_name('subscription-captured-worker-transport.py'), PATH.with_name('subscription-captured-start-adapter.py'),
                PATH.with_name('subscription-exec-server-worker-gate.py'), PATH.with_name('subscription-captured-start.fixture.json'))},
            'pump': report, 'peerObserved': observed, 'peerThreadsJoined': True, 'peerErrors': errors, 'chunkSize': chunk_size}
        with Path(artifact_path).open('x', encoding='utf-8') as output:
            json.dump(artifact, output, indent=2)
            output.write('\n')
