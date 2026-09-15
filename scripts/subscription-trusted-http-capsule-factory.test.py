"""Offline capsule factory ownership/deadline regression tests; no sockets."""
import errno
import hashlib
import importlib.util
import math
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from contextlib import ExitStack
import pytest


def load(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


m = load('subscription-trusted-http-capsule-factory.py')


def expected(): return {'dev': 7, 'ino': 99, 'type': 49152, 'family': 1, 'socketType': 1}


class Endpoint:
    def __init__(self, fd, address=('127.0.0.1', 40000)):
        self.fd = fd; self.address = address; self.family = 1; self.calls = []; self.fail = None; self.silent_close = False
        self.connected = 0; self.acceptconn = 1; self.socket_error = 0
    def call(self, name):
        self.calls.append(name)
        if self.fail == name: raise OSError(errno.EIO, name)
    def fileno(self): return self.fd
    def close(self):
        self.call('close')
        if not self.silent_close: self.fd = -1
    def setblocking(self, value): self.call('setblocking')
    def set_inheritable(self, value): self.call('set_inheritable')
    def bind(self, value): self.call('bind')
    def listen(self, count): self.call('listen')
    def getsockname(self): self.call('getsockname'); return self.address
    def getsockopt(self, level, kind):
        self.call('getsockopt')
        if kind == m.socket.SO_TYPE: return 1
        if kind == m.socket.SO_ACCEPTCONN: return self.acceptconn
        return self.socket_error
    def getpeername(self): self.call('getpeername'); return ''
    def connect_ex(self, address): self.call('connect_ex'); return self.connected


class Selector:
    def __init__(self): self.closed = False; self.calls = []; self.fail = None; self.silent_close = False; self.ready = True
    def fileno(self): return -1 if self.closed else 90
    def register(self, *args):
        self.calls.append('register')
        if self.fail == 'register': raise OSError('register')
    def select(self, timeout):
        self.calls.append(('select', timeout))
        if self.fail == 'select': raise OSError('select')
        return [object()] if self.ready else []
    def close(self):
        self.calls.append('close')
        if self.fail == 'close': raise OSError('close')
        if not self.silent_close: self.closed = True


def setup(stack):
    core = load('subscription-trusted-http-ingress.py')
    handles = [Endpoint(20), Endpoint(21), Endpoint(22, ('127.0.0.1', 40001)), Endpoint(23), Endpoint(24)]
    ingress, listener, client, control, peer = handles
    selector = Selector()
    stack.enter_context(patch.object(m.sys, 'platform', 'linux'))
    stack.enter_context(patch.object(m, '_UNCERTAIN_CLEANUP', False))
    stack.enter_context(patch.object(m.time, 'monotonic', return_value=10))
    stack.enter_context(patch.object(m, 'load_core', return_value=core))
    duplicate = stack.enter_context(patch.object(m, 'duplicate_fixed_ingress', return_value=ingress))
    socket = stack.enter_context(patch.object(m.socket, 'socket', side_effect=[listener, client]))
    stack.enter_context(patch.object(m.socket, 'AF_UNIX', 1, create=True))
    pair = stack.enter_context(patch.object(m.socket, 'socketpair', return_value=(control, peer)))
    select = stack.enter_context(patch.object(m.selectors, 'DefaultSelector', return_value=selector))
    namespace = stack.enter_context(patch.object(m.os, 'readlink', return_value='net:[123]'))
    stack.enter_context(patch.object(core, 'identity', side_effect=lambda endpoint: {'dev': 1, 'ino': endpoint.fd, 'type': 49152}))
    return SimpleNamespace(core=core, handles=handles, ingress=ingress, listener=listener, client=client, control=control, peer=peer,
        selector=selector, duplicate=duplicate, socket=socket, pair=pair, select=select, namespace=namespace)


@pytest.mark.parametrize('mutation', ['bool', 'extra', 'missing', 'wrongtype', 'zero', 'negative', 'unsafe'])
def test_invalid_identity_never_inspects_or_duplicates_any_fd(mutation):
    value = expected()
    if mutation == 'bool': value['dev'] = True
    if mutation == 'extra': value['extra'] = 1
    if mutation == 'missing': value.pop('ino')
    if mutation == 'wrongtype': value['type'] = 4096
    if mutation == 'zero': value['ino'] = 0
    if mutation == 'negative': value['dev'] = -1
    if mutation == 'unsafe': value['ino'] = 9007199254740992
    with patch.object(m.os, 'fstat') as stat, patch.object(m.os, 'dup') as dup, patch.object(m.os, 'close') as close:
        with pytest.raises(ValueError): m.duplicate_fixed_ingress(value)
        stat.assert_not_called(); dup.assert_not_called(); close.assert_not_called()


@pytest.mark.parametrize('case', ['mismatch', 'inheritable'])
def test_unrelated_or_inheritable_original_untouched(case):
    value = SimpleNamespace(st_dev=7, st_ino=98 if case == 'mismatch' else 99, st_mode=49152)
    with patch.object(m.os, 'fstat', return_value=value), patch.object(m.os, 'get_inheritable', return_value=case == 'inheritable'), \
         patch.object(m.os, 'dup') as dup, patch.object(m.os, 'close') as close, patch.object(m.os, 'set_inheritable') as change:
        with pytest.raises(ValueError): m.duplicate_fixed_ingress(expected())
        dup.assert_not_called(); close.assert_not_called(); change.assert_not_called()


@pytest.mark.parametrize('case', ['valid', 'wrap-failed', 'wrong-kind', 'listener', 'disconnected', 'original-changed', 'cloexec-failed'])
def test_only_validated_duplicate_owned_and_original_never_closed(case):
    channel = Endpoint(77); channel.acceptconn = 1 if case == 'listener' else 0
    if case == 'disconnected': channel.fail = 'getpeername'
    first = SimpleNamespace(st_dev=7, st_ino=99, st_mode=49152)
    after = SimpleNamespace(st_dev=7, st_ino=100 if case == 'original-changed' else 99, st_mode=49152)
    with patch.object(m, '_UNCERTAIN_CLEANUP', False), patch.object(m.os, 'fstat', side_effect=[first, after]), \
         patch.object(m.os, 'get_inheritable', return_value=False), patch.object(m.os, 'dup', return_value=77) as dup, \
         patch.object(m.os, 'set_inheritable', side_effect=OSError('flags') if case == 'cloexec-failed' else None) as flags, \
         patch.object(m.socket, 'socket', side_effect=OSError('wrap') if case == 'wrap-failed' else None, return_value=channel), \
         patch.object(m, 'socket_identity', return_value={**expected(), 'family': 2} if case == 'wrong-kind' else expected()), \
         patch.object(m.os, 'close') as close:
        if case == 'valid':
            assert m.duplicate_fixed_ingress(expected()) is channel
            assert channel.fd == 77 and 'close' not in channel.calls
        else:
            with pytest.raises((OSError, ValueError)): m.duplicate_fixed_ingress(expected())
            if case in ('wrap-failed', 'cloexec-failed'): close.assert_called_once_with(77)
            else: assert channel.fd == -1
        dup.assert_called_once_with(198); flags.assert_called_once_with(77, False)
        assert all(call.args != (198,) for call in close.call_args_list)


@pytest.mark.parametrize('case', ['symlink', 'directory', 'too-large', 'writable', 'hash'])
def test_core_admission_before_import(case):
    path = Mock(); path.lstat.return_value = SimpleNamespace(st_mode={'symlink': 0o120777, 'directory': 0o40755}.get(case, 0o100444),
        st_size=1048577 if case == 'too-large' else 100)
    path.read_bytes.return_value = b'not pinned source'
    with patch.object(m, 'Path', return_value=path), patch.object(m.os, 'statvfs', return_value=SimpleNamespace(f_flag=0 if case == 'writable' else 1), create=True), \
         patch.object(m.os, 'ST_RDONLY', 1, create=True), patch.object(m.importlib.util, 'module_from_spec') as imported:
        with pytest.raises(ValueError): m.load_core()
        imported.assert_not_called()
        if case != 'hash': path.read_bytes.assert_not_called()


def test_fixed_actual_pinned_core_import_is_side_effect_free():
    path = Mock(); path.lstat.return_value = SimpleNamespace(st_mode=0o100444, st_size=100)
    raw = Path(__file__).with_name('subscription-trusted-http-ingress.py').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == m.CORE_SHA256
    path.read_bytes.return_value = raw
    with patch.object(m, 'Path', return_value=path), patch.object(m.os, 'statvfs', return_value=SimpleNamespace(f_flag=1), create=True), \
         patch.object(m.os, 'ST_RDONLY', 1, create=True), patch.object(m.importlib.util, 'spec_from_file_location', return_value=importlib.util.spec_from_loader('fixed_core', loader=None)):
        loaded = m.load_core()
        assert loaded.PINNED_WSS_REQUEST.endswith(b'Proxy-Connection: Keep-Alive\r\n\r\n')


@pytest.mark.parametrize('deadline', [True, None, float('nan'), float('inf'), 10, 9, 40.01])
def test_bad_deadline_before_loading_or_adopting(deadline):
    with patch.object(m.sys, 'platform', 'linux'), patch.object(m, '_UNCERTAIN_CLEANUP', False), patch.object(m.time, 'monotonic', return_value=10), \
         patch.object(m, 'load_core') as loaded, patch.object(m, 'duplicate_fixed_ingress') as duplicate:
        with pytest.raises(ValueError): m.create_fixed_session(expected(), deadline)
        loaded.assert_not_called(); duplicate.assert_not_called()


@pytest.mark.parametrize('remaining,session_seconds,negotiation_seconds', [(0.5, 0.5, 0.5), (3, 3, 2), (30, 5, 2)])
def test_shared_parent_deadline_clamped_without_extension(remaining, session_seconds, negotiation_seconds):
    with ExitStack() as stack:
        f = setup(stack)
        session, client, peer = m.create_fixed_session(expected(), 10 + remaining)
        assert f.core.SESSION_SECONDS == session_seconds and f.core.NEGOTIATION_SECONDS == negotiation_seconds
        assert session.began == 10 and session.profile == 'pinned-wss-shaped-fixture'
        assert session.ownership['borrowedOriginalFd'] == 198 and session.ownership['callerRetainsOriginal'] is True
        assert session.ownership['ownedIngressFd'] == 20
        assert client is f.client and peer is f.peer
        session.close()
        assert all(value.fd == -1 for value in (f.ingress, f.listener, f.control))
        assert client.fd == 22 and peer.fd == 24


@pytest.mark.parametrize('case', ['duplicate', 'ingress-flags', 'listener-create', 'listener-flags', 'bind', 'listen', 'address',
    'client-create', 'client-flags', 'client-bind', 'connect', 'selector-create', 'selector-register', 'selector-select',
    'selector-timeout', 'selector-close', 'socket-error', 'socketpair', 'control-flags', 'peer-flags', 'namespace', 'session-constructor'])
def test_setup_failures_attempt_all_owned_cleanup(case):
    with ExitStack() as stack:
        f = setup(stack)
        if case == 'duplicate': f.duplicate.side_effect = OSError('dup')
        if case == 'ingress-flags': f.ingress.fail = 'setblocking'
        if case == 'listener-create': f.socket.side_effect = OSError('listener')
        if case == 'listener-flags': f.listener.fail = 'set_inheritable'
        if case in ('bind', 'listen'): f.listener.fail = case
        if case == 'address': f.listener.address = ('0.0.0.0', 40000)
        if case == 'client-create': f.socket.side_effect = [f.listener, OSError('client')]
        if case == 'client-flags': f.client.fail = 'setblocking'
        if case == 'client-bind': f.client.fail = 'bind'
        if case == 'connect': f.client.connected = errno.ECONNREFUSED
        if case.startswith('selector') or case == 'socket-error': f.client.connected = errno.EINPROGRESS
        if case == 'selector-create': f.select.side_effect = OSError('selector')
        if case in ('selector-register', 'selector-select', 'selector-close'): f.selector.fail = case.removeprefix('selector-')
        if case == 'selector-timeout': f.selector.ready = False
        if case == 'socket-error': f.client.socket_error = errno.ECONNREFUSED
        if case == 'socketpair': f.pair.side_effect = OSError('pair')
        if case == 'control-flags': f.control.fail = 'setblocking'
        if case == 'peer-flags': f.peer.fail = 'set_inheritable'
        if case == 'namespace': f.namespace.return_value = 'net:[0]'
        if case == 'session-constructor': stack.enter_context(patch.object(f.core.OfflineSession, '__init__', side_effect=RuntimeError('session')))
        with pytest.raises((OSError, ValueError, RuntimeError)): m.create_fixed_session(expected(), 15)
        if case != 'duplicate': assert 'close' in f.ingress.calls
        if case not in ('duplicate', 'ingress-flags', 'listener-create'): assert 'close' in f.listener.calls
        if case in ('control-flags', 'peer-flags', 'namespace', 'session-constructor'):
            assert all('close' in value.calls for value in f.handles)


def test_one_close_failure_still_closes_rest_and_fences_next_factory():
    bad, good = Endpoint(20), Endpoint(21); bad.fail = 'close'
    with patch.object(m, '_UNCERTAIN_CLEANUP', False), patch.object(m.sys, 'platform', 'linux'), patch.object(m, 'load_core') as loaded:
        assert not m.close_owned([bad, good]); assert good.fd == -1
        with pytest.raises(ValueError, match='PREVIOUS'): m.create_fixed_session(expected(), 15)
        loaded.assert_not_called()


def test_core_session_unknown_close_propagates_factory_fence():
    with ExitStack() as stack:
        f = setup(stack); session, _, _ = m.create_fixed_session(expected(), 15)
        f.ingress.fail = 'close'
        assert session.close()['known'] is False
        f.duplicate.reset_mock()
        with pytest.raises(ValueError, match='PREVIOUS'): m.create_fixed_session(expected(), 15)
        f.duplicate.assert_not_called()


def test_closed_selector_fileno_exception_is_not_misclassified_as_socket_failure():
    selector = Selector(); selector.fileno = Mock(side_effect=ValueError('closed selector'))
    with patch.object(m, '_UNCERTAIN_CLEANUP', False):
        assert m.close_owned([selector]) is True and selector.closed
        selector.fileno.assert_not_called()
        assert m._UNCERTAIN_CLEANUP is False


def test_silent_socket_close_marks_unknown_cleanup():
    endpoint = Endpoint(20); endpoint.silent_close = True
    with patch.object(m, '_UNCERTAIN_CLEANUP', False):
        assert m.close_owned([endpoint]) is False
        assert m._UNCERTAIN_CLEANUP is True


def test_expired_after_source_load_never_duplicates_ingress():
    with ExitStack() as stack:
        f = setup(stack)
        stack.enter_context(patch.object(m.time, 'monotonic', side_effect=[10, 12.1, 12.1]))
        with pytest.raises(ValueError, match='DEADLINE'): m.create_fixed_session(expected(), 15)
        f.duplicate.assert_not_called()
