"""Fixed FD198 duplication for a future trusted capsule profile; no entrypoint."""
import errno
import hashlib
import importlib.util
import math
import os
from pathlib import Path
import re
import selectors
import socket
import stat
import sys
import time

FD = 198
CORE_PATH = '/usr/bin/trusted-http-ingress.py'
CORE_SHA256 = '9abe08ec337b4de4e2f3b217023a7dc3c19d87ea890633cacc63df16dfd0fd84'
_UNCERTAIN_CLEANUP = False


def valid_identity(value):
    return (type(value) is dict and set(value) == {'dev', 'ino', 'type', 'family', 'socketType'}
        and all(type(item) is int and 0 <= item <= 9007199254740991 for item in value.values())
        and value['ino'] > 0 and value['type'] == stat.S_IFSOCK
        and value['family'] == 1 and value['socketType'] == 1)


def socket_identity(channel):
    value = os.fstat(channel.fileno())
    return {'dev': value.st_dev, 'ino': value.st_ino, 'type': stat.S_IFMT(value.st_mode),
            'family': int(channel.family),
            'socketType': channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE)}


def close_owned(handles):
    global _UNCERTAIN_CLEANUP
    known = True
    for handle in handles:
        try:
            handle.close()
            # A closed selector may raise from fileno(); socket fileno() has
            # the defined -1 closed state. Do not turn known selector closure
            # into an unknown socket outcome.
            if hasattr(handle, 'getsockopt') and handle.fileno() != -1: known = False
        except Exception:
            known = False
    if not known: _UNCERTAIN_CLEANUP = True
    return known


def load_core():
    path = Path(CORE_PATH)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 * 1024:
        raise ValueError('FIXED_CORE_REGULAR_REQUIRED')
    if not os.statvfs(path).f_flag & os.ST_RDONLY:
        raise ValueError('FIXED_CORE_READONLY_REQUIRED')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != CORE_SHA256:
        raise ValueError('FIXED_CORE_HASH_REQUIRED')
    spec = importlib.util.spec_from_file_location('private_capsule_http_core', path)
    core = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(path), 'exec'), core.__dict__)
    return core


def duplicate_fixed_ingress(expected):
    """Own only the duplicate. Never close/reconfigure an unverified original."""
    if not valid_identity(expected): raise ValueError('FIXED_INGRESS_IDENTITY_REQUIRED')
    before = os.fstat(FD)
    if ({'dev': before.st_dev, 'ino': before.st_ino, 'type': stat.S_IFMT(before.st_mode)}
            != {key: expected[key] for key in ('dev', 'ino', 'type')} or os.get_inheritable(FD)):
        raise ValueError('FIXED_INGRESS_BINDING_REQUIRED')
    duplicate = os.dup(FD)
    channel = None
    try:
        os.set_inheritable(duplicate, False)
        channel = socket.socket(fileno=duplicate)
        if (socket_identity(channel) != expected
                or channel.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 0):
            raise ValueError('FIXED_CONNECTED_INGRESS_REQUIRED')
        channel.getpeername()
        after = os.fstat(FD)
        if (after.st_dev, after.st_ino, after.st_mode) != (before.st_dev, before.st_ino, before.st_mode):
            raise ValueError('FIXED_INGRESS_CHANGED')
        return channel
    except BaseException:
        if channel is not None:
            close_owned([channel])
        else:
            try: os.close(duplicate)
            except OSError:
                global _UNCERTAIN_CLEANUP
                _UNCERTAIN_CLEANUP = True
        raise


def create_fixed_session(expected, parent_deadline):
    """Return (session, client, control_peer); caller still owns original FD198.

    Trusted caller supplies its existing absolute shared work/total deadline.
    Original FD198 must be identity-checked and closed before any worker spawn.
    This factory owns the validated duplicate, listener and cancellation end.
    """
    if sys.platform != 'linux': raise ValueError('FIXED_LINUX_CAPSULE_REQUIRED')
    if _UNCERTAIN_CLEANUP: raise ValueError('PREVIOUS_CAPSULE_HTTP_CLEANUP_UNKNOWN')
    began = time.monotonic()
    if (type(parent_deadline) not in (int, float) or not math.isfinite(parent_deadline)
            or not 0 < parent_deadline - began <= 30):
        raise ValueError('FIXED_PARENT_DEADLINE_REQUIRED')
    core = load_core()
    core.SESSION_SECONDS = min(5.0, parent_deadline - began)
    core.NEGOTIATION_SECONDS = min(2.0, core.SESSION_SECONDS)
    owned = []
    def remaining():
        value = min(core.NEGOTIATION_SECONDS - (time.monotonic() - began), parent_deadline - time.monotonic())
        if value <= 0: raise ValueError('NEGOTIATION_DEADLINE')
        return value
    try:
        remaining()
        ingress = duplicate_fixed_ingress(expected); owned.append(ingress)
        ingress.setblocking(False)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM); owned.append(listener)
        listener.set_inheritable(False); listener.setblocking(False)
        listener.bind(('127.0.0.1', 0)); listener.listen(1)
        address = listener.getsockname()
        if address[0] != '127.0.0.1' or not listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN):
            raise ValueError('FIXED_LISTENER_REQUIRED')
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM); owned.append(client)
        client.set_inheritable(False); client.setblocking(False); client.bind(('127.0.0.1', 0))
        peer = client.getsockname()
        remaining()
        connected = client.connect_ex(address)
        if connected not in (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY):
            raise ValueError('FIXED_CLIENT_CONNECT_FAILED')
        if connected:
            connector = selectors.DefaultSelector(); owned.append(connector)
            connector.register(client, selectors.EVENT_WRITE)
            if not connector.select(remaining()): raise ValueError('NEGOTIATION_DEADLINE')
            remaining()
            if client.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR): raise ValueError('FIXED_CLIENT_CONNECT_FAILED')
            connector.close(); owned.remove(connector)
        control, control_peer = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        owned.extend((control, control_peer))
        for endpoint in (control, control_peer):
            endpoint.setblocking(False); endpoint.set_inheritable(False)
        namespace = os.readlink('/proc/self/ns/net')
        if re.fullmatch(r'net:\[[1-9][0-9]*\]', namespace) is None: raise ValueError('FIXED_NETWORK_NAMESPACE_REQUIRED')
        ownership = {'address': list(address), 'expectedClient': list(peer), 'listener': core.identity(listener),
            'ingress': core.identity(ingress), 'client': core.identity(client), 'control': core.identity(control),
            'networkNamespace': namespace, 'borrowedOriginalFd': FD, 'callerRetainsOriginal': True,
            'ownedIngressFd': ingress.fileno(), 'coreSha256': CORE_SHA256,
            'effectiveNegotiationSeconds': core.NEGOTIATION_SECONDS, 'effectiveSessionSeconds': core.SESSION_SECONDS}
        remaining()
        class CapsuleSession(core.OfflineSession):
            def close(self):
                global _UNCERTAIN_CLEANUP
                try:
                    outcome = super().close()
                    if outcome.get('known') is not True: _UNCERTAIN_CLEANUP = True
                    return outcome
                except BaseException:
                    _UNCERTAIN_CLEANUP = True
                    raise
        session = CapsuleSession(listener, ingress, control, peer, ownership, began, core._TOKEN, 'pinned-wss-shaped-fixture')
        return session, client, control_peer
    except BaseException:
        close_owned(owned)
        raise


if __name__ == '__main__': raise SystemExit('FIXED_CAPSULE_CALLER_ONLY')
