import copy
import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock, patch
import pytest
from types import SimpleNamespace


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


c = module('metadata_pipe_child_test', 'subscription-appserver-metadata-pipe-child.py')
p = module('metadata_pipe_policy_test', 'subscription-appserver-noenv.py')
HOME = '/work/appserver-home/fixed-test0000'
INIT = {'id': 1, 'method': 'initialize', 'params': {
    'clientInfo': {'name': 'reality_compiler_generation', 'version': '1'},
    'capabilities': {'experimentalApi': True}}}
INITIALIZED = {'method': 'initialized', 'params': {}}
INIT_REPLY = {'id': 1, 'result': {'userAgent': 'unit fixture', 'platformFamily': 'unix', 'platformOs': 'linux', 'codexHome': HOME}}
THREAD_REPLY = {'id': 2, 'result': {'thread': {'id': 'unit-thread', 'ephemeral': True, 'path': None},
    'model': 'gpt-5.6-sol', 'modelProvider': 'openai', 'reasoningEffort': 'low', 'cwd': '/work',
    'approvalPolicy': 'never', 'runtimeWorkspaceRoots': [], 'sandbox': {'type': 'readOnly', 'networkAccess': False}}}
MODEL = {'id': 3, 'method': 'model/list', 'params': {'includeHidden': True}}
ADVISORY = {'method': 'configWarning', 'params': {
    'summary': "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.",
    'details': None}, 'emittedAtMs': 1789049278908}


def wire(frame):
    return (json.dumps(frame, separators=(',', ':')) + '\n').encode()


def thread_request():
    frame = p.thread_request()
    frame['params']['developerInstructions'] = 'Metadata transport validation only; no inference.'
    return frame


def write_all(gate):
    with patch.object(c.os, 'write', side_effect=lambda _fd, raw: len(raw)) as write:
        gate.drain(42)
    return b''.join(bytes(call.args[1]) for call in write.call_args_list)


def initialized_gate():
    gate = c.WireGate(p, HOME)
    gate.receive_client(wire(INIT))
    write_all(gate)
    gate.receive_server(wire(INIT_REPLY))
    return gate


def test_no_auto_forward_before_explicit_admission_and_full_actual_write():
    gate = c.WireGate(p, HOME)
    assert gate.protocol.pending
    with patch.object(c.os, 'write') as write:
        assert gate.drain(42) == 0
    write.assert_not_called()
    gate.receive_client(wire(INIT))
    assert gate.protocol.delivered == set()
    with patch.object(c.os, 'write', side_effect=[BlockingIOError(), 1]) as write:
        assert gate.drain(42) == 0
        assert gate.drain(42) == 1
    assert gate.protocol.delivered == set()
    remainder = write_all(gate)
    assert bytes(write.call_args_list[1].args[1])[:1] + remainder == wire(INIT)
    assert gate.protocol.delivered == {1}
    gate.receive_server(wire(INIT_REPLY))
    with patch.object(c.os, 'write') as write:
        gate.drain(42)
    write.assert_not_called()  # Response prepares fixed requests but never sends.


def test_same_chunk_initialized_and_thread_write_order_and_optional_model_list():
    gate = initialized_gate()
    gate.receive_client(wire(INITIALIZED) + wire(thread_request()))
    assert write_all(gate) == wire(INITIALIZED) + wire(thread_request())
    gate.receive_server(wire(THREAD_REPLY))
    gate.client_eof()  # model/list is optional, never auto-forwarded.
    gate.receive_client(wire(MODEL))
    assert write_all(gate) == wire(MODEL)
    gate.receive_server(wire({'id': 3, 'result': {'nextCursor': None, 'data': [{'id': 'gpt-5.6-sol', 'model': 'gpt-5.6-sol'}]}}))
    assert gate.protocol.done
    with pytest.raises(ValueError, match='METADATA_REQUEST_REFUSED'):
        gate.receive_client(wire({'id': 4, 'method': 'turn/start', 'params': {}}))
    with patch.object(c.os, 'write') as write:
        gate.drain(42)
    write.assert_not_called()


@pytest.mark.parametrize('method', ['turn/start', 'account/login/start', 'account/read', 'auth/start', 'environment/add', 'thread/resume', 'unknown'])
def test_prohibited_rpc_rejected_before_any_os_write(method):
    gate = c.WireGate(p, HOME)
    with pytest.raises(ValueError):
        gate.receive_client(wire(INIT) + wire({'id': 2, 'method': method, 'params': {}}))
    with patch.object(c.os, 'write') as write:
        gate.drain(42)
    write.assert_not_called()  # Even prior admission in this unflushed chunk is fenced.


@pytest.mark.parametrize('change', ['bool-id', 'jsonrpc', 'extra-key', 'wrong-client', 'nonexperimental'])
def test_initialize_exact_typed_profile(change):
    frame = copy.deepcopy(INIT)
    if change == 'bool-id': frame['id'] = True
    if change == 'jsonrpc': frame['jsonrpc'] = '2.0'
    if change == 'extra-key': frame['params']['unknown'] = 1
    if change == 'wrong-client': frame['params']['clientInfo']['name'] = 'other'
    if change == 'nonexperimental': frame['params']['capabilities']['experimentalApi'] = 1
    with pytest.raises(ValueError): c.WireGate(p, HOME).receive_client(wire(frame))


@pytest.mark.parametrize('key,value', [('model', 'other'), ('ephemeral', 1), ('developerInstructions', 'caller prompt'),
                                     ('environments', [{}]), ('config', {}), ('dynamicTools', [{}])])
def test_thread_profile_cannot_be_mutated(key, value):
    gate = initialized_gate()
    request = thread_request()
    request['params'][key] = value
    with pytest.raises(ValueError): gate.receive_client(wire(INITIALIZED) + wire(request))
    with patch.object(c.os, 'write') as write: gate.drain(42)
    write.assert_not_called()
    assert 'developerInstructions' not in p.thread_request()['params']


@pytest.mark.parametrize('raw', [b'{"id":1,"id":1}\n', b'{"id":NaN}\n', b'\xff\n', b'\n', b'x' * 4097])
def test_bad_json_or_bounded_input_fails_closed(raw):
    gate = c.WireGate(p, HOME)
    with pytest.raises(ValueError): gate.receive_client(raw)
    assert gate.failed


def test_split_client_frame_is_not_admitted_until_newline():
    gate = c.WireGate(p, HOME)
    raw = wire(INIT)
    gate.receive_client(raw[:-1])
    assert gate.authorized_bytes == 0
    gate.receive_client(raw[-1:])
    assert write_all(gate) == raw


def test_response_before_actual_request_write_permanently_fences_gate():
    gate = c.WireGate(p, HOME)
    gate.receive_client(wire(INIT))
    with pytest.raises(ValueError): gate.receive_server(wire(INIT_REPLY))
    with patch.object(c.os, 'write') as write: gate.drain(42)
    write.assert_not_called()


def test_eof_with_partial_or_missing_metadata_never_means_completed_handshake():
    gate = c.WireGate(p, HOME)
    gate.receive_client(b'{')
    with pytest.raises(ValueError): gate.client_eof()
    with pytest.raises(ValueError): initialized_gate().client_eof()


def test_server_requests_are_not_answered_or_executed():
    gate = initialized_gate()
    with pytest.raises(ValueError):
        gate.receive_server(wire({'id': 77, 'method': 'item/commandExecution/requestApproval', 'params': {}}))
    assert gate.failed
    with patch.object(c.os, 'write') as write: gate.drain(42)
    write.assert_not_called()


@pytest.mark.parametrize('timestamp', [True, False])
def test_exact_advisory_is_retained_once_without_new_request_or_write_credit(timestamp):
    gate = initialized_gate()
    frame = copy.deepcopy(ADVISORY)
    if not timestamp: del frame['emittedAtMs']
    before = bytes(gate.protocol.pending), gate.authorized_bytes, gate.approved, set(gate.protocol.delivered)
    gate.receive_server(wire(frame))
    assert gate.protocol.history[-1] == {'event': 'received', 'frame': frame}
    assert (bytes(gate.protocol.pending), gate.authorized_bytes, gate.approved, set(gate.protocol.delivered)) == before
    with patch.object(c.os, 'write') as write: gate.drain(42)
    write.assert_not_called()


@pytest.mark.parametrize('case', ['preinit', 'repeat', 'unknown-summary', 'details', 'extra-param',
                                'extra-envelope', 'request-id', 'bool-time', 'negative-time', 'unsafe-time', 'null-time'])
def test_advisory_rejects_unrecognized_shape_scope_and_duplicates(case):
    gate = c.WireGate(p, HOME) if case == 'preinit' else initialized_gate()
    frame = copy.deepcopy(ADVISORY)
    if case == 'repeat': gate.receive_server(wire(frame))
    if case == 'unknown-summary': frame['params']['summary'] = 'Some other warning'
    if case == 'details': frame['params']['details'] = 'Enable broader permissions'
    if case == 'extra-param': frame['params']['unknown'] = True
    if case == 'extra-envelope': frame['unknown'] = True
    if case == 'request-id': frame['id'] = 3
    if case == 'bool-time': frame['emittedAtMs'] = True
    if case == 'negative-time': frame['emittedAtMs'] = -1
    if case == 'unsafe-time': frame['emittedAtMs'] = 9007199254740992
    if case == 'null-time': frame['emittedAtMs'] = None
    with pytest.raises(ValueError, match='METADATA_SANDBOX_ADVISORY_INVALID'):
        gate.receive_server(wire(frame))
    assert gate.failed
    with patch.object(c.os, 'write') as write: gate.drain(42)
    write.assert_not_called()


def test_main_orders_lockdown_before_policy_home_or_appserver_spawn():
    order = []
    lockdown = Mock(install_worker_lockdown=Mock(side_effect=lambda: order.append('lockdown')))
    def loader(_name, path):
        order.append(path)
        return lockdown if path.endswith('/worker-lockdown.py') else p
    with patch.object(c.sys, 'platform', 'linux'), patch.object(c.sys, 'argv', ['fixed']), \
         patch.object(c, 'load_fixed', side_effect=loader), \
         patch.object(c, 'fresh_environment', side_effect=lambda: order.append('home') or (HOME, {})), \
         patch.object(c, 'run_pipe', side_effect=lambda *_: order.append('pipe') or 0):
        assert c.main() == 0
    assert order == ['/usr/bin/worker-lockdown.py', 'lockdown', '/usr/bin/appserver-noenv.py', 'home', 'pipe']


def test_lockdown_failure_never_falls_back_or_launches_appserver():
    with patch.object(c.sys, 'platform', 'linux'), patch.object(c.sys, 'argv', ['fixed']), \
         patch.object(c, 'load_fixed', return_value=Mock(install_worker_lockdown=Mock(side_effect=OSError('denied')))), \
         patch.object(c, 'fresh_environment') as home, patch.object(c.subprocess, 'Popen') as spawn, pytest.raises(OSError):
        c.main()
    home.assert_not_called()
    spawn.assert_not_called()


def test_fresh_home_is_exclusive_and_environment_never_inherits_host_values():
    with patch.object(c.tempfile, 'mkdtemp', return_value=HOME) as create, patch.object(c.Path, 'mkdir') as mkdir:
        home, environment = c.fresh_environment()
    create.assert_called_once_with(prefix='fixed-', dir='/work/appserver-home')
    mkdir.assert_called_once_with(mode=0o700, exist_ok=False)
    assert home == HOME
    assert environment == {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': HOME, 'CODEX_HOME': HOME, 'TMPDIR': HOME + '/tmp'}


@pytest.mark.parametrize('reject,advisory', [(False, False), (True, False), (False, True)])
def test_pipe_loop_preserves_stream_bytes_and_refusal_never_reaches_appserver(reject, advisory):
    process = SimpleNamespace(pid=123, returncode=None)
    process.poll = lambda: process.returncode
    class Stream:
        def __init__(self, fd): self.fd, self.closed = fd, False
        def fileno(self): return self.fd
        def close(self):
            self.closed = True
            if self.fd == 10: process.returncode = 0
    process.stdin, process.stdout, process.stderr = Stream(10), Stream(11), Stream(12)
    # Kernel and selector are authored unit fixtures. No process is launched.
    turns = [[0], [11, 12], [0], [11], [0], [11, 12]] if not reject else [[0], [11, 12]]
    chunks = {0: [wire(INIT), wire(INITIALIZED) + wire(thread_request()), b''],
              11: [wire(INIT_REPLY), wire(THREAD_REPLY), b''], 12: [b'fixed CLI stderr\n', b'']}
    if advisory:
        # Preserve a noncanonical original wire representation, not a newly
        # serialized/sanitized warning, alongside the initialize response.
        warning_wire = (json.dumps(ADVISORY, indent=None) + '\n').encode()
        chunks[11][0] += warning_wire
    if reject:
        chunks = {0: [wire({'id': 1, 'method': 'turn/start', 'params': {}})], 11: [b''], 12: [b'']}
    class Selector:
        def __init__(self): self.keys = {}
        def register(self, fd, _events, data): self.keys[fd] = SimpleNamespace(fd=fd, data=data)
        def unregister(self, fd): del self.keys[fd]
        def get_map(self): return self.keys
        def close(self): pass
        def select(self, _timeout):
            assert turns, 'unexpected extra loop: fixture would hang'
            return [(self.keys[fd], 1) for fd in turns.pop(0) if fd in self.keys]
    writes = {1: bytearray(), 2: bytearray(), 10: bytearray()}
    def write(fd, raw):
        writes[fd].extend(raw)
        return len(raw)
    with patch.object(c.subprocess, 'Popen', return_value=process) as spawn, \
         patch.object(c.os, 'pidfd_open', return_value=42, create=True), patch.object(c.os, 'close') as close, \
         patch.object(c.os, 'set_blocking'), patch.object(c.os, 'read', side_effect=lambda fd, _count: chunks[fd].pop(0)), \
         patch.object(c.os, 'write', side_effect=write), patch.object(c.selectors, 'DefaultSelector', Selector), \
         patch.object(c.signal, 'pidfd_send_signal', create=True) as signal:
        assert c.run_pipe(p, HOME, {'fixed': 'test'}) == (1 if reject else 0)
    assert spawn.call_args.args[0] == p.ARGV
    assert spawn.call_args.kwargs['env'] == {'fixed': 'test'}
    assert spawn.call_args.kwargs['close_fds'] is True
    close.assert_called_once_with(42)
    signal.assert_not_called()
    if reject:
        assert writes[10] == b''
        assert writes[1] == b''
        assert writes[2] == b'METADATA_PIPE_DIAGNOSTIC:METADATA_REQUEST_REFUSED\n'
    else:
        assert writes[10] == wire(INIT) + wire(INITIALIZED) + wire(thread_request())
        assert writes[1] == wire(INIT_REPLY) + (warning_wire if advisory else b'') + wire(THREAD_REPLY)
        assert writes[2] == b'fixed CLI stderr\n'
